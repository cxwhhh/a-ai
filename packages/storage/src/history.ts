import { toolStatus, type StoredMessage } from "../../protocol/src/lib/shared";
import type { ToolCall } from "../../llm/src/types";
import { db } from "./db";
import { historyCallDetails, historyTerms } from "./history-index";

/** 以用户问题为单位检索当前会话。beforeInput 限定自动召回只碰摘要覆盖的旧段落。 */
export function searchHistory(userId: string, sessionId: string, query: string, limit: number, beforeInput?: string) {
  const terms = historyTerms(query.slice(0, 1600)).slice(0, 80);
  if (!terms.length) return [];
  const rows = db().prepare(`SELECT h.input_id,h.topic,h.summary,h.entities,h.tool_calls,
      SUM(t.weight) AS score
    FROM history_segment_terms t
    JOIN history_segments h ON h.input_id=t.input_id
    JOIN sessions s ON s.id=h.session_id
    WHERE t.term IN (SELECT value FROM json_each(?)) AND s.user_id=? AND s.id=?
      AND (? IS NULL OR h.end_seq < (
        SELECT start_seq FROM history_segments WHERE session_id=s.id AND input_id=?
      ))
    GROUP BY h.input_id ORDER BY score DESC, COUNT(*) DESC, h.start_seq DESC LIMIT ?`)
    .all(JSON.stringify(terms), userId, sessionId, beforeInput ?? null, beforeInput ?? null, limit);
  return rows.map((row) => ({
    segmentId: String(row.input_id),
    topic: String(row.topic),
    summary: String(row.summary),
    entities: JSON.parse(String(row.entities)) as string[],
    toolCalls: Number(row.tool_calls),
  }));
}

type SavedResult = Pick<StoredMessage, "id" | "content" | "status" | "isError" | "durationMs" | "toolResult" | "artifactId">;

/** 获取指定段落的调用清单。每组以 assistant 消息界定范围，同一个调用 ID 在不同模型步骤重复也不会串结果。 */
export function readHistoryExecution(userId: string, sessionId: string, segmentId: string, offset: number, limit: number) {
  const d = db();
  const segment = d.prepare(`SELECT h.* FROM history_segments h
    JOIN sessions s ON s.id=h.session_id WHERE s.user_id=? AND s.id=? AND h.input_id=?`).get(userId, sessionId, segmentId);
  if (!segment) return null;
  // 先分页选调用声明，再按相邻工具结果定位正文指针。仅旧记录缺少状态时，把原文交给统一的状态推断。
  const rows = d.prepare(`WITH page AS (
    SELECT m.id AS assistant_id,m.seq AS assistant_seq,c.key AS call_order,c.value AS call
    FROM messages m JOIN json_each(m.data,'$.toolCalls') c
    WHERE m.session_id=? AND m.seq BETWEEN ? AND ? AND m.superseded_by IS NULL AND m.role='assistant'
    ORDER BY m.seq,c.key LIMIT ? OFFSET ?
  )
  SELECT p.*,r.seq AS result_seq,CASE WHEN r.id IS NOT NULL THEN
    json_object('id',r.id,'content',CASE WHEN r.data->>'status' IS NULL AND NOT COALESCE(r.data->>'isError',0)
      THEN r.data->>'content' ELSE '' END,'status',r.data->>'status',
      'isError',r.data->>'isError','durationMs',r.data->>'durationMs','artifactId',r.data->>'artifactId',
      'totalChars',length(r.data->>'content'),
      'toolResult',json_extract(r.data,'$.toolResult')) END AS result
  FROM page p LEFT JOIN messages r ON r.id=(
    SELECT m.id FROM messages m
    WHERE m.session_id=? AND m.superseded_by IS NULL AND m.seq>p.assistant_seq AND m.seq<=?
      AND m.seq<COALESCE((
        SELECT MIN(n.seq) FROM messages n WHERE n.session_id=m.session_id AND n.superseded_by IS NULL
          AND n.seq>p.assistant_seq AND n.seq<=? AND n.role<>'tool'
      ),?)
      AND m.role='tool' AND m.data->>'toolCallId'=p.call->>'id' ORDER BY m.seq LIMIT 1
  ) ORDER BY p.assistant_seq,p.call_order`)
    .all(sessionId, segment.start_seq, segment.end_seq, limit, offset, sessionId, segment.end_seq, segment.end_seq, Number(segment.end_seq) + 1);
  const calls = rows.map((row, index) => {
    const call = JSON.parse(String(row.call)) as ToolCall;
    const result = row.result ? JSON.parse(String(row.result)) as SavedResult & { totalChars: number } : null;
    return {
      index: offset + index + 1,
      assistantId: String(row.assistant_id),
      assistantSeq: Number(row.assistant_seq),
      callId: call.id,
      tool: call.name,
      ...historyCallDetails(call.arguments),
      status: result ? toolStatus(result) : "unknown",
      resultId: result?.id ?? null,
      resultSeq: row.result_seq ?? null,
      durationMs: result?.durationMs ?? null,
      artifactId: result?.artifactId ?? null,
      totalChars: result?.totalChars ?? null,
      ...(result?.toolResult ? { resultFields: result.toolResult.fields } : {}),
    };
  });
  const totalCalls = Number(segment.tool_calls);
  const end = offset + calls.length;
  return {
    segmentId, topic: String(segment.topic), summary: String(segment.summary),
    totalCalls, calls, nextOffset: calls.length && end < totalCalls ? end : null,
  };
}
