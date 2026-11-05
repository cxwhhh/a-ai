import "server-only";
import type { LLMProvider, Usage } from "../llm/types";
import { toolStatus, type Session, type Skill, type StoredMessage, type ToolStatus } from "../shared";
import { db } from "../server/db";
import { getSkillByName, listSkills, normalizeSkill, putSkill, recordUse, updateSkill } from "../server/skills";
import { logUsage } from "../server/usage";
import { splitAttachments } from "../attachments";
import { CORRECTION, parseJson, transcript } from "./reflect";
import { estimateUsage } from "./context";
import { SKILL_MARK } from "./tools/load-skill";

/** 技能学习请求的系统提示词开头。mock 模型靠它认出这是“总结技能”的请求 */
export const LEARN_TAG = "[A.ai:learn]";

const LEARN_PROMPT = `${LEARN_TAG} 你是 A.ai 的技能学习模块。A.ai 是一个会调用工具（读写文件、运行代码、联网、生成文档）的 agent。
你的任务：根据“本轮对话”，决定要不要把这类任务的做法总结成一个“技能”，或者改进已有的技能。下次遇到同类任务，A.ai 会先读技能再按步骤做。

什么值得总结：
- 用户反复提的同一类请求（固定的格式、语言、风格、输出位置、检查要求都是用户的习惯，要写进技能）
- 多步才完成的任务：用了哪些工具、按什么顺序、关键参数怎么填
- 出过错又修好的任务：错在哪、怎么避免
什么不值得：一次性的闲聊、单步就能回答的问题、只对这一次有用的具体数据；和具体做法无关的单条偏好（例如“回答简短一点”）属于长期记忆，不要建成技能。拿不准就不建（action=none）。

写法：
- name：简短的中文名，2~12 个字，说清楚是哪类任务。例：周报生成、CSV 数据清洗、接口压测脚本
- description：一句话说明什么时候用，以“当用户…”开头，写出能触发它的关键词。例：当用户要写周报 / 本周总结时
- body：Markdown，按这几节写，总共不超过 1500 字：
  ## 适用场景
  ## 步骤
  1. …（每步写清楚用哪个工具、关键参数或命令，以及为什么）
  ## 用户的固定要求
  （格式、语言、风格、文件放哪里；没有就写“无”）
  ## 注意事项
  （踩过的坑、容易出错的地方）
  ## 怎么验证做对了
- 要通用：把这一次的具体文件名、数字、日期换成“用户给的文件”“本周”这样的说法；但用户每次都一样的要求（例如固定的输出目录）要原样保留。
- 已经有同类技能（看“现有技能”）：用 action=update 改进它，name 写原来的名字，输出改进后的完整 description 和 body。不要建重复的技能。
- 改进时：保留原来有用的内容，把这次学到的加进去；这次证明是错的步骤要改掉。
- 不要写进密码、API Key、Token、证件号等敏感信息。

只输出一个 JSON 对象，不要解释，不要代码块标记。格式：
{"action": "create" | "update" | "none", "name": "...", "description": "...", "body": "...", "note": "一句话：为什么建 / 这次改了什么"}`;

/** 这一轮调用工具的次数达到这么多、并且顺利完成，才算“值得总结的复杂任务” */
const COMPLEX_CALLS = 5;
/** 用户在至少这么多个其他对话里提过类似的请求，就算“经常做的事” */
const REPEAT_SESSIONS = 2;
const SIMILAR = 0.4;

export interface LearnResult {
  action: "create" | "update";
  skill: Skill;
}

/**
 * 每轮对话结束后（/api/chat 里“后台”调用，不阻塞回答）：
 *   1. 记账：这一轮用了哪些技能、顺不顺利；用户这轮在说“不对”，上一轮用的技能记一次失败
 *   2. 判断值不值得学：用了技能却出问题 → 改进；复杂任务顺利完成 / 出错后修好 / 同类请求反复出现 → 总结新技能
 *   3. 值得的话调一次模型，按 LEARN_PROMPT 输出 JSON，新建或改进技能
 * 新建的技能默认是“待确认”，用户在设置 → 技能里点启用才会进提示词（autoEnable 时直接启用）。
 *
 * 为什么不是每轮都调模型：和反思一样要花钱和时间。大部分轮次只做第 1 步（纯数据库操作）。
 */
