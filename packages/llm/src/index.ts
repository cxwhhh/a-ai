import type { LLMProvider } from "./types";
import { MockProvider } from "./providers/mock";
import { OpenAICompatibleProvider } from "./providers/openai-compatible";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenAIResponsesProvider } from "./providers/openai-responses";
import { openAIReasoningProtocol, reasoningOptions, type Settings } from "../../protocol/src/lib/settings";

export * from "./types";

/**
 * 根据设置里选中的模型，创建对应的 provider。
 *   "mock"                 → MockProvider（不联网演示）
 *   "连接id/模型名"         → 按连接和模型使用 Chat Completions、Claude Messages 或 OpenAI Responses
 * 新增一种协议（比如 Anthropic 原生协议）= 写一个新 provider 类，在这里加一个分支。
 */
export function getProvider(s: Pick<Settings, "connections" | "currentModel"> & Partial<Pick<Settings, "reasoningEffort">>): LLMProvider {
  if (!s.currentModel || s.currentModel === "mock") return new MockProvider();
  const slash = s.currentModel.indexOf("/");
  const connId = s.currentModel.slice(0, slash);
  const model = s.currentModel.slice(slash + 1);
  const c = s.connections.find((x) => x.id === connId);
  if (!c) throw new Error("所选模型的连接已被删除，请在输入框下方重新选择模型");
  if (!c.apiKey) throw new Error(`连接「${c.name}」还没有填写 API Key（设置 → 模型）`);
  if (!c.baseUrl) throw new Error(`连接「${c.name}」还没有填写 Base URL（设置 → 模型）`);
  const selection = s.reasoningEffort ?? "default";
  if (!reasoningOptions(s, s.currentModel).includes(selection)) throw new Error("该模型不支持所选思考强度");
  const effort = selection === "default" ? undefined : selection;
  const options = { baseUrl: c.baseUrl, apiKey: c.apiKey, model, label: `${c.name} · ${model}`, effort };
  // Claude 用 Anthropic 自己的协议（官方 SDK），不走 OpenAI 兼容
  if (c.preset === "anthropic") return new AnthropicProvider(options);
  const protocol = openAIReasoningProtocol(c, model);
  if (protocol === "openai-responses") return new OpenAIResponsesProvider({ ...options, source: s.currentModel });
  // 只有原生 DeepSeek 需要显式开启思考并回传思考正文。标准 OpenAI 档位用 reasoning_effort。
  const deepSeekEffort = c.preset === "deepseek" && effort !== undefined;
  return new OpenAICompatibleProvider({
    ...options,
    sendReasoning: c.sendReasoning || deepSeekEffort,
    thinking: deepSeekEffort ? "enabled" : c.thinking === "default" ? undefined : c.thinking,
    completionTokenLimit: protocol === "openai-compatible",
  });
}
