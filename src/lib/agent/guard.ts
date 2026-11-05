import type { ToolCall } from "../llm/types";
import type { StoredMessage } from "../shared";
import { FEEDBACK_TAG } from "./verify";

/**
 * 防止“同一个错误反复撞”：模型看到报错后，常常原样再调一次，或者换个无关紧要的写法再撞同一堵墙
 * （路径不对、断网、没权限、文件不存在…），过程里就是一长串红色的失败，步数也被耗光。
 *
 * 两条规则，按一次 agent 运行（一轮对话）计数：
 *   1. 完全相同的调用（同一工具 + 同样的参数）已经失败 2 次 → 第 3 次直接拦下，不再执行
 *   2. 同一工具的“同一类错误”（报错第一行去掉数字、路径、引号里的内容后相同）
 *        第 2 次：在结果后面提醒“别再用同样的方式重试”
 *        第 3 次起：要求停止这种做法；缺条件（权限、网络、文件）时用 ask_user 告诉用户
 * 失败指 isError 的结果（工具抛错、参数不对、被拦截）；命令跑了但退出码非 0 归反馈闭环（verify.ts）管。
 * 它和 Verifier 一样只看调用和结果，不碰数据库，方便单独测试。
 */
export class CallGuard {
  private failedCalls = new Map<string, { n: number; error: string }>();
  private kinds = new Map<string, number>();

  /** 执行前：返回拦截原因（null = 放行） */
  before(call: ToolCall): string | null {
    const f = this.failedCalls.get(signature(call));
    if (!f || f.n < 2) return null;
    return (
      `${FEEDBACK_TAG}这个调用（${call.name}，参数完全相同）已经失败 ${f.n} 次，这次没有执行。上次的错误：${firstLine(f.error)}\n` +
      "请换一种方法：改参数、换工具，或者先查清原因（例如用 list_files / glob 确认路径）。如果是缺少权限、网络或文件，用 ask_user 告诉用户需要什么。"
    );
  }

  /** 执行后：记下失败，必要时在结果后面追加提醒。返回（可能改过的）结果 */
  after(call: ToolCall, result: StoredMessage): StoredMessage {
    if (!result.isError) return result;
    const sig = signature(call);
    const prev = this.failedCalls.get(sig);
    this.failedCalls.set(sig, { n: (prev?.n ?? 0) + 1, error: result.content });

    const kind = `${call.name}|${errorKind(result.content)}`;
    const n = (this.kinds.get(kind) ?? 0) + 1;
    this.kinds.set(kind, n);
    if (n === 2)
      result.content += `\n\n${FEEDBACK_TAG}${call.name} 已经第 2 次出现同一类错误。不要用同样的方式再试：先弄清原因，或者换一种方法。`;
    else if (n >= 3)
      result.content +=
        `\n\n${FEEDBACK_TAG}${call.name} 已经第 ${n} 次出现同一类错误，请停止这种做法。` +
        "换别的工具或思路完成任务；如果确实缺少条件（权限、网络、文件、配置），用 ask_user 告诉用户缺什么，或者在回答里如实说明。";
    return result;
  }
}

/** 工具名 + 规范化后的参数：键的顺序、空白不同也算同一个调用 */
function signature(call: ToolCall) {
  let args: unknown = call.arguments;
  try {
    args = sortKeys(JSON.parse(call.arguments || "{}"));
  } catch {
    /* 解析不了就按原文比 */
  }
  return `${call.name}|${JSON.stringify(args)}`;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}

/** 报错的“类型”：第一行去掉引号里的内容、路径、数字。 “文件不存在：a.txt” 和 “文件不存在：b.txt” 算同一类 */
export function errorKind(content: string) {
  const line = firstLine(content).replace(/^工具执行失败：/, "");
  // “文件不存在：a.txt”这种“原因：对象”的格式，只取冒号前面的原因
  const head = line.split(/[：:]\s*/)[0];
  return (head.length >= 2 && head.length < line.length ? head : line)
    .replace(/[「“"'`][^」”"'`]*[」”"'`]/g, "…")
    .replace(/(?:~|\.{0,2})?\/[^\s，。、；：:]+/g, "…")
    .replace(/\d+/g, "#")
    .slice(0, 80);
}

const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? "";
