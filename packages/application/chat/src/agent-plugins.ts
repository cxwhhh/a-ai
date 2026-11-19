import type { AgentPluginCatalog } from "../../../agent-core/agent/src/scope";
import type { AgentRegistry } from "../../../agent-registry/src/index";
import { readAgentPlugins, writeAgentPlugins } from "../../../session/src/agent-plugins";

export function getAgentPluginSettings(sessionId: string, userId: string, catalog: AgentPluginCatalog) {
  const enabled = readAgentPlugins(sessionId, userId);
  if (!enabled) return null;
  const available = [...catalog].map(([id, { title }]) => ({ id, title }));
  return { enabled, available };
}

/** 在实例空闲且没有待消费输入时更新配置，下一次打开会话使用新的 Scope。 */
export async function configureAgentPlugins(sessionId: string, userId: string, input: unknown, catalog: AgentPluginCatalog, agents: AgentRegistry) {
  const settings = getAgentPluginSettings(sessionId, userId, catalog);
  if (!settings) return { status: "missing" } as const;
  if (!Array.isArray(input) || !input.every((id): id is string => typeof id === "string" && catalog.has(id))) {
    return { status: "invalid" } as const;
  }
  const enabled = [...new Set(input)].sort();
  if (enabled.length === settings.enabled.length && enabled.every((id, index) => id === settings.enabled[index])) {
    return { status: "ok", settings } as const;
  }
  const agent = agents.get(sessionId, userId);
  if (agents.isInitializing(sessionId, userId) || (agent && (agent.status !== "idle" || agent.queueSnapshot().items.length))) {
    return { status: "busy" } as const;
  }
  if (!writeAgentPlugins(sessionId, userId, enabled)) return { status: "missing" } as const;
  // 写配置到标记实例关闭之间保持同步，期间不会有新的请求取得旧实例的运行权。
  await agents.dispose(sessionId, userId);
  return { status: "ok", settings: { ...settings, enabled } } as const;
}
