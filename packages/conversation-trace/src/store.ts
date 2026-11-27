import { gzipSync, gunzipSync } from "node:zlib";
import { db } from "../../storage/src/db";
import { SUBAGENT_REFERENCE_TAG } from "../../protocol/src/lib/message-tags";
import { analyzeRequestContext } from "./analysis";
import type { ToolCall } from "../../llm/src/types";
import type { RequestResponse, RequestSnapshot, TraceEntry, TraceEntryMeta, TraceFinishFacts, TracePreview, TraceRecordDetail, TraceToolResult } from "./types";

const encode = (value: unknown) => gzipSync(JSON.stringify(value));
const decode = (value: unknown) => JSON.parse(gunzipSync(value as Uint8Array).toString("utf8"));

function excerpt(value?: string): string | undefined {
  if (!value) return;
  const preview = value.slice(0, 640).trim();
  return (preview && value.length > 640 ? preview + "…" : preview) || undefined;
}

function requestPreview(meta: TraceEntryMeta, payload: unknown): TracePreview {
  if (meta.kind === "tool") return { arguments: excerpt((payload as ToolCall).arguments) };
  const snapshot = payload as RequestSnapshot;
  const messages = { system: 0, user: 0, assistant: 0, tool: 0 };
  for (const message of snapshot.messages) messages[message.role]++;
  return { context: { messages, tools: snapshot.tools.length } };
}

function resultPreview(facts: TraceFinishFacts, result: unknown): TracePreview {
  if (!("metrics" in facts)) return { result: excerpt((result as TraceToolResult | null)?.content) };
  const response = result as RequestResponse | null;
  const text = (kind: "text" | "reasoning") => {
    const block = response?.blocks.find((item) => item.kind === kind);
    return block && "text" in block ? excerpt(block.text) : undefined;
  };
  return { text: text("text"), reasoning: text("reasoning") };
}

/** 按会话保存压缩快照，并在索引上留出可直接展示的短摘要。 */
export function insertTraceEntry(sessionId: string, entry: TraceEntry, payload: unknown) {
  const meta = { ...entry.meta, preview: requestPreview(entry.meta, payload) };
  return db().prepare(`INSERT INTO conversation_trace_entries(id,session_id,at,meta,payload)
    SELECT ?,id,?,?,? FROM sessions WHERE id=?`)
    .run(entry.id, entry.at, JSON.stringify(meta), encode(payload), sessionId).changes > 0;
}

/** 按会话和记录 ID 收尾，同时保存结果正文和列表使用的状态指标。 */
export function finishTraceEntry(sessionId: string, id: string, outcome: NonNullable<TraceEntry["outcome"]>, result: unknown, facts?: TraceFinishFacts) {
  // 索引指标和响应一起收尾。并发或重复收尾不能覆盖第一次记录的事实。
  db().prepare(`UPDATE conversation_trace_entries SET finished_at=?,outcome=?,result=?,meta=json_patch(meta,?)
    WHERE session_id=? AND id=? AND finished_at IS NULL`)
    .run(Date.now(), outcome, encode(result), JSON.stringify(facts ? { ...facts, preview: resultPreview(facts, result) } : {}), sessionId, id);
}

function toEntry(row: Record<string, unknown>): TraceEntry {
  return {
    id: String(row.id), at: Number(row.at), finishedAt: row.finished_at == null ? null : Number(row.finished_at),
    outcome: row.outcome as TraceEntry["outcome"], meta: JSON.parse(String(row.meta)) as TraceEntryMeta,
  };
}

/** 列出当前用户在指定会话的轨迹索引。打开统计时才补读旧快照缺失的指标。 */
export function listTraceEntries(sessionId: string, userId: string, includeStats = false, includePreview = false): TraceEntry[] {
  // 新记录直接读取索引，老记录在列表里也能看摘要。旧快照过大或损坏时保留索引信息。
  const preview = includePreview ? `,
    CASE WHEN json_type(t.meta,'$.preview') IS NULL THEN t.payload END AS legacy_payload,
    CASE WHEN json_type(t.meta,'$.preview') IS NULL THEN t.result END AS preview_result` : "";
  const legacy = includeStats
    ? ",CASE WHEN json_extract(t.meta,'$.kind')='request' AND json_type(t.meta,'$.metrics') IS NULL THEN t.result END AS legacy_result"
    : "";
  const rows = db().prepare(`SELECT t.id,t.at,t.finished_at,t.outcome,t.meta${legacy}${preview} FROM conversation_trace_entries t
    JOIN sessions s ON s.id=t.session_id WHERE t.session_id=? AND s.user_id=? ORDER BY t.at,t.rowid`)
    .iterate(sessionId, userId);
  return Array.from(rows, (row) => {
    const entry = toEntry(row);
    if (row.legacy_payload != null) {
      const decodePreview = (data: unknown) => JSON.parse(gunzipSync(data as Uint8Array, { maxOutputLength: 2 * 1024 * 1024 }).toString("utf8"));
      try {
        entry.meta.preview = requestPreview(entry.meta, decodePreview(row.legacy_payload));
      } catch { /* 仍显示请求类型和状态。 */ }
      try {
        if (row.preview_result != null) {
          const facts = entry.meta.kind === "request" ? { metrics: {} } : { toolStatus: "ok" as const };
          entry.meta.preview = { ...entry.meta.preview, ...resultPreview(facts, decodePreview(row.preview_result)) };
        }
      } catch { /* 仍显示已有的参数或上下文。 */ }
    }
    if (entry.meta.kind === "request" && row.legacy_result != null) {
      try {
        const response = decode(row.legacy_result) as RequestResponse | null;
        if (response) {
          const { blocks: _blocks, ...metrics } = response;
          entry.meta.metrics = metrics;
        }
      } catch { /* 旧响应不可读时，仍保留请求与状态计数。 */ }
    }
    return entry;
  });
}

