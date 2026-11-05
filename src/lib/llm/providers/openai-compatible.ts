import type { ChatMessage, ChatRequest, LLMProvider, StreamChunk, ToolCall, Usage } from "../types";

/**
 * OpenAI 兼容协议的模型实现。DeepSeek、OpenAI、通义、Kimi、Ollama、vLLM 等都支持这个协议，
 * 所以一个类就能接大部分模型。
 *
 * 它做三件事：
 *   1. 把 A.ai 的消息 / 工具格式转换成 OpenAI 格式，POST 到 {baseUrl}/chat/completions（stream: true）
 *   2. 逐行解析 SSE 流：reasoning_content → reasoning 块；content → text 块；
 *      tool_calls 按 index 分片到达，要先拼完整再发出 tool_call 块
 *   3. 最后一个块里读出 usage（token 用量），随 done 块一起交给 agent
 */
export interface OpenAICompatibleOptions {
  baseUrl: string; // 例如 https://api.deepseek.com
  apiKey: string;
  model: string; // 例如 deepseek-flash
  /** 把历史中的思考内容作为 reasoning_content 回传。DeepSeek 思考模式 + 工具调用时必须开启，否则 400 */
  sendReasoning?: boolean;
  /** DeepSeek 的思考开关：不传 = 用模型默认（开启） */
  thinking?: "enabled" | "disabled";
  /** 显示名 */
  label?: string;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;

  constructor(private readonly o: OpenAICompatibleOptions) {
    this.id = o.label || o.model;
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
    const body: Record<string, unknown> = {
      model: this.o.model,
      messages: req.messages.map((m) => toOpenAI(m, !!this.o.sendReasoning)),
      stream: true,
      stream_options: { include_usage: true }, // 让最后一个块带上 token 用量
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (this.o.thinking) body.thinking = { type: this.o.thinking };

    const res = await fetch(joinUrl(this.o.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.o.apiKey}` },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok || !res.body) throw new Error(await readError(res));

    // 工具调用的参数是分片到达的：按 index 累积。
    // calls 按出现顺序存每个调用，slotOf 记 “index → calls 里的第几个”
    const calls: { id: string; name: string; args: string }[] = [];
    const slotOf = new Map<number, number>();
    let usage: Usage | undefined;
    let finishReason: string | undefined;

    for await (const data of sseData(res.body)) {
      if (data === "[DONE]") break;
      let chunk: OAChunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.usage) usage = toUsage(chunk.usage);
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const d = choice.delta ?? {};
      if (d.reasoning_content) yield { type: "reasoning", delta: d.reasoning_content };
      if (d.content) yield { type: "text", delta: d.content };
      for (const [k, tc] of (d.tool_calls ?? []).entries()) {
        const idx = tc.index ?? k; // 有的服务（部分本地模型）不带 index
        let slot = slotOf.get(idx);
        // 同一个 index 上出现了另一个调用（有的服务把每个调用都标成 index 0）：
        // 来了不同的 id，或者上一个调用的参数已经是完整 JSON 又来了一个 name。
        // 以前会把两个调用的参数拼成 "{}{}"，导致“参数不是合法 JSON”
        if (slot !== undefined) {
          const prev = calls[slot];
          if ((tc.id && prev.id && tc.id !== prev.id) || (tc.function?.name && prev.name && isCompleteJson(prev.args))) slot = undefined;
        }
        if (slot === undefined) {
          slot = calls.push({ id: "", name: "", args: "" }) - 1;
          slotOf.set(idx, slot);
        }
        const p = calls[slot];
        if (tc.id) p.id = tc.id;
        if (tc.function?.name) p.name = tc.function.name;
        if (tc.function?.arguments) p.args += tc.function.arguments;
        // 同时把增量推给界面：写长代码时用户能实时看到内容，而不是干等
        if (tc.function?.arguments) yield { type: "tool_call_delta", index: slot, name: p.name, delta: tc.function.arguments };
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    // 流结束后，把拼好的工具调用按顺序发出
    for (const [i, p] of calls.entries()) {
      if (!p.name) continue; // 没有名字的残片，执行不了
      const call: ToolCall = { id: p.id || `call_${i}_${Date.now()}`, name: p.name, arguments: p.args || "{}" };
      yield { type: "tool_call", call };
    }
    yield { type: "done", finishReason, usage };
  }
}

/* ---------------- 格式转换 ---------------- */

function toOpenAI(m: ChatMessage, sendReasoning: boolean) {
  if (m.role === "assistant") {
    const out: Record<string, unknown> = { role: "assistant", content: m.content || (m.toolCalls?.length ? null : "") };
    if (m.toolCalls?.length) {
      out.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }));
    }
    if (sendReasoning && m.reasoning) out.reasoning_content = m.reasoning;
    return out;
  }
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  return { role: m.role, content: m.content };
}

type OAUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
};
type OAChunk = {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: OAUsage | null;
};

function toUsage(u: OAUsage): Usage {
  return {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    cacheHitTokens: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens,
  };
}

/* ---------------- SSE 解析 ---------------- */

/** 把字节流按 SSE 规则切成一条条 data（一条可能跨多个网络包，所以要缓冲） */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  if (buf.startsWith("data:")) yield buf.slice(5).trim();
}

/* ---------------- 工具函数 ---------------- */

function isCompleteJson(s: string) {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

export function joinUrl(base: string, path: string) {
  return base.replace(/\/+$/, "") + path;
}

/** 把 API 的错误响应翻译成一句人能看懂的话 */
export async function readError(res: Response) {
  let msg = "";
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t);
      msg = j.error?.message || j.message || t;
    } catch {
      msg = t;
    }
  } catch {
    /* ignore */
  }
  const hint =
    res.status === 401 ? "（API Key 无效）" : res.status === 402 ? "（账户余额不足）" : res.status === 404 ? "（地址或模型名不对）" : res.status === 429 ? "（请求太频繁或额度用完）" : "";
  return `模型接口返回 ${res.status}${hint}：${msg.slice(0, 300)}`;
}