export async function learnSkills(opts: { provider: LLMProvider; userId: string; session: Session; turnStart: number; autoEnable: boolean; signal?: AbortSignal }): Promise<LearnResult | null> {
  const { session, turnStart, userId } = opts;
  const turn = session.messages.slice(turnStart);
  const userMsg = turn.find((m) => m.role === "user" && !m.feedback);
  const userText = splitAttachments(userMsg?.content ?? "").text;
  const out = outcome(turn);

  // 1. 记账
  const prevStart = previousTurnStart(session, turnStart);
  const corrected = CORRECTION.test(userText);
  const prevUsed = corrected && prevStart >= 0 ? usedSkills(userId, session.messages.slice(prevStart, turnStart)) : [];
  for (const s of prevUsed) recordUse(userId, s.id, false, true);
  if (!out.finished) return null; // 以 ask_user 结束或中途停止：还不知道结果，等下一轮
  const used = usedSkills(userId, turn);
  for (const s of used) recordUse(userId, s.id, out.ok);

  // 2. 值不值得学
  const reasons: string[] = [];
  for (const s of used) if (!out.ok || out.troubled) reasons.push(`这一轮用了技能「${s.name}」，但过程中出了问题（${out.ok ? "报错后才修好" : "没有顺利完成"}）：改进这个技能（action=update），把这次的坑写进注意事项，步骤错了就改步骤。`);
  for (const s of prevUsed) reasons.push(`用户这一轮在纠正上一轮的结果，上一轮用了技能「${s.name}」：判断问题是不是出在技能上，是的话改进它（action=update）。`);
  const similar = used.length ? [] : similarRequests(userId, session.id, userText, userMsg?.id);
  if (!used.length && out.ok) {
    if (out.calls >= COMPLEX_CALLS) reasons.push(`这一轮是一个多步任务（调用了 ${out.calls} 次工具）并顺利完成：这类任务以后可能还会做的话，总结成技能。`);
    else if (out.troubled) reasons.push("这一轮出过错但最后修好了：修复的方法对同类任务有用的话，总结成技能，或者加进已有技能的注意事项。");
    if (similar.length >= REPEAT_SESSIONS) reasons.push(`用户在 ${similar.length} 个其他对话里提过类似的请求（见下面），这是经常做的事：把这类请求的固定要求和做法总结成技能。`);
  }
  if (!reasons.length) return null;

  // 3. 调模型
  const all = listSkills(userId);
  const related = [...prevUsed, ...used.filter((s) => !prevUsed.some((p) => p.id === s.id))];
  const parts = [
    `为什么要你看这一轮：\n${reasons.map((r) => `- ${r}`).join("\n")}`,
    `现有技能：\n${all.length ? all.map((s) => `- ${s.name}（${STATUS[s.status]}）：${s.description}`).join("\n") : "（还没有）"}`,
  ];
  if (related.length) parts.push(`本轮相关技能的全文：\n${related.map((s) => `### ${s.name}\n适用：${s.description}\n${s.body}`).join("\n\n")}`);
  if (similar.length) parts.push(`用户以前类似的请求：\n${similar.map((t) => `- ${t}`).join("\n")}`);
  // 用户在纠正上一轮：从上一轮开始看，才知道上一轮用技能时做了什么
  parts.push(`本轮对话：\n${transcript(session, prevUsed.length && prevStart >= 0 ? prevStart : turnStart)}`);
  const input = parts.join("\n\n");

  let text = "";
  let usage: Usage | undefined;
  const startedAt = Date.now();
  for await (const chunk of opts.provider.stream({
    messages: [
      { role: "system", content: LEARN_PROMPT },
      { role: "user", content: input },
    ],
    temperature: 0,
    signal: opts.signal,
  })) {
    if (chunk.type === "text") text += chunk.delta;
    else if (chunk.type === "done") usage = chunk.usage;
  }
  logUsage(userId, session.id, "learn", usage ?? estimateUsage(LEARN_PROMPT + input, text), startedAt);

  const parsed = parseJson(text) as Record<string, unknown> | null;
  if (!parsed) throw new Error(`技能学习输出不是 JSON：${text.slice(0, 200)}`);
  return apply(userId, parsed, related[0], opts.autoEnable);
}

const TROUBLE = new Set(["retry", "unverified", "stall", "limit"]);
const BAD = new Set<ToolStatus>(["error", "timeout", "unknown"]);
const STATUS: Record<Skill["status"], string> = { pending: "待确认", active: "已启用", disabled: "已停用" };

/** 把模型的决定写进数据库。同名就是改进；模型说 update 却写错了名字，就改进本轮用到的那个技能 */
function apply(userId: string, r: Record<string, unknown>, fallback: Skill | undefined, autoEnable: boolean): LearnResult | null {
  if (r.action !== "create" && r.action !== "update") return null;
  const draft = normalizeSkill({ name: r.name, description: r.description, body: r.body });
  if (!draft.name || !draft.description || !draft.body) throw new Error("技能学习输出缺少 name / description / body");
  const note = typeof r.note === "string" && r.note.trim() ? r.note.trim().slice(0, 120) : "";
  const existing = getSkillByName(userId, draft.name) ?? (r.action === "update" ? fallback : undefined);
  if (existing) {
    const skill = updateSkill(userId, existing.id, { description: draft.description, body: draft.body }, `自动改进：${note || "根据这次任务的结果"}`);
    return skill ? { action: "update", skill } : null;
  }
  const now = Date.now();
  const skill = putSkill(
    userId,
    normalizeSkill({ ...draft, status: autoEnable ? "active" : "pending", source: "auto", history: [{ at: now, note: `自动总结：${note || "从这次任务里学到"}` }] }),
  );
  return { action: "create", skill };
}

/** 这一轮怎么样：有没有正常结束、算不算顺利、有没有出过错、调用了几次工具 */
function outcome(turn: StoredMessage[]) {
  const last = turn.at(-1);
  // 正常结束 = 最后一条是模型的文字回答（以 ask_user 结束时最后一条是工具结果）
  const finished = last?.role === "assistant" && !last.toolCalls?.length && !!last.content.trim();
  // 工具状态用统一的 toolStatus()（shared.ts）：命令退出码不是 0、超时、执行到一半被停都算失败；用户拒绝、跳过不算
  const tools = turn.filter((m) => m.role === "tool");
  const bad = (m: StoredMessage) => BAD.has(toolStatus(m));
  const runs = tools.filter((m) => m.content.includes('"exitCode"'));
  const lastRunFailed = !!runs.length && bad(runs.at(-1)!);
  const lastToolFailed = !!tools.length && bad(tools.at(-1)!);
  const ok = finished && !turn.some((m) => m.feedback?.kind === "limit") && !lastRunFailed && !lastToolFailed;
  // 出过错：被自动检查打回（运行失败、没验证、没进展、步数用完）或工具失败。交付前的自检（check）、补充想法、压缩不算
  const troubled = turn.some((m) => TROUBLE.has(m.feedback?.kind ?? "") || (m.role === "tool" && bad(m)));
  const calls = turn.flatMap((m) => m.toolCalls ?? []).filter((c) => c.name !== "load_skill" && c.name !== "load_tools" && c.name !== "remember").length;
  return { finished, ok, troubled, calls };
}

/** 这几条消息里用 load_skill 成功读取过的技能（同一个只算一次） */
function usedSkills(userId: string, msgs: StoredMessage[]): Skill[] {
  const names = new Set<string>();
  for (const m of msgs) {
    if (m.role !== "tool" || toolStatus(m) !== "ok" || !m.content.startsWith(SKILL_MARK)) continue;
    const head = m.content.slice(SKILL_MARK.length).split("\n")[0];
    names.add(head.slice(0, head.lastIndexOf("（v")).trim());
  }
  return [...names].map((n) => getSkillByName(userId, n)).filter((s): s is Skill => !!s);
}

/** 上一轮从哪条消息开始（上一条真正的用户消息），没有就是 -1 */
function previousTurnStart(session: Session, turnStart: number) {
  for (let i = turnStart - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m.role === "user" && !m.feedback) return i;
  }
  return -1;
}

