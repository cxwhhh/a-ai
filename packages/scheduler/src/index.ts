import type { Agent, AgentRun } from "../../agent-core/agent/src/runtime-types";
import type { AgentEvent } from "../../protocol/src/lib/shared";

const MAX_EVENTS = 20_000;
const MAX_HISTORY = 64;
const encoder = new TextEncoder();

/** 一个运行拥有一个取消信号。订阅关闭只撤销监听，执行权一直保留到最后收尾。 */
export class ScheduledRun {
  readonly subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  readonly frames: { id: number; data: Uint8Array }[] = [];
  private sequence = 0;
  private closed = false;

  constructor(readonly owner: string, readonly sessionId: string, readonly lease: AgentRun, readonly cancellation: AbortController) {}

  get id() { return this.lease.id; }
  get done() { return this.closed; }

  emit(event: AgentEvent) {
    const id = ++this.sequence;
    const data = encoder.encode(`data: ${JSON.stringify(event)}\nid: ${id}\n\n`);
    this.frames.push({ id, data });
    if (this.frames.length > MAX_EVENTS) this.frames.splice(0, MAX_EVENTS / 4);
    for (const subscriber of this.subscribers) {
      // 订阅消费太慢时重连可从游标补读，执行循环不等网络写入。
      if ((subscriber.desiredSize ?? 0) < -MAX_EVENTS) {
        this.subscribers.delete(subscriber);
        subscriber.error(new Error("订阅消费滞后"));
      } else subscriber.enqueue(data);
    }
  }

  subscribe(after: number): Response {
    if (after > this.sequence || (this.frames[0] && after < this.frames[0].id - 1)) {
      return Response.json({ error: "事件游标超出可回放范围，请重新读取会话" }, { status: 409 });
    }
    let listener: ReadableStreamDefaultController<Uint8Array>;
    return new Response(new ReadableStream<Uint8Array>({
      start: (controller) => {
        listener = controller;
        // 回放和注册发生在同一轮同步代码内，期间没有事件可以插进两步之间。
        for (const frame of this.frames) if (frame.id > after) controller.enqueue(frame.data);
        if (this.closed) controller.close();
        else this.subscribers.add(controller);
      },
      cancel: () => { this.subscribers.delete(listener); }
    }), { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    for (const subscriber of this.subscribers) subscriber.close();
    this.subscribers.clear();
  }
}

/** 管理运行索引和订阅。会话是否可以获得执行权仍由 Agent 的 lease 原子决定。 */
export class Scheduler {
  private readonly runs = new Map<string, ScheduledRun>();
  private accepting = true;

  acquire(agent: Agent): ScheduledRun | null {
    if (!this.accepting) return null;
    const cancellation = new AbortController();
    const lease = agent.openRun(cancellation.signal);
    if (!lease) return null;
    const run = new ScheduledRun(agent.userId, agent.id, lease, cancellation);
    this.runs.set(run.id, run);
    return run;
  }

  current(owner: string, sessionId: string) {
    for (const run of this.runs.values()) if (!run.done && run.owner === owner && run.sessionId === sessionId) return run;
  }

  get(owner: string, id: string) {
    const run = this.runs.get(id);
    return run?.owner === owner ? run : undefined;
  }

  finish(run: ScheduledRun) {
    run.finish();
    const completed = [...this.runs.values()].filter((item) => item.done);
    for (const old of completed.slice(0, Math.max(0, completed.length - MAX_HISTORY))) this.runs.delete(old.id);
  }

  stopAccepting() {
    this.accepting = false;
    for (const run of this.runs.values()) if (!run.done) run.cancellation.abort();
  }
}
