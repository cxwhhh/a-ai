import type { AgentFactory } from "../../agent-core/agent/src/factory";
import type { Agent, AgentHandle } from "../../agent-core/agent/src/runtime-types";

type Entry = {
  userId: string;
  ready: Promise<AgentHandle>;
  instance?: AgentHandle;
  disposal?: Promise<void>;
};

export class AgentUnavailable extends Error {}

/** Registry 只管理当前进程中的实例。调用方负责确认持久会话存在且归属正确。 */
export class AgentRegistry {
  private readonly live = new Map<string, Entry>();
  private accepting = true;
  constructor(private readonly factory: AgentFactory) {}

  /** 初始化期间保留同一个登记位置，并发请求共用工厂结果。 */
  getOrCreate(sessionId: string, userId: string, pluginIds: readonly string[] = []): Promise<AgentHandle> {
    const entry = this.live.get(sessionId);
    const status = entry?.instance?.agent.status;
    if (!this.accepting || entry?.disposal || status === "closing" || status === "disposed") {
      return Promise.reject(new AgentUnavailable("Agent 正在关闭，请稍后重试"));
    }
    if (entry) {
      if (entry.userId !== userId) return Promise.reject(new Error("Agent 已归属其他用户"));
      return entry.ready;
    }

    const pending: Entry = {
      userId,
      ready: Promise.resolve().then(() => this.initialize(sessionId, pending, pluginIds))
    };
    this.live.set(sessionId, pending);
    return pending.ready;
  }

  private async initialize(sessionId: string, entry: Entry, pluginIds: readonly string[]): Promise<AgentHandle> {
    try {
      if (entry.disposal || !this.accepting) throw new AgentUnavailable("Agent 已关闭");
      const instance = await this.factory(sessionId, entry.userId, pluginIds);
      const status = instance.agent.status;
      if (entry.disposal || !this.accepting || status === "closing" || status === "disposed") {
        await instance.dispose();
        throw new AgentUnavailable("Agent 已关闭");
      }
      entry.instance = instance;
      // Cordis owner 也可以直接关闭实例。只撤销已释放实例自身的登记。
      void instance.closed.then(() => this.detach(sessionId, entry));
      return {
        agent: instance.agent,
        closed: instance.closed,
        dispose: () => this.release(sessionId, entry)
      };
    } catch (error) {
      this.detach(sessionId, entry);
      throw error;
    }
  }

  get(sessionId: string, userId: string): Agent | undefined {
    return this.owned(sessionId, userId)?.instance?.agent;
  }

  list(userId: string): Agent[] {
    return [...this.live.values()].flatMap(({ instance, userId: owner }) =>
      owner === userId && instance ? [instance.agent] : []
    );
  }

  /** 尚未发布的实例也持有登记位置，以便配置更新和创建互斥。 */
  isInitializing(sessionId: string, userId: string): boolean {
    const entry = this.owned(sessionId, userId);
    return !!entry && !entry.instance;
  }

  async dispose(sessionId: string, userId: string): Promise<void> {
    const entry = this.owned(sessionId, userId);
    if (entry) await this.release(sessionId, entry);
  }

  async disposeAll(): Promise<void> {
    this.accepting = false;
    const disposals = [...this.live].map(([id, entry]) => this.release(id, entry));
    const results = await Promise.allSettled(disposals);
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Agent 释放失败");
  }

  private owned(sessionId: string, userId: string): Entry | undefined {
    const entry = this.live.get(sessionId);
    return entry?.userId === userId ? entry : undefined;
  }

  private detach(sessionId: string, entry: Entry) {
    if (this.live.get(sessionId) === entry) this.live.delete(sessionId);
  }

  private release(sessionId: string, entry: Entry): Promise<void> {
    if (entry.disposal) return entry.disposal;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<void>((accept, refuse) => {
      resolve = accept;
      reject = refuse;
    });
    entry.disposal = completion;
    const instance = entry.instance;
    if (instance) {
      // 先标记关闭，再停止实例；迟到的旧句柄只能注销自己的登记。
      const dispose = async () => {
        try {
          await instance.dispose();
        } finally {
          this.detach(sessionId, entry);
        }
      };
      void dispose().then(resolve, reject);
    } else {
      // 构造方看到关闭标记后负责清理，失败的实例也会撤销登记。
      void entry.ready.then(resolve, (error) => {
        if (error instanceof AgentUnavailable) resolve();
        else reject(error);
      });
    }
    return completion;
  }
}
