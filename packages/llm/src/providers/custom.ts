import type { ChatRequest, LLMProvider, StreamChunk } from "../types";

/**
 * 【已被 openai-compatible.ts 取代，保留作为“自己实现一个 provider”的练习模板】
 *
 * ====== 在这里接你自己的 API ======
 *
 * 要做的事情只有一件：把 req 发给模型，然后把返回结果转换成 StreamChunk 逐个 yield 出来。
 *
 *   yield { type: "reasoning", delta: "..." }                  // 思维链增量（模型支持时，会显示在中栏思考链路里）
 *   yield { type: "text", delta: "..." }                       // 文字增量
 *   yield { type: "tool_call", call: { id, name, arguments } } // 工具调用（arguments 为 JSON 字符串，拼完整后再 yield）
 *   yield { type: "done", finishReason: "stop", usage: { inputTokens, outputTokens } } // 结束（usage 可选，用量页面会统计）
 *
 * req.messages 已经是 OpenAI 格式（toolCalls → tool_calls、toolCallId → tool_call_id 需要你按目标 API 改一下字段名）。
 * req.tools 是工具定义，按目标 API 的格式放进请求体即可。
 * req.signal 用于用户点击“停止”时中断请求，记得传给 fetch。
 *
 * 写完后在 .env.local 里设置 A_PROVIDER=custom。
 */
export class CustomProvider implements LLMProvider {
  readonly id: string;

  constructor(
    private readonly opts = {
      baseUrl: process.env.A_API_BASE ?? "",
      apiKey: process.env.A_API_KEY ?? "",
      model: process.env.A_MODEL ?? "",
    },
  ) {
    this.id = opts.model || "custom";
  }

  // eslint-disable-next-line require-yield
  async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
    void req;
    throw new Error("CustomProvider 尚未实现：请编辑 src/lib/llm/providers/custom.ts");
  }
}
