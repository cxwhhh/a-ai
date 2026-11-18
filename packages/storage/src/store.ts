import type { Artifact, ArtifactMeta, Session, SessionMeta, StoredMessage } from "../../protocol/src/lib/shared";
import { db, newId, tx } from "./db";
import { recordAgentLog } from "../../session/src/log";
import type { ReasoningEffort } from "../../protocol/src/agent-events";

export { newId };

/**
 * 会话存储（SQLite）。
 * 规则只有一条：每个函数都要传 userId，每条 SQL 都带 user_id 条件。
 * 别人的对话一律当作“不存在”（返回 null），接口再统一回 404 ——
 * 这样就算猜到了别人的会话 id，也读不到、改不了、删不掉（防 IDOR 越权）。
 */

type Row = Record<string, unknown>;
const toMeta = (r: Row): SessionMeta => ({
  revision: Number(r.history_revision ?? 0),
  id: r.id as string,
  title: r.title as string,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  ...(r.archived_at != null ? { archivedAt: Number(r.archived_at) } : {}),
  ...(r.model ? { modelSelection: { model: String(r.model), effort: r.effort as ReasoningEffort } } : {}),
  ...(r.project_id ? { projectId: r.project_id as string } : {}),
});

export function listSessions(userId: string): SessionMeta[] {
  // has_files：有产出物，或者有一条 assistant 消息调用过 write_file（消息存的是 JSON，用 LIKE 粗查即可）
  return db().prepare(
    `SELECT s.id, s.title, s.created_at, s.updated_at, s.project_id, s.archived_at, s.history_revision,
       EXISTS(SELECT 1 FROM artifacts a WHERE a.session_id = s.id AND a.superseded_by IS NULL)
       OR EXISTS(SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.superseded_by IS NULL AND m.role = 'assistant' AND m.data LIKE '%"name":"write_file"%') AS has_files
     FROM sessions s WHERE user_id = ? ORDER BY updated_at DESC`,
  )
    .all(userId)
    .map((r) => ({ ...toMeta(r), hasFiles: !!r.has_files }));
}

/** 读取一个会话（含消息和产出物）；不存在或不属于这个用户都返回 null */
export function getSession(id: string, userId: string): Session | null {
  const r = db().prepare(`SELECT s.*, m.model, m.effort FROM sessions s
    LEFT JOIN agent_model_selection m ON m.session_id=s.id WHERE s.id=? AND s.user_id=?`).get(id, userId);
  if (!r) return null;
  const messages = db().prepare("SELECT data FROM messages WHERE session_id = ? AND superseded_by IS NULL ORDER BY seq")
    .all(id)
    .map((m) => JSON.parse(m.data as string) as StoredMessage);
  const artifacts = db().prepare("SELECT data FROM artifacts WHERE session_id = ? AND superseded_by IS NULL ORDER BY created_at")
    .all(id)
    .map((a) => JSON.parse(a.data as string) as Artifact);
  return { ...toMeta(r), messages, artifacts };
}

/** projectId 要先确认是这个用户自己的项目（见 api/chat 里的 getProject），这里不再检查 */
export function createSession(userId: string, title = "新对话", projectId?: string): Session {
  const now = Date.now();
  const s: Session = { id: newId("s"), revision: 0, title, createdAt: now, updatedAt: now, messages: [], artifacts: [], ...(projectId ? { projectId } : {}) };
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
  const now = Date.now();
  tx(() => {
    advanceRevision(s);
    // 编辑后内存只剩当前有效消息，数据库却还保留旧版本，不能再用数组长度编号。
    // 例如旧记录 0、1、2 都还在，截到 0 后的新消息应接着编号 3，而不是重新使用 1。
    // MAX 看全部历史；读取序号和 INSERT 在同一事务中，避免中间插入其他记录。
    const seq = Number(db().prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM messages WHERE session_id = ?").get(s.id)!.next);
    db().prepare("INSERT INTO messages (id, session_id, seq, role, created_at, data) VALUES (?, ?, ?, ?, ?, ?)").run(
      m.id, s.id, seq, m.role, m.createdAt, JSON.stringify(clean),
    );
    db().prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, s.id);
  });
  // 数据库提交成功后才更新内存；写入失败时，页面不能多出一条实际没有保存的消息。
  s.messages.push(m);
  s.revision = (s.revision ?? 0) + 1;
  s.updatedAt = now;
}

