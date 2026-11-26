import type { ChatMessage, ChatRequest, LLMProvider, ModelRequestOptions, StreamChunk, Usage } from "../types";
import { ModelStreamInterrupted } from "../stream";
import { joinUrl, readError, sseData } from "./openai-compatible";
import { fetchModel } from "./provider-fetch";

interface ResponsesOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  label: string;
  source: string;
  effort?: ModelRequestOptions["reasoningEffort"];
}

type OutputItem =
  | { type: "message"; role: "assistant"; content: unknown[]; phase?: string }
  | { type: "reasoning"; encrypted_content?: string }
  | { type: "function_call"; name: string; call_id: string; arguments: string };

interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

interface ResponseEvent {
  type: string;
  delta?: string;
  output_index?: number;
  item?: OutputItem;
  response?: {
    output?: OutputItem[];
    usage?: ResponsesUsage;
    incomplete_details?: { reason: string };
    error?: { message: string };
  };
  message?: string;
}

/** GPT-6 的工具调用走 Responses。携带必要的历史项，保持 A.ai 自己管理会话与压缩边界。 */
export class OpenAIResponsesProvider implements LLMProvider {
  readonly id: string;

  constructor(private readonly o: ResponsesOptions) {
    this.id = o.label;
  }

  requestOptions(req: ChatRequest): ModelRequestOptions {
    return {
      protocol: "openai-responses", model: this.o.model, reasoningEffort: this.o.effort,
      maxOutputTokens: req.maxOutputTokens, includeUsage: true,
    };
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
    const options = this.requestOptions(req);
    const body = {
      model: options.model,
      input: req.messages.flatMap((message) => toResponsesInput(message, this.o.source)),
      reasoning: { effort: options.reasoningEffort, summary: "auto" },
      max_output_tokens: options.maxOutputTokens,
      tools: req.tools?.map((tool) => ({
        type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false,
      })),
      include: ["reasoning.encrypted_content"],
      store: false,
      stream: true,
    };
    const res = await fetchModel(joinUrl(this.o.baseUrl, "/responses"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.o.apiKey}` },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok || !res.body) throw Object.assign(new Error(await readError(res)), { status: res.status });

    const toolSlots = new Map<number, { name: string; index: number }>();
    const completedReasoning = new Map<number, OutputItem>();
    for await (const data of sseData(res.body)) {
      let event: ResponseEvent;
      try { event = JSON.parse(data); }
      catch { continue; }
      if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
        if (event.delta) yield { type: "text", delta: event.delta };
      } else if (event.type === "response.reasoning_summary_text.delta") {
        if (event.delta) yield { type: "reasoning", delta: event.delta };
      } else if (event.type === "response.output_item.added" && event.item?.type === "function_call" && event.output_index !== undefined) {
        toolSlots.set(event.output_index, { name: event.item.name, index: toolSlots.size });
      } else if (event.type === "response.output_item.done" && event.item?.type === "reasoning" &&
        event.item.encrypted_content && event.output_index !== undefined) {
        completedReasoning.set(event.output_index, event.item);
      } else if (event.type === "response.function_call_arguments.delta" && event.output_index !== undefined) {
        const slot = toolSlots.get(event.output_index);
        if (slot && event.delta) yield { type: "tool_call_delta", ...slot, delta: event.delta };
      } else if (event.type === "response.failed" || event.type === "error") {
        throw new Error(event.response?.error?.message ?? event.message ?? "OpenAI Responses 请求失败");
      } else if (event.type === "response.incomplete") {
        req.signal?.throwIfAborted();
        const reason = event.response?.incomplete_details?.reason;
        if (reason !== "max_output_tokens" && reason !== "content_filter") throw new ModelStreamInterrupted();
        yield { type: "done", finishReason: reason === "max_output_tokens" ? "length" : reason, usage: toUsage(event.response?.usage) };
        return;
      } else if (event.type === "response.completed" && Array.isArray(event.response?.output)) {
        req.signal?.throwIfAborted();
        // 只从已完成的响应提取工具。截断或断流时，参数分片可能还未收齐。
        const items = event.response.output.map((item, index) => completedReasoning.get(index) ?? item);
        const calls = items.filter((item) => item.type === "function_call");
        const replay = items.filter((item) => item.type === "message" || item.type === "function_call" ||
          (item.type === "reasoning" && item.encrypted_content));
        if (replay.length) yield { type: "raw", raw: { provider: "openai-responses", source: this.o.source, items: replay } };
        for (const call of calls) {
          yield { type: "tool_call", call: { id: call.call_id, name: call.name, arguments: call.arguments } };
        }
        yield { type: "done", finishReason: calls.length ? "tool_calls" : "stop", usage: toUsage(event.response.usage) };
        return;
      }
    }
    req.signal?.throwIfAborted();
    throw new ModelStreamInterrupted();
  }
}

function toResponsesInput(message: ChatMessage, source: string): unknown[] {
  if (message.role === "tool") return [{ type: "function_call_output", call_id: message.toolCallId, output: message.content }];
  if (message.role !== "assistant") return [{ role: message.role === "system" ? "developer" : message.role, content: message.content }];
  const raw = message.raw as { provider?: string; source?: string; items?: OutputItem[] } | undefined;
  // 仅重放当前连接和模型的加密思考。切换来源或读旧历史时，用通用文字和调用记录重建。
  if (raw?.provider === "openai-responses" && raw.source === source && Array.isArray(raw.items)) return raw.items;
  return [
    ...(message.content ? [{ role: "assistant", content: message.content }] : []),
    ...(message.toolCalls ?? []).map((call) => ({
      type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments,
    })),
  ];
}

function toUsage(usage?: ResponsesUsage): Usage | undefined {
  if (!usage || !Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.output_tokens)) return undefined;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheHitTokens: usage.input_tokens_details?.cached_tokens,
    cacheWriteTokens: usage.input_tokens_details?.cache_write_tokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
  };
}
