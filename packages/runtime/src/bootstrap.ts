import { Context } from "@A-ai/cordis";
import { AgentRegistry } from "../../agent-registry/src/index";
import { getProvider } from "../../llm/src/index";
import { deferredCatalog, findTool, toolSpecs, toolsFor } from "../../tool-runtime/src/index";
import { Scheduler } from "../../scheduler/src/index";

declare module "@A-ai/cordis" {
  interface Context {
    agents: AgentRegistry;
    scheduler: Scheduler;
    models: typeof getProvider;
    tools: typeof builtinTools;
  }
}

const builtinTools = { deferredCatalog, findTool, toolSpecs, toolsFor };

/** 一个 Host 装配一套服务。会话与运行身份由 Harness 校验，Context 用于装配和释放服务。 */
export async function bootstrap() {
  const root = new Context();
  await root.plugin(function models(ctx) { ctx.provide("models", getProvider); });
  await root.plugin(function tools(ctx) { ctx.provide("tools", builtinTools); });
  await root.plugin(function registry(ctx) {
    const agents = new AgentRegistry();
    ctx.provide("agents", agents);
    ctx.effect(() => () => agents.disposeAll());
  });
  await root.plugin(function scheduler(ctx) {
    const scheduler = new Scheduler();
    ctx.provide("scheduler", scheduler);
    ctx.effect(() => () => scheduler.stopAccepting());
  });
  return { root, close: () => root.fiber.dispose() };
}
