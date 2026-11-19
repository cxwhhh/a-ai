/** 前后端共用的 Agent 数据。浏览器可以直接引用此文件。 */
import type { ToolStatus } from "./lib/shared";
import type { agentLogSchema, AgentLogDetail } from "../../storage/src/log-schema";

/** next-turn 开始独立轮次。next-step 在当前轮下一次模型请求前写成引导。 */
export type InboxTarget = "next-turn" | "next-step";

export interface AgentQueueItem {
  /** 排队时分配。作为普通输入或引导写入历史后沿用该 ID。 */
  id: string;
  message: string;
  target: InboxTarget;
}

export interface AgentQueueSnapshot {
  sessionId: string;
  /** 每个 Host 的 Inbox 共用一个 epoch。版本号只能在同会话、同 epoch 内比较。 */
  epoch: string;
  /** 快照更新时递增，供客户端丢弃同一来源的较旧推送。 */
  version: number;
  items: AgentQueueItem[];
}

export type AgentModelSelection = AgentLogDetail<"model-selected">;
export type ReasoningEffort = AgentModelSelection["effort"];

/** 会话 ID 确定数据所有者，运行 ID 区分同一会话的两次流。 */
export interface AgentEventScope {
  sessionId: string;
  runId: string;
}

/** 结束原因描述执行流程，不保证回答质量，也不表示工具的副作用已经回滚。 */
export type AgentTurnOutcome = AgentLogDetail<"turn-end">["outcome"];
export type AgentLogKind = keyof typeof agentLogSchema;

type AgentLogScopes = {
  /** 一条运行可连续执行多轮。步骤和工具事件需要运行 ID 与主输入 ID 定位轮次。 */
  "run-input": {
    runId: string;
    inputId: string;
  };
  /** 停止请求可发生在两轮之间，届时没有当前输入 ID。 */
  run: {
    runId: string;
    inputId?: string;
  };
  /** 历史截断或移除待处理输入时，实例可能没有正在执行的运行。 */
  input: {
    runId?: string;
    inputId: string;
  };
  /** 归档、恢复和模型选择作用于整段会话。 */
  session: {
    runId?: never;
    inputId?: never;
  };
};

/** kind、detail 和作用域作为一个事件整体进行类型检查。 */
export type AgentLogEvent<K extends AgentLogKind = AgentLogKind> = {
  [Kind in K]: {
    kind: Kind;
    detail: AgentLogDetail<Kind>;
  } & AgentLogScopes[(typeof agentLogSchema)[Kind]["scope"]];
}[K];

type AgentStepLogKind = "step-start" | "step-end" | "model-request" | "model-result";

/** 循环提交步骤事实，聊天入口附加当前轮的 runId 和 inputId 后写库。 */
export type AgentStepLogEvent = {
  [Kind in AgentStepLogKind]: Pick<AgentLogEvent<Kind>, "kind" | "detail">;
}[AgentStepLogKind];

interface AgentLogMetadata {
  /** SQLite 递增事件号。排序和分页使用它，避免同毫秒的事件次序不明。 */
  id: number;
  sessionId: string;
  /** 查询时取会话当前标题，改名后历史事件会显示新标题。 */
  sessionTitle: string;
  at: number;
}

/** 已持久化的事件。记录元数据附在原事件上，字段仍由 kind 决定。 */
export type AgentLogEntry = AgentLogMetadata & AgentLogEvent;

export interface AgentToolProjection {
  callId: string;
  name?: string;
  started: boolean;
  startEventId?: number;
  /** 没有可靠结果时为 unknown；cancelled 与 unknown 不能混用。 */
  status: ToolStatus;
  resultEventId?: number;
}

export interface AgentStepProjection {
  step: number;
  startEventId: number;
  /** 尚未记录 step-end 时为 null。模型返回后，该步的工具仍可能继续执行。 */
  endEventId: number | null;
  /** 由 step-start 建立时为 true。仅从 model-request 建立时为 false。 */
  explicitBoundary: boolean;
  modelRequested: boolean;
  /** 本次模型请求的结果。没有 model-result 时为 null。 */
  modelOutcome: string | null;
  /** 由模型请求事件确认进入该步的引导输入。 */
  guidanceIds: string[];
  tools: AgentToolProjection[];
}

export interface AgentTurnProjection extends AgentEventScope {
  inputId: string;
  startEventId: number;
  endEventId: number | null;
  outcome: AgentTurnOutcome | null;
  /** 编辑重发只改变活动视图，旧轮次的执行事实仍保留。 */
  inCurrentHistory: boolean;
  steps: AgentStepProjection[];
}

export interface AgentSessionProjection {
  sessionId: string;
  revision: number;
  lastEventId: number;
  turns: AgentTurnProjection[];
  /** 当前视图中没有对应领取或轮次开始事件的用户输入。 */
  untrackedInputIds: string[];
}

export type AgentWorkStatus = "queued" | "accepted" | "running" | "completed" | "cancelled" | "failed" | "waiting-for-answer" | "output-truncated" | "interrupted" | "unknown";
export interface AgentConsumedInput {
  inputId: string;
  kind: "turn" | "guidance" | "queued" | "unknown";
  runId?: string;
  /** 主输入指向自身，引导指向它所补充的轮次主输入。 */
  turnInputId?: string;
  /** 输入已被本轮领取，或作为引导写入本轮。 */
  claimed: boolean;
  /** 进入模型请求才算 consumed；领取或写入历史本身不算模型已处理。 */
  consumed: boolean;
  status: AgentWorkStatus;
  /** 有证据表明排队期间被移除，工具或模型尚未为它执行。 */
  droppedUnrun: boolean;
  /** 历史版本切换时退出当前视图。此前执行记录仍可查询。 */
  truncated: boolean;
  inCurrentHistory: boolean;
}

export interface AgentWorkSnapshot {
  projection: AgentSessionProjection;
  inputs: AgentConsumedInput[];
  /** offline 表示当前服务进程没有登记实例。轮次是否取消由对应事件记录。 */
  lifecycle: "offline" | "idle" | "running" | "closing" | "disposed";
  activeRunId: string | null;
  counts: Record<AgentWorkStatus, number>;
}
