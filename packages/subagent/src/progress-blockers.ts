export type TaskStatus = "queued" | "running" | "completed" | "partial" | "blocked" | "failed" | "timed-out" | "cancelled" | "interrupted";
export type TerminalTaskStatus = Exclude<TaskStatus, "queued" | "running">;
export type BlockerCode = "budget" | "timeout" | "idle-timeout" | "repeated-output" | "tool-loop" | "cancelled" | "interrupted" | "truncated" | "model" | "tool" | "acceptance" | "queue" | "dependency";
export type ProgressKind = "text" | "reasoning" | "tool-call" | "tool-output" | "tool-result";
type LoopCode = "repeated-output" | "tool-loop";

class TaskLoopStop extends Error {
  constructor(readonly code: LoopCode, detail: string) { super(detail); }
}

export interface Blocker {
  code: BlockerCode;
  detail: string;
}

export interface TaskProgress {
  steps: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
  blockers: Blocker[];
  lastOutputAt?: number;
  lastProgressAt?: number;
  lastProgressKind?: ProgressKind;
}

export const emptyProgress = (): TaskProgress => ({
  steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, estimated: false, blockers: [],
});

const CANCELLATION_GRACE_MS = 1_000;

/** 给驱动留出正常关闭的时间。若驱动没有归还执行权，调用方仍能按已有快照结算。 */
export async function waitForCleanup<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  let expire!: () => void;
  const deadline = new Promise<undefined>((resolve) => { expire = () => resolve(undefined); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => { timer = setTimeout(expire, CANCELLATION_GRACE_MS); };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try { return await Promise.race([work, deadline]); }
  finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/** 有效事件只更新单调时钟。计时器到期才重算剩余时间，避免每个流片段都重建计时器。 */
export class TaskWatchdog {
  private activityAt = performance.now();
  private timer?: ReturnType<typeof setTimeout>;
  private waits = 0;
  private closed = false;

  constructor(private readonly idleMs: number, private readonly stop: AbortController) {
    this.arm(idleMs);
  }

  progress() { this.activityAt = performance.now(); }
  /** 用户审批属于等待状态。审批返回后再从该时点计算无进展时限。 */
  pause() {
    this.waits++;
    clearTimeout(this.timer);
    return () => {
      if (--this.waits > 0 || this.closed || this.stop.signal.aborted) return;
      this.progress();
      this.arm(this.idleMs);
    };
  }
  close() { this.closed = true; clearTimeout(this.timer); }
  stopLoop(code: LoopCode, detail: string) { this.stop.abort(new TaskLoopStop(code, detail)); }

  private arm(delay: number) {
    this.timer = setTimeout(() => {
      if (this.stop.signal.aborted) return;
      const remaining = this.idleMs - (performance.now() - this.activityAt);
      if (remaining > 0) this.arm(Math.ceil(remaining));
      else this.stop.abort(new DOMException(`连续 ${this.idleMs / 1000} 秒无有效进展，已停止子任务`, "IdleTimeoutError"));
    }, delay);
    this.timer.unref();
  }
}

/** 区分持续无进展、任务到期和主动取消。已获得的证据和片段继续随终态保存。 */
export function stopReason(signal: AbortSignal, hasPartial: boolean): { status: TerminalTaskStatus; blocker: Blocker } {
  const reason = signal.reason;
  if (reason instanceof TaskLoopStop) {
    return { status: hasPartial ? "partial" : "blocked", blocker: { code: reason.code, detail: reason.message } };
  }
  if (reason instanceof Error && reason.name === "IdleTimeoutError") {
    return { status: "timed-out", blocker: { code: "idle-timeout", detail: reason.message } };
  }
  if (reason instanceof Error && reason.name === "TimeoutError") {
    return { status: "timed-out", blocker: { code: "timeout", detail: reason.message } };
  }
  return { status: "cancelled", blocker: { code: "cancelled", detail: "子任务已停止" } };
}
