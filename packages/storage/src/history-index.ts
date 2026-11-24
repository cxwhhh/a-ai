import type { DatabaseSync } from "node:sqlite";
import type { StoredMessage } from "../../protocol/src/lib/shared";

export const historyReaders = new Set(["search_history", "read_history_execution", "read_tool_result"]);

/** 清单保留定位目标所需的参数，完整参数仍与调用声明一起保存在原消息。 */
export function historyCallDetails(raw: string) {
  const args: Record<string, string | number | boolean> = {};
  let purpose = "";
  try {
    const parsed = JSON.parse(raw || "{}") as Record<string, unknown>;
    if (typeof parsed.purpose === "string") purpose = parsed.purpose.slice(0, 160);
    for (const key of ["path", "file", "source", "destination", "pattern", "expression", "offset", "limit", "recursive", "taskId", "resultId", "segmentId"]) {
      const value = parsed[key];
      if (typeof value === "string") args[key] = value.slice(0, 180);
      if (typeof value === "number" || typeof value === "boolean") args[key] = value;
    }
  } catch {
    // 半截调用的参数可能无效；列表仍显示调用 ID 和状态。
  }
  return { purpose, arguments: args };
}

/** 兼顾英文标识符与无空格中文。连续中文按相邻二字入索引，支持“东京”这样的短查询。 */
export function historyTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const match of text.normalize("NFKC").toLowerCase().matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[a-z0-9][a-z0-9_-]{1,79}/gu)) {
    const word = match[0];
    if (!/^[a-z0-9]/.test(word) && word.length > 1) {
      const chars = Array.from(word);
      for (let i = 1; i < chars.length; i++) terms.add(chars[i - 1] + chars[i]);
    } else {
      terms.add(word);
      for (const part of word.split(/[_-]/)) if (part.length > 1) terms.add(part);
    }
  }
  return [...terms];
}

function entities(text: string): string[] {
  return Array.from(text.matchAll(/[a-z0-9_./\\:-]+\.[a-z0-9]{1,12}\b|\b[a-z]+[_-][a-z0-9_-]+\b|\b[A-Z][A-Z0-9]{2,20}\b|[“「`][^”」`\r\n]{2,72}[”」`]/gi), ([value]) => value.replace(/^[“「`]|[”」`]$/g, ""))
    .filter((value) => value.length <= 96 && (/[._/\\-]/.test(value) || /^[A-Z0-9]+$/.test(value) || /[^\x00-\x7f]/.test(value)));
}

/** 消息、段落和检索词在同一事务内更新。只提取索引所需字段，原始结果继续保留在 messages。 */
export function indexHistoryMessage(d: DatabaseSync, sessionId: string, seq: number, message: StoredMessage) {
  if (message.feedback && message.feedback.kind !== "note") return;
  const start = message.role === "user" && !message.feedback;
  const text = (message.role === "tool" ? "" : message.content).slice(0, 1600);
  if (start) {
    const topic = text.trim().split(/\r?\n/, 1)[0].slice(0, 140);
    d.prepare("INSERT INTO history_segments(input_id,session_id,start_seq,end_seq,topic) VALUES (?,?,?,?,?)")
      .run(message.id, sessionId, seq, seq, topic);
  }
  const segment = d.prepare("SELECT input_id,entities FROM history_segments WHERE session_id=? ORDER BY start_seq DESC LIMIT 1").get(sessionId);
  if (!segment) return;
  const inputId = String(segment.input_id);
  const calls = (message.toolCalls ?? []).filter((call) => !historyReaders.has(call.name));
  const callTerms = calls.map((call) => {
    const details = historyCallDetails(call.arguments);
    return [call.name, details.purpose, ...Object.values(details.arguments)].join(" ");
  }).join(" ").slice(0, 2400);
  const resultFields = message.toolResult ? JSON.stringify(message.toolResult.fields).slice(0, 480) : "";
  const keys = [...new Set([...JSON.parse(String(segment.entities)) as string[], ...calls.map((call) => call.name), ...entities(text + " " + callTerms + " " + resultFields)])].slice(0, 24);
  const summary = message.role === "assistant" && !message.toolCalls?.length ? text.trim().replace(/\s+/g, " ").slice(0, 220) : "";
  d.prepare(`UPDATE history_segments SET end_seq=?,tool_calls=tool_calls+?,entities=?,
    summary=CASE WHEN ?='' THEN summary ELSE ? END WHERE input_id=?`)
    .run(seq, message.toolCalls?.length ?? 0, JSON.stringify(keys), summary, summary, inputId);
  const weight = start ? 4 : 1;
  const terms = new Map(historyTerms(text).slice(0, 220).map((term) => [term, weight]));
  for (const term of historyTerms(keys.join(" ") + " " + callTerms + " " + resultFields).slice(0, 140)) terms.set(term, 6);
  if (!terms.size) return;
  const data = JSON.stringify([...terms].map(([term, score]) => ({ term, score })));
  d.prepare(`INSERT INTO history_segment_terms(input_id,term,weight)
    SELECT ?,value->>'term',value->>'score' FROM json_each(?) WHERE true
    ON CONFLICT(input_id,term) DO UPDATE SET weight=MAX(weight,excluded.weight)`).run(inputId, data);
}

/** 首次升级按会话和消息顺序回填已有的当前分支。回填与建表一起提交，失败时下次可重做。 */
export function migrateHistoryIndex(d: DatabaseSync) {
  if (d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_segments'").get()) return;
  d.exec(`CREATE TABLE history_segments (
    input_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    start_seq INTEGER NOT NULL,
    end_seq INTEGER NOT NULL,
    topic TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    entities TEXT NOT NULL DEFAULT '[]',
    tool_calls INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX history_segments_session ON history_segments(session_id,start_seq);
  CREATE TABLE history_segment_terms (
    input_id TEXT NOT NULL REFERENCES history_segments(input_id) ON DELETE CASCADE,
    term TEXT NOT NULL,
    weight INTEGER NOT NULL,
    PRIMARY KEY(input_id,term)
  ) WITHOUT ROWID;
  CREATE INDEX history_segment_terms_lookup ON history_segment_terms(term,input_id);`);
  // 工具行只需元数据。旧大型输出的正文无需从 SQLite 复制到迁移进程。
  for (const row of d.prepare(`SELECT session_id,seq,
    CASE WHEN role='tool' THEN json_object('role','tool','content','','toolResult',json_extract(data,'$.toolResult'))
         ELSE data END AS data FROM messages WHERE superseded_by IS NULL AND json_valid(data)
    ORDER BY session_id,seq`).iterate()) {
    indexHistoryMessage(d, String(row.session_id), Number(row.seq), JSON.parse(String(row.data)));
  }
}
