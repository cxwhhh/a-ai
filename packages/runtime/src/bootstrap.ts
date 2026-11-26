import { Context } from "@A-ai/cordis";
import { createAgentInstance } from "../../agent-core/agent/src/factory";
import { createQueueClock } from "../../agent-core/inbox/src/clock";
import { AgentRegistry } from "../../agent-registry/src/index";
import { getProvider } from "../../llm/src/index";
import { deferredCatalog, findTool, toolSpecs, toolsFor } from "../../tool-runtime/src/index";
import { Scheduler } from "../../scheduler/src/index";
import { SubagentOrchestrator } from "../../subagent/src/subagent";
import { agentSessions } from "../../session/src/agent-session";
import { builtinAgentPlugins } from "./agent-plugins";
import path from "node:path";
import { DATA_DIR } from "../../storage/src/db";
import { StorageManager } from "../../storage-manager/src/index";
import { closeEvaluationSandboxes, startSandboxStorage } from "../../sandbox/src/sandbox";

declare module "@A-ai/cordis" {
  interface Context {
    agents: AgentRegistry;
    scheduler: Scheduler;
    subagents: SubagentOrchestrator;
    storageManager: StorageManager;
  }
}

const builtinTools = { deferredCatalog, findTool, toolSpecs, toolsFor };

/** 一个 Host 装配一套服务。会话与运行身份由 Harness 校验，Context 用于装配和释放服务。 */
export async function bootstrap() {
  const root = new Context();
  await root.plugin(function storage(ctx) {
    const service = new StorageManager(process.env.A_STORAGE_MANAGER_DIR || path.join(DATA_DIR, "storage-manager"));
    service.start();
    startSandboxStorage();
    ctx.provide("storageManager", service);
    ctx.effect(() => () => service.close());
  });
  await root.plugin(function models(ctx) { ctx.provide("models", getProvider); });
  await root.plugin(function tools(ctx) { ctx.provide("hostTools", builtinTools); });
  await root.plugin(function agentServices(ctx) {
    ctx.provide("queueClock", createQueueClock());
    ctx.provide("agentPlugins", builtinAgentPlugins);
    ctx.provide("agentSessions", agentSessions);
  });
  await root.plugin(function scheduler(ctx) {
    const scheduler = new Scheduler();
    ctx.provide("scheduler", scheduler);
    ctx.effect(() => () => scheduler.stopAccepting());
  });
  await root.plugin(function subagents(ctx) {
    const service = new SubagentOrchestrator();
    ctx.provide("subagents", service);
    ctx.effect(() => () => service.close());
  });
  await root.inject(["models", "hostTools", "queueClock", "agentPlugins", "agentSessions"], function registry(owner) {
    // 共享依赖来自 Host，实例的 Scope 由 Registry 所在的 Cordis fiber 持有。
    const agents = new AgentRegistry((sessionId, userId, plugins) => createAgentInstance(root, owner, sessionId, userId, plugins));
    owner.provide("agents", agents);
    owner.effect(() => () => agents.disposeAll());
  });
  return { root, close: async () => {
    try { await root.fiber.dispose(); }
    finally { await closeEvaluationSandboxes(); }
  } };
}