/**
 * 从一条真正的用户消息开始重新对话：保留旧记录，只让它们退出当前有效视图。
 * 例：A → B → C → D，从 C 重发后，当前视图先剩 A → B，再接 C₂ → D₂；
 * C、D 仍留在库里。函数名沿用 truncateFrom，因为截断的是当前视图，不再是永久历史。
 * 每次保存变更前的 ID 快照，今后可据此追溯完整旧视图；暂不提供版本切换界面。
 * 产出按来源调用关联；旧数据只有 artifactId 时兼容关联，来源不明的产出保守保留。
 */
export function truncateFrom(s: Session, messageId: string, reason: "edit" | "regenerate" | "resend" = "resend"): boolean {
  const i = s.messages.findIndex((m) => m.id === messageId);
  if (i < 0 || s.messages[i].role !== "user" || s.messages[i].feedback) return false;
  // i 是当前视图的位置，不是数据库永久 seq；后面按稳定消息 ID 更新，不能用 seq >= i。
  const removed = s.messages.slice(i);
  // 同时收集 assistant 声明的调用与 tool 结果的调用 ID：
  // 工具可能已生成产出、还没来得及保存结果，不能只依赖结果消息。
  const calls = new Set(removed.flatMap((m) => [...(m.toolCalls ?? []).map((c) => c.id), ...(m.toolCallId ? [m.toolCallId] : [])]));
  // 老产出没有 sourceToolCallId 时，用旧结果里的 artifactId 兼容关联。
  // 不按 createdAt 猜：不同回答可能在同一毫秒产生文件；来源不明的旧产出先保留。
  const linked = new Set(removed.flatMap((m) => m.artifactId ? [m.artifactId] : []));
  const artifacts = s.artifacts.filter((a) => linked.has(a.id) || (a.sourceToolCallId && calls.has(a.sourceToolCallId)));
  const revision = newId("rev");
  const now = Date.now();
  tx(() => {
    advanceRevision(s);
    // 先比对当前有效记录，拒绝过时的内存快照，避免另一轮写入后错误截断。
    // 消息要比较顺序；产出这里只比较成员，所以排序后再比。这道检查不能替代会话运行锁。
    const ids = db().prepare("SELECT id FROM messages WHERE session_id = ? AND superseded_by IS NULL ORDER BY seq").all(s.id).map((r) => r.id);
    const artifactIds = db().prepare("SELECT id FROM artifacts WHERE session_id = ? AND superseded_by IS NULL ORDER BY created_at, id").all(s.id).map((r) => r.id);
    if (JSON.stringify(ids) !== JSON.stringify(s.messages.map((m) => m.id)) ||
        JSON.stringify([...artifactIds].sort()) !== JSON.stringify(s.artifacts.map((a) => a.id).sort())) throw new HistoryConflict();
    // 保存的是“变更前完整视图”的 ID 清单，包含未被截掉的前缀，不只保存被替代的后半段。
    // 正文仍在原表，不复制一遍；这些引用为后续历史查看提供依据，本阶段还没有切换版本的界面。
    db().prepare("INSERT INTO session_revisions (id, session_id, cut_message_id, created_at, message_ids, artifact_ids) VALUES (?, ?, ?, ?, ?, ?)").run(
      revision, s.id, messageId, now, JSON.stringify(ids), JSON.stringify(artifactIds),
    );
    const versions = db().prepare(`SELECT v.id FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id
      WHERE a.session_id=? AND a.superseded_by IS NULL
      AND v.version=(SELECT MAX(v2.version) FROM artifact_versions v2 WHERE v2.artifact_id=a.id)
      ORDER BY a.created_at,a.id`).all(s.id).map((r) => r.id);
    db().prepare("UPDATE session_revisions SET artifact_version_ids=?,reason=? WHERE id=?").run(JSON.stringify(versions), reason, revision);
    // 消息、产出标记和修订快照一起提交，任何一步失败都回滚，不能只保留半份历史。
    const markMessage = db().prepare("UPDATE messages SET superseded_by = ? WHERE session_id = ? AND id = ? AND superseded_by IS NULL");
    for (const m of removed) {
      markMessage.run(revision, s.id, m.id);
      if (m.role === "user" && (!m.feedback || m.feedback.kind === "note")) {
        recordAgentLog(s.id, { kind: "truncated", inputId: m.id,
          detail: { revision, reason, cutMessageId: messageId, preview: m.content.slice(0, 400) } });
      }
    }
    const markArtifact = db().prepare("UPDATE artifacts SET superseded_by = ? WHERE session_id = ? AND id = ? AND superseded_by IS NULL");
    for (const a of artifacts) markArtifact.run(revision, s.id, a.id);
    db().prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, s.id);
  });
  // 事务成功后才截断内存；磁盘上的工作区文件不动，保存聊天历史不等于回滚真实文件。
  s.messages.length = i;
  s.revision = (s.revision ?? 0) + 1;
  const hidden = new Set(artifacts.map((a) => a.id));
  s.artifacts = s.artifacts.filter((a) => !hidden.has(a.id));
  s.updatedAt = now;
  return true;
}

