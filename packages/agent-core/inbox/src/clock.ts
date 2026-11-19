import type { AgentQueueSnapshot } from "../../../protocol/src/agent-events";

export type QueueClock = {
  snapshot(): Pick<AgentQueueSnapshot, "epoch" | "version">;
  advance(): void;
};

/** 同一个 Host 的所有 Inbox 共用版本。释放再创建实例时，客户端仍能比较新旧快照。 */
export function createQueueClock(): QueueClock {
  const epoch = crypto.randomUUID();
  let version = 0;
  return {
    snapshot: () => ({ epoch, version }),
    advance() {
      version++;
    }
  };
}
