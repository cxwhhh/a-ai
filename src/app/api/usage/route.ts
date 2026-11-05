import { allSessions } from "@/lib/server/store";
import { currentUser, unauthorized } from "@/lib/server/auth";
import type { UsageStats } from "@/lib/settings";
import { usageRows } from "@/lib/server/usage";
import { toolStatus } from "@/lib/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/usage：统计当前用户的用量。
 * - token 和模型调用次数：以用量日志 usage_log 为准（每次调用模型记一行，包括上下文压缩和记忆整理，删对话也不丢）
 * - 对话轮次、工具调用、耗时：遍历会话里的消息（tool 消息存了 durationMs / isError）
 * 用量日志是后来才加的：在它第一行之前的老消息，token 仍从消息上的 usage 读，两边不会重复计算。
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();
  const sessions = allSessions(user.id);
  const DAYS = 14;
  const dayKey = (t: number) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = new Map<string, { turns: number; tokens: number }>();
  for (let i = DAYS - 1; i >= 0; i--) days.set(dayKey(today.getTime() - i * 86400000), { turns: 0, tokens: 0 });

  const s: UsageStats = {
    sessions: sessions.length, cacheHitTokens: 0, turns: 0, modelCalls: 0, toolCalls: 0, toolErrors: 0, artifacts: 0,
    inputTokens: 0, outputTokens: 0, modelMs: 0, toolMs: 0, byTool: [], byDay: [], byKind: [], estimatedTokens: 0,
  };
  const kinds = new Map<UsageStats["byKind"][number]["kind"], { calls: number; tokens: number }>();
  const count = (kind: UsageStats["byKind"][number]["kind"], at: number, u: { inputTokens: number; outputTokens: number; cacheHitTokens?: number; estimated?: boolean }) => {
    const tk = u.inputTokens + u.outputTokens;
    s.modelCalls++;
    s.inputTokens += u.inputTokens;
    s.outputTokens += u.outputTokens;
    s.cacheHitTokens += u.cacheHitTokens ?? 0;
    if (u.estimated) s.estimatedTokens += tk;
    const k = kinds.get(kind) ?? { calls: 0, tokens: 0 };
    k.calls++;
    k.tokens += tk;
    kinds.set(kind, k);
    const day = days.get(dayKey(at));
    if (day) day.tokens += tk;
  };

  const rows = usageRows(user.id);
  const logStart = rows[0]?.createdAt ?? Infinity;
  for (const r of rows) count(r.kind, r.createdAt, { ...r, cacheHitTokens: r.cacheTokens });
  const tools = new Map<string, { count: number; errors: number; ms: number }>();

  for (const sess of sessions) {
    s.artifacts += sess.artifacts.length;
    const nameOf = new Map<string, string>(); // callId → 工具名
    for (const m of sess.messages) {
      const day = days.get(dayKey(m.createdAt));
      if (m.role === "user" && !m.feedback) {
        s.turns++;
        if (day) day.turns++;
      } else if (m.role === "assistant") {
        s.modelMs += m.durationMs ?? 0;
        if (m.createdAt < logStart) count("chat", m.createdAt, m.usage ?? { inputTokens: 0, outputTokens: 0 }); // 用量日志之前的老数据
        for (const c of m.toolCalls ?? []) nameOf.set(c.id, c.name);
      } else if (m.role === "tool") {
        const name = nameOf.get(m.toolCallId ?? "") ?? "unknown";
        const t = tools.get(name) ?? { count: 0, errors: 0, ms: 0 };
        t.count++;
        t.ms += m.durationMs ?? 0;
        s.toolCalls++;
        s.toolMs += m.durationMs ?? 0;
        // 和过程面板同一套状态：退出码非 0、超时、结果不确定算出错；用户拒绝、取消、跳过不算（M1-02）
        const st = toolStatus(m);
        if (st === "error" || st === "timeout" || st === "unknown") {
          t.errors++;
          s.toolErrors++;
        } else if (st !== "ok") s.toolSkipped = (s.toolSkipped ?? 0) + 1;
        tools.set(name, t);
      }
    }
  }

  s.byTool = [...tools.entries()]
    .map(([name, t]) => ({ name, count: t.count, errors: t.errors, avgMs: Math.round(t.ms / t.count) }))
    .sort((a, b) => b.count - a.count);
  s.byDay = [...days.entries()].map(([date, v]) => ({ date, ...v }));
  s.byKind = [...kinds.entries()].map(([kind, v]) => ({ kind, ...v }));
  return Response.json(s);
}
