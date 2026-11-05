import "server-only";
import { getMemory, saveMemory } from "../../server/memory";
import { getSettings } from "../../server/settings";
import type { Tool } from "./types";

/**
 * 主动记住用户的信息。
 * A.ai 本来就会在每轮对话结束后自动反思、更新长期记忆（reflect.ts），但那是“事后、由另一个模型判断值不值得记”。
 * 用户明确说“记住：以后报告都用日语写”时，应该当场记下、马上生效，而不是赌反思会不会挑中它。
 * 写进的是同一份记忆（memories 表），设置 → 记忆 里能看到、能删。
 */
type Args = { action: "add_habit" | "set_profile" | "forget"; text: string };

export const remember: Tool<Args> = {
  spec: {
    name: "remember",
    description:
      "把用户明确要求记住的事写进长期记忆，以后的对话都会看到，返回当前的记忆。" +
      "action：add_habit 记一条习惯或偏好（例：报告用日语写、金额用万元）；set_profile 设置职业 / 背景（整句替换）；forget 删掉包含 text 的习惯。" +
      "适合：用户说“记住…”“以后都…”“别再…”，或者纠正了一个以后也适用的偏好。" +
      "不要用于：只对这一次任务有用的信息；密码、密钥、身份证号这类敏感信息（不要记）。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add_habit", "set_profile", "forget"], description: "要做的操作" },
        text: { type: "string", description: "要记住（或删除）的内容，一句话，写成以后也能直接照做的规则。例：周报用日语写，结尾附下周计划" },
      },
      required: ["action", "text"],
    },
  },
  async run({ action, text }, ctx) {
    if (!ctx.userId) throw new Error("没有登录用户，无法保存记忆");
    const t = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!t) throw new Error("text 不能为空：写要记住的那句话");
    if (/(password|passwd|密码|api[_ -]?key|secret|token|身份证)/i.test(t) && action !== "forget")
      throw new Error("看起来是密码、密钥或证件号这类敏感信息，不写进长期记忆。告诉用户这类信息不会被保存");
    const m = getMemory(ctx.userId);
    let changed = true;
    if (action === "set_profile") m.profile = t;
    else if (action === "add_habit") {
      if (m.habits.some((h) => h === t)) changed = false;
      else m.habits = [t, ...m.habits]; // 新的放前面：超出上限时丢掉最旧的
    } else if (action === "forget") {
      const before = m.habits.length;
      m.habits = m.habits.filter((h) => !h.includes(t));
      changed = m.habits.length !== before;
      if (m.profile.includes(t)) {
        m.profile = "";
        changed = true;
      }
    } else throw new Error(`action 只能是 add_habit、set_profile、forget，收到：${action}`);
    const saved = changed ? saveMemory(ctx.userId, m) : m;
    const enabled = getSettings(ctx.userId).memory;
    return {
      content: JSON.stringify({
        saved: changed,
        profile: saved.profile,
        habits: saved.habits,
        ...(changed ? {} : { note: action === "forget" ? "没有找到包含这段文字的记忆" : "这条已经记过了" }),
        ...(enabled ? {} : { warning: "已保存，但用户在设置里关闭了“记忆”功能，以后的对话暂时不会用到。告诉用户可以在 设置 → 记忆 里打开" }),
      }),
    };
  },
};
