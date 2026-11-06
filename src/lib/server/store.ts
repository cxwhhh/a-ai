import "server-only";
import type { Artifact, ArtifactMeta, Session, SessionMeta, StoredMessage } from "../shared";
import { db, newId, tx } from "./db";

export { newId };

/**
 * 会话存储（SQLite）。
 * 规则只有一条：每个函数都要传 userId，每条 SQL 都带 user_id 条件。
 * 别人的对话一律当作“不存在”（返回 null），接口再统一回 404 ——
 * 这样就算猜到了别人的会话 id，也读不到、改不了、删不掉（防 IDOR 越权）。
 */

type Row = Record<string, unknown>;
const toMeta = (r: Row): SessionMeta => ({
  id: r.id as string,
  title: r.title as string,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  ...(r.project_id ? { projectId: r.project_id as string } : {}),
});

export function listSessions(userId: string): SessionMeta[] {
  // has_files：有产出物，或者有一条 assistant 消息调用过 write_file（消息存的是 JSON，用 LIKE 粗查即可）
  return db().prepare(
    `SELECT id, title, created_at, updated_at, project_id,
       EXISTS(SELECT 1 FROM artifacts a WHERE a.session_id = s.id)
       OR EXISTS(SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.role = 'assistant' AND m.data LIKE '%"name":"write_file"%') AS has_files
     FROM sessions s WHERE user_id = ? ORDER BY updated_at DESC`,
  )
    .all(userId)
    .map((r) => ({ ...toMeta(r), hasFiles: !!r.has_files }));
}

/** 读取一个会话（含消息和产出物）；不存在或不属于这个用户都返回 null */
export function getSession(id: string, userId: string): Session | null {
  const r = db().prepare("SELECT id, title, created_at, updated_at, project_id FROM sessions WHERE id = ? AND user_id = ?").get(id, userId);
  if (!r) return null;
  const messages = db().prepare("SELECT data FROM messages WHERE session_id = ? ORDER BY seq")
    .all(id)
    .map((m) => JSON.parse(m.data as string) as StoredMessage);
  const artifacts = db().prepare("SELECT data FROM artifacts WHERE session_id = ? ORDER BY created_at")
    .all(id)
    .map((a) => JSON.parse(a.data as string) as Artifact);
  return { ...toMeta(r), messages, artifacts };
}

/** projectId 要先确认是这个用户自己的项目（见 api/chat 里的 getProject），这里不再检查 */
export function createSession(userId: string, title = "新对话", projectId?: string): Session {
  const now = Date.now();
  const s: Session = { id: newId("s"), title, createdAt: now, updatedAt: now, messages: [], artifacts: [], ...(projectId ? { projectId } : {}) };
  db().prepare("INSERT INTO sessions (id, user_id, title, created_at, updated_at, project_id) VALUES (?, ?, ?, ?, ?, ?)").run(s.id, userId, title, now, now, projectId ?? null);
  return s;
}

export function renameSession(id: string, userId: string, title: string): SessionMeta | null {
  const now = Date.now();
  const r = db().prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(title, now, id, userId);
  if (!r.changes) return null;
  return toMeta(db().prepare("SELECT id, title, created_at, updated_at, project_id FROM sessions WHERE id = ?").get(id)!);
}

