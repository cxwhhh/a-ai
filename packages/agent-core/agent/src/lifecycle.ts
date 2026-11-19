import type { AgentTurnOutcome } from "../../../protocol/src/agent-events";
import type { AgentSession } from "../../../session/src/agent-session";
import type { AgentInbox, QueueListener } from "../../inbox/src/index";
import type { Agent, AgentRun } from "./runtime-types";
import type { AgentRuntime } from "./scope";

/** settled 由执行方调用 finish 后兑现，实例释放时等待它交还执行权。 */
type ActiveRun = {
  id: string;
  signal: AbortSignal;
  settled: Promise<void>;
  notify?: QueueListener;
};

/** 一个实例同一时间只有一份运行占用。队列操作先通过占用校验，再交给 Inbox。 */
export function createAgentLifecycle(sessionId: string, userId: string, inbox: AgentInbox, runtime: AgentRuntime, sessionPort: AgentSession) {
  const lifetime = new AbortController();
  let active: ActiveRun | undefined;
  let disposal: Promise<void> | undefined;
  let disposed = false;

  const agent: Agent = {
    id: sessionId,
    userId,
    runtime,
    get activeRunId() {
      return active?.id ?? null;
    },
    get status() {
      if (disposed) return "disposed";
      if (lifetime.signal.aborted) return "closing";
      return active ? "running" : "idle";
    },
    queueSnapshot: inbox.snapshot,
    async waitIdle({ waitMs = 5000, signal } = {}) {
      const end = Date.now() + waitMs;
      while (active) {
        if (signal?.aborted || Date.now() >= end) return false;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return !signal?.aborted;
    },
    // 检查与占用同步完成。等待结束后仍须在这里重新判断是否有其他运行抢先取得执行权。
    openRun(requestSignal): AgentRun | null {
      if (active || requestSignal.aborted || lifetime.signal.aborted || sessionPort.isArchived()) return null;
      const signal = AbortSignal.any([requestSignal, lifetime.signal]);
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const run: ActiveRun = {
        id: crypto.randomUUID(),
        signal,
        settled
      };
      active = run;
      // 一条聊天流可能处理多轮，run.id 不变，主输入 ID 在每轮开始和结束时更新。
      let turnInputId: string | undefined;
      // 旧流回调可能迟到，只有仍持有占用的回调能写入或释放。
      const current = () => active === run;
      const endTurn = (outcome: AgentTurnOutcome) => {
        if (!current() || !turnInputId) return;
        sessionPort.record({
          kind: "turn-end",
          runId: run.id,
          inputId: turnInputId,
          detail: { outcome: signal.aborted ? "cancelled" : outcome }
        });
        turnInputId = undefined;
      };
      // 取消先恢复尚未消费的引导，执行方完成收尾后才会交还占用。
      const cancel = () => {
        if (!current()) return;
        try {
          sessionPort.record({
            kind: "stop-requested",
            runId: run.id,
            inputId: turnInputId,
            detail: { reason: lifetime.signal.aborted ? "实例释放" : "调用方停止或连接断开" }
          });
          if (inbox.parkSteering(run.id)) inbox.publish(run.notify);
        } catch (error) {
          console.warn("[agent-lifecycle] 停止日志写入失败", error);
        }
      };
      signal.addEventListener("abort", cancel, { once: true });

      return {
        id: run.id,
        signal,
        observeQueue(listener) {
          if (!current()) return;
          run.notify = listener;
          inbox.notify(listener);
        },
        begin(session, message, truncateFrom) {
          if (!current() || signal.aborted || session.id !== sessionId || turnInputId) {
            throw new Error("运行已结束、上一轮未收尾或会话不匹配");
          }
          sessionPort.beginTurn(session, message, run.id, truncateFrom);
          turnInputId = message.id;
        },
        hasNext: () => current() && inbox.hasNext(),
        beginNext(session, expectedId) {
          if (!current() || signal.aborted || session.id !== sessionId || turnInputId) {
            return null;
          }
          const message = inbox.claimNext(session, run.id, expectedId);
          if (message) {
            turnInputId = message.id;
            inbox.publish(run.notify);
          }
          return message;
        },
        endTurn,
        steering: {
          pending: () => current() ? inbox.pendingSteering() : [],
          committed(id) {
            if (current()) inbox.commitSteering(run.id, turnInputId ?? null, id, run.notify);
          }
        },
        parkSteering() {
          if (!current() || !inbox.parkSteering(run.id)) return false;
          inbox.publish(run.notify);
          return true;
        },
        finish() {
          if (!current()) return;
          signal.removeEventListener("abort", cancel);
          try {
            endTurn("interrupted");
            inbox.parkSteering(run.id);
          } finally {
            // 日志失败也要交还执行权，并唤醒等待实例释放的调用方。
            active = undefined;
            inbox.publish(run.notify);
            settle();
          }
        }
      };
    },
    enqueueInput(runId, message, target) {
      if (!active || active.signal.aborted || (runId !== undefined && active.id !== runId)) {
        return false;
      }
      return inbox.enqueue(active.id, message, target, active.notify);
    },
    changeQueuedInput(id, action, runId) {
      if (lifetime.signal.aborted || sessionPort.isArchived()) return false;
      if (action === "steer" && (!runId || active?.id !== runId || active.signal.aborted)) {
        return false;
      }
      return inbox.change(id, action, active?.id, active?.notify);
    }
  };

  return {
    agent,
    dispose() {
      if (disposal) return disposal;
      // 关闭输入并等待当前执行方收尾，最后清空队列并通知订阅方。
      const run = active;
      disposal = (async () => {
        await run?.settled;
        inbox.clear(run?.id);
        disposed = true;
        inbox.publish(run?.notify);
      })();
      lifetime.abort();
      return disposal;
    }
  };
}
