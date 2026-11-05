import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, ChatRequest, LLMProvider, StreamChunk, Usage } from "../types";

/**
 * Claude（Anthropic Messages API）的模型实现，用官方 SDK @anthropic-ai/sdk。
 *
 * 和 openai-compatible.ts 的区别：
 *   1. system 提示词单独放在 system 参数里，不在 messages 里
 *   2. 工具调用是 assistant 消息里的 tool_use 块，工具结果是 user 消息里的 tool_result 块
 *   3. 思考内容是 thinking 块，带一个 signature（签名）。下一次请求要把它原样发回，
 *      Claude 才能接着上一步的思路做（工具调用时尤其重要）。所以流结束时把整条回复的
 *      原始内容块通过 { type: "raw" } 交给 agent 存进历史，下次原样拼回去
 *
 * A.ai 会改历史（上下文压缩会截短旧的工具结果、步数提醒只发一次），而思考块的签名绑定了
 * “它之前的全部内容”，内容变了旧思考块就失效。所以开启 thinking-binding-controls 测试版，
 * 设置 prefix_mismatch_behavior: "drop_block"：失效的思考块由 API 丢掉（不计费），而不是报 400。
 */
export interface AnthropicOptions {
  baseUrl?: string; // 默认 https://api.anthropic.com
  apiKey: string;
  model: string; // 例如 claude-opus-5-5
  label?: string;
}

/** 这几个模型支持服务端拒绝兜底（fallbacks: "default"）：被安全分类器拒绝时，API 自动换一个模型重试 */
const FALLBACK_MODELS = /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5-1)$/;

export class AnthropicProvider implements LLMProvider {
  readonly id: string;
  private readonly client: Anthropic;

  constructor(private readonly o: AnthropicOptions) {
    this.id = o.label || o.model;
    this.client = new Anthropic({ apiKey: o.apiKey, baseURL: o.baseUrl?.replace(/\/+$/, "").replace(/\/v1$/, "") || undefined });
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
    const { system, messages } = toAnthropic(req.messages);
    const fallback = FALLBACK_MODELS.test(this.o.model);
    const betas: Anthropic.Beta.AnthropicBeta[] = ["thinking-binding-controls-2026-08-01"];
    if (fallback) betas.push("server-side-fallback-2026-07-01");

    const stream = this.client.beta.messages.stream(
      {
        model: this.o.model,
        max_tokens: 64000,
        system: system || undefined,
        messages,
        // 自动缓存：同一对话后续请求的前缀命中缓存，输入价格约 1/10
        cache_control: { type: "ephemeral" },
        thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } },
        // agent 任务（写代码、多步工具调用）用 high；Opus 5.5 默认是 medium
        output_config: { effort: "high" },
        tools: req.tools?.length
          ? req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema, eager_input_streaming: true }))
          : undefined,
        betas,
        ...(fallback ? { fallbacks: "default" as const } : {}),
      },
      { signal: req.signal },
    );

    // 工具调用块：content_block_start 时记下 id/name，input_json_delta 实时推给界面
    const toolIdx = new Map<number, number>(); // 内容块序号 → 第几个工具调用
    for await (const ev of stream) {
      if (ev.type === "content_block_start" && ev.content_block.type === "tool_use") {
        toolIdx.set(ev.index, toolIdx.size);
      } else if (ev.type === "content_block_delta") {
        const d = ev.delta;
        if (d.type === "thinking_delta") yield { type: "reasoning", delta: d.thinking };
        else if (d.type === "text_delta") yield { type: "text", delta: d.text };
        else if (d.type === "input_json_delta" && toolIdx.has(ev.index)) {
          const block = stream.currentMessage?.content[ev.index];
          yield { type: "tool_call_delta", index: toolIdx.get(ev.index)!, name: block?.type === "tool_use" ? block.name : "", delta: d.partial_json };
        }
      }
    }

    const msg = await stream.finalMessage();
    // 被截断（max_tokens）或被拒绝时，工具参数可能不完整：这一步不执行工具
    const toolsOk = msg.stop_reason !== "max_tokens" && msg.stop_reason !== "refusal";
    if (msg.stop_reason === "refusal") yield { type: "text", delta: "\n\n（Claude 拒绝回答这个请求。可以换个说法，或换一个模型再试。）" };

    for (const b of msg.content) {
      if (b.type === "tool_use" && toolsOk) yield { type: "tool_call", call: { id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) } };
    }
    // 原始内容块（含思考签名）存进历史，下次请求原样发回
    yield { type: "raw", raw: { provider: "anthropic", content: msg.content } };

    const u = msg.usage;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const usage: Usage = {
      inputTokens: u.input_tokens + cacheRead + (u.cache_creation_input_tokens ?? 0),
      outputTokens: u.output_tokens,
      cacheHitTokens: cacheRead,
    };
    yield { type: "done", finishReason: msg.stop_reason === "tool_use" ? "tool_calls" : msg.stop_reason === "max_tokens" ? "length" : (msg.stop_reason ?? undefined), usage };
  }
}

