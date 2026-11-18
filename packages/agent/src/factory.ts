import type { AgentQueueSnapshot } from "../../protocol/src/lib/shared";
import type { AgentTurnOutcome } from "../../protocol/src/agent-events";
import { beginTurn, newId } from "../../storage/src/store";
import { isSessionArchived } from "../../session/src/archive-admission";
import { recordAgentLog } from "../../session/src/log";
import type { Agent, AgentHandle, AgentRun } from "./runtime-types";

export const MAX_QUEUE_MESSAGE_LENGTH = 32_000;
const MAX_PENDING = 20;

/** 进程内共用的快照版本。实例释放后重新登记，版本仍从同一个时钟继续递增。 */
export type QueueClock = Pick<AgentQueueSnapshot, "epoch" | "version">;
/** 当前聊天流持有的占用。settled 由执行方调用 finish 后兑现，释放实例时等待它。 */
type ActiveRun = {
  id: string;
  signal: AbortSignal;
  settled: Promise<void>;
  notify?: (queue: AgentQueueSnapshot) => void;
};

/** 工厂负责构造实例，注册表负责发布。工厂收到的是已确认属于调用方的会话身份。 */
export type AgentFactory = (sessionId: string, userId: string, clock: QueueClock) => AgentHandle;

/** 默认工厂构造一个真正持有收件箱和运行状态的实例，运行循环由现有调用方驱动。 */
export function createAgentInstance(sessionId: string, userId: string, clock: QueueClock): AgentHandle {
  const lifetime = new AbortController();
  // 只在此实例保留待处理输入的完整正文。进程退出后，日志仍可核对曾经排过哪些输入。
  let items: AgentQueueSnapshot["items"] = [];
  let active: ActiveRun | undefined;
  let disposal: Promise<void> | undefined;
  let disposed = false;

  const snapshot = (): AgentQueueSnapshot => ({
    sessionId,
    ...clock,
    items: [...items]
  });
  const notify = (listener?: ActiveRun["notify"]) => {
    try {
      listener?.(snapshot());
    } catch (error) {
      // 一次界面通知失败不会撤销已经提交的消息，也不能阻止运行释放执行权。
      console.warn("[agent-registry] 队列通知失败", error);
    }
  };
  const publish = (listener = active?.notify) => {
    clock.version++;
    notify(listener);
  };
  /** 运行无法进入下一步时，把尚在收件箱的引导转回下一轮，保留原 ID 和顺序。 */
  const parkSteering = () => {
    const parked = items.filter((item) => item.target === "next-step");
    if (!parked.length) return false;
    items = items.map((item) => item.target === "next-step" ? {
      ...item,
      target: "next-turn"
    } : item);
    try {
      for (const item of parked) recordAgentLog(sessionId, {
        kind: "deferred",
        runId: active?.id,
        inputId: item.id,
        detail: { reason: "未进入下一步，转回下一轮" }
      });
    } catch (error) {
      console.warn("[agent-registry] 转回排队日志写入失败", error);
    }
    return true;
  };
  /** 提交成功后的内部出队入口。用户主动取消走 changeQueuedInput 并写取消事件。 */
  const drop = (id: string) => {
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) return;
    items.splice(index, 1);
    publish();
  };

  const agent: Agent = {
    id: sessionId,
    userId,
    get activeRunId() {
      return active?.id ?? null;
    },
    get status() {
      if (disposed) return "disposed";
      if (lifetime.signal.aborted) return "closing";
      return active ? "running" : "idle";
    },
    queueSnapshot: snapshot,
    async waitIdle({ waitMs = 5000, signal } = {}) {
      const end = Date.now() + waitMs;
      while (active) {
        if (signal?.aborted || Date.now() >= end) return false;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return !signal?.aborted;
    },
    // 同步检查并取得执行权。请求已取消、实例正在关闭或归档时，调用方无法取得运行句柄。
    openRun(requestSignal): AgentRun | null {
      if (active || requestSignal.aborted || lifetime.signal.aborted || isSessionArchived(sessionId, userId)) return null;
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
      // 一条聊天流可能顺序处理多个输入。run.id 保持稳定，当前轮的主输入随 begin 和 endTurn 切换。
      let turnInputId: string | undefined;
      // 旧流的回调可能迟到。用占用对象的身份确认它仍有权写入或释放。
      const current = () => active === run;
      const endTurn = (outcome: AgentTurnOutcome) => {
        if (!current() || !turnInputId) return;
        recordAgentLog(sessionId, {
          kind: "turn-end",
          runId: run.id,
          inputId: turnInputId,
          detail: { outcome: signal.aborted ? "cancelled" : outcome }
        });
        turnInputId = undefined;
      };
      // 浏览器可能先于模型收尾读取队列。尚未被消费的引导先恢复为普通排队项。
      const onAbort = () => {
        if (!current()) return;
        try {
          recordAgentLog(sessionId, {
            kind: "stop-requested",
            runId: run.id,
            inputId: turnInputId,
            detail: { reason: lifetime.signal.aborted ? "实例释放" : "调用方停止或连接断开" }
          });
          if (parkSteering()) publish();
        } catch (error) {
          console.warn("[agent-registry] 停止日志写入失败", error);
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });

      return {
        id: run.id,
        signal,
        observeQueue(listener) {
          if (!current()) return;
          run.notify = listener;
          notify(listener);
        },
        begin(session, message, truncateFrom) {
          if (!current() || signal.aborted || session.id !== sessionId || turnInputId) throw new Error("运行已结束、上一轮未收尾或会话不匹配");
          beginTurn(session, message, truncateFrom, run.id);
          turnInputId = message.id;
        },
        hasNext: () => current() && items.some((item) => item.target === "next-turn"),
        beginNext(session, expectedId) {
          if (!current() || signal.aborted || session.id !== sessionId || turnInputId) return null;
          const item = items.find((candidate) => candidate.target === "next-turn");
          // 用户手动继续时要求队首仍是点击时看到的那一项，避免误领已变更的队首。
          if (!item || (expectedId !== undefined && item.id !== expectedId)) return null;
          const message = {
            id: item.id,
            role: "user" as const,
            content: item.message,
            createdAt: Date.now()
          };
          // 先提交再出队。事务失败时，队首仍可重新领取。
          beginTurn(session, message, undefined, run.id);
          turnInputId = message.id;
          drop(item.id);
          return message;
        },
        endTurn,
        steering: {
          pending: () => current() ? items.filter((item) => item.target === "next-step") : [],
          committed(id) {
            if (!current()) return;
            const item = items.find((candidate) => candidate.id === id && candidate.target === "next-step");
            if (!item) return;
            try {
              recordAgentLog(sessionId, {
                kind: "guidance",
                runId: run.id,
                inputId: id,
              detail: {
                turnInputId: turnInputId ?? null,
                preview: item.message.slice(0, 400)
              }
              });
            }
            finally {
              // 调用方已提交消息正文。即使这条引导日志写入失败，也要出队以免再次提交同一条消息。
              drop(id);
            }
          },
        },
        parkSteering() {
          if (!current() || !parkSteering()) return false;
          publish();
          return true;
        },
        finish() {
          if (!current()) return;
          signal.removeEventListener("abort", onAbort);
          try {
            endTurn("interrupted");
            parkSteering();
          }
          finally {
            // 日志写入失败也要交还执行权，并唤醒正在等待实例释放的调用方。
            active = undefined;
            publish(run.notify);
            settle();
          }
        },
      };
    },
    enqueueInput(runId, message, target) {
      if (!active || active.signal.aborted || (runId !== undefined && active.id !== runId)) return false;
      if (!message || message.length > MAX_QUEUE_MESSAGE_LENGTH || items.length >= MAX_PENDING) return false;
      const item = {
        id: newId("m"),
        message,
        target
      };
      // 先写入可追溯的排队事件，再发布内存快照。落库失败时，界面不会收到成功排队的快照。
      recordAgentLog(sessionId, {
        kind: "queued",
        runId: active.id,
        inputId: item.id,
        detail: {
          target,
          preview: message.slice(0, 400)
        }
      });
      items.push(item);
      publish();
      return true;
    },
    changeQueuedInput(id, action, runId) {
      if (lifetime.signal.aborted || isSessionArchived(sessionId, userId)) return false;
      // 排队区只允许操作仍待领取的普通输入。已转为引导的项由当前运行接管。
      const index = items.findIndex((item) => item.id === id && item.target === "next-turn");
      if (index === -1) return false;
      if (action === "steer") {
        if (!runId || active?.id !== runId || active.signal.aborted) return false;
        recordAgentLog(sessionId, {
          kind: "steered",
          runId: active.id,
          inputId: id,
          detail: { target: "next-step" }
        });
        items[index] = {
          ...items[index],
          target: "next-step"
        };
      } else {
        recordAgentLog(sessionId, {
          kind: "cancelled",
          runId: active?.id,
          inputId: id,
          detail: { reason: "从排队区移除，未执行" }
        });
        items.splice(index, 1);
      }
      publish();
      return true;
    },
  };

  return {
    agent,
    dispose() {
      if (disposal) return disposal;
      // 先锁住实例的输入，再等待执行方补齐结果和释放令牌。直接清空 active 会允许重叠写入。
      const run = active;
      disposal = (async () => {
        await run?.settled;
        try {
          for (const item of items) recordAgentLog(sessionId, {
            kind: "cancelled",
            runId: run?.id,
            inputId: item.id,
            detail: { reason: "实例释放，待处理输入被清空" }
          });
        } catch (error) {
          console.warn("[agent-registry] 实例释放日志写入失败", error);
        }
        items = [];
        disposed = true;
        publish(run?.notify);
      })();
      lifetime.abort();
      return disposal;
    },
  };
}
