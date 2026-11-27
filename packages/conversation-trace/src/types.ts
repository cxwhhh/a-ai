import type { ChatMessage, ModelRequestOptions, Role, ToolCall, ToolSpec, Usage } from "../../llm/src/types";
import type { AgentConsumedInput, AgentWorkStatus, ReasoningEffort } from "../../protocol/src/agent-events";
import type { ErrorKind, ToolStatus } from "../../protocol/src/lib/shared";

export interface TraceScope {
  sessionId: string;
  runId: string;
  inputId: string;
  model: string;
  effort: ReasoningEffort;
}

export interface TraceLocation {
  step: number;
  /** 父节点使用轨迹行 ID，避免不同步骤和并行子 Agent 复用 callId 时串记录。 */
  parentId?: string;
  childStep?: number;
  /** 同一个父委派调用可启动多个子任务。比较请求时这一标识区分它们。 */
  taskId?: string;
}

export type TracePhase = "chat" | "compact" | "research";
/** 子 Agent 请求的细分类型，向后兼容旧记录（旧记录省略此字段，统一按原“子 Agent”展示）。 */
export type SubagentTraceKind = "research" | "review" | "analysis" | "implementation" | "revision" | "followup" | "review-check" | "compact";

/** 列表快照只存数量和短片段，完整请求与响应仍在压缩正文。 */
export interface TracePreview {
  context?: { messages: Record<Role, number>; tools: number };
  reasoning?: string;
  text?: string;
  arguments?: string;
  result?: string;
}

export type TraceEntryMeta = Omit<TraceScope, "sessionId"> & TraceLocation & { preview?: TracePreview } & (
  | { kind: "request"; phase: TracePhase; subagentKind?: SubagentTraceKind; assistantId?: string; metrics?: RequestMetrics }
  | { kind: "tool"; callId: string; name: string; toolStatus?: ToolStatus; errorKind?: ErrorKind }
);

export interface TraceEntry {
  id: string;
  at: number;
  finishedAt: number | null;
  outcome: "completed" | "cancelled" | "failed" | "output-truncated" | "interrupted" | null;
  meta: TraceEntryMeta;
}

/** 保存 A.ai 交给适配器的消息顺序和工具定义。适配器内部结构与连接凭据不属于展示数据。 */
export interface RequestSnapshot {
  messages: Omit<ChatMessage, "raw">[];
  /** 主请求中本轮输入的位置。null 表示无法定位，未定义表示旧快照。 */
  turnStart?: number | null;
  /** 子 Agent 实际接收的继承资料位置。null 表示本次没有继承资料。 */
  referenceIndex?: number | null;
  tools: ToolSpec[];
  temperature?: number;
  provider?: { label: string; options?: ModelRequestOptions };
  agent?: { contextWindow?: number; compactAt?: number; stepBudget?: number; guidanceIds?: string[] };
}

export type ResponseBlock =
  | { kind: "text" | "reasoning"; text: string }
  | { kind: "tool-call"; call: ToolCall }
  | { kind: "tool-draft"; index: number; name: string; text: string };

/** 只把小型指标写入索引。旧记录的指标从已有压缩响应读取。 */
export interface RequestMetrics {
  providerStartedAt?: number;
  streamMs?: number;
  /** 首次可用增量，可能是思考、正文或工具参数。旧记录从轨迹创建时间计起。 */
  firstOutputMs?: number;
  firstTextMs?: number;
  firstReasoningMs?: number;
  firstToolMs?: number;
  usage?: Usage;
  finishReason?: string;
  /** 只持久化 HTTP 状态与分类，提供方错误正文可能含请求内容。 */
  error?: { kind: "auth" | "rate-limit" | "request" | "service" | "other"; status?: number };
}

export interface RequestResponse extends RequestMetrics {
  blocks: ResponseBlock[];
}

export interface TraceToolResult {
  content: string;
  isError?: boolean;
  status?: ToolStatus;
  errorKind?: ErrorKind;
}

export type TraceFinishFacts = { metrics: RequestMetrics } | { toolStatus: ToolStatus; errorKind?: ErrorKind };

export interface RequestContextAnalysis {
  messages: Record<Role, number>;
  estimatedInputTokens: number;
  previous?: {
    id: string;
    step: number;
    childStep?: number;
    firstChanged?: number;
    added: number;
    removed: number;
    systemChanged: boolean;
    toolsAdded: string[];
    toolsRemoved: string[];
    toolsChanged: string[];
    toolOrderChanged: boolean;
  };
}

export type TraceRecordDetail = TraceEntry & (
  | { kind: "request"; request: RequestSnapshot; response?: RequestResponse; context?: RequestContextAnalysis; prompts?: string[] }
  | { kind: "tool"; call: ToolCall; result?: TraceToolResult }
);

export type TraceKind = "input" | "model" | "tool" | "event";
export type TraceToolState = ToolStatus | "running" | "interrupted";
export type TraceRequestState = NonNullable<TraceEntry["outcome"]> | "running";

export interface TraceRow {
  id: string;
  kind: TraceKind;
  title: string;
  at: number;
  durationMs?: number;
  turn?: number;
  step?: number;
  historical?: boolean;
  status?: string;
  body?: string;
  reasoning?: string;
  args?: string;
  result?: string;
  tool?: string;
  traceId?: string;
  requestId?: string;
  parentId?: string;
  childStep?: number;
  paths?: string[];
  detail?: Record<string, string | number | boolean | null>;
  input?: AgentConsumedInput;
  callId?: string;
  requestState?: TraceRequestState;
  requestPhase?: TracePhase;
  subagentKind?: SubagentTraceKind;
  toolState?: TraceToolState;
  toolStarted?: boolean;
  preview?: TracePreview;
  requestMetrics?: RequestMetrics;
}

/** 样本计数用来区分真实的 0 与没有记录。 */
export interface TraceDurationTotal { count: number; ms: number }

export interface TraceUsageTotal {
  count: number;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  cacheReadInput?: number;
}

export interface TraceRequestTotals {
  count: number;
  phases: Record<TracePhase, number>;
  subagentKinds?: Partial<Record<SubagentTraceKind, number>>;
  states: Partial<Record<TraceRequestState, number>>;
  elapsed: TraceDurationTotal;
  firstOutput: TraceDurationTotal;
  decode: TraceDurationTotal & { tokens: number };
  reported: TraceUsageTotal;
  estimated: TraceUsageTotal;
}

export interface TraceAnalysis {
  requests: TraceRequestTotals;
  /** 旧消息仍可查看，缺请求快照的模型记录不冒充请求计数。 */
  legacyModelRows: number;
  models: { model: string; effort: ReasoningEffort; totals: TraceRequestTotals; rowId: string }[];
  tools: {
    name: string; count: number; started: number; children: number;
    elapsed: TraceDurationTotal; states: Partial<Record<TraceToolState, number>>; rowId: string;
  }[];
  turns: {
    inputId: string; number?: number; at?: number; durationMs?: number; status: AgentWorkStatus;
    historical: boolean; consumed: boolean; guidance: number; consumedGuidance: number;
    steps: number; closedSteps: number; requests: number; tools: number; rowId?: string;
  }[];
  inputs: { total: number; consumed: number; dropped: number; counts: Record<AgentWorkStatus, number> };
  issues: { rowId: string; state: TraceRequestState; finishReason?: string; error?: RequestMetrics["error"] }[];
}

export interface SessionTrace {
  rows: TraceRow[];
  schemas: Record<string, ToolSpec>;
  running: boolean;
  analysis?: TraceAnalysis;
}
