import { Service, type Context } from "@A-ai/cordis";
import type { StoredMessage } from "../../protocol/src/lib/shared";
import type { Tool, ToolRegistry } from "./types";
import { prepare } from "./validate";

/** 内置目录供各 Agent 读取，只有本实例的插件可以修改自己的扩展工具。 */
export class AgentTools extends Service implements ToolRegistry {
  private readonly local = new Map<string, Tool<any>>();

  constructor(ctx: Context, private readonly base: ToolRegistry) {
    super(ctx, "tools");
  }

  register<Args>(tool: Tool<Args>): () => void | Promise<void> {
    const { name } = tool.spec;
    // 子任务工具由 Agent Loop 单独分发，保留其名称。
    if (name === "research" || name === "delegate_tasks" || this.base.findTool(name) || this.local.has(name)) {
      throw new Error(`工具名称已注册：${name}`);
    }
    const entry = prepare({ ...tool, spec: structuredClone(tool.spec) });
    // Cordis 将 this.ctx 绑定到调用插件。卸载插件时，只移除它登记的这一个工具。
    return this.ctx.effect(() => {
      this.local.set(name, entry);
      return () => {
        if (this.local.get(name) === entry) this.local.delete(name);
      };
    }, `tools.register(${name})`);
  }

  findTool(name: string) {
    const tool = this.local.get(name) ?? this.base.findTool(name);
    // 每次交出去的是说明书的副本，修改它不会污染目录或其他 Agent。
    return tool && { ...tool, spec: structuredClone(tool.spec) };
  }

  toolsFor(history: Pick<StoredMessage, "toolCalls">[], disabled: Record<string, string> = {}) {
    const tools = this.base.toolsFor(history, disabled);
    const extensions = [...this.local.values()].filter(({ spec }) => !disabled[spec.name]);
    return [...tools, ...extensions.map(({ spec }) => spec)].map((spec) => structuredClone(spec));
  }

  toolSpecs() {
    const extensions = [...this.local.values()].map(({ spec }) => spec);
    return [...this.base.toolSpecs(), ...extensions].map((spec) => structuredClone(spec));
  }

  deferredCatalog(disabled?: Record<string, string>) {
    return this.base.deferredCatalog(disabled);
  }
}
