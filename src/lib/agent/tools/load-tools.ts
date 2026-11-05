import type { Tool } from "./types";

/**
 * load_tools：按需加载工具的“开关”。
 *
 * 为什么需要它：工具越来越多（25 个，说明书约 1.9 万字），每一步请求都要把全部说明书发给模型，
 * 又占上下文、又贵，工具一多模型还更容易选错。所以工具分成两类（见 index.ts）：
 *   - 常用工具：每一步都带完整说明书（读写文件、终端、搜索……）
 *   - 按需工具：系统提示词里只有一行“名字 + 用途”的目录（见 deferredCatalog）
 *
 * 模型怎么知道要加载哪个：不是程序去猜用户想要什么，而是模型自己读目录做判断。
 * 例如用户说“做成 Word 发我”，模型在目录里看到“write_document：生成 Word/Excel/PPT 文件”，
 * 就先调用 load_tools({names:["write_document"]})。这个工具本身什么都不执行，只回一句“已加载”；
 * 真正起作用的是 run.ts：每一步发请求前从对话历史里找出“已经加载过哪些工具”，把它们的完整说明书加进 tools 列表，
 * 所以下一步模型就能看到参数、正常调用了。
 *
 * 和 load_skill 是同一个思路：目录常驻、全文按需（技能是“怎么做”，工具是“能做什么”）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeLoadTools(deferred: () => Tool<any>[]): Tool<{ names: string[] }> {
  return {
    parallelSafe: true,
    spec: {
      name: "load_tools",
      description:
        "加载系统提示词「按需加载的工具」目录里的工具。加载后下一步起就能像其他工具一样调用（能看到完整参数）。" +
        "任务需要目录里的工具时先调用它，用得上几个就一次加载几个；同一个会话里加载过的不用再加载。" +
        "不要用于：已经能直接调用的工具。",
      parameters: {
        type: "object",
        properties: {
          names: { type: "array", items: { type: "string" }, description: '要加载的工具名，和目录里写的一样。例：["write_document"]、["query_data","make_chart"]' },
        },
        required: ["names"],
      },
    },
    async run({ names }) {
      const all = deferred();
      const want = [...new Set((names ?? []).map((n) => String(n).trim()).filter(Boolean))];
      const found = all.filter((t) => want.includes(t.spec.name));
      const unknown = want.filter((n) => !found.some((t) => t.spec.name === n));
      if (!found.length) {
        throw new Error(`目录里没有 ${unknown.join("、")}。能加载的是：${all.map((t) => t.spec.name).join("、")}；其他工具已经可以直接调用，不用加载`);
      }
      return {
        content: JSON.stringify({
          loaded: found.map((t) => t.spec.name),
          ...(unknown.length ? { unknown, note: "这些不在目录里：要么已经能直接调用，要么不存在" } : {}),
          next: "下一步起可以直接调用，完整参数见工具列表",
        }),
      };
    },
  };
}