/** 和消息一样，先保存产出再更新内存；失败时不留下只在页面里存在的产出。 */
export function addArtifact(s: Session, a: Artifact) {
  tx(() => {
    advanceRevision(s);
    db().prepare("INSERT INTO artifacts (id, session_id, created_at, data) VALUES (?, ?, ?, ?)").run(a.id, s.id, a.createdAt, JSON.stringify(a));
    saveArtifactVersion(s.id, a);
  });
  s.revision = (s.revision ?? 0) + 1;
  s.artifacts.push(a);
}

/** 当前卡片保持同一 ID；每份正文先留版本，旧引用仍能追溯修正前的内容。 */
export function replaceArtifact(s: Session, a: Artifact) {
  const i = s.artifacts.findIndex((x) => x.id === a.id);
  if (i < 0) return addArtifact(s, a);
  tx(() => {
    advanceRevision(s);
    const result = db().prepare("UPDATE artifacts SET data = ? WHERE id = ? AND session_id = ? AND superseded_by IS NULL").run(JSON.stringify(a), a.id, s.id);
    if (!result.changes) throw new HistoryConflict();
    saveArtifactVersion(s.id, a);
  });
  s.artifacts[i] = a;
  s.revision = (s.revision ?? 0) + 1;
}

/** 快照或请求版本过期时让调用者刷新，不能静默把新问题接到错误分支。 */
export class HistoryConflict extends Error {
  constructor() { super("会话已更新，请刷新后重试"); }
}

function advanceRevision(s: Session) {
  const r = db().prepare("UPDATE sessions SET history_revision=history_revision+1 WHERE id=? AND history_revision=?").run(s.id, s.revision ?? 0);
  if (!r.changes) throw new HistoryConflict();
}

function saveArtifactVersion(sessionId: string, a: Artifact) {
  db().prepare(`INSERT INTO artifact_versions(id,artifact_id,session_id,version,data)
    SELECT ?,?,?,COALESCE(MAX(version),0)+1,? FROM artifact_versions WHERE artifact_id=?`)
    .run(newId("av"), a.id, sessionId, JSON.stringify(a), a.id);
}

/** 截断和新问题作为一次提交；临时快照只在整个事务成功后发布给当前运行。 */
export function beginTurn(s: Session, m: StoredMessage, from?: string, runId?: string) {
  const next = { ...s, messages: [...s.messages], artifacts: [...s.artifacts] };
  tx(() => {
    const reason = s.messages.find((m) => m.id === from)?.content === m.content ? "regenerate" : "edit";
    if (from && !truncateFrom(next, from, reason)) throw new HistoryConflict();
    addMessage(next, m);
    if (runId) {
      recordAgentLog(s.id, { kind: "accepted", runId, inputId: m.id, detail: { preview: m.content.slice(0, 400) } });
      // 和输入一起提交；停止发生在模型准备之前时，也能追踪这一轮领取过什么。
      recordAgentLog(s.id, { kind: "turn-start", runId, inputId: m.id, detail: {} });
    }
  });
  Object.assign(s, next);
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
       WHERE s.user_id = ? AND a.superseded_by IS NULL ORDER BY a.created_at DESC LIMIT 500`,
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
       WHERE s.user_id = ? AND m.superseded_by IS NULL AND m.role = 'assistant' AND m.data LIKE '%write_document%'
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
