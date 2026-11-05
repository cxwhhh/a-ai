/**
 * 模型接口 —— A.ai 与任何大模型之间唯一的契约。
 *
 * 消息格式参照 OpenAI Chat Completions（role / content / tool_calls），
 * 这样云端 API、Ollama、vLLM 等 OpenAI 兼容服务都能直接对接。
 * 接入新模型 = 新建一个实现 LLMProvider 的类，然后在 ./index.ts 里注册。
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  /** JSON 字符串，与 OpenAI 一致 */
  arguments: string;
}

export interface ChatMessage {
  /** 请求视图中的原始消息 ID，仅供内部确认投递；provider 转换协议时不发送此字段。 */
  sourceMessageId?: string;
  role: Role;
  content: string;
  /** assistant 的思考过程（推理模型才有；只用于展示，不再发回给模型） */
  reasoning?: string;
  /** provider 专用的原始回复（如带签名的思考块）；由对应适配器校验后读取。 */
  raw?: unknown;
  /** assistant 发起的工具调用 */
  toolCalls?: ToolCall[];
  /** role=tool 时，对应哪一次调用 */
  toolCallId?: string;
}

/** JSON Schema（只用到常见子集） */
export type JSONSchema = {
  type: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  enum?: string[];
  items?: JSONSchema;
};

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  signal?: AbortSignal;
}

/** 一次模型调用消耗的 token 数（API 计费和“用量”页面都靠它） */
export interface Usage {
  inputTokens: number; // 本次请求发给模型的全部 token（= 上下文占用）
  outputTokens: number; // 模型生成的 token（含思考）
  cacheHitTokens?: number; // 输入中命中缓存的部分（DeepSeek: prompt_cache_hit_tokens，更便宜）
  reasoningTokens?: number; // 输出中用于思考的部分
  /** true = API 没返回用量（本地模型、中途停止），这是按字数估算的 */
  estimated?: boolean;
}

/**
 * 流式输出的五种块：
 * - reasoning：思考过程增量（如 DeepSeek-R1 的 reasoning_content、Claude 的 thinking）
 * - text：回答文字增量
 * - tool_call_delta：工具参数的增量（可选）。只给界面实时显示“正在写的代码”，执行以 tool_call 为准
 * - tool_call：一个“完整”的工具调用（参数拼好之后再发出）
 * - done：本轮结束；usage 可选 —— 大多数 API 在流的最后一块里返回用量（OpenAI 需要 stream_options.include_usage）
 */
export type StreamChunk =
  | { type: "reasoning"; delta: string }
  | { type: "text"; delta: string }
  | { type: "tool_call_delta"; index: number; name: string; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "raw"; raw: unknown }
  | { type: "done"; finishReason?: "stop" | "tool_calls" | "length" | string; usage?: Usage };

export interface LLMProvider {
  /** 显示用的名字，例如 "mock" / "deepseek-chat" */
  readonly id: string;
  /** 唯一必须实现的方法 */
  stream(req: ChatRequest): AsyncIterable<StreamChunk>;
}
