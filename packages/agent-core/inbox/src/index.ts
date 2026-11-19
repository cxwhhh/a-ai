import type { AgentQueueItem, AgentQueueSnapshot } from "../../../protocol/src/agent-events";
import type { Session, StoredMessage } from "../../../protocol/src/lib/shared";
import type { AgentSession } from "../../../session/src/agent-session";
import type { QueueClock } from "./clock";

export const MAX_QUEUE_MESSAGE_LENGTH = 32_000;
const MAX_PENDING = 20;

export type QueueListener = (snapshot: AgentQueueSnapshot) => void;

/** 当前进程没有登记实例时，空快照仍使用本 Host 的版本。 */
export function emptyQueueSnapshot(sessionId: string, clock: QueueClock): AgentQueueSnapshot {
  return {
    sessionId,
    ...clock.snapshot(),
    items: []
  };
}

export type AgentInbox = ReturnType<typeof createInbox>;

/** 完整待处理正文保存在 Inbox 内存中。落库的事件用于核对已发生的队列操作。 */
export function createInbox(sessionId: string, clock: QueueClock, sessionPort: AgentSession) {
  let items: AgentQueueItem[] = [];
  const snapshot = (): AgentQueueSnapshot => ({
    sessionId,
    ...clock.snapshot(),
    items: [...items]
  });

  const notify = (listener?: QueueListener) => {
    try {
      listener?.(snapshot());
    } catch (error) {
      // 客户端通知失败时，已提交的数据仍然有效，执行方也必须可以完成收尾。
      console.warn("[agent-inbox] 队列通知失败", error);
    }
  };
  const publish = (listener?: QueueListener) => {
    clock.advance();
    notify(listener);
  };

  return {
    snapshot,
    notify,
    publish,
    enqueue(runId: string, message: string, target: AgentQueueItem["target"], listener?: QueueListener): boolean {
      if (!message || message.length > MAX_QUEUE_MESSAGE_LENGTH || items.length >= MAX_PENDING) {
        return false;
      }
      const item = {
        id: sessionPort.newInputId(),
        message,
        target
      };
      // 先记录排队事实。写入失败时，队列和客户端快照都保持原样。
      sessionPort.record({
        kind: "queued",
        runId,
        inputId: item.id,
        detail: {
          target,
          preview: message.slice(0, 400)
        }
      });
      items.push(item);
      publish(listener);
      return true;
    },
    change(id: string, action: "steer" | "remove", runId?: string, listener?: QueueListener): boolean {
      const index = items.findIndex((item) => item.id === id && item.target === "next-turn");
      if (index === -1) return false;
      if (action === "steer") {
        if (!runId) return false;
        sessionPort.record({
          kind: "steered",
          runId,
          inputId: id,
          detail: { target: "next-step" }
        });
        items[index] = {
          ...items[index],
          target: "next-step"
        };
      } else {
        sessionPort.record({
          kind: "cancelled",
          runId,
          inputId: id,
          detail: { reason: "从排队区移除，未执行" }
        });
        items.splice(index, 1);
      }
      publish(listener);
      return true;
    },
    hasNext: () => items.some((item) => item.target === "next-turn"),
    claimNext(session: Session, runId: string, expectedId?: string): StoredMessage | null {
      const index = items.findIndex((item) => item.target === "next-turn");
      const item = items[index];
      // 手动继续只领取用户看到的队首。事务失败时仍可重新领取。
      if (!item || (expectedId !== undefined && item.id !== expectedId)) return null;
      const message: StoredMessage = {
        id: item.id,
        role: "user",
        content: item.message,
        createdAt: Date.now()
      };
      sessionPort.beginTurn(session, message, runId);
      items.splice(index, 1);
      // 由执行方更新当前轮标记后发布快照，监听器收到的轮次和队列才一致。
      return message;
    },
    pendingSteering: () => items.filter((item) => item.target === "next-step"),
    commitSteering(runId: string, turnInputId: string | null, id: string, listener?: QueueListener) {
      const item = items.find((candidate) => candidate.id === id && candidate.target === "next-step");
      if (!item) return;
      try {
        sessionPort.record({
          kind: "guidance",
          runId,
          inputId: id,
          detail: {
            turnInputId,
            preview: item.message.slice(0, 400)
          }
        });
      } finally {
        // 正文已由调用方写入历史，日志失败也须出队，以免重复提交。
        items = items.filter((candidate) => candidate.id !== id);
        publish(listener);
      }
    },
    /** 尚未消费的引导转回普通队列，保留原有 ID 和顺序。 */
    parkSteering(runId: string): boolean {
      const parked = items.filter((item) => item.target === "next-step");
      if (!parked.length) return false;
      items = items.map((item) => {
        if (item.target !== "next-step") return item;
        return {
          ...item,
          target: "next-turn"
        };
      });
      try {
        for (const item of parked) sessionPort.record({
          kind: "deferred",
          runId,
          inputId: item.id,
          detail: { reason: "未进入下一步，转回下一轮" }
        });
      } catch (error) {
        console.warn("[agent-inbox] 转回排队日志写入失败", error);
      }
      return true;
    },
    clear(runId?: string) {
      try {
        for (const item of items) sessionPort.record({
          kind: "cancelled",
          runId,
          inputId: item.id,
          detail: { reason: "实例释放，待处理输入被清空" }
        });
      } catch (error) {
        console.warn("[agent-inbox] 实例释放日志写入失败", error);
      }
      items = [];
    }
  };
}
