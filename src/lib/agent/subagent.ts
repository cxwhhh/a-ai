import "server-only";
import type { ChatMessage, LLMProvider, ToolCall, ToolSpec, Usage } from "../llm/types";
import { logUsage } from "../server/usage";
import { normalizeArgs, parseToolArgs } from "./args";
import { findTool, toolSpecs } from "./tools/index";
import { withPurpose } from "./tools/validate";

/**
 * 调研子 agent（第 4 步的“更进一步”）：主 agent 调用 research 工具，把一个调研类子任务交给它。
 *
 * 为什么要子 agent：调研要搜很多网页、翻很多文件，原始结果动辄几万字。
 * 全塞进主 agent 的上下文，后面每一步都要背着它们（更贵、更慢，也更容易“看花眼”）。
 * 子 agent 用自己独立的上下文做完调研，只把结论和来源交回来，主 agent 只多了几百字。
 * 几个 research 调用还能并行跑（例如同时调研三家公司）。
 *
 * 子 agent 只有只读工具：不能写文件、不能运行代码、不能问用户。所以它不需要确认，也不会改坏东西。
 * 它是一个精简版的 ReAct 循环：不存数据库、不压缩上下文、不走反馈闭环，最多 MAX_STEPS 步。
 */

const MAX_STEPS = 8;
/** 单个工具结果在子 agent 上下文里最多保留多少字 */
const MAX_RESULT = 8000;
const TOOLS = ["web_search", "web_fetch", "read_file", "read_document", "grep", "glob", "list_files", "calculator", "current_time"];

// 和其他工具一样，purpose 必填并排在第一个（见 tools/validate.ts）
export const RESEARCH_SPEC: ToolSpec = withPurpose({
  name: "research",
  description:
    "把一个调研类子任务交给调研子 agent：它用自己独立的上下文搜索网页、读文件，最后只交回结论、要点和来源。" +
    "适合：要看很多网页或文件才能回答的问题（对比几个方案、查一家公司的情况、在一堆文档里找答案）；几个独立的调研可以在同一步并行发出。" +
    "不适合：一次 web_search / read_file 就能解决的小问题（直接自己调用更快）；需要写文件、运行代码或问用户的事（子 agent 只有只读工具）。" +
    "task 要写清楚：要回答什么、范围（网站、目录、时间）、交回什么格式。子 agent 看不到当前对话，需要的背景都写进 task。",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "交给子 agent 的完整任务说明，包括背景、要回答的问题、范围和交回格式" },
      purpose: { type: "string", description: "一句话说明这次调研的目的，显示在过程里。例：对比三家东京 AI 公司的招聘要求" },
    },
    required: ["task"],
  },
});

const SYSTEM = `你是 A.ai 的调研子 agent。主 agent 把一个调研任务交给你，你独立完成，最后交回一份简洁的调研结果。

- 先想清楚要回答什么，再动手；互不依赖的搜索和读取放在同一步一起发出。
- 只用工具拿到的信息，不要编造；查不到就说查不到，并说明查过哪些地方。
- 网页先 web_search，再 web_fetch 打开最相关的 2～4 个结果；文件先 glob / grep 缩小范围，再 read_file 读需要的部分。
- 最多 ${MAX_STEPS} 步，信息够了就停，不要追求面面俱到。
- 最终回答的格式：
  ## 结论
  一到三句话直接回答任务。
  ## 要点
  - 关键事实，每条后面注明来源（网址或文件路径）
  ## 没查到 / 不确定
  - （没有就写“无”）`;

export interface ResearchCtx {
  provider: LLMProvider;
  userId: string;
  sessionId: string;
  workspace: string;
  signal?: AbortSignal;
  disabled: Record<string, string>;
  /** 进度推给前端（显示在 research 这一步里） */
  onOutput(text: string): void;
}

