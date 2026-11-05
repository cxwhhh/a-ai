import type { LLMProvider } from "./types";
import { MockProvider } from "./providers/mock";
import { OpenAICompatibleProvider } from "./providers/openai-compatible";
import type { Settings } from "../settings";

export * from "./types";

/**
 * 根据设置里选中的模型，创建对应的 provider。
 *   "mock"                 → MockProvider（不联网演示）
 *   "连接id/模型名"         → OpenAICompatibleProvider（DeepSeek 等）
 * 新增一种协议（比如 Anthropic 原生协议）= 写一个新 provider 类，在这里加一个分支。
 */
export function getProvider(s: Pick<Settings, "connections" | "currentModel">): LLMProvider {
  if (!s.currentModel || s.currentModel === "mock") return new MockProvider();
  const slash = s.currentModel.indexOf("/");
  const connId = s.currentModel.slice(0, slash);
  const model = s.currentModel.slice(slash + 1);
  const c = s.connections.find((x) => x.id === connId);
  if (!c) throw new Error("所选模型的连接已被删除，请在输入框下方重新选择模型");
  if (!c.apiKey) throw new Error(`连接「${c.name}」还没有填写 API Key（设置 → 模型）`);
  if (!c.baseUrl) throw new Error(`连接「${c.name}」还没有填写 Base URL（设置 → 模型）`);
  return new OpenAICompatibleProvider({
    baseUrl: c.baseUrl,
    apiKey: c.apiKey,
    model,
    sendReasoning: c.sendReasoning,
    thinking: c.thinking === "default" ? undefined : c.thinking,
    label: `${c.name} · ${model}`,
  });
}
