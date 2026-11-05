import type { Tool } from "./types";

/**
 * 向用户提问：需求不清楚、有几种做法要用户选、或者要做有风险的操作前，停下来问用户。
 *
 * 和别的工具不一样，它不“执行”什么：调用后本轮对话就结束（endsTurn），
 * 界面上显示一张提问卡片（问题 + 选项 + 补充想法的输入框）。
 * 用户的回答作为下一条普通的用户消息发回来，模型看到“自己的问题 + 用户的回答”，接着做下一步。
 *
 *   模型：ask_user("用哪种图表？", ["柱状图", "折线图"])  → 本轮结束，等待
 *   用户：选择：柱状图；补充：按月份排序                   → 新的一轮，模型继续
 */
export const askUser: Tool<{ question: string; options?: string[]; multiple?: boolean }> = {
  endsTurn: true,
  spec: {
    name: "ask_user",
    description:
      "向用户提一个问题并等待回答（调用后本轮结束，用户的回答会作为下一条用户消息发来）。" +
      "适合：需求有歧义、有几种做法需要用户选、缺少关键信息（路径、范围、格式、账号）、要做删除/覆盖等不可撤销的操作前确认、同一个问题试了几种办法都失败需要用户帮忙。一次只问一个最关键的问题，尽量给 2~5 个具体选项（用户也可以不选，自己写）。" +
      "不要用于：能自己查到或合理推断的事。单独调用，不要和其他工具放在同一轮。",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "问题，一句话，说清楚为什么要问。例：报表要按月还是按季度汇总？" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "可选的答案，2~5 个，每个尽量短。例：[\"按月\", \"按季度\"]。开放式问题可以不给",
        },
        multiple: { type: "boolean", description: "是否允许多选，默认 false" },
      },
      required: ["question"],
    },
  },
  async run({ question, options, multiple }) {
    const q = String(question ?? "").trim();
    if (!q) throw new Error("question 不能为空：写一句具体的问题，说清楚为什么要问");
    const opts = Array.isArray(options) ? options.map((o) => String(o).trim()).filter(Boolean).slice(0, 6) : [];
    return {
      content: JSON.stringify({
        status: "waiting_for_user",
        question: q,
        options: opts,
        multiple: !!multiple,
        note: "问题已显示给用户，本轮结束。用户的回答会作为下一条用户消息发来，收到后按回答继续。",
      }),
    };
  },
};
