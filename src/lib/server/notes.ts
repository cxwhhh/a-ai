import "server-only";

/**
 * 运行中的“补充想法”：agent 正在工作时，用户在输入框里又想到什么，可以随时发过来。
 *
 * /api/chat 开始运行时 openRun 登记，结束时 closeRun；
 * 运行期间 /api/chat/note 把文字放进这个会话的队列（addNote），
 * agent 循环每次调用模型前取走（takeNotes），作为一条用户消息加进历史 —— 模型下一步就能看到。
 *
 * 只放在内存里：补充想法只在“这一次运行”里有意义，运行结束就没用了，不用进数据库。
 * 挂在 globalThis 上：开发模式热更新时不会丢。
 */
/** 补充想法发给模型时的开头，模型和 mock 都靠它认出“这是用户中途补充的” */
export const NOTE_TAG = "【用户补充】";

interface Run {
  userId: string;
  notes: string[];
}
const g = globalThis as unknown as { __aRuns?: Map<string, Run> };
const runs = (g.__aRuns ??= new Map());

export function openRun(sessionId: string, userId: string) {
  runs.set(sessionId, { userId, notes: [] });
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

export function closeRun(sessionId: string) {
  runs.delete(sessionId);
}

/** 返回 false = 这个会话现在没有在运行（或不是你的），前端改成正常发送 */
export function addNote(sessionId: string, userId: string, text: string): boolean {
  const r = runs.get(sessionId);
  if (!r || r.userId !== userId) return false;
  r.notes.push(text.slice(0, 4000));
  return true;
}

export function takeNotes(sessionId: string): string[] {
  const r = runs.get(sessionId);
  if (!r?.notes.length) return [];
  return r.notes.splice(0);
}