/** 删除会话；消息和产出物通过 ON DELETE CASCADE 一起删掉 */
export function deleteSession(id: string, userId: string): boolean {
  return db().prepare("DELETE FROM sessions WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}

/**
 * 追加一条消息：只 INSERT 这一行，不重写整个会话。
 * 调用前 session 必须是用 getSession / createSession 拿到的（已经确认属于当前用户）。
 */
export function addMessage(s: Session, m: StoredMessage) {
  const { drafts: _d, ...clean } = m; // drafts 只是前端流式显示用的，不存
  s.messages.push(m);
  s.updatedAt = Date.now();
  tx(() => {
    db().prepare("INSERT INTO messages (id, session_id, seq, role, created_at, data) VALUES (?, ?, ?, ?, ?, ?)").run(
      m.id, s.id, s.messages.length - 1, m.role, m.createdAt, JSON.stringify(clean),
    );
    db().prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(s.updatedAt, s.id);
  });
}

/**
 * 从某条用户消息开始，把它和它之后的消息全部删掉（“重新生成”和“编辑后重发”用）。
 * 只认用户消息：传别的 id、或者这条消息不在这个会话里，都什么也不做，返回 false。
 * 这一段里生成的产出物也一起删掉，免得右侧还挂着已经不存在的回答生成的东西；
 * 工作区里写过的文件不动（那是磁盘上的真实文件，删了反而危险）。
 */
export function truncateFrom(s: Session, messageId: string): boolean {
  const i = s.messages.findIndex((m) => m.id === messageId);
  if (i < 0 || s.messages[i].role !== "user") return false;
  const since = s.messages[i].createdAt;
  tx(() => {
    db().prepare("DELETE FROM messages WHERE session_id = ? AND seq >= ?").run(s.id, i);
    db().prepare("DELETE FROM artifacts WHERE session_id = ? AND created_at >= ?").run(s.id, since);
  });
  s.messages.length = i;
  s.artifacts = s.artifacts.filter((a) => a.createdAt < since);
  return true;
}

export function addArtifact(s: Session, a: Artifact) {
  s.artifacts.push(a);
  db().prepare("INSERT INTO artifacts (id, session_id, created_at, data) VALUES (?, ?, ?, ?)").run(a.id, s.id, a.createdAt, JSON.stringify(a));
}

/** 原地更新一个产出物（id、创建时间不变，只换内容）：同一轮里按检查意见改好再提交时用，不再多出一份 */
export function replaceArtifact(s: Session, a: Artifact) {
  const i = s.artifacts.findIndex((x) => x.id === a.id);
  if (i < 0) return addArtifact(s, a);
  s.artifacts[i] = a;
  db().prepare("UPDATE artifacts SET data = ? WHERE id = ? AND session_id = ?").run(JSON.stringify(a), a.id, s.id);
}

/** 用量统计用：这个用户的全部会话（一次查询取出所有消息，不是每个会话查一次） */
export function allSessions(userId: string): Session[] {
  const map = new Map<string, Session>();
  for (const r of db().prepare("SELECT id, title, created_at, updated_at FROM sessions WHERE user_id = ?").all(userId))
    map.set(r.id as string, { ...toMeta(r), messages: [], artifacts: [] });
  const rows = (table: string, order: string) =>
    db().prepare(`SELECT t.session_id, t.data FROM ${table} t JOIN sessions s ON s.id = t.session_id WHERE s.user_id = ? ORDER BY ${order}`).all(userId);
  for (const r of rows("messages", "t.session_id, t.seq")) map.get(r.session_id as string)?.messages.push(JSON.parse(r.data as string));
  for (const r of rows("artifacts", "t.created_at")) map.get(r.session_id as string)?.artifacts.push(JSON.parse(r.data as string));
  return [...map.values()];
}

/**
 * 全部产出物的概要（“产出物”页面用），最新的在前，最多 500 个。
 * 和对话一样只查这个用户自己的：JOIN sessions 带上 user_id 条件。
 * 不返回全文：网页、代码可能很长，列表只要标题和开头一小段；点开时再按对话加载全文。
 */
export function listArtifacts(userId: string): ArtifactMeta[] {
  return db()
    .prepare(
      `SELECT a.data, a.session_id, s.title AS session_title, s.project_id
       FROM artifacts a JOIN sessions s ON s.id = a.session_id
       WHERE s.user_id = ? ORDER BY a.created_at DESC LIMIT 500`,
    )
    .all(userId)
    .map((r) => {
      const a = JSON.parse(r.data as string) as Artifact;
      const isSvg = a.kind === "code" && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(a.content) && a.content.length < 60_000;
      return {
        id: a.id,
        title: a.title,
        kind: a.kind,
        ...(a.language ? { language: a.language } : {}),
        createdAt: a.createdAt,
        sessionId: r.session_id as string,
        sessionTitle: r.session_title as string,
        ...(r.project_id ? { projectId: r.project_id as string } : {}),
        snippet: snippetOf(a),
        size: a.content.length,
        ...(isSvg ? { svg: a.content } : {}),
      };
    });
}

/**
 * “产出物”页也要列出 write_document 生成的 Word / Excel / PPT（它们是文件，不在 artifacts 表里）。
 * 这里只从对话记录里找出“哪个对话、什么时候、生成了哪个路径”，文件还在不在由接口去查磁盘。
 */
export function listDocFiles(userId: string) {
  const rows = db()
    .prepare(
      `SELECT m.data, m.session_id, s.title AS session_title, s.project_id
       FROM messages m JOIN sessions s ON s.id = m.session_id
       WHERE s.user_id = ? AND m.role = 'assistant' AND m.data LIKE '%write_document%'
       ORDER BY m.created_at DESC LIMIT 500`,
    )
    .all(userId);
  const out: { path: string; createdAt: number; sessionId: string; sessionTitle: string; projectId?: string }[] = [];
  for (const r of rows) {
    const m = JSON.parse(r.data as string) as StoredMessage;
    for (const c of m.toolCalls ?? []) {
      if (c.name !== "write_document") continue;
      try {
        const p = String(JSON.parse(c.arguments || "{}").path ?? "").trim();
        if (p) out.push({ path: p, createdAt: m.createdAt, sessionId: r.session_id as string, sessionTitle: r.session_title as string, ...(r.project_id ? { projectId: r.project_id as string } : {}) });
      } catch {
        /* 参数不是合法 JSON：这次调用本来就失败了 */
      }
    }
  }
  return out;
}

/** 卡片预览用的纯文字：网页去掉 <style>/<script> 和标签，Markdown 去掉 # * ` 这些符号，代码原样取前几行 */
function snippetOf(a: Artifact) {
  let t = a.content.slice(0, 6000);
  if (a.kind === "html") t = t.replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  else if (a.kind === "markdown") t = t.replace(/[#>*_`|-]+/g, " ");
  if (a.kind !== "code") t = t.replace(/\s+/g, " ");
  return t.trim().slice(0, 220);
}
