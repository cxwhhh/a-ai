import "server-only";
import type { Usage } from "../llm/types";
import { db } from "./db";

/**
 * 用量日志（usage_log 表）：每次调用模型就记一行。
 * 统计页（/api/usage）的 token 数以这张表为准：
 *   - 对话里的每一步、上下文压缩、记忆整理都算进去（以前只算对话的步骤，后两种漏掉了）
 *   - 删掉对话不影响统计
 */
export type UsageKind = "chat" | "compact" | "reflect" | "learn";

export interface UsageRow {
  kind: UsageKind;
  sessionId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  reasoningTokens: number;
  estimated: boolean;
  createdAt: number;
}

/** at：这次调用开始的时间（和消息的 createdAt 一致，统计时靠它区分新旧数据） */
export function logUsage(userId: string, sessionId: string | null, kind: UsageKind, u: Usage | undefined, at = Date.now()) {
  if (!u) return;
  try {
    db()
      .prepare(
        `INSERT INTO usage_log (user_id, session_id, kind, input_tokens, output_tokens, cache_tokens, reasoning_tokens, estimated, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(userId, sessionId, kind, u.inputTokens, u.outputTokens, u.cacheHitTokens ?? 0, u.reasoningTokens ?? 0, u.estimated ? 1 : 0, at);
  } catch (e) {
    // 记账失败不能影响对话本身
    console.warn("[usage] 写入失败：", e instanceof Error ? e.message : e);
  }
}

export function usageRows(userId: string): UsageRow[] {
  const rows = db()
    .prepare(
      `SELECT kind, session_id, input_tokens, output_tokens, cache_tokens, reasoning_tokens, estimated, created_at
       FROM usage_log WHERE user_id = ? ORDER BY created_at`,
    )
    .all(userId) as Record<string, number | string | null>[];
  return rows.map((r) => ({
    kind: r.kind as UsageKind,
    sessionId: (r.session_id as string | null) ?? null,
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cacheTokens: Number(r.cache_tokens),
    reasoningTokens: Number(r.reasoning_tokens),
    estimated: Number(r.estimated) === 1,
    createdAt: Number(r.created_at),
  }));
}
