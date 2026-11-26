import type { StoredMessage, ToolStatus } from "../../protocol/src/lib/shared";
import type { TaskProgress, TerminalTaskStatus } from "./progress-blockers";
import { normalizeFactKey } from "./task-contract";

export interface Evidence {
  id: string;
  kind: "tool" | "message" | "artifact";
  source: string;
  tool?: string;
  childStep?: number;
  callId?: string;
  traceId?: string;
  factKey?: string;
}

export interface VerifiedFact {
  key: string;
  value: string;
  evidenceIds: string[];
  quote: string;
}

export interface AcceptanceResult {
  criterion: string;
  met: boolean;
  evidenceIds: string[];
}

export interface TaskVerification {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface TaskResult {
  status: TerminalTaskStatus;
  summary: string;
  evidence: Evidence[];
  acceptance: AcceptanceResult[];
  unresolved: string[];
  progress: TaskProgress;
  facts: VerifiedFact[];
  writtenPaths?: string[];
  verification?: TaskVerification[];
  /** 用户在运行期间直接发给这个分支的内容，随结算结果交给父轮。 */
  dialogue?: { messages: string[]; reply?: string; unanswered: number };
}

interface ResultBody { summary?: unknown; checks?: unknown; unresolved?: unknown; facts?: unknown; review?: unknown; reply?: unknown }

function readResultBody(text: string): ResultBody | undefined {
  try {
    const value: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ""));
    if (value && typeof value === "object" && !Array.isArray(value)) return value as ResultBody;
  } catch { /* 不完整的 JSON 继续走已有的部分结果和缺口判定。 */ }
}

export function readSubagentReply(text: string) {
  const reply = readResultBody(text)?.reply;
  return typeof reply === "string" ? reply.trim().slice(0, 4_000) : "";
}

/** 只有正文回执能支持旧证据。重复查询的简短提示和失败回执不含可引用原文。 */
export function savedToolExcerpts(messages: readonly StoredMessage[] = []) {
  const excerpts = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "tool" || message.isError) continue;
    const proof = /^\[(E\d+\.\d+)\]\n([\s\S]*)/.exec(message.content);
    if (proof) excerpts.set(proof[1], proof[2].split("\n（文档下一段", 1)[0]);
  }
  return excerpts;
}

/** 复核只读取分工自己标记的口径歧义和实际存在的证据节选。 */
export function readReviewConcern(text: string, excerpts: ReadonlyMap<string, string>) {
  const review = readResultBody(text)?.review;
  if (!review || typeof review !== "object" || !("reason" in review) || typeof review.reason !== "string" || !review.reason.trim()) return;
  const ids: unknown[] = "evidenceIds" in review && Array.isArray(review.evidenceIds) ? review.evidenceIds : [];
  const cited = [...new Set(ids)].flatMap((id) => {
    const excerpt = typeof id === "string" ? excerpts.get(id) : undefined;
    return excerpt ? [{ id, excerpt: excerpt.slice(0, 1_200) }] : [];
  }).slice(0, 4);
  return { reason: review.reason.trim().slice(0, 500), cited };
}

export function readReviewDecision(text: string) {
  let value: { action?: unknown; reason?: unknown };
  try { value = JSON.parse(text.trim()); } catch { return; }
  if (!value || typeof value.reason !== "string" || !value.reason.trim()) return;
  const { action } = value;
  if (action === "accept" || action === "revise" || action === "stop") return { action, reason: value.reason.trim().slice(0, 500) };
}