/** 读取正文时同时校验用户、会话和记录，单独猜到记录 ID 也无法跨对话读取。 */
export function readTraceEntry(sessionId: string, userId: string, id: string, compare = false): TraceRecordDetail | null {
  // 旧适配器未上报用量时，主流程可能已经保存估算。只取同一次请求对应的助手消息的用量。
  const estimate = compare ? `,(SELECT json_extract(m.data,'$.usage') FROM messages m WHERE m.session_id=t.session_id
    AND m.id=json_extract(t.meta,'$.assistantId') AND m.role='assistant' AND json_type(m.data,'$.usage')='object') AS message_usage` : "";
  const row = db().prepare(`SELECT t.*,t.rowid AS sequence${estimate} FROM conversation_trace_entries t JOIN sessions s ON s.id=t.session_id
    WHERE t.session_id=? AND s.user_id=? AND t.id=?`).get(sessionId, userId, id);
  if (!row) return null;
  const entry = toEntry(row);
  const payload = decode(row.payload);
  const result = row.result == null ? undefined : decode(row.result) ?? undefined;
  if (entry.meta.kind !== "request") return { ...entry, kind: "tool", call: payload, result };
  if (result && !result.usage && typeof row.message_usage === "string") result.usage = JSON.parse(row.message_usage);
  let baseline: { entry: TraceEntry; request: RequestSnapshot } | undefined;
  if (compare) {
    const { runId, inputId, phase, subagentKind, parentId, taskId } = entry.meta;
    // 排队输入可共享 runId，子 Agent 可共享步骤号。对比必须同时匹配输入、阶段、子任务细分类型与父调用，避免复核/压缩和主步骤串台。
    const previous = db().prepare(`SELECT p.id,p.at,p.finished_at,p.outcome,p.meta,p.payload
      FROM conversation_trace_entries p JOIN sessions s ON s.id=p.session_id
      WHERE p.session_id=? AND s.user_id=? AND p.rowid<?
        AND json_extract(p.meta,'$.kind')='request' AND json_extract(p.meta,'$.runId')=?
        AND json_extract(p.meta,'$.inputId')=? AND json_extract(p.meta,'$.phase')=?
        AND json_extract(p.meta,'$.subagentKind') IS ?
        AND json_extract(p.meta,'$.parentId') IS ? AND json_extract(p.meta,'$.taskId') IS ? ORDER BY p.rowid DESC LIMIT 1`)
      .get(sessionId, userId, row.sequence, runId, inputId, phase, subagentKind ?? null, parentId ?? null, taskId ?? null);
    if (previous) {
      try { baseline = { entry: toEntry(previous), request: decode(previous.payload) }; }
      catch { /* 旧快照损坏不影响查看当前请求。 */ }
    }
  }
  return { ...entry, kind: "request", request: payload, response: result, context: compare ? analyzeRequestContext(payload, baseline) : undefined };
}

/** 旧主请求没有保存起点，按本会话内的输入 ID 找回起点，兼容当时附加在输入末尾的环境快照。 */
function legacyTurnStart(sessionId: string, inputId: string, messages: RequestSnapshot["messages"]) {
  const row = db().prepare("SELECT data FROM messages WHERE session_id=? AND id=? AND role='user'").get(sessionId, inputId);
  if (!row) return -1;
  const { content, feedback } = JSON.parse(String(row.data));
  if (typeof content !== "string" || feedback) return -1;
  const environmentPrefix = `${content}\n\n<环境>\n`;
  let exact = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "user") continue;
    if (message.content.startsWith(environmentPrefix) && message.content.endsWith("\n</环境>")) return index;
    if (exact < 0 && message.content === content) exact = index;
  }
  return exact;
}

/** 请求详情只交付当前对话的消息。用量和变化仍按原快照计算，提示词由独立标签读取。 */
export function readTraceRecordView(sessionId: string, userId: string, id: string, compare = false): TraceRecordDetail | null {
  const detail = readTraceEntry(sessionId, userId, id, compare);
  if (!detail || detail.kind !== "request" || detail.meta.kind !== "request") return detail;
  const { messages, turnStart, referenceIndex, ...request } = detail.request;
  const prompts = messages.filter((message) => message.role === "system").map((message) => message.content);
  const { phase, inputId } = detail.meta;
  let current: RequestSnapshot["messages"] = [];
  if (phase === "chat") {
    const start = turnStart === undefined ? legacyTurnStart(sessionId, inputId, messages) : turnStart;
    if (start !== null && start >= 0 && messages[start]?.role === "user") current = messages.slice(start);
  } else if (phase === "research") {
    const inherited = referenceIndex === undefined && messages[2]?.role === "user"
      && messages[2].content.startsWith(SUBAGENT_REFERENCE_TAG) ? 2 : referenceIndex;
    current = messages.filter((_, index) => index !== inherited);
  }
  return { ...detail, prompts, request: { ...request, messages: current.filter((message) => message.role !== "system") } };
}