export async function runResearch(call: ToolCall, ctx: ResearchCtx): Promise<{ content: string; isError?: boolean }> {
  const parsed = parseToolArgs(call.arguments);
  const task = parsed.ok ? String(parsed.args.task ?? "").trim() : "";
  if (!task) return { content: "工具执行失败：research 需要 task 参数，写清楚要调研什么、范围和交回格式。", isError: true };

  const tools = toolSpecs().filter((t) => TOOLS.includes(t.name) && !ctx.disabled[t.name]);
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: task },
  ];
  const log: string[] = [];
  const total: Usage = { inputTokens: 0, outputTokens: 0 };
  let answer = "";

  for (let step = 0; step < MAX_STEPS; step++) {
    if (ctx.signal?.aborted) break;
    const last = step === MAX_STEPS - 1;
    if (last) messages.push({ role: "user", content: "步数用完了，不能再调用工具。根据已有结果按格式给出最终调研结果。" });
    const t0 = Date.now();
    let text = "";
    const calls: ToolCall[] = [];
    let usage: Usage | undefined;
    for await (const chunk of ctx.provider.stream({ messages, tools: last ? undefined : tools, signal: ctx.signal })) {
      if (chunk.type === "text") text += chunk.delta;
      else if (chunk.type === "tool_call") calls.push({ ...chunk.call, arguments: normalizeArgs(chunk.call.arguments) });
      else if (chunk.type === "done" && chunk.usage) usage = chunk.usage;
    }
    if (usage) {
      total.inputTokens += usage.inputTokens;
      total.outputTokens += usage.outputTokens;
      logUsage(ctx.userId, ctx.sessionId, "chat", usage, t0);
    }
    if (!calls.length || last) {
      answer = text.trim();
      break;
    }
    messages.push({ role: "assistant", content: text, toolCalls: calls });
    // 子 agent 的工具都是只读的，一步里的调用全部并行
    const results = await Promise.all(calls.map((c) => execReadOnly(c, ctx)));
    calls.forEach((c, i) => {
      const line = `${results[i].isError ? "✗" : "✓"} ${c.name} ${brief(c)}`;
      log.push(line);
      ctx.onOutput(line + "\n");
      messages.push({ role: "tool", toolCallId: c.id, content: results[i].content.slice(0, MAX_RESULT) });
    });
  }

  if (!answer) return { content: "工具执行失败：调研子 agent 没有给出结果" + (ctx.signal?.aborted ? "（已停止）" : ""), isError: true };
  // 过程也写进结果：刷新页面后实时输出没了，靠这几行还能看到子 agent 查过哪些地方
  return {
    content: `${answer}\n\n---\n子 agent 用了 ${log.length} 次工具、${fmtK(total.inputTokens + total.outputTokens)} token：\n${log.join("\n") || "（没有调用工具）"}`,
  };
}

async function execReadOnly(call: ToolCall, ctx: ResearchCtx): Promise<{ content: string; isError?: boolean }> {
  const tool = findTool(call.name);
  if (!tool || !TOOLS.includes(call.name)) return { content: `工具执行失败：子 agent 只能用 ${TOOLS.join("、")}`, isError: true };
  const parsed = parseToolArgs(call.arguments);
  if (!parsed.ok) return { content: `工具执行失败：${parsed.error}`, isError: true };
  try {
    const r = await tool.run(parsed.args, {
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      workspace: ctx.workspace,
      signal: ctx.signal,
      emitArtifact: () => {
        throw new Error("子 agent 不能生成产出物");
      },
      confirm: async () => false,
    });
    return { content: r.content };
  } catch (e) {
    return { content: `工具执行失败：${e instanceof Error ? e.message : String(e)}`, isError: true };
  }
}

/** 进度里显示的一小段参数：搜什么、读哪个文件 */
function brief(c: ToolCall) {
  const p = parseToolArgs(c.arguments);
  const a = p.ok ? p.args : {};
  const v = a.query ?? a.url ?? a.path ?? a.pattern ?? a.expression ?? "";
  return String(v).slice(0, 80);
}

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
