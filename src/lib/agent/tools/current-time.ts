import type { Tool } from "./types";

/** 最简单的工具：没有副作用，用来理解“模型调用 → 程序执行 → 结果回给模型”的完整过程 */
export const currentTime: Tool<{ timezone?: string }> = {
  parallelSafe: true,
  spec: {
    name: "current_time",
    description:
      "获取当前的日期、时间和星期，返回 {timezone, iso, text}。" +
      "适合：要知道精确到分钟的时间，或者另一个时区的时间（例：现在纽约几点）；要算“几天后、倒计时、年龄”时用它拿准确的起点。" +
      "不要用于：只需要今天日期时（系统提示的「运行环境」里已经有了）。",
    parameters: {
      type: "object",
      properties: {
        timezone: { type: "string", description: "IANA 时区名。例：Asia/Tokyo、Asia/Shanghai、America/New_York。用户没提时区就不填（用本机时区）" },
      },
    },
  },
  async run({ timezone }) {
    const now = new Date();
    const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const text = new Intl.DateTimeFormat("zh-CN", {
      timeZone: tz,
      dateStyle: "full",
      timeStyle: "long",
    }).format(now);
    return { content: JSON.stringify({ timezone: tz, iso: now.toISOString(), text }) };
  },
};
