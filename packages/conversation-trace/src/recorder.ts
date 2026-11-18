import type { ChatRequest, LLMProvider, ModelRequestOptions, StreamChunk, ToolCall } from "../../llm/src/types";
import { ModelStreamInterrupted, requireModelEnd } from "../../llm/src/stream";
import { finishTraceEntry, insertTraceEntry } from "./store";
import type {
  RequestMetrics, RequestResponse, RequestSnapshot, TraceEntry, TraceEntryMeta, TraceFinishFacts,
  TraceLocation, TracePhase, TraceScope, TraceToolResult,
} from "./types";

type RequestLocation = TraceLocation & { phase: TracePhase; assistantId?: string; agent?: RequestSnapshot["agent"] };

/** 连接配置与适配器错误正文只服务执行层，调试快照只保存稳定字段。 */
function requestOptions(provider: LLMProvider, request: ChatRequest): ModelRequestOptions | undefined {
  try {
    const options = provider.requestOptions?.(request);
    if (!options) return;
    const { protocol, model, temperature, thinking, reasoningEffort, maxOutputTokens, sendReasoning, includeUsage, serverFallback } = options;
    return { protocol, model, temperature, thinking, reasoningEffort, maxOutputTokens, sendReasoning, includeUsage, serverFallback };
  } catch {
    console.warn("[conversation-trace] 无法读取适配器选项");
  }
}

/** 将服务端错误映射为安全的分类和 HTTP 状态，供统计使用。 */
function requestError(error: unknown): NonNullable<RequestMetrics["error"]> {
  const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 400 || status > 599) return { kind: "other" };
  if (status === 401 || status === 403) return { kind: "auth", status };
  if (status === 429) return { kind: "rate-limit", status };
  return { kind: status >= 500 ? "service" : "request", status };
}

/** 一轮绑定一个记录器。写轨迹失败时仍让原调用运行，避免记录故障触发工具重试或改变回答。 */
export function createConversationTrace(scope: TraceScope) {
  const { sessionId, ...owner } = scope;
  function start(meta: TraceEntryMeta, payload: unknown) {
    const entry: TraceEntry = { id: `trace:${crypto.randomUUID()}`, at: Date.now(), finishedAt: null, outcome: null, meta };
    try {
      return insertTraceEntry(sessionId, entry, payload) ? entry : undefined;
    } catch {
      console.warn("[conversation-trace] 无法保存执行快照");
    }
  }
  function finish(entry: TraceEntry, outcome: NonNullable<TraceEntry["outcome"]>, result: unknown, facts: TraceFinishFacts) {
    try {
      finishTraceEntry(sessionId, entry.id, outcome, result, facts);
    } catch {
      console.warn("[conversation-trace] 无法保存执行结果");
    }
  }

  return {
    /**
     * 快照保存交给适配器的请求。消费包装流时逐块转发，同时记录已收到的内容和首段输出时间。
     * 流被提前关闭时保留已有片段。快照未创建成功时，调用方仍消费原模型流。
     */
    request(provider: LLMProvider, request: ChatRequest, { agent, ...location }: RequestLocation) {
      const snapshot: RequestSnapshot = {
        messages: request.messages.map(({ role, content, reasoning, toolCalls, toolCallId }) => ({ role, content, reasoning, toolCalls, toolCallId })),
        tools: request.tools ?? [],
        temperature: request.temperature,
        provider: { label: provider.id, options: requestOptions(provider, request) },
        agent,
      };
      const entry = start({ ...owner, ...location, kind: "request" }, snapshot);
      async function* observed(record: TraceEntry): AsyncGenerator<StreamChunk> {
        const response: RequestResponse = { blocks: [], providerStartedAt: Date.now() };
        const started = performance.now();
        const elapsed = () => Math.round(performance.now() - started);
        let outcome: NonNullable<TraceEntry["outcome"]> = "interrupted";
        try {
          for await (const chunk of requireModelEnd(provider.stream(request), request.signal)) {
            const previous = response.blocks.at(-1);
            if (chunk.type === "text" || chunk.type === "reasoning") {
              if (chunk.delta) {
                const at = elapsed();
                response.firstOutputMs ??= at;
                if (chunk.type === "reasoning") response.firstReasoningMs ??= at;
                else response.firstTextMs ??= at;
                if (previous?.kind === chunk.type) previous.text += chunk.delta;
                else response.blocks.push({ kind: chunk.type, text: chunk.delta });
              }
            } else if (chunk.type === "tool_call_delta") {
              if (chunk.delta) {
                const at = elapsed();
                response.firstOutputMs ??= at;
                response.firstToolMs ??= at;
              }
              if (previous?.kind === "tool-draft" && previous.index === chunk.index && previous.name === chunk.name) previous.text += chunk.delta;
              else response.blocks.push({ kind: "tool-draft", index: chunk.index, name: chunk.name, text: chunk.delta });
            } else if (chunk.type === "tool_call") {
              const at = elapsed();
              response.firstOutputMs ??= at;
              response.firstToolMs ??= at;
              response.blocks.push({ kind: "tool-call", call: { ...chunk.call } });
            } else if (chunk.type === "done") {
              if (chunk.usage) response.usage = chunk.usage;
              if (chunk.finishReason !== undefined) response.finishReason = chunk.finishReason;
            }
            yield chunk;
          }
          outcome = response.finishReason === "length" ? "output-truncated" : "completed";
        } catch (error) {
          outcome = error instanceof ModelStreamInterrupted ? "interrupted" : "failed";
          if (!request.signal?.aborted) response.error = requestError(error);
          throw error;
        } finally {
          // 停止或异常时仍保存已经收到的思考、文字和参数片段。
          response.streamMs = elapsed();
          const { blocks: _blocks, ...metrics } = response;
          finish(record, request.signal?.aborted ? "cancelled" : outcome, response, { metrics });
        }
      }
      return { id: entry?.id, stream: entry ? observed(entry) : requireModelEnd(provider.stream(request), request.signal) };
    },
    /** 包装一次子工具调用。记录结果时优先使用工具返回的状态，原有返回值或异常继续传给调用方。 */
    async tool(call: ToolCall, location: TraceLocation, signal: AbortSignal | undefined, run: () => Promise<TraceToolResult>): Promise<TraceToolResult> {
      const entry = start({ ...owner, ...location, kind: "tool", callId: call.id, name: call.name }, call);
      let result: TraceToolResult | undefined;
      try {
        result = await run();
        return result;
      } finally {
        if (entry) {
          const toolStatus = result?.status ?? (result && !result.isError ? "ok" : signal?.aborted ? "cancelled" : "error");
          const outcome = toolStatus === "ok" ? "completed" : toolStatus === "cancelled" ? "cancelled" : "failed";
          finish(entry, outcome, result ?? null, { toolStatus, errorKind: result?.errorKind });
        }
      }
    },
  };
}

export type ConversationTraceRecorder = ReturnType<typeof createConversationTrace>;
