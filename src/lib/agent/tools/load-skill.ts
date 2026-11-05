import "server-only";
import type { Tool } from "./types";
import { activeSkills } from "../../server/skills";
import { BUILTIN_SKILLS } from "../builtin-skills";

/** load_skill 的结果开头。学习模块（learn.ts）和 mock 模型靠它认出“这一轮用了哪个技能” */
export const SKILL_MARK = "【技能】";

/**
 * 读取一个技能的完整内容（步骤、用哪些工具、踩过的坑）。
 *
 * 为什么不把技能全文直接放进系统提示词：技能多了以后每次请求都要带上几千字，又贵又会稀释重点。
 * 现在提示词里只有“技能目录”（名字 + 一句话，见 server/skills.ts 的 skillsPrompt），
 * 模型判断这次的任务用得上，再调用这个工具读全文 —— 按需加载，和 Hermes / Claude 的 Skills 一样。
 *
 * 只能读“已启用”的技能：待确认、停用的技能对模型不可见。
 * 用了技能以后这一轮顺不顺利，由 learn.ts 在本轮结束后记录，并在出问题时改进技能。
 */
export const loadSkill: Tool<{ name: string }> = {
  parallelSafe: true,
  spec: {
    name: "load_skill",
    description:
      "读取一个已学会的技能的完整步骤。系统提示词的“你学会的技能”里列出了可用的技能和适用场景；任务对得上时，动手之前先调用它，再按步骤做。" +
      "不要用于：目录里没有的技能、和任务无关的技能。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "技能名字，和技能目录里写的一样。例：周报生成" },
      },
      required: ["name"],
    },
  },
  async run({ name }, ctx) {
    if (!ctx.userId) throw new Error("没有用户信息，读不了技能");
    const want = String(name ?? "").trim();
    // 用户学会的技能在前（同名时以用户的为准），内置技能（builtin-skills.ts）在后
    const learned = activeSkills(ctx.userId);
    const all = [...learned, ...BUILTIN_SKILLS.filter((b) => !learned.some((s) => s.name === b.name)).map((b) => ({ ...b, version: 1, uses: 0, successes: 0, builtin: true }))];
    // 先精确匹配，再忽略大小写和空格，最后互相包含（模型偶尔会少写或多写几个字）
    const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
    const s =
      all.find((x) => x.name === want) ??
      all.find((x) => norm(x.name) === norm(want)) ??
      all.find((x) => norm(x.name).includes(norm(want)) || norm(want).includes(norm(x.name)));
    if (!want || !s) throw new Error(`没有叫「${want}」的技能。已启用的技能：${all.map((x) => x.name).join("、")}。都对不上就不用技能，按常规方法做`);
    const stats = s.uses ? `，用过 ${s.uses} 次，顺利 ${s.successes} 次` : "";
    return {
      content: [
        `${SKILL_MARK}${s.name}（v${s.version}${stats}）`,
        `适用：${s.description}`,
        "",
        s.body,
        "",
        "---",
        "builtin" in s
          ? "这是内置的规范，按它来做；和用户的要求冲突时以用户为准。"
          : "按上面的步骤做；有不适用的地方按这次的实际情况调整。做完不用手动更新技能，系统会根据这次的结果自动改进它。",
      ].join("\n"),
    };
  },
};
