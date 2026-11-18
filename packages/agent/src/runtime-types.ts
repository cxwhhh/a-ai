import type { AgentQueueItem, AgentQueueSnapshot, Session, StoredMessage } from "../../protocol/src/lib/shared";
import type { AgentTurnOutcome } from "../../protocol/src/agent-events";

/** 在线实例暴露的当前状态。关闭期间可能仍在等待本轮收尾，最终结果从日志读取。 */
export type AgentStatus = "idle" | "running" | "closing" | "disposed";

export interface WaitIdleOptions {
  /** 最长等待毫秒数，默认 5000。超时返回 false。 */
  waitMs?: number;
  /** 中止等待，调用方仍须通过运行自己的信号来停止执行。 */
  signal?: AbortSignal;
}

/** 一次聊天流的执行权。流可以按顺序执行多轮，结束后 Agent 仍可使用。 */
export interface AgentRun {
  readonly id: string;
  /** 同时响应调用方停止和 Agent 实例释放。执行方用它收尾后才调用 finish。 */
  readonly signal: AbortSignal;
  /** 注册当前流的队列监听器，登记时立即推送现有快照。 */
  observeQueue(notify: (queue: AgentQueueSnapshot) => void): void;
  /** 提交本轮用户消息。编辑重发时由同一事务截断当前历史。 */
  begin(session: Session, message: StoredMessage, truncateFrom?: string): void;
  /** 检查队列中是否有普通输入可接续，实际领取由 beginNext 完成。 */
  hasNext(): boolean;
  /** 领取第一条普通排队输入。指定 expectedId 时，只有队首仍匹配才会提交。 */
  beginNext(session: Session, expectedId?: string): StoredMessage | null;
  /** 关闭当前轮的日志边界。运行信号已中止时，最终结果记录为取消。 */
  endTurn(outcome: AgentTurnOutcome): void;
  readonly steering: {
    /** 获取本次请求前可以注入的引导，读取时仍保留这些输入。 */
    pending(): AgentQueueItem[];
    /** 正文已成功写入会话后确认出队。是否进入模型以模型请求事件为准。 */
    committed(id: string): void;
  };
  /** 将还没写入会话的引导转回下一轮。无可转移输入时返回 false。 */
  parkSteering(): boolean;
  /** 释放整条流的执行权。未闭合轮次补记中断，运行已取消时补记取消。 */
  finish(): void;
}

/** 注册表交给普通调用方的在线实例，可读取状态并使用该会话的运行入口。 */
export interface Agent {
  /** 使用持久会话 ID 标识实例，进程重启后可以用同一 ID 重建。 */
  readonly id: string;
  readonly userId: string;
  readonly status: AgentStatus;
  /** 无占用时为 null。一条流结束后，下次取得占用会生成新的 ID。 */
  readonly activeRunId: string | null;
  /** 尝试占用当前实例，实例忙碌、关闭或归档时返回 null。 */
  openRun(signal: AbortSignal): AgentRun | null;
  waitIdle(options?: WaitIdleOptions): Promise<boolean>;
  queueSnapshot(): AgentQueueSnapshot;
  /** 向活跃运行提交输入。传入 runId 时须匹配当前运行，以拦截旧页面的请求。 */
  enqueueInput(runId: string | undefined, message: string, target: AgentQueueItem["target"]): boolean;
  /** 移除尚未领取的普通输入，或用当前 runId 将它转为下一步引导。 */
  changeQueuedInput(id: string, action: "steer" | "remove", runId?: string): boolean;
}

/** 实例所有者持有句柄。释放会等待当前执行收尾，然后撤销登记。 */
export interface AgentHandle {
  readonly agent: Agent;
  dispose(): Promise<void>;
}

export interface CreateAgentOptions {
  userId: string;
  title?: string;
  projectId?: string;
}

export interface OpenedAgent {
  readonly handle: AgentHandle;
  /** 本次从 SQLite 读取的会话快照，写入仍受 revision 校验。 */
  readonly session: Session;
}
