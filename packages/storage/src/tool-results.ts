import { toolStatus, type StoredMessage } from "../../protocol/src/lib/shared";
import { estimateTokens } from "../../protocol/src/lib/tokens";
import { db } from "./db";
import { resolveReadableSession } from "./history";

const INLINE_TOKENS = 1_200;
export const TOOL_RESULT_PAGE_CHARS = 2_000;
const fieldsByTool: Record<string, readonly string[]> = {
  calculator: ["expression", "result", "value", "unit"],
  query_data: ["columns", "rowCount", "truncated"],
  run_python: ["exitCode", "timedOut"],
  run_command: ["exitCode", "timedOut", "truncated"],
  web_fetch: ["title", "url", "status", "truncated"],
  web_search: ["query", "engine", "count"],
  http_request: ["status", "url", "contentType", "truncated"],
  read_file: ["path", "startLine", "endLine", "totalLines", "nextOffset"],
  read_document: ["path", "pages", "totalChars", "offset", "nextOffset", "truncated"],
  grep: ["pattern", "path", "matches", "truncated"],
  glob: ["pattern", "path", "count", "truncated"],
  archive: ["action", "path", "count"],
};

type ResultFields = NonNullable<StoredMessage["toolResult"]>["fields"];

/** 从委派工具的围栏 JSON 中提取高层摘要字段，避免多分支大 JSON 灌爆主上下文。 */
function extractDelegationFields(name: string, content: string, fields: ResultFields) {
  const match = /```json\s*\r?\n([\s\S]*?)\r?\n```/i.exec(content);
  if (!match) return;
  try {
    const data = JSON.parse(match[1]) as Record<string, unknown>;
    if (name === "delegate_tasks") {
      if (typeof data.objective === "string") fields.objective = data.objective.slice(0, 160);
      if (typeof data.batchStatus === "string") fields.batchStatus = data.batchStatus;
      if (Array.isArray(data.results)) {
        fields.branchCount = data.results.length;
        fields.branches = data.results.slice(0, 12).map((item) => {
          const r = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
          const facts = Array.isArray(r.facts) ? r.facts.length : 0;
          const missing = Array.isArray(r.missingFactKeys) ? r.missingFactKeys.length : 0;
          return `${String(r.name ?? r.taskId ?? "分支").slice(0, 32)}(${String(r.status ?? "unknown")},facts=${facts},missing=${missing})`;
        });
      }
    } else if (name === "research") {
      if (typeof data.taskId === "string") fields.taskId = data.taskId.slice(0, 80);
      if (typeof data.status === "string") fields.status = data.status;
      if (Array.isArray(data.facts)) fields.factCount = data.facts.length;
      if (Array.isArray(data.evidence)) fields.evidenceCount = data.evidence.length;
      if (Array.isArray(data.unresolved)) fields.unresolvedCount = data.unresolved.length;
    }
  } catch {
    // 非预期格式保留基础字符数与预览，正文仍可完整回读。
  }
}

/** 长结果只做一次结构化提取，并和正文通过同一条消息提交。 */
export function describeToolResult(name: string, content: string): StoredMessage["toolResult"] {
  if (estimateTokens(content) <= INLINE_TOKENS) return;
  const fields: ResultFields = { chars: content.length };
  if (name === "delegate_tasks" || name === "research") {
    extractDelegationFields(name, content, fields);
  }
  const keys = Object.hasOwn(fieldsByTool, name) ? fieldsByTool[name] : [];
  if (keys.length && content.startsWith("{")) {
    try {
      const data = JSON.parse(content) as Record<string, unknown>;
      for (const key of keys) {
        const value = data[key];
        if (typeof value === "string") fields[key] = value.slice(0, 256);
        else if (typeof value === "number" || typeof value === "boolean" || value === null) fields[key] = value;
        else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
          fields[key] = value.slice(0, 20).map((item) => item.slice(0, 80));
        }
      }
    } catch {
      // 非 JSON 的正文照常保留，调用方可分页回读。
    }
  }
  // 没有提取到领域字段时附带一段单行预览，避免模型只看到裸 ID 盲翻。
  if (Object.keys(fields).length === 1) {
    const preview = content.replace(/\s+/g, " ").trim().slice(0, 120);
    if (preview) fields.preview = preview;
  }
  return { name, fields };
}

/**
 * 以消息 ID 回读当前会话（或同项目已开启共享的历史会话）的有效工具结果。摘要覆盖的原消息仍能读取。
 * 传入 query 时在原文中按关键词定位命中片段（不区分大小写），避免在大结果里盲翻偏移。
 */
export function readToolResult(
  userId: string,
  sessionId: string,
  resultId: string,
  offset: number,
  limit: number,
  query?: string,
  targetSessionId?: string,
) {
  const readableSessionId = resolveReadableSession(userId, sessionId, targetSessionId);
  if (!readableSessionId) return null;
  const row = db().prepare(`SELECT m.data FROM messages m JOIN sessions s ON s.id = m.session_id
    WHERE m.id = ? AND s.id = ? AND s.user_id = ? AND m.role = 'tool' AND m.superseded_by IS NULL`)
    .get(resultId, readableSessionId, userId);
  if (!row) return null;
  const message = JSON.parse(String(row.data)) as StoredMessage;
  const chars = Array.from(message.content);
  const trimmedQuery = query?.trim();
  if (trimmedQuery) {
    const needle = trimmedQuery.toLowerCase();
    const lines = message.content.split(/\r?\n/);
    const hits: { line: number; offset: number; text: string }[] = [];
    let pos = 0;
    let totalMatches = 0;
    let budget = limit;
    let nextOffset: number | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineLen = Array.from(line).length;
      if (pos + lineLen > offset && line.toLowerCase().includes(needle)) {
        totalMatches++;
        const snippet = line.length > 360 ? line.slice(0, 360) + "…" : line;
        if (budget > 0) {
          hits.push({ line: i + 1, offset: pos, text: snippet.slice(0, budget) });
          budget = Math.max(0, budget - snippet.length - 1);
        } else if (nextOffset === null) {
          nextOffset = pos;
        }
      }
      pos += lineLen + 1;
    }
    return {
      resultId, status: toolStatus(message), tool: message.toolResult?.name,
      fields: message.toolResult?.fields ?? {}, query: trimmedQuery,
      matches: hits, totalMatches,
      content: hits.map((hit) => `L${hit.line}@${hit.offset}: ${hit.text}`).join("\n"),
      totalChars: chars.length, nextOffset,
    };
  }
  const content = chars.slice(offset, offset + limit).join("");
  const end = Math.min(offset + limit, chars.length);
  return {
    resultId, status: toolStatus(message), tool: message.toolResult?.name,
    fields: message.toolResult?.fields ?? {}, content,
    totalChars: chars.length, nextOffset: end < chars.length ? end : null,
  };
}