/* ---------------- 格式转换 ---------------- */

type RawContent = { provider: "anthropic"; content: Anthropic.Beta.BetaContentBlock[] };
const isRaw = (r: unknown): r is RawContent => !!r && typeof r === "object" && (r as RawContent).provider === "anthropic" && Array.isArray((r as RawContent).content);

/**
 * A.ai 的消息（OpenAI 风格）→ Anthropic 格式：
 * - 开头的 system 合并成 system 参数；中途的 system（少见）当作 user 文字
 * - tool 消息变成 user 消息里的 tool_result 块；相邻的 user 内容合并成一条（tool_result 在前）
 * - assistant 有原始块时原样发回（思考块要带签名），只按当前 toolCalls 过滤 tool_use
 */
export function toAnthropic(msgs: ChatMessage[]) {
  const sys: string[] = [];
  let i = 0;
  for (; i < msgs.length && msgs[i].role === "system"; i++) if (msgs[i].content) sys.push(msgs[i].content);

  const out: Anthropic.Beta.BetaMessageParam[] = [];
  const pushUser = (blocks: Anthropic.Beta.BetaContentBlockParam[]) => {
    const last = out[out.length - 1];
    if (last?.role === "user" && Array.isArray(last.content)) last.content.push(...blocks);
    else out.push({ role: "user", content: blocks });
  };

  for (; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === "tool") {
      pushUser([{ type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content || "（空）" }]);
    } else if (m.role === "user" || m.role === "system") {
      if (m.content) pushUser([{ type: "text", text: m.content }]);
    } else {
      const content = assistantBlocks(m);
      if (content.length) out.push({ role: "assistant", content });
    }
  }
  return { system: sys.join("\n\n"), messages: out };
}

function assistantBlocks(m: ChatMessage): Anthropic.Beta.BetaContentBlockParam[] {
  const calls = new Map((m.toolCalls ?? []).map((c) => [c.id, c]));
  if (isRaw(m.raw)) {
    const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const b of m.raw.content) {
      if (b.type === "tool_use") {
        const c = calls.get(b.id);
        if (!c) continue; // 这次调用没保留（例如最后一步被丢掉），发回去会因为缺结果而 400
        calls.delete(b.id);
        blocks.push({ type: "tool_use", id: b.id, name: b.name, input: parseArgs(c.arguments) });
      } else {
        blocks.push(b as Anthropic.Beta.BetaContentBlockParam);
      }
    }
    for (const c of calls.values()) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: parseArgs(c.arguments) });
    return blocks;
  }
  // 没有原始块（别的模型生成的历史）：只发文字和工具调用，思考内容不发
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (m.content) blocks.push({ type: "text", text: m.content });
  for (const c of calls.values()) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: parseArgs(c.arguments) });
  return blocks;
}

function parseArgs(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : { value: v };
  } catch {
    return { _raw: s };
  }
}
