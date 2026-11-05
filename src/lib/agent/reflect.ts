import "server-only";
import type { LLMProvider, Usage } from "../llm/types";
import type { Session, StoredMessage, UserMemory } from "../shared";
import { getMemory, normalizeMemory, saveMemory } from "../server/memory";
import { logUsage } from "../server/usage";
import { estimateUsage } from "./context";

/** 反思请求的系统提示词开头。mock 模型靠它认出这是“整理记忆”的请求 */
export const REFLECT_TAG = "[A.ai:reflect]";

const REFLECT_PROMPT = `${REFLECT_TAG} 你是 A.ai 的记忆整理模块。根据“现有记忆”和“本轮对话”，输出更新后的完整记忆。

规则：
- profile：用户的职业 / 身份 / 背景，一两句话。只写对话里能看出来的，看不出就保持原样（可以为空）。
- habits：用户的习惯与偏好（使用的语言、喜欢的回答风格、常用技术栈、工作方式、反复提的要求），每条一句话，最多 12 条。合并重复的；和新信息冲突的旧条目要改掉。
- lessons：本轮里 agent（也就是 A.ai 自己）犯的错误和反思，例如：代码报错、理解错需求、被用户纠正、工具用错、没验证就交付、回答太啰嗦。
  每条有三项：mistake = 具体发生了什么；lesson = 以后应该怎么做（一条能直接执行的规则，用“先… / 必须… / 不要…”开头）；count = 出现次数。
  和已有的同类错误合并成一条：count 加 1，并把 lesson 改写得更通用。本轮没有新错误，就原样保留已有的 lessons。用户自己的笔误不算。
- 不要记录密码、API Key、证件号等敏感信息。
- 只输出一个 JSON 对象，不要解释，不要代码块标记。格式：
{"profile": "...", "habits": ["..."], "lessons": [{"mistake": "...", "lesson": "...", "count": 1}]}`;

/** 用户在纠正 agent 时常说的话：出现了就说明上一轮可能做错了，值得反思（技能学习 learn.ts 也用它判断“上一轮用的技能好不好用”） */
export const CORRECTION = /不对|错了|不是这样|不是我要|重新|又错|还是不行|没用|搞错|理解错|wrong|incorrect|not what|again|doesn'?t work/i;

/**
 * 每轮对话结束后：判断值不值得反思 → 把本轮过程压缩成一段文字 → 让模型更新记忆 → 存库。
 * 在 /api/chat 里“后台”调用（不阻塞回答），出任何错都只打日志，不影响对话。
 *
 * 为什么不是每轮都做：反思也是一次模型调用，要花钱和时间。
 * 只在“有东西可学”时做：出过错、被用户纠正、记忆还是空的，以及每 3 轮一次（更新职业和习惯）。
 */
export async function reflect(opts: {
  provider: LLMProvider;
  userId: string;
  session: Session;
  turnStart: number;
  /** 记忆读写到哪里：不传 = 用户的全局记忆；项目选了“独立记忆”时传项目自己的那份（见 api/chat） */
  store?: { get(): UserMemory; save(m: unknown): UserMemory };
  signal?: AbortSignal;
}) {
  const { session, turnStart } = opts;
  const store = opts.store ?? { get: () => getMemory(opts.userId), save: (m: unknown) => saveMemory(opts.userId, m) };
  const memory = store.get();
  const turn = session.messages.slice(turnStart);
  if (!shouldReflect(session, turn, memory)) return null;

  let text = "";
  let usage: Usage | undefined;
  const startedAt = Date.now();
  const input = `现有记忆：\n${JSON.stringify(stripTimes(memory))}\n\n本轮对话：\n${transcript(session, turnStart)}`;
  for await (const chunk of opts.provider.stream({
    messages: [
      { role: "system", content: REFLECT_PROMPT },
      { role: "user", content: input },
    ],
    temperature: 0,
    signal: opts.signal,
  })) {
    if (chunk.type === "text") text += chunk.delta;
    else if (chunk.type === "done") usage = chunk.usage;
  }
  // 记忆整理也是一次模型调用，同样计入用量（以前漏算了）
  logUsage(opts.userId, session.id, "reflect", usage ?? estimateUsage(REFLECT_PROMPT + input, text), startedAt);

  const parsed = parseJson(text);
  if (!parsed) throw new Error(`反思输出不是 JSON：${text.slice(0, 200)}`);
  const next = normalizeMemory(parsed);
  // 模型输出里没有时间：已有的教训保留原来的时间，新的才算“现在”
  const old = new Map(memory.lessons.map((l) => [l.lesson, l.updatedAt]));
  next.lessons = next.lessons.map((l) => ({ ...l, updatedAt: old.get(l.lesson) ?? Date.now() }));
  return store.save(next);
}

export function shouldReflect(session: Session, turn: StoredMessage[], memory: UserMemory) {
  const userText = turn.find((m) => m.role === "user" && !m.feedback)?.content ?? "";
  const hadError = turn.some((m) => (m.feedback && m.feedback.kind !== "compact") || m.isError || (m.role === "tool" && failedRun(m.content)));
  const userTurns = session.messages.filter((m) => m.role === "user" && !m.feedback).length;
  const empty = !memory.profile && !memory.habits.length && !memory.lessons.length;
  return hadError || CORRECTION.test(userText) || empty || userTurns % 3 === 0;
}

/** run_python 的结果是 JSON：退出码不是 0 或超时就算失败 */
export function failedRun(content: string) {
  if (!content.startsWith("{") || !content.includes('"exitCode"')) return false;
  try {
    const r = JSON.parse(content);
    return r.exitCode !== 0 || r.timedOut;
  } catch {
    return false;
  }
}

/**
 * 把本轮压缩成给模型看的文字：只留“学得到东西”的部分，长内容截断。
 * 还会带上上一轮的最终回答 —— 用户说“不对”时，错的是上一轮，模型得知道上一轮答了什么。
 */
export function transcript(session: Session, turnStart: number) {
  const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
  const lines: string[] = [];
  const prev = session.messages.slice(0, turnStart).reverse().find((m) => m.role === "assistant" && m.content.trim());
  if (prev) lines.push(`（上一轮 A.ai 的回答）${cut(prev.content.trim(), 600)}`);
  for (const m of session.messages.slice(turnStart)) {
    if (m.role === "user") lines.push(m.feedback ? `系统检查：${m.feedback.summary}\n${cut(m.content, 500)}` : `用户：${cut(m.content, 1000)}`);
    else if (m.role === "assistant") {
      if (m.content.trim()) lines.push(`A.ai：${cut(m.content.trim(), 600)}`);
      for (const c of m.toolCalls ?? []) lines.push(`A.ai 调用 ${c.name}：${cut(c.arguments, 400)}`);
    } else if (m.role === "tool") {
      const bad = m.isError || failedRun(m.content);
      lines.push(`工具结果${bad ? "（失败）" : ""}：${cut(m.content, bad ? 600 : 200)}`);
    }
  }
  // 太长时保留开头（用户的需求）和结尾（最后的结果）
  const all = lines.join("\n");
  return all.length > 9000 ? all.slice(0, 3000) + "\n…（中间省略）…\n" + all.slice(-6000) : all;
}

const stripTimes = (m: UserMemory) => ({ profile: m.profile, habits: m.habits, lessons: m.lessons.map(({ mistake, lesson, count }) => ({ mistake, lesson, count })) });

/** 模型有时会包一层 ```json 或在前后加话：取第一个 { 到最后一个 } */
export function parseJson(text: string): unknown {
  const s = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}
