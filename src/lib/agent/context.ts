import "server-only";
import type { ChatMessage, LLMProvider, ToolSpec, Usage } from "../llm/types";
import type { StoredMessage } from "../shared";
import { estimateTokens } from "../tokens";
import { FEEDBACK_TAG } from "./verify";

/**
 * 上下文管理：决定“这一步发给模型的历史长什么样”。
 *
 * 以前每一步都把整个会话原样发过去：几十轮之后，每次调用都带着很久以前的网页全文、
 * 代码输出、思考过程，又慢又贵，最后还会超出模型的上下文长度。
 *
 * 现在分两层（和 Claude Code 等 agent 的做法一致：先做便宜的，不够再做贵的）：
 *
 * 第 1 层 瘦身（每一步都做，不调用模型，结果不落库）
 *   - 以前轮次的思考内容（reasoning）不再回传，只保留当前这一轮的（DeepSeek 只要求回传当前轮）
 *   - 以前轮次的工具结果只留开头和结尾；超长的工具参数（例如整页 HTML）换成一句说明
 *   - 当前轮只有最近几个工具结果原样保留，更早的截短
 *   - 被截掉的内容里如果有【A.ai 自动检查】提示，提示会原样保留
 *
 * 第 2 层 摘要压缩（瘦身后仍超过阈值时才做，调用一次模型，结果落库）
 *   - 最近 KEEP_TURNS 轮原样保留，更早的对话让模型整理成一段摘要
 *   - 摘要作为一条 feedback.kind = "compact" 的消息存进会话，之后每一步都用“摘要 + 保留部分”代替完整历史
 *   - 数据库里的原始消息一条都不删，界面照常显示；只是不再发给模型
 */

/** 最近几轮对话原样保留，不进摘要 */
const KEEP_TURNS = 2;
/** 以前轮次：工具结果最多保留多少字 */
const OLD_TOOL_CHARS = 1200;
/** 以前轮次：工具参数超过多少字就换成说明（create_artifact、write_file 的完整内容） */
const OLD_ARGS_CHARS = 1500;
/** 当前轮：最近几个工具结果原样保留 */
const RECENT_TOOLS = 6;
/** 当前轮：更早的工具结果最多保留多少字（压得更狠时用 TIGHT_TOOL_CHARS） */
const CUR_TOOL_CHARS = 4000;
const TIGHT_TOOL_CHARS = 1200;
/** 要摘要的旧对话至少有这么多 token 才值得压缩 */
const MIN_COMPACT_TOKENS = 2000;
/** 摘要时，每条消息最多取多少字给模型看 */
const SUMMARY_MSG_CHARS = 1500;
/** 摘要输入的总长度上限（字）：再长就保留开头和结尾 */
const SUMMARY_INPUT_CHARS = 60_000;

/**
 * 什么时候做摘要压缩：预计输入超过上下文长度的 70%，且最多 96k token。
 * 为什么还要封顶：DeepSeek 等模型有 1M 上下文，70% 就是 70 万 token，
 * 每一步都带着它既慢又贵（按输入计费），远没到上限之前就该压缩了。
 */
export function compactThreshold(contextWindow: number) {
  // 环境变量 A_COMPACT_TOKENS 可以直接指定阈值（调试时设小一点，几轮就能看到压缩）
  const env = Number(process.env.A_COMPACT_TOKENS);
  if (env > 0) return env;
  return Math.min(Math.floor(contextWindow * 0.7), 96_000);
}

/** 摘要消息的开头：发给模型时放进系统提示词里 */
export const COMPACT_TITLE = "## 之前对话的摘要\n以下是本会话更早部分的摘要（原文已省略）。需要细节时可以重新读取文件或重新查询，不要凭摘要编造原文。";

/** 压缩请求的系统提示词开头。mock 模型靠它认出这是“压缩”的请求 */
export const COMPACT_TAG = "[A.ai:compact]";

const COMPACT_PROMPT = `${COMPACT_TAG} 你是 A.ai 的上下文压缩模块。把“需要合并的对话”整理成一份摘要，让 agent 只看摘要就能接着工作。

必须保留：
1. 用户的目标和所有明确提出的要求、偏好、否决过的方案（用户的原话尽量保留）
2. 已经完成的事和得到的关键结果（数字、结论、网址、命令的输出要点）
3. 创建或修改过的文件路径，以及每个文件现在的状态
4. 做过的重要决定和原因；试过但失败的方法和失败原因（避免重复踩坑）
5. 还没完成的事、待解决的问题

不要保留：寒暄、重复的尝试过程、大段工具原始输出、思考过程。
如果有“之前的摘要”，把它和新内容合并成一份，不要分成两段。
用中文分小标题输出，只输出摘要正文，不要解释。`;

