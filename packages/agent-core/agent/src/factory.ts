import type { Context } from "@A-ai/cordis";
import { AgentTools } from "../../../tool-runtime/src/agent-tools";
import { createInbox } from "../../inbox/src/index";
import { createAgentLifecycle } from "./lifecycle";
import type { AgentHandle } from "./runtime-types";
import { createAgentRuntime } from "./scope";

/** 工厂收到已校验的会话身份，登记由 Registry 完成。 */
export type AgentFactory = (sessionId: string, userId: string, pluginIds: readonly string[]) => AgentHandle | Promise<AgentHandle>;

/** Host 提供依赖，owner 持有实例的关闭权。每个实例的装配和收尾归同一个 Cordis effect。 */
export async function createAgentInstance(host: Context, owner: Context, sessionId: string, userId: string, pluginIds: readonly string[]): Promise<AgentHandle> {
  const scoped = owner.isolate("agentIdentity").isolate("agentSession").isolate("models").isolate("tools");
  const fiber = scoped.plugin(function agentScope(ctx) {
    ctx.provide("agentIdentity", { sessionId, userId });
    ctx.provide("agentSession", host.agentSessions.bind(sessionId, userId));
    ctx.provide("models", host.models);
    new AgentTools(ctx, host.hostTools);
  });
  let lifecycle: ReturnType<typeof createAgentLifecycle> | undefined;
  let disposal: Promise<void> | undefined;
  let closing = false;
  let finishClose!: () => void;
  const closed = new Promise<void>((resolve) => { finishClose = resolve; });
  let release: (() => void | Promise<void>) | undefined;
  const dispose = () => {
    disposal ??= (async () => {
      await release?.();
      await closed;
    })();
    return disposal;
  };

  try {
    // 反向释放：先停运行，再释放 Scope，最后通知 Registry。也适用于 owner 自身先关闭。
    release = owner.effect(function* () {
      yield finishClose;
      yield fiber.dispose;
      yield () => {
        closing = true;
        return lifecycle?.dispose();
      };
    }, "agent.lifecycle");
    const { ctx } = await fiber;
    ctx.fiber.assertActive();
    if (closing) throw new Error("Agent 所有者已开始关闭");
    const sessionPort = ctx.agentSession;
    const inbox = createInbox(sessionId, host.queueClock, sessionPort);
    lifecycle = createAgentLifecycle(sessionId, userId, inbox, createAgentRuntime(ctx), sessionPort);
    for (const id of pluginIds) {
      const definition = host.agentPlugins.get(id);
      if (!definition) continue;
      const plugin = await ctx.plugin(definition.plugin);
      if (!plugin.committed) throw new Error(`Agent 插件依赖不可用：${id}`);
    }
    ctx.fiber.assertActive();
    if (closing) throw new Error("Agent 所有者已开始关闭");
    return { agent: lifecycle.agent, closed, dispose };
  } catch (error) {
    const cleanup = release ? dispose() : fiber.dispose();
    await cleanup.catch((reason) => host.logger.error(reason));
    throw error;
  }
}