/** 验收项只有在引用确实存在的证据时才接受模型的完成声明。证据是否充分仍由父轮或用户判断。 */
export function assessResult(text: string, criteria: string[], evidence: Evidence[], factKeys: string[] = [],
  excerpts: ReadonlyMap<string, string> = new Map(), carried?: Pick<TaskResult, "facts" | "acceptance">) {
  const body = criteria.length || factKeys.length ? readResultBody(text) : undefined;
  const known = new Set(evidence.map(({ id }) => id));
  const checks = Array.isArray(body?.checks) ? body.checks : [];
  const acceptance = criteria.map((criterion, index): AcceptanceResult => {
    const entries = checks.filter((check) => check && typeof check === "object" && check.index === index + 1);
    const check = entries.length === 1 ? entries[0] : entries.length === 0 ? carried?.acceptance[index] : undefined;
    const evidenceIds = Array.isArray(check?.evidenceIds)
      ? [...new Set<string>(check.evidenceIds.filter((id: unknown): id is string => typeof id === "string" && known.has(id)))]
      : [];
    return { criterion, met: check?.met === true && evidenceIds.length > 0, evidenceIds };
  });
  const facts: VerifiedFact[] = [];
  // 复杂分工仅转交受控事实。自由文本可能同时携带越界主张，尤其是模型未遵守输出格式时。
  const unresolved = !factKeys.length && Array.isArray(body?.unresolved)
    ? body.unresolved.filter((item): item is string => typeof item === "string" && !!item.trim()).slice(0, 8).map((item) => item.slice(0, 500))
    : [];
  const claims = Array.isArray(body?.facts) ? body.facts : [];
  if (factKeys.length && Array.isArray(body?.unresolved) && body.unresolved.some((value) => typeof value === "string" && value.trim())) {
    unresolved.push("子 Agent 报告仍有未完成事项，请回读证据和验收项");
  }
  function claimKey(claim: unknown) {
    return claim && typeof claim === "object" && "key" in claim && typeof claim.key === "string" ? normalizeFactKey(claim.key) : "";
  }
  if (factKeys.length && claims.some((claim) => !factKeys.includes(claimKey(claim)))) {
    unresolved.push("子 Agent 返回了分工范围以外的事实，已过滤");
  }
  for (const key of factKeys) {
    const results = claims.filter((claim) => claimKey(claim) === key);
    // 只填补本轮省略的已核验事实。模型给出新值或新引文时，仍按本轮的证据规则验收。
    if (!results.length) {
      const saved = carried?.facts.find((fact) => fact.key === key);
      if (saved) results.push(saved);
    }
    const values = new Set(results.map((claim) => typeof claim.value === "string" ? claim.value.trim() : ""));
    if (values.size > 1) {
      unresolved.push(`${key} 有互相冲突的值，需核对原始证据`);
      continue;
    }
    const value = values.values().next().value;
    const allowed = new Set(evidence.filter((item) => item.kind !== "tool" || item.factKey === key).map(({ id }) => id));
    const proof = results.flatMap<{ quote: string; ids: string[] }>((claim) => {
      const quote = typeof claim.quote === "string" ? claim.quote.trim() : "";
      if (!quote || quote.length > 600 || !value || !matchesMeasurement(value, quote, key)) return [];
      const candidates: unknown[] = Array.isArray(claim.evidenceIds) ? claim.evidenceIds : [];
      const ids = candidates.filter((id): id is string =>
        typeof id === "string" && allowed.has(id) && evidenceContains(excerpts.get(id), quote));
      return ids.length ? [{ quote, ids }] : [];
    })[0];
    if (!value || value.length > 1_000 || !proof) {
      unresolved.push(`${key} 缺少可回读的证据或有效结论`);
      continue;
    }
    facts.push({ key, value, quote: proof.quote, evidenceIds: [...new Set(proof.ids)] });
  }
  const summary = factKeys.length ? facts.map(({ key, value }) => `${key} · ${value}`).join("\n")
    : (typeof body?.summary === "string" ? body.summary : text).trim().slice(0, 8_000);
  if (factKeys.length) {
    const verified = new Set(facts.flatMap(({ evidenceIds }) => evidenceIds));
    for (const check of acceptance) {
      check.evidenceIds = check.evidenceIds.filter((id) => verified.has(id));
      check.met &&= check.evidenceIds.length > 0;
    }
  }
  return { summary, acceptance, unresolved, facts };
}

const normalizeQuote = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim();

function evidenceContains(text: string | undefined, quote: string) {
  if (!text) return false;
  const normalized = normalizeQuote(quote);
  if (normalizeQuote(text).includes(normalized)) return true;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.content === "string" && normalizeQuote(parsed.content).includes(normalized);
  } catch { return false; }
}

const numberPattern = "([-+]?\\d+(?:\\.\\d+)?)";
const unitPattern = "(°\\s*[CF]?|摄氏度|华氏度|度|%|mm|cm|km|m|kg|g)";
const readingPattern = new RegExp(`^${numberPattern}\\s*${unitPattern}?$`, "i");

function unitCode(unit: string | undefined) {
  if (!unit) return undefined;
  const value = unit.replace(/\s+/g, "").toLowerCase();
  if (value === "°c" || value === "摄氏度") return "c";
  if (value === "°f" || value === "华氏度") return "f";
  return value === "度" ? "°" : value;
}

/** 完整数值和单位要在引文同一处匹配，避免把“下午 2 点记录 29°C”误用为 2°C。 */
function matchesMeasurement(value: string, quote: string, factKey: string) {
  const declared = /:temp:(c|f)$/.exec(factKey)?.[1];
  const numeric = readingPattern.exec(normalizeQuote(value));
  if (!numeric) return !declared;
  const unit = unitCode(numeric[2]);
  if (declared && unit && declared !== unit) return false;
  const expected = declared ?? unit;
  const readings = normalizeQuote(quote).matchAll(new RegExp(`${numberPattern}\\s*${unitPattern}?`, "gi"));
  return Array.from(readings).some((item) => Number(item[1]) === Number(numeric[1]) && (!expected || unitCode(item[2]) === expected));
}

export function resultToolStatus(status: TerminalTaskStatus): ToolStatus {
  if (status === "completed") return "ok";
  if (status === "cancelled") return "cancelled";
  if (status === "timed-out") return "timeout";
  if (status === "partial" || status === "interrupted") return "unknown";
  if (status === "blocked") return "skipped";
  return "error";
}

/** 保留聊天里的可读正文，同一份结构供任务 API 和父 Agent 检查。 */
export function formatTaskResult(id: string, result: TaskResult) {
  const { summary, ...facts } = result;
  const fence = "```";
  return `${summary || "子 Agent 暂无结论。"}\n\n---\n子任务结果\n\n${fence}json\n${JSON.stringify({ taskId: id, ...facts })}\n${fence}`;
}