/** 发给模型之前的历史：系统提示词 + （摘要）+ 保留下来的消息（已瘦身） */
export function buildContext(messages: StoredMessage[], system: string, opts: { tight?: boolean } = {}): ChatMessage[] {
  const c = lastCompact(messages);
  const sys = c ? `${system}\n\n${COMPACT_TITLE}\n\n${c.message.content}` : system;
  const kept = c ? messages.slice(c.keepIndex).filter((m) => m.feedback?.kind !== "compact") : messages.filter((m) => m.feedback?.kind !== "compact");
  return [{ role: "system", content: sys }, ...pairCalls(slim(kept, opts.tight))];
}

/**
 * 发出前检查“调用—结果”是否配对（M1-03）：
 * 每个 assistant 的 tool_call 后面必须跟着它的 tool 结果，每个 tool 结果前面必须有对应的调用，否则 API 直接报 400。
 * 新代码在停止、跳过时都会补结果；这里兜底处理老数据和意外中断（服务重启、进程崩溃）留下的半截历史：
 * 缺结果的补一条“没有结果”，找不到调用的孤立结果丢掉。只改发给模型的副本。
 */
export function pairCalls(msgs: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === "tool") continue; // 结果跟着它的调用一起处理；走到这里的是孤立结果
    out.push(m);
    if (m.role !== "assistant" || !m.toolCalls?.length) continue;
    const ids = new Set(m.toolCalls.map((c) => c.id));
    let j = i + 1;
    for (; j < msgs.length && msgs[j].role === "tool"; j++) if (ids.has(msgs[j].toolCallId ?? "")) out.push(msgs[j]), ids.delete(msgs[j].toolCallId ?? "");
    for (const id of ids) out.push({ role: "tool", toolCallId: id, content: "（没有结果：这次调用在运行中断时没有执行完，实际状态未知。需要的话先检查再重新调用。）" });
    i = j - 1;
  }
  return out;
}

/** 估算这次请求的输入 token：消息 + 工具说明书。只是估算，用来判断要不要压缩 */
export function estimateRequest(msgs: ChatMessage[], tools?: ToolSpec[]) {
  let n = tools?.length ? estimateTokens(JSON.stringify(tools)) : 0;
  for (const m of msgs) {
    n += 4 + estimateTokens(m.content ?? "") + estimateTokens(m.reasoning ?? "");
    for (const c of m.toolCalls ?? []) n += estimateTokens(c.name) + estimateTokens(c.arguments);
  }
  return n;
}

/**
 * 找最近一次摘要。keepIndex = 摘要覆盖到哪里（这条之前的都被摘要了）。
 * 摘要消息本身排在它生成时的位置（会话末尾），保留部分在它前面，所以要靠 keepFrom 找回起点。
 */
function lastCompact(messages: StoredMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.feedback?.kind !== "compact" || !m.compact) continue;
    const keepIndex = messages.findIndex((x) => x.id === m.compact!.keepFrom);
    return { message: m, index: i, keepIndex: keepIndex < 0 ? i + 1 : keepIndex };
  }
  return null;
}

/** 第 1 层：瘦身。只改发给模型的副本，不改数据库里的消息 */
function slim(messages: StoredMessage[], tight = false): ChatMessage[] {
  // 当前轮 = 最后一条用户真正发的消息之后（自动反馈、补充想法不算新的一轮）
  let turnStart = 0;
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i].role === "user" && !messages[i].feedback) {
      turnStart = i;
      break;
    }
  const toolIdx = messages.map((m, i) => (m.role === "tool" && i > turnStart ? i : -1)).filter((i) => i >= 0);
  const recent = new Set(toolIdx.slice(-RECENT_TOOLS));

  return messages.map((m, i): ChatMessage => {
    const old = i < turnStart;
    const out: ChatMessage = { role: m.role, content: m.content, toolCalls: m.toolCalls, toolCallId: m.toolCallId, reasoning: m.reasoning, raw: m.raw };
    if (m.role === "assistant") {
      if (old) {
        out.reasoning = undefined;
        out.raw = undefined; // 旧轮次的思考也不再发回（Claude 允许从最前面开始去掉思考块）
        out.toolCalls = m.toolCalls?.map((c) => (c.arguments.length > OLD_ARGS_CHARS ? { ...c, arguments: omitArgs(c.arguments) } : c));
      }
    } else if (m.role === "tool") {
      const limit = old ? OLD_TOOL_CHARS : recent.has(i) ? Infinity : tight ? TIGHT_TOOL_CHARS : CUR_TOOL_CHARS;
      out.content = clip(m.content, limit);
    }
    return out;
  });
}

