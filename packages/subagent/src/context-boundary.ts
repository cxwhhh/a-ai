import type { ChatMessage, ToolSpec } from "../../llm/src/types";
import type { Session } from "../../protocol/src/lib/shared";
import { estimateRequest } from "../../context-engine/src/context";
import { estimateTokens } from "../../protocol/src/lib/tokens";
import type { CapabilityScope } from "./capability-scope";
import type { Evidence } from "./result-contract";
import { SubagentRequestError, type TaskContract } from "./task-contract";

const EXCERPT_CHARS = 1_500;

/** 只从当前会话的有效记录取明确引用。文件引用只传规范路径，内容仍经只读工具和权限分发。 */
export function selectContext(task: TaskContract, session: Pick<Session, "messages" | "artifacts"> | undefined, scope: CapabilityScope) {
  const sections: string[] = [];
  const evidence: Evidence[] = [];
  const excerpts = new Map<string, string>();
  function select(kind: "message" | "artifact", source: string, text: string) {
    const id = `C${evidence.length + 1}`;
    evidence.push({ id, kind, source });
    const excerpt = text.slice(0, EXCERPT_CHARS);
    excerpts.set(id, excerpt);
    sections.push(`[${id}] ${kind} ${source}\n${excerpt}`);
  }
  function filePath(file: string) {
    try { return scope.readPath(file).shown; }
    catch { throw new SubagentRequestError("引用的文件超出子任务允许范围", 403); }
  }
  for (const id of task.contextMessages ?? []) {
    const message = session?.messages.find((item) => item.id === id);
    if (!message) throw new SubagentRequestError("引用的消息不在当前会话的有效记录中", 404);
    select("message", id, message.content);
  }
  for (const id of task.contextArtifacts ?? []) {
    const artifact = session?.artifacts.find((item) => item.id === id);
    if (!artifact) throw new SubagentRequestError("引用的产物不在当前会话的有效记录中", 404);
    // 文件型产物通过文件工具读取，避免用产物引用绕过任务路径范围。
    if (artifact.file) sections.push(`文件产物路径：${filePath(artifact.file)}`);
    else select("artifact", id, artifact.content);
  }
  for (const file of task.contextFiles ?? []) sections.push(`文件路径：${filePath(file)}`);
  return { evidence, excerpts, text: sections.join("\n\n") };
}

export const READ_EVIDENCE_SPEC: ToolSpec = {
  name: "read_evidence",
  description: "按证据编号回读本子任务已保存的原文。可按字面关键字定位或从 nextOffset 接着读。",
  parameters: { type: "object", properties: {
    evidenceId: { type: "string" }, offset: { type: "integer" }, query: { type: "string" },
  }, required: ["evidenceId"] },
};

type EvidenceFocus = { terms: string[]; quotes: ReadonlyMap<string, string[]> };
const evidenceLabel = /^\[(?:原文 )?([CDE]\d+(?:\.\d+)?)\]/;

/** 只压缩请求副本。给各段按剩余 token 分配篇幅，优先保留已引用引文和与分工相关的原文行。 */
export function boundedContext(messages: ChatMessage[], tools: ToolSpec[] | undefined, limit: number, focus?: EvidenceFocus) {
  const full = estimateRequest(messages, tools);
  if (full <= limit) return { messages: [...messages], tokens: full, compactedEvidence: false };
  const copy = [...messages];
  const entries = messages.flatMap((message, index) => {
    if (message.role !== "tool" || estimateTokens(message.content) < 70) return [];
    const id = evidenceLabel.exec(message.content)?.[1];
    const header = id ? `[${id}] 证据节选，按编号调用 read_evidence 回读。` : "工具回执节选。";
    const pinned = id ? [...new Set(focus?.quotes.get(id) ?? [])] : [];
    const base = [header, ...pinned].join("\n");
    if (estimateTokens(base) >= estimateTokens(message.content)) return [];
    copy[index] = { ...message, content: base };
    return [{ message, index, id, base, body: id ? message.content.split("\n").slice(1).join("\n") : message.content }];
  });
  let room = Math.max(0, limit - estimateRequest(copy, tools));
  const terms = new Set((focus?.terms.join(" ").toLowerCase().match(/[a-z0-9_-]{3,}|\p{Script=Han}{2,6}/gu) ?? []).slice(0, 60));
  let weights = entries.length + Number(entries.length > 0);
  let compactedEvidence = false;
  for (const [i, entry] of entries.entries()) {
    const weight = i === entries.length - 1 ? 2 : 1;
    const share = Math.floor(room * weight / weights);
    weights -= weight;
    const baseCost = estimateTokens(entry.base);
    if (estimateTokens(entry.message.content) <= baseCost + share) {
      copy[entry.index] = entry.message;
    } else {
      const pieces = entry.body.split(/\n|(?<=[。！？；])\s*/u).flatMap((part) => part.match(/[\s\S]{1,480}/gu) ?? []);
      const ranked = pieces.map((part, index) => {
        const text = part.toLowerCase();
        return { part, index, score: [...terms].filter((term) => text.includes(term)).length * 3 + Number(index === 0 || index === pieces.length - 1) };
      });
      ranked.sort((a, b) => b.score - a.score || a.index - b.index);
      const kept: typeof ranked = [];
      let left = share;
      for (const part of ranked) {
        const cost = estimateTokens(part.part) + 1;
        if (cost <= left && !entry.base.includes(part.part)) { kept.push(part); left -= cost; }
      }
      kept.sort((a, b) => a.index - b.index);
      copy[entry.index].content = [entry.base, ...kept.map(({ part }) => part)].join("\n");
      compactedEvidence ||= !!entry.id;
    }
    room -= estimateTokens(copy[entry.index].content) - baseCost;
  }
  return { messages: copy, tokens: estimateRequest(copy, tools), compactedEvidence };
}

