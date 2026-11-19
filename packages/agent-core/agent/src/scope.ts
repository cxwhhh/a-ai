import { Context, type Plugin } from "@A-ai/cordis";
import type { getProvider } from "../../../llm/src/index";
import type { AgentTools } from "../../../tool-runtime/src/agent-tools";
import type { ToolRegistry } from "../../../tool-runtime/src/types";
import type { AgentEvent } from "../../../protocol/src/lib/shared";
import type { AgentSession, AgentSessionService } from "../../../session/src/agent-session";
import type { QueueClock } from "../../inbox/src/clock";

export interface AgentIdentity {
  sessionId: string;
  userId: string;
}

export type AgentPluginCatalog = ReadonlyMap<string, {
  title: string;
  plugin: Plugin;
}>;

interface AgentTurnSetup {
  runId: string;
  inputId: string;
  signal: AbortSignal;
  addPrompt(text: string): void;
}

declare module "@A-ai/cordis" {
  interface Context {
    agentIdentity: AgentIdentity;
    agentSession: AgentSession;
    agentSessions: AgentSessionService;
    agentPlugins: AgentPluginCatalog;
    queueClock: QueueClock;
    models: typeof getProvider;
    /** Host 共享内置工具的查询接口，各 Agent 的 tools 负责自己的扩展。 */
    hostTools: ToolRegistry;
    tools: AgentTools;
  }
  interface Events {
    "agent/event"(event: AgentEvent): void;
    "agent/turn-setup"(setup: AgentTurnSetup): void | Promise<void>;
  }
}

export type AgentRuntime = ReturnType<typeof createAgentRuntime>;

/** 通过 Cordis 解析服务和监听器；同一会话重建实例时也会取得新的作用域标签。 */
export function createAgentRuntime(ctx: Context) {
  const label = ctx[Context.isolate].agentIdentity;
  const target = {
    [Context.filter]: (listener: Context) => listener[Context.isolate].agentIdentity === label
  };
  return {
    models: ctx.models,
    tools: ctx.tools,
    onEvent(listener: (event: AgentEvent) => void) {
      return ctx.on("agent/event", listener);
    },
    emitEvent(event: AgentEvent) {
      const callbacks = ctx.events.dispatch("emit", [target, "agent/event", event]);
      for (const callback of callbacks) {
        // 单个观察插件失败时，后续监听器仍须收到事件，运行也必须完成收尾。
        try {
          void Promise.resolve(callback(event)).catch((error) => ctx.logger.error(error));
        } catch (error) {
          ctx.logger.error(error);
        }
      }
    },
    async setupTurn(runId: string, inputId: string, signal: AbortSignal): Promise<string> {
      const sections: string[] = [];
      await ctx.serial(target, "agent/turn-setup", {
        runId,
        inputId,
        signal,
        addPrompt(text: string) { if (text.trim()) sections.push(text.trim()); }
      });
      return sections.join("\n\n");
    }
  };
}
