import { db } from "../../storage/src/db";
import type { AgentLogEntry, AgentLogEvent } from "../../protocol/src/agent-events";

/** agent_events 的 CHECK 已按 kind 验证 detail 和 ID，此处只做数据库列名转换。 */
function fromRow(row: Record<string, unknown>): AgentLogEntry {
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    sessionTitle: String(row.title),
    at: Number(row.at),
    kind: row.kind,
    ...(row.run_id ? { runId: String(row.run_id) } : {}),
    ...(row.input_id ? { inputId: String(row.input_id) } : {}),
    detail: JSON.parse(String(row.detail)),
  } as AgentLogEntry;
}

/** 状态对账必须读取完整序列，不能拿界面最近 100 条日志代替；归属仍在 SQL 中校验。 */
export function readAgentEvents(userId: string, sessionId: string): AgentLogEntry[] {
  const rows = db().prepare(`SELECT e.*,s.title FROM agent_events e JOIN sessions s ON s.id=e.session_id
    WHERE s.user_id=? AND s.id=? ORDER BY e.id`).all(userId, sessionId);
  return rows.map(fromRow);
}

/**
 * 追加会话事件。调用方负责校验用户归属并绑定运行 ID，SQLite 校验事件的字段和作用域形状。
 * 会话不存在时 SELECT 不产生行。写入错误向上抛出，由调用方决定回滚或收尾。
 */
export function recordAgentLog(sessionId: string, event: AgentLogEvent) {
  const { kind, detail, runId, inputId } = event;
  db().prepare(`INSERT INTO agent_events(session_id,at,kind,run_id,input_id,detail)
    SELECT id,?,?,?,?,? FROM sessions WHERE id=?`).run(Date.now(), kind, runId ?? null, inputId ?? null, JSON.stringify(detail), sessionId);
}

/**
 * 按用户和可选会话倒序分页，每页最多 100 条。before 使用上一页最小的事件 ID，查询时排除该 ID。
 * 按输入筛选时也返回包含该引导的模型事件，方便检查引导进入了哪次请求。
 * 显式指定的会话不可访问时返回 null，可访问且没有匹配事件时返回空数组。
 */
export function readAgentLog(userId: string, sessionId?: string, before?: number, inputId?: string): AgentLogEntry[] | null {
  if (sessionId && !db().prepare("SELECT 1 FROM sessions WHERE id=? AND user_id=?").get(sessionId, userId)) return null;
  const rows = db().prepare(`SELECT e.*,s.title FROM agent_events e JOIN sessions s ON s.id=e.session_id
    WHERE s.user_id=? AND e.id < ? ${sessionId ? "AND s.id=?" : ""}
    ${inputId ? "AND (e.input_id=? OR instr(',' || json_extract(e.detail, '$.guidanceIds') || ',', ',' || ? || ',') > 0)" : ""}
    ORDER BY e.id DESC LIMIT 100`)
    .all(userId, before ?? Number.MAX_SAFE_INTEGER, ...(sessionId ? [sessionId] : []), ...(inputId ? [inputId, inputId] : []));
  return rows.map(fromRow);
}