export function readEvidence(args: Record<string, unknown>, excerpts: ReadonlyMap<string, string>) {
  const id = args.evidenceId;
  const source = typeof id === "string" ? excerpts.get(id) : undefined;
  if (!source) throw new Error("证据编号不在当前子任务的可用范围内");
  const query = typeof args.query === "string" ? args.query.trim().slice(0, 200) : "";
  const offset = typeof args.offset === "number" && Number.isSafeInteger(args.offset) ? Math.max(0, args.offset) : 0;
  const match = query ? source.toLowerCase().indexOf(query.toLowerCase(), offset) : offset;
  if (match < 0) throw new Error("证据没有找到这个关键词，可以按偏移回读");
  const start = Math.max(offset, match - 240);
  const end = Math.min(source.length, start + 1_600);
  if (start >= source.length) throw new Error("证据已读到末尾");
  return `[原文 ${id}]\n${source.slice(start, end)}${end < source.length ? `\n（nextOffset=${end}）` : ""}`;
}

export const CHILD_COMPACTION_PROMPT = `你是子任务上下文整理器。请把较早的执行步骤压缩成紧凑的工作态 JSON，供后续步骤继续完成同一分工。
只输出一个 JSON 对象：{"summary":"当前进展简述","confirmedEvidence":[{"id":"证据编号","quote":"对应原文准确片段"}],"completedSteps":["已完成动作"],"writtenFiles":["已写入路径"],"pending":["剩余待办或待修复项"]}。
规则：
- confirmedEvidence 里的 id 必须来自输入中真实出现过的证据编号，quote 必须是对应原文的准确片段；无法核对的不要写。
- 不要编造未通过的测试为通过；失败或未验证项写入 pending。
- 没有内容的列表用 []。`;

/**
 * 规划子 Agent 轮内压缩边界：保留前缀（system、task、引用资料、检查点说明）和最近 2 组完整工具调用，
 * 将中间较早的完整调用组提取出来生成工作态，绝不拆散 assistant.toolCalls 与对应的 tool 回执。
 */
export function planChildCompaction(messages: readonly ChatMessage[], prefixCount: number) {
  const groups: { start: number; end: number }[] = [];
  let cursor = prefixCount;
  while (cursor < messages.length) {
    const start = cursor;
    const msg = messages[cursor];
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      cursor++;
      while (cursor < messages.length && messages[cursor].role === "tool") cursor++;
      groups.push({ start, end: cursor });
    } else {
      cursor++;
      groups.push({ start, end: cursor });
    }
  }
  // 至少保留最近 2 组交互，且前面至少有 2 组可折叠内容，避免频繁做无意义的微小压缩。
  if (groups.length < 4) return null;
  const keepFromGroup = groups.length - 2;
  const keepFrom = groups[keepFromGroup].start;
  const part = messages.slice(prefixCount, keepFrom);
  if (part.length < 3) return null;
  return {
    prefix: messages.slice(0, prefixCount),
    part,
    tail: messages.slice(keepFrom),
  };
}

const normalizeExcerpt = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim();

function excerptContains(text: string | undefined, quote: string) {
  if (!text) return false;
  const needle = normalizeExcerpt(quote);
  if (!needle) return false;
  if (normalizeExcerpt(text).includes(needle)) return true;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.content === "string" && normalizeExcerpt(parsed.content).includes(needle);
  } catch { return false; }
}

/** 回检子任务阶段工作态：只保留能在已保存证据原文中核对到的引文，过滤幻觉引用。 */
export function validateChildCompaction(raw: string, excerpts: ReadonlyMap<string, string>) {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "");
  const parsed: unknown = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("子任务摘要必须是 JSON 对象");
  const obj = parsed as Record<string, unknown>;
  const summary = typeof obj.summary === "string" && obj.summary.trim() ? obj.summary.trim().slice(0, 1_200) : "";
  if (!summary) throw new Error("子任务摘要缺少 summary");
  const list = (value: unknown, max: number, itemMax: number) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && !!item.trim()).slice(0, max).map((item) => item.trim().slice(0, itemMax))
      : [];
  const confirmedEvidence = Array.isArray(obj.confirmedEvidence)
    ? obj.confirmedEvidence.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const { id, quote } = entry as Record<string, unknown>;
      if (typeof id !== "string" || typeof quote !== "string") return [];
      const cleanQuote = quote.trim().slice(0, 400);
      if (!cleanQuote || !excerptContains(excerpts.get(id), cleanQuote)) return [];
      return [{ id, quote: cleanQuote }];
    }).slice(0, 16)
    : [];
  return JSON.stringify({
    summary,
    confirmedEvidence,
    completedSteps: list(obj.completedSteps, 12, 240),
    writtenFiles: list(obj.writtenFiles, 12, 240),
    pending: list(obj.pending, 12, 240),
  });
}
