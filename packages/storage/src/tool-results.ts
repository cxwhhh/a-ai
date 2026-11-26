import { toolStatus, type StoredMessage } from "../../protocol/src/lib/shared";
import { estimateTokens } from "../../protocol/src/lib/tokens";
import { db } from "./db";

const INLINE_TOKENS = 1_200;
const DELEGATION_PREVIEW_TOKENS = 900;
export const TOOL_RESULT_PAGE_CHARS = 2_000;
export const delegationResultTools = new Set(["research", "delegate_tasks", "recover_subagent_tasks"]);
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
  if (delegationResultTools.has(name)) return { name, fields, preview: delegationPreview(content) };
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

type DelegationRow = { taskId?: string; name?: string; status?: string; canRecover?: boolean; summary?: string;
  writtenPaths?: string[]; missingFactKeys?: string[]; facts?: { key: string; value: string }[];
  verification?: { command: string; exitCode: number | null; timedOut: boolean }[];
  acceptance?: { met: boolean }[]; blockers?: { detail: string }[]; unresolved?: string[]; dialogue?: { unanswered: number } };

/** 主模型需要状态、事实值和缺项来继续。原文、验收细节和证据元数据留给分页回读。 */
function delegationPreview(content: string) {
  const fence = /\n```json\n([\s\S]*?)\n```/.exec(content);
  if (!fence) return content.slice(0, 400);
  try {
    const batch = JSON.parse(fence[1]) as DelegationRow & { batchStatus?: string; results?: DelegationRow[] };
    const rows = batch.results ?? [batch];
    const text = (value: string | undefined, max: number) => (value ?? "").replace(/\s+/g, " ").slice(0, max);
    const statuses = rows.map((row) => `${text(row.name, 24) || "子任务"} ${row.status ?? "unknown"} ${row.taskId ?? ""}${row.canRecover ? " 可恢复" : ""}`);
    const details = rows.map((row) => {
      const facts = row.facts?.map((fact) => `${text(fact.key, 100)}=${text(fact.value, 90)}`) ?? [];
      const files = row.writtenPaths?.slice(0, 6).map((file) => `文件 ${text(file, 140)}`) ?? [];
      const verification = row.verification?.at(-1);
      const checked = verification ? `验证 ${text(verification.command, 100)} · ${verification.timedOut ? "超时" : `退出码 ${verification.exitCode ?? "未知"}`}` : "";
      const gaps = row.missingFactKeys?.length ? [`缺 ${row.missingFactKeys.map((key) => text(key, 70)).join("、")}`] : [];
      const blocker = text(row.blockers?.[0]?.detail ?? row.unresolved?.[0], 115);
      const summary = facts.length ? "" : text(row.summary, 140);
      const pending = row.dialogue?.unanswered ? `${row.dialogue.unanswered} 条补充待回复` : "";
      return [...files, checked, ...facts, ...gaps, blocker, summary, pending].filter(Boolean);
    });
    const lines = [`分工 ${batch.batchStatus ?? (rows.length === 1 ? rows[0].status : "") ?? ""}，共 ${rows.length} 项。`];
    const append = (line: string) => {
      if (estimateTokens([...lines, line].join("\n")) > DELEGATION_PREVIEW_TOKENS) return false;
      lines.push(line);
      return true;
    };
    // 先让各分支都获得状态和回读标识，剩余预算按轮补入事实、文件与缺口。
    let omitted = false;
    const visible = new Set<number>();
    statuses.forEach((line, index) => {
      const kept = append(line);
      if (kept) visible.add(index);
      omitted ||= !kept;
    });
    for (let index = 0; index < Math.max(0, ...details.map((items) => items.length)); index++) {
      details.forEach((items, row) => {
        if (items[index] && (!visible.has(row) || !append(`${text(rows[row].name, 24) || rows[row].taskId} · ${items[index]}`))) omitted = true;
      });
    }
    if (omitted) lines.push("其余分支或详情请分页回读。");
    return lines.join("\n");
  } catch { return content.slice(0, 400); }
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
