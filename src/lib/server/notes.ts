import "server-only";
import { randomUUID } from "node:crypto";

/**
 * 这里只登记当前进程中的运行状态；可编辑队列与投递状态保存在 message-queue.ts 的 SQLite 表中。
 * 关闭运行不会删除队列。执行器在下一个请求边界读取 ready 草稿，而不是中途改写已发出的请求。
 */
/** 补充想法发给模型时的开头，模型和 mock 都靠它认出“这是用户中途补充的” */
export const NOTE_TAG = "【用户补充】";

interface Run {
  id: string;
  userId: string;
}
const g = globalThis as unknown as { __aRuns?: Map<string, Run> };
const runs = (g.__aRuns ??= new Map());

export function openRun(sessionId: string, userId: string) {
  // 同步检查并占用：两个请求都等到“空闲”后，也只能有一个真正启动执行。
  if (runs.has(sessionId)) return false;
  const id = randomUUID();
  runs.set(sessionId, { id, userId });
  return id;
}

/** 这个会话现在有没有正在运行的 agent */
export const isRunning = (sessionId: string) => runs.has(sessionId);

/**
 * 等上一次运行结束（最多 waitMs）。点“停止”后马上重发时，上一次运行还在收尾（补结果、写数据库），稍等一下就好。
 * 返回 false = 等不到，说明真的有另一个运行在进行（例如两个浏览器标签同时在发）。
 */
export async function waitIdle(sessionId: string, waitMs = 5000): Promise<boolean> {
  const end = Date.now() + waitMs;
  while (runs.has(sessionId)) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

export function closeRun(sessionId: string, lease?: string) {
  // 旧请求的 finally 可能晚于新运行，带上占用凭证，不能误删新运行的登记。
  if (lease && runs.get(sessionId)?.id !== lease) return;
  runs.delete(sessionId);
}

/** 兼容已有调用方：补充内容先持久排队，再由用户明确选择插队。 */
export { readyNotes as takeNotes } from "./message-queue";