/** 保留开头 70% 和结尾 30%，中间说明省略了多少；【A.ai 自动检查】提示一定保留 */
function clip(s: string, limit: number) {
  if (s.length <= limit) return s;
  const tag = s.indexOf(FEEDBACK_TAG);
  const body = tag >= 0 ? s.slice(0, tag) : s;
  const hint = tag >= 0 ? s.slice(tag) : "";
  if (body.length <= limit) return s;
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  return `${body.slice(0, head)}\n…【上下文压缩：此处省略 ${body.length - limit} 字，需要时请重新获取】…\n${body.slice(-tail)}${hint ? "\n\n" + hint : ""}`;
}

/** 超长参数换成一个仍然合法的 JSON（有的 API 会校验历史里的 arguments） */
function omitArgs(args: string) {
  return JSON.stringify({ _omitted: `参数共 ${args.length} 字，已在上下文中省略`, preview: args.slice(0, 300) });
}

/**
 * 第 2 层：判断能不能做摘要。返回要被摘要的消息范围和保留起点；做不了返回 null。
 * 只在“用户消息”处切开：工具调用和它的结果必须在同一边，否则 API 会报 400。
 */
export function planCompact(messages: StoredMessage[]) {
  const c = lastCompact(messages);
  const from = c ? c.keepIndex : 0;
  const users: number[] = [];
  for (let i = from; i < messages.length; i++) if (messages[i].role === "user" && !messages[i].feedback) users.push(i);
  if (users.length <= KEEP_TURNS) return null; // 能保留的轮数都不够，没东西可摘要
  const keepIndex = users[users.length - KEEP_TURNS];
  const part = messages.slice(from, keepIndex).filter((m) => m.feedback?.kind !== "compact");
  if (!part.length) return null;
  // 要摘要的部分（按瘦身后的样子估算）太少就不做：省下的 token 还不如多调用一次模型花的多。
  // 大头是系统提示词和工具说明书时就是这种情况，压缩也压不下来
  const tokens = estimateRequest(slim(part));
  if (tokens < MIN_COMPACT_TOKENS) return null;
  return { previous: c?.message.content ?? "", part, keepFrom: messages[keepIndex].id, tokens };
}

/** 调用模型生成摘要。返回摘要正文和这次调用的用量（用量也要计入统计） */
export async function summarize(provider: LLMProvider, plan: NonNullable<ReturnType<typeof planCompact>>, signal?: AbortSignal) {
  const input = `${plan.previous ? `之前的摘要：\n${plan.previous}\n\n` : ""}需要合并的对话：\n${transcript(plan.part)}`;
  let text = "";
  let usage: Usage | undefined;
  for await (const chunk of provider.stream({
    messages: [
      { role: "system", content: COMPACT_PROMPT },
      { role: "user", content: input },
    ],
    temperature: 0,
    signal,
  })) {
    if (chunk.type === "text") text += chunk.delta;
    else if (chunk.type === "done") usage = chunk.usage;
  }
  const summary = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (!summary) throw new Error("模型没有返回摘要");
  return { summary, usage: usage ?? estimateUsage(COMPACT_PROMPT + input, text) };
}

/** 没拿到真实用量时（本地模型、中途停止）按字数估算，并标记 estimated */
export function estimateUsage(input: string, output: string): Usage {
  return { inputTokens: estimateTokens(input), outputTokens: estimateTokens(output), estimated: true };
}

function transcript(part: StoredMessage[]) {
  const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
  const lines: string[] = [];
  for (const m of part) {
    if (m.role === "user") lines.push(m.feedback ? `[${m.feedback.kind === "note" ? "用户补充" : "系统检查"}] ${cut(m.feedback.summary, 300)}` : `[用户] ${cut(m.content, SUMMARY_MSG_CHARS)}`);
    else if (m.role === "assistant") {
      if (m.content.trim()) lines.push(`[A.ai] ${cut(m.content.trim(), SUMMARY_MSG_CHARS)}`);
      for (const c of m.toolCalls ?? []) lines.push(`[调用 ${c.name}] ${cut(c.arguments, 400)}`);
    } else if (m.role === "tool") lines.push(`[结果${m.isError ? "（失败）" : ""}] ${cut(m.content, 600)}`);
  }
  const all = lines.join("\n");
  if (all.length <= SUMMARY_INPUT_CHARS) return all;
  const head = Math.floor(SUMMARY_INPUT_CHARS / 3);
  return all.slice(0, head) + "\n…（中间省略）…\n" + all.slice(-(SUMMARY_INPUT_CHARS - head));
}
