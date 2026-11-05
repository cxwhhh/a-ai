import "server-only";

/**
 * 工具执行前的“用户确认”（人在回路，human-in-the-loop）。
 *
 * 难点：SSE 只能服务端 → 浏览器单向推送。用户点“允许”必须另发一个请求（POST /api/approve），
 * 而 agent 循环要停在原地等它。做法是把一个还没 resolve 的 Promise 的 resolve 函数存进 Map：
 *
 *   run_command → ctx.confirm → waitApproval() 返回一个 Promise，agent 循环 await 它（停住）
 *   浏览器收到 approval 事件 → 显示确认卡片 → 用户点按钮 → POST /api/approve
 *   → answerApproval() 从 Map 里取出 resolve 调用 → Promise 完成 → agent 循环继续
 *
 * key 带用户 id：别人知道了 callId 也不能替你点“允许”。
 * 存在内存里，只适合单进程部署（现在就是）；多实例时要换成 Redis 发布/订阅之类。
 */
export type ApprovalDecision = "allow" | "allow_session" | "deny";

const WAIT_MS = 5 * 60_000;
const waiting = new Map<string, (d: ApprovalDecision) => void>();
/** 用户点过“本会话都允许”的会话 */
const allowedSessions = new Set<string>();

/** 等用户决定。5 分钟没人处理、或用户点了停止，都算拒绝 */
export function waitApproval(userId: string, callId: string, signal?: AbortSignal): Promise<ApprovalDecision> {
  const key = `${userId}:${callId}`;
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve("deny");
    const done = (d: ApprovalDecision) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      waiting.delete(key);
      resolve(d);
    };
    const onAbort = () => done("deny");
    const timer = setTimeout(() => done("deny"), WAIT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    waiting.set(key, done);
  });
}

/** 用户点了按钮。返回 false = 这个确认已经超时、已处理过，或者不是这个用户的 */
export function answerApproval(userId: string, callId: string, d: ApprovalDecision) {
  const done = waiting.get(`${userId}:${callId}`);
  done?.(d);
  return !!done;
}

export const allowSession = (sessionId: string) => void allowedSessions.add(sessionId);
export const isSessionAllowed = (sessionId: string) => allowedSessions.has(sessionId);
