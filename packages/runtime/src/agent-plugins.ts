import type { AgentPluginCatalog } from "../../agent-core/agent/src/scope";

/** Host 注册可选插件。会话配置只引用这里的 ID。 */
export const builtinAgentPlugins: AgentPluginCatalog = new Map([
  ["concise-replies", {
    title: "简洁回答",
    plugin: {
      inject: ["agentIdentity"],
      apply(ctx) {
        ctx.on("agent/turn-setup", ({ addPrompt }) => {
          addPrompt("答复时先给结论，省去重复背景，只保留完成任务所需的细节。");
        });
      }
    }
  }],
  ["structured-replies", {
    title: "结构化回答",
    plugin: {
      inject: ["agentIdentity"],
      apply(ctx) {
        ctx.on("agent/turn-setup", ({ addPrompt }) => {
          addPrompt("当答复包含多个主题时，用简短的小标题组织；需要比较多个选项时优先用表格。");
        });
      }
    }
  }]
]);
