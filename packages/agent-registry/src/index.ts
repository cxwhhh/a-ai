import { createAgentInstance, type AgentFactory, type QueueClock } from "../../agent/src/factory";
export { MAX_QUEUE_MESSAGE_LENGTH } from "../../agent/src/factory";
import type { AgentQueueSnapshot } from "../../protocol/src/lib/shared";
import { createSession, deleteSession, getSession } from "../../storage/src/store";
import type { Agent, AgentHandle, AgentRun, CreateAgentOptions, OpenedAgent, WaitIdleOptions } from "../../agent/src/runtime-types";
import { isSessionArchived } from "../../session/src/archive-admission";
import { readAgentEvents } from "../../session/src/log";
import { projectSession } from "../../session-projection/src/projection";
import { countConsumedWork, foldConsumedWork } from "../../session-projection/src/consumed-work";
import type { AgentWorkSnapshot } from "../../protocol/src/agent-events";

export type { Agent, AgentHandle, AgentRun, AgentStatus, CreateAgentOptions, OpenedAgent } from "../../agent/src/runtime-types";

/** 补充输入写入会话后，模型和历史读取都靠这个标记识别它。 */
export const NOTE_TAG = "【用户补充】";
/**
 * 一个 Session 可以跨进程保存，一个在线 Agent 在当前进程里跨轮复用，
 * 一个 AgentRun 只持有一条聊天流的执行权。三个生命周期由各自的所有者管理。
 */
export class AgentRegistry {
  private readonly live = new Map<string, AgentHandle>();
  private readonly clock: QueueClock = {
    epoch: crypto.randomUUID(),
    version: 0
  };

  constructor(private readonly factory: AgentFactory = createAgentInstance) {}

  /** 等每个实例的执行循环完成收尾后，再释放该 Host 的资源。 */
  async disposeAll(): Promise<void> {
    const results = await Promise.allSettled([...this.live.values()].map((handle) => handle.dispose()));
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Agent 释放失败");
  }

  /** 新建持久会话并发布在线实例；构造失败时回收刚建立的空会话。 */
  create({ userId, title, projectId }: CreateAgentOptions): OpenedAgent {
    const session = createSession(userId, title, projectId);
    try {
      return {
        session,
        handle: this.register(session.id, userId)
      };
    } catch (error) {
      deleteSession(session.id, userId);
      throw error;
    }
  }

  /** 先从 SQLite 校验归属并取得最新快照，再复用在线实例或为旧会话重建实例。 */
  resume(sessionId: string, userId: string): OpenedAgent | null {
    const session = getSession(sessionId, userId);
    return session ? {
      session,
      handle: this.register(sessionId, userId)
    } : null;
  }

  /** 普通查询只交出 Agent；释放能力保留在所有者句柄。 */
  get(sessionId: string, userId: string): Agent | undefined {
    return this.owned(sessionId, userId)?.agent;
  }

  /** 列出调用方的在线实例，空闲实例同样留在登记表里。 */
  list(userId: string): Agent[] {
    return [...this.live.values()].map(({ agent }) => agent).filter((agent) => agent.userId === userId);
  }

  /** 读取持久化执行事实并核对当前实例，不会因为查看历史而创建 Agent 或开始运行。 */
  inspect(sessionId: string, userId: string): AgentWorkSnapshot | null {
    const session = getSession(sessionId, userId);
    if (!session) return null;
    const events = readAgentEvents(userId, sessionId);
    const projection = projectSession(session, events);
    const agent = this.get(sessionId, userId);
    const activeRunId = agent?.activeRunId ?? null;
    const inputs = foldConsumedWork(projection, events, {
      activeRunId,
      queue: agent?.queueSnapshot() ?? null
    });
    return {
      projection,
      inputs,
      // offline 只说明当前进程没有登记该实例，无法从这里得知浏览器的连接状态。
      lifecycle: agent?.status ?? "offline",
      activeRunId,
      counts: countConsumedWork(inputs)
    };
  }

  /** 宿主按会话释放实例，例如删除持久会话之后清理内存资源。 */
  async dispose(sessionId: string, userId: string): Promise<void> {
    await this.owned(sessionId, userId)?.dispose();
  }

  /** 无在线实例时返回空队列。历史事件只保存预览，无法用来重建待处理正文。 */
  queueSnapshot(sessionId: string, userId: string): AgentQueueSnapshot {
    return this.get(sessionId, userId)?.queueSnapshot() ?? {
      sessionId,
      ...this.clock,
      items: []
    };
  }

  /** 等待占用释放。返回 true 后仍需调用 openRun，因为等待本身不会锁定下一次运行。 */
  async waitIdle(sessionId: string, userId: string, options?: WaitIdleOptions): Promise<boolean> {
    return this.get(sessionId, userId)?.waitIdle(options) ?? !options?.signal?.aborted;
  }

  private owned(sessionId: string, userId: string): AgentHandle | undefined {
    const handle = this.live.get(sessionId);
    return handle?.agent.userId === userId ? handle : undefined;
  }

  /** 同步完成检查、构造和登记，避免同一个会话因并发恢复发布两个实例。 */
  private register(sessionId: string, userId: string): AgentHandle {
    const existing = this.live.get(sessionId);
    if (existing) {
      if (existing.agent.userId !== userId) throw new Error("Agent 已归属其他用户");
      return existing;
    }
    const instance = this.factory(sessionId, userId, this.clock);
    let disposal: Promise<void> | undefined;
    const handle: AgentHandle = {
      agent: instance.agent,
      dispose: () => (disposal ??= instance.dispose().then(() => {
        // 只撤销这一次的登记。旧句柄即使再次释放，也不能移除后来恢复的新实例。
        if (this.live.get(sessionId) === handle) this.live.delete(sessionId);
      })),
    };
    this.live.set(sessionId, handle);
    return handle;
  }
}
