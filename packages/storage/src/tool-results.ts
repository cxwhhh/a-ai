import { toolStatus, type StoredMessage } from "../../protocol/src/lib/shared";
import { estimateTokens } from "../../protocol/src/lib/tokens";
import { db } from "./db";

const INLINE_TOKENS = 1_200;
export const TOOL_RESULT_PAGE_CHARS = 2_000;
const fieldsByTool: Record<string, readonly string[]> = {
  calculator: ["expression", "result", "value", "unit"],
  query_data: ["columns", "rowCount", "truncated"],
  run_python: ["exitCode", "timedOut"],
  run_command: ["exitCode", "timedOut", "truncated"],
  web_fetch: ["title", "url", "status", "truncated"],
  read_file: ["path", "startLine", "endLine", "totalLines", "nextOffset"],
};

/** 长结果只做一次结构化提取，并和正文通过同一条消息提交。 */
export function describeToolResult(name: string, content: string): StoredMessage["toolResult"] {
  if (estimateTokens(content) <= INLINE_TOKENS) return;
  const fields: NonNullable<StoredMessage["toolResult"]>["fields"] = { chars: content.length };
  const keys = Object.hasOwn(fieldsByTool, name) ? fieldsByTool[name] : [];
  if (!keys.length || !content.startsWith("{")) return { name, fields };
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
  return { name, fields };
}

/** 以消息 ID 回读当前会话的有效工具结果。摘要覆盖的原消息仍能读取。 */
export function readToolResult(userId: string, sessionId: string, resultId: string, offset: number, limit: number) {
  const row = db().prepare(`SELECT m.data FROM messages m JOIN sessions s ON s.id = m.session_id
    WHERE m.id = ? AND s.id = ? AND s.user_id = ? AND m.role = 'tool' AND m.superseded_by IS NULL`)
    .get(resultId, sessionId, userId);
  if (!row) return null;
  const message = JSON.parse(String(row.data)) as StoredMessage;
  const chars = Array.from(message.content);
  const content = chars.slice(offset, offset + limit).join("");
  const end = Math.min(offset + limit, chars.length);
  return {
    resultId, status: toolStatus(message), tool: message.toolResult?.name,
    fields: message.toolResult?.fields ?? {}, content,
    totalChars: chars.length, nextOffset: end < chars.length ? end : null,
  };
}