/**
 * 在用户其他对话里找“类似的请求”：字符二元组的 Dice 相似度 ≥ 0.4。
 * 例：「帮我写本周的周报，按项目分」和「写一下这周周报，按项目分类」≈ 0.45。
 * 每个对话最多算一条：同一个对话里反复说（例如“重新生成”）不算“经常做”。
 * 不用向量检索：不需要额外的模型和依赖，几百条消息算一遍也只要几毫秒。
 */
function similarRequests(userId: string, sessionId: string, text: string, excludeId?: string): string[] {
  const a = bigrams(text);
  if (a.size < 5) return []; // “继续”“好的”这种短回复不算
  const rows = db()
    .prepare(
      `SELECT m.id, m.session_id, m.data FROM messages m JOIN sessions s ON s.id = m.session_id
       WHERE s.user_id = ? AND m.role = 'user' AND m.session_id != ? ORDER BY m.created_at DESC LIMIT 400`,
    )
    .all(userId, sessionId) as { id: string; session_id: string; data: string }[];
  const seen = new Set<string>();
  const hits: string[] = [];
  for (const r of rows) {
    if (r.id === excludeId || seen.has(r.session_id)) continue;
    let m: StoredMessage;
    try {
      m = JSON.parse(r.data);
    } catch {
      continue;
    }
    if (m.feedback) continue;
    const t = splitAttachments(m.content).text;
    if (dice(a, bigrams(t)) < SIMILAR) continue;
    seen.add(r.session_id);
    hits.push(t.replace(/\s+/g, " ").slice(0, 120));
    if (hits.length >= 5) break;
  }
  return hits;
}

function bigrams(s: string) {
  const t = s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "").slice(0, 300);
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

function dice(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return (2 * n) / (a.size + b.size);
}
