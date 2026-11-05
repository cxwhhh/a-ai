import type { ToolCall } from "../llm/types";
import { toolStatus, type Feedback, type StoredMessage } from "../shared";
import { FEEDBACK_TAG } from "./verify";

/**
 * “掌舵”：在 agent 循环里适时推模型一把，让它少走弯路（第 1 步“行动前想清楚”、第 4 步“做错时拉一把”）。
 *
 *   规划    模型第一步回答以「【规划】」开头、没调用工具 → 不算交付，接着执行（见 isPlanOnly）
 *   自检    做过规划的任务，交付前发一次“对照要求逐条检查”（selfCheck，每轮最多一次）
 *   步数    用掉一半以上的步数后，每步在请求末尾提醒“还剩几步”（budgetHint，只发给模型，不存）
 *   卡住    连续 3 步没有新进展（都报错、重复调用、拿到的结果和以前一样）→ 要求停下来重新规划或提问（Progress）
 *
 * 和 verify.ts 的分工：Verifier 只管“代码有没有运行通过”，这里管“方向对不对、有没有在原地打转”。
 * 和 guard.ts 的分工：CallGuard 拦住“同一个调用失败两次还在调”，这里看的是更大的范围（几步都没进展）。
 */

export const PLAN_MARK = "【规划】";
/** 本轮环境快照（env.ts 的 turnEnv）附在用户消息末尾的格式；mock 模型靠它把快照去掉再看用户说了什么 */
export const ENV_RE = /\n*<环境>\n[\s\S]*?\n<\/环境>\s*$/;
/** 连续几步没进展就提醒 */
const STALL_STEPS = 3;
/** 每轮最多提醒几次“卡住了”，再多也没用，交给步数上限 */
const MAX_STALL_HINTS = 2;

/** 第一步只写了规划、没调用工具：继续执行，不当成最终回答 */
export const isPlanOnly = (step: number, content: string, calls: ToolCall[]) => step === 0 && !calls.length && content.trimStart().startsWith(PLAN_MARK);

/** 用了一半以上的步数后，每步附在请求末尾（不存进历史，不显示） */
export function budgetHint(step: number, budget: number): string | null {
  const left = budget - step; // 含这一步
  if (budget < 6 || step < Math.ceil(budget / 2) || left <= 1) return null;
  return `${FEEDBACK_TAG}本轮已用 ${step}/${budget} 步，还剩 ${left} 步（含最后的回答）。优先完成用户最核心的要求；剩 2 步时就该收尾交付，不要再开新的方向。`;
}

/** 交付前自检：只对做过规划的复杂任务发一次 */
export function selfCheck(): { content: string; feedback: Feedback } {
  return {
    feedback: { kind: "check", summary: "交付前对照要求自检" },
    content:
      `${FEEDBACK_TAG}交付前请自检：把用户这一轮的要求逐条列出来（包括格式、路径、数量、“不要改”之类的限制），每条写“满足 / 没满足 + 依据”。` +
      "依据要来自你实际看到的工具结果，不要凭印象。有没满足的就继续完成；全部满足就直接给出最终回答（不用重复自检清单，最多一句话说明已核对）。",
  };
}

/**
 * 进展追踪：一步里只要有一个工具“带来了新信息”，这一步就算有进展。
 * 新信息 = 没出错 + 不是之前调用过的同一个调用 + 结果内容以前没见过（同一个目录换个写法再列一次不算）。
 */
export class Progress {
  private calls = new Set<string>();
  private results = new Set<string>();
  private progressed = false;
  private streak = 0;
  private hints = 0;
  /** 最近几步没进展的原因，写进提醒里，让模型知道自己在干什么 */
  private why: string[] = [];

  observe(call: ToolCall, result: StoredMessage) {
    const sig = call.name + "\0" + canon(call.arguments);
    const body = hash(result.content);
    const repeated = this.calls.has(sig);
    const seen = this.results.has(body);
    this.calls.add(sig);
    this.results.add(body);
    const failed = toolStatus(result) !== "ok";
    if (!failed && !repeated && !seen) this.progressed = true;
    else this.why.push(`${call.name}${failed ? " 没有成功" : repeated ? " 重复调用" : " 结果和之前一样"}`);
  }

  /** 每步工具执行完调用。返回 null = 不用提醒 */
  endStep(): { content: string; feedback: Feedback } | null {
    this.streak = this.progressed ? 0 : this.streak + 1;
    if (this.progressed) this.why = [];
    this.progressed = false;
    if (this.streak < STALL_STEPS || this.hints >= MAX_STALL_HINTS) return null;
    this.hints++;
    this.streak = 0;
    const why = [...new Set(this.why.slice(-6))].join("、");
    this.why = [];
    return {
      feedback: { kind: "stall", summary: `连续 ${STALL_STEPS} 步没有新进展，要求重新规划` },
      content:
        `${FEEDBACK_TAG}最近 ${STALL_STEPS} 步没有拿到新信息（${why}）。先停下来，不要继续同样的做法：` +
        "用两三句话写出已经确认的事实、卡在哪里，然后换一条路重新规划下一步。" +
        "如果缺的是只有用户知道的信息（路径、账号、偏好、需求细节），用 ask_user 问用户。",
    };
  }
}

/** 参数规范化：键排序、去空白，{"a":1,"b":2} 和 { "b": 2, "a": 1 } 算同一个调用 */
function canon(args: string) {
  try {
    return JSON.stringify(sortKeys(JSON.parse(args || "{}")));
  } catch {
    return args.replace(/\s+/g, "");
  }
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "purpose").sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}

/** 简单的字符串哈希（FNV-1a），只用来判断“这个结果见过没有” */
function hash(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36) + ":" + s.length;
}
