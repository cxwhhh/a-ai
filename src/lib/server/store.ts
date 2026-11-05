import "server-only";
import type { Artifact, ArtifactMeta, Session, SessionMeta, StoredMessage } from "../shared";
import { db, newId, tx } from "./db";

export { newId };

/**
 * 会话存储（SQLite）。
 * 读写边界：面向用户的读取/管理入口要校验 userId；追加消息、产出和截断，
 * 则只接收入口用 getSession / createSession 拿到的 Session，不直接接受浏览器拼出的会话对象。
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
  // has_files：只看当前有效记录。旧回答里曾经有文件，不能让新对话一直显示“有产出”。
  // write_file 从 assistant 的调用参数粗查（JSON 用 LIKE），这里只表示调用记录，不证明磁盘文件存在。
  return db().prepare(
    `SELECT id, title, created_at, updated_at, project_id,
       EXISTS(SELECT 1 FROM artifacts a WHERE a.session_id = s.id AND a.superseded_by IS NULL)
       OR EXISTS(SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.superseded_by IS NULL AND m.role = 'assistant' AND m.data LIKE '%"name":"write_file"%') AS has_files
     FROM sessions s WHERE user_id = ? ORDER BY updated_at DESC`,
  )
    .all(userId)
    .map((r) => ({ ...toMeta(r), hasFiles: !!r.has_files }));
}

/**
 * 读取“当前有效对话”，给页面和下一次模型请求使用；先校验会话属于当前用户。
 * superseded_by 为空 = 仍有效；有值 = 被那次编辑替代，原文还在库里，但这里不返回。
 * 否则页面一刷新，刚退出当前视图的旧回答又会混回来，模型也可能把旧结论当成新任务的依据。
 * 不存在或不属于这个用户都返回 null；这不是读取全部历史版本的接口。
 */
export function getSession(id: string, userId: string): Session | null {
  const r = db().prepare("SELECT id, title, created_at, updated_at, project_id FROM sessions WHERE id = ? AND user_id = ?").get(id, userId);
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

/** 彻底删除会话：消息、产出物和修订记录由外键级联删除；与编辑时保留旧记录不同，不是归档。 */
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
  s.updatedAt = now;
}

/**
 * 从一条真正的用户消息开始重新对话：保留旧记录，只让它们退出当前有效视图。
 * 例：A → B → C → D，从 C 重发后，当前视图先剩 A → B，再接 C₂ → D₂；
 * C、D 仍留在库里。函数名沿用 truncateFrom，因为截断的是当前视图，不再是永久历史。
 * 每次保存变更前的 ID 快照，今后可据此追溯完整旧视图；暂不提供版本切换界面。
 * 产出按来源调用关联；旧数据只有 artifactId 时兼容关联，来源不明的产出保守保留。
 */
export function truncateFrom(s: Session, messageId: string): boolean {
  const i = s.messages.findIndex((m) => m.id === messageId);
  if (i < 0 || s.messages[i].role !== "user") return false;
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
    // 先比对当前有效记录，拒绝过时的内存快照，避免另一轮写入后错误截断。
    // 消息要比较顺序；产出这里只比较成员，所以排序后再比。这道检查不能替代会话运行锁。
    const ids = db().prepare("SELECT id FROM messages WHERE session_id = ? AND superseded_by IS NULL ORDER BY seq").all(s.id).map((r) => r.id);
    const artifactIds = db().prepare("SELECT id FROM artifacts WHERE session_id = ? AND superseded_by IS NULL ORDER BY created_at, id").all(s.id).map((r) => r.id);
    if (JSON.stringify(ids) !== JSON.stringify(s.messages.map((m) => m.id)) ||
        JSON.stringify([...artifactIds].sort()) !== JSON.stringify(s.artifacts.map((a) => a.id).sort())) throw new Error("会话已更新，请刷新后重试");
    // 保存的是“变更前完整视图”的 ID 清单，包含未被截掉的前缀，不只保存被替代的后半段。
    // 正文仍在原表，不复制一遍；这些引用为后续历史查看提供依据，本阶段还没有切换版本的界面。
    db().prepare("INSERT INTO session_revisions (id, session_id, cut_message_id, created_at, message_ids, artifact_ids) VALUES (?, ?, ?, ?, ?, ?)").run(
      revision, s.id, messageId, now, JSON.stringify(ids), JSON.stringify(artifactIds),
    );
    // 消息、产出标记和修订快照一起提交，任何一步失败都回滚，不能只保留半份历史。
    const markMessage = db().prepare("UPDATE messages SET superseded_by = ? WHERE session_id = ? AND id = ? AND superseded_by IS NULL");
    for (const m of removed) {
      markMessage.run(revision, s.id, m.id);
      // 未送达的补充被编辑退出当前版本时，退回草稿并分配新消息 ID；
      // 旧正文仍保留，新版不能复用旧记录的主键。已送达回执保留为过去发生的事实。
      db().prepare("UPDATE message_queue SET status='queued', message_id=? WHERE session_id=? AND message_id=? AND status!='sent'")
        .run(newId("m"), s.id, m.id);
    }
    const markArtifact = db().prepare("UPDATE artifacts SET superseded_by = ? WHERE session_id = ? AND id = ? AND superseded_by IS NULL");
    for (const a of artifacts) markArtifact.run(revision, s.id, a.id);
    db().prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, s.id);
  });
  // 事务成功后才截断内存；磁盘上的工作区文件不动，保存聊天历史不等于回滚真实文件。
  s.messages.length = i;
  const hidden = new Set(artifacts.map((a) => a.id));
  s.artifacts = s.artifacts.filter((a) => !hidden.has(a.id));
  s.updatedAt = now;
  return true;
}

/** 和消息一样，先保存产出再更新内存；失败时不留下只在页面里存在的产出。 */
export function addArtifact(s: Session, a: Artifact) {
  db().prepare("INSERT INTO artifacts (id, session_id, created_at, data) VALUES (?, ?, ?, ?)").run(a.id, s.id, a.createdAt, JSON.stringify(a));
  s.artifacts.push(a);
}

/**
 * 统计用途：读取这个用户的全部记录，包括被替代的旧版本；一次查询，不逐个会话查。
 * 旧回答虽然不再显示，实际发生过的调用仍然消耗了资源，不能因为编辑就从历史统计中消失。
 * 这与 getSession 的“当前有效对话”用途不同，不要拿这个结果直接展示对话或发送给模型。
 */
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
 * 当前有效产出物的概要（“产出物”页面用），最新的在前，最多 500 个；旧版本记录仍在库里。
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

/** 卡片预览用的纯文字：网页去掉 <style>/<script> 和标签，Markdown 去掉 # * ` 这些符号，代码原样取前几行 */
function snippetOf(a: Artifact) {
  let t = a.content.slice(0, 6000);
  if (a.kind === "html") t = t.replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  else if (a.kind === "markdown") t = t.replace(/[#>*_`|-]+/g, " ");
  if (a.kind !== "code") t = t.replace(/\s+/g, " ");
  return t.trim().slice(0, 220);
}
