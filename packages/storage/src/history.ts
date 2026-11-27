import { toolStatus, type StoredMessage } from "../../protocol/src/lib/shared";
import type { ToolCall } from "../../llm/src/types";
import { db } from "./db";
import { historyCallDetails, historyTerms } from "./history-index";

export type HistoryScope = "session" | "project";

const SINGLE_CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u;

/** 核对跨会话回查权限：仅当源会话与目标会话同属当前用户同一个未归档且开启 share 的项目时放行。 */
export function resolveReadableSession(userId: string, sessionId: string, targetSessionId?: string): string | null {
  const target = targetSessionId?.trim() || sessionId;
  if (target === sessionId) return sessionId;
  const row = db().prepare(`SELECT t.id FROM sessions cur
    JOIN projects p ON p.id = cur.project_id AND p.user_id = cur.user_id
    JOIN sessions t ON t.project_id = p.id AND t.user_id = cur.user_id
    WHERE cur.id = ? AND cur.user_id = ? AND t.id = ?
      AND cur.archived_at IS NULL AND t.archived_at IS NULL AND p.archived_at IS NULL
      AND json_extract(p.data, '$.share') = 1`).get(sessionId, userId, target);
  return row ? String(row.id) : null;
}

/**
 * 以用户问题为单位检索历史段落。
 * - scope="session"（默认）：仅检索当前会话；beforeInput 限定自动召回只碰摘要覆盖的旧段落。
 * - scope="project"：仅当当前会话属于未归档且开启 share 的项目时，检索同项目下全部未归档会话。
 * - 同时支持单字中文回退匹配（无需重建已有索引）与长度归一化相关性排序。
 */
export function searchHistory(
  userId: string,
  sessionId: string,
  query: string,
  limit: number,
  beforeInput?: string,
  scope: HistoryScope = "session",
) {
  const terms = historyTerms(query.slice(0, 1600)).slice(0, 80);
  if (!terms.length) return [];
  const singleCjk = terms.filter((term) => SINGLE_CJK.test(term)).slice(0, 8);
  const termsJson = JSON.stringify(terms);
  const singleJson = JSON.stringify(singleCjk);
  const termMatch = singleCjk.length
    ? `(t.term IN (SELECT value FROM json_each(?)) OR EXISTS (SELECT 1 FROM json_each(?) sc WHERE instr(t.term, sc.value) > 0))`
    : `t.term IN (SELECT value FROM json_each(?))`;
  const termScore = singleCjk.length
    ? `SUM(CASE WHEN t.term IN (SELECT value FROM json_each(?)) THEN t.weight ELSE 2 END)`
    : `SUM(t.weight)`;
  const rankExpr = `(${termScore} * (1.0 + 0.25 * COUNT(DISTINCT t.term))) / (1.0 + 0.04 * h.tool_calls)`;

  if (scope === "project") {
    const proj = db().prepare(`SELECT p.id FROM sessions s
      JOIN projects p ON p.id = s.project_id AND p.user_id = s.user_id
      WHERE s.id = ? AND s.user_id = ? AND s.archived_at IS NULL AND p.archived_at IS NULL
        AND json_extract(p.data, '$.share') = 1`).get(sessionId, userId);
    if (!proj) return [];
    const params = singleCjk.length
      ? [termsJson, termsJson, singleJson, userId, String(proj.id), sessionId, beforeInput ?? null, sessionId, beforeInput ?? null, limit]
      : [termsJson, userId, String(proj.id), sessionId, beforeInput ?? null, sessionId, beforeInput ?? null, limit];
    const rows = db().prepare(`SELECT h.input_id,h.session_id,s.title AS session_title,h.topic,h.summary,h.entities,h.tool_calls,
        ${rankExpr} AS rank_score
      FROM history_segment_terms t
      JOIN history_segments h ON h.input_id=t.input_id
      JOIN sessions s ON s.id=h.session_id
      WHERE ${termMatch} AND s.user_id=? AND s.project_id=? AND s.archived_at IS NULL
        AND (s.id<>? OR ? IS NULL OR h.end_seq < (
          SELECT start_seq FROM history_segments WHERE session_id=? AND input_id=?
        ))
      GROUP BY h.input_id ORDER BY rank_score DESC, h.start_seq DESC LIMIT ?`)
      .all(...params);
    return rows.map((row) => ({
      segmentId: String(row.input_id),
      sessionId: String(row.session_id),
      sessionTitle: String(row.session_title),
      topic: String(row.topic),
      summary: String(row.summary),
      entities: JSON.parse(String(row.entities)) as string[],
      toolCalls: Number(row.tool_calls),
    }));
  }

  const params = singleCjk.length
    ? [termsJson, termsJson, singleJson, userId, sessionId, beforeInput ?? null, beforeInput ?? null, limit]
    : [termsJson, userId, sessionId, beforeInput ?? null, beforeInput ?? null, limit];
  const rows = db().prepare(`SELECT h.input_id,h.topic,h.summary,h.entities,h.tool_calls,
      ${rankExpr} AS rank_score
    FROM history_segment_terms t
    JOIN history_segments h ON h.input_id=t.input_id
    JOIN sessions s ON s.id=h.session_id
    WHERE ${termMatch} AND s.user_id=? AND s.id=?
      AND (? IS NULL OR h.end_seq < (
        SELECT start_seq FROM history_segments WHERE session_id=s.id AND input_id=?
      ))
    GROUP BY h.input_id ORDER BY rank_score DESC, h.start_seq DESC LIMIT ?`)
    .all(...params);
  return rows.map((row) => ({
    segmentId: String(row.input_id),
    topic: String(row.topic),
    summary: String(row.summary),
    entities: JSON.parse(String(row.entities)) as string[],
    toolCalls: Number(row.tool_calls),
  }));
}

type SavedResult = Pick<StoredMessage, "id" | "content" | "status" | "isError" | "durationMs" | "toolResult" | "artifactId">;

/** 获取指定段落的调用清单。允许在同项目开启 share 时按 targetSessionId 只读回查同项目历史段落。 */
export function readHistoryExecution(
  userId: string,
  sessionId: string,
  segmentId: string,
  offset: number,
  limit: number,
  targetSessionId?: string,
) {
  const readableSessionId = resolveReadableSession(userId, sessionId, targetSessionId);
  if (!readableSessionId) return null;
  const d = db();
  const segment = d.prepare(`SELECT h.* FROM history_segments h
    JOIN sessions s ON s.id=h.session_id WHERE s.user_id=? AND s.id=? AND h.input_id=?`).get(userId, readableSessionId, segmentId);
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
    .all(readableSessionId, segment.start_seq, segment.end_seq, limit, offset, readableSessionId, segment.end_seq, segment.end_seq, Number(segment.end_seq) + 1);
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
    segmentId,
    ...(readableSessionId !== sessionId ? { sessionId: readableSessionId } : {}),
    topic: String(segment.topic),
    summary: String(segment.summary),
    totalCalls,
    calls,
    nextOffset: calls.length && end < totalCalls ? end : null,
  };
}
