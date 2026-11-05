import "server-only";
import type { Tool } from "./types";

/**
 * 任务清单（对应 Claude Code 的 TodoWrite）：模型给自己列计划、边做边打勾。
 *
 * 它不“做”任何事，作用全在模型身上：
 * - 复杂任务一开始先拆成步骤，后面每一步都能看到“还剩什么”，不容易做到一半忘了目标、或者提前宣布完成
 * - 清单在每次调用的结果里完整返回，就算前面的对话很长，最新的计划也总在最近的上下文里
 * - 用户在过程里能看到计划和进度（Trace 里显示成一个勾选列表）
 *
 * 每次调用传完整清单（不是增量），实现最简单，也不会出现“两边状态对不上”。
 * 服务端不用另外保存：清单就在对话历史里（这次调用的参数和结果），刷新页面、重启服务都不会丢。
 */
type Status = "pending" | "in_progress" | "completed";
interface Todo {
  content: string;
  status: Status;
}

export const todoWrite: Tool<{ todos: Todo[] }> = {
  spec: {
    name: "todo_write",
    description:
      "维护本次任务的待办清单：每次传入完整清单（会整体替换旧的），返回清单和进度。" +
      "适合：需要 3 步以上的任务。开始前先列出步骤；开始做某一步时把它标成 in_progress（同一时间只有一个），做完立刻标 completed，发现新的步骤就加进去。全部 completed 之前不要说任务已完成。" +
      "不要用于：简单问答、一两步就能做完的事。",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "完整的待办清单，按执行顺序",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "这一步要做什么，一句话。例：读取 sales.csv 并检查缺失值" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "pending=未开始，in_progress=进行中，completed=已完成" },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
  async run({ todos }) {
    if (!Array.isArray(todos)) throw new Error('todos 必须是数组，每项是 {content, status}。例：[{"content":"读取数据","status":"in_progress"}]');
    const list: Todo[] = todos
      .filter((t) => t && String(t.content ?? "").trim())
      .slice(0, 30)
      .map((t) => ({
        content: String(t.content).trim().slice(0, 200),
        status: t.status === "completed" || t.status === "in_progress" ? t.status : "pending",
      }));
    const done = list.filter((t) => t.status === "completed").length;
    const doing = list.filter((t) => t.status === "in_progress").length;
    return {
      content: JSON.stringify({
        todos: list,
        progress: `${done}/${list.length}`,
        ...(doing > 1 ? { note: "同一时间只应有一个 in_progress，请把其余的改回 pending 或 completed" } : {}),
        ...(list.length && done === list.length ? { note: "清单已全部完成，可以向用户交付结果" } : {}),
      }),
    };
  },
};
