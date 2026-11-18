import { estimateRequest } from "../../context-engine/src/context";
import { countConsumedWork } from "../../session-projection/src/consumed-work";
import type { AgentConsumedInput, AgentLogEntry, AgentSessionProjection } from "../../protocol/src/agent-events";
import type { Usage } from "../../llm/src/types";
import type {
  RequestContextAnalysis, RequestMetrics, RequestSnapshot, TraceAnalysis, TraceDurationTotal,
  TraceEntry, TraceRequestState, TraceRequestTotals, TraceRow, TraceUsageTotal,
} from "./types";

/** 同一作用域内比较适配器输入。相同内容被移到别处时，位置仍会显示有变化。 */
export function analyzeRequestContext(request: RequestSnapshot, baseline?: { entry: TraceEntry; request: RequestSnapshot }): RequestContextAnalysis {
  const messages = { system: 0, user: 0, assistant: 0, tool: 0 };
  for (const message of request.messages) messages[message.role]++;
  const result: RequestContextAnalysis = { messages, estimatedInputTokens: estimateRequest(request.messages, request.tools) };
  if (!baseline) return result;

  const before = baseline.request.messages.map((message) => JSON.stringify(message));
  const after = request.messages.map((message) => JSON.stringify(message));
  const remaining = new Map<string, number>();
  for (const key of before) remaining.set(key, (remaining.get(key) ?? 0) + 1);
  let shared = 0;
  for (const key of after) {
    const count = remaining.get(key) ?? 0;
    if (count > 0) {
      shared++;
      remaining.set(key, count - 1);
    }
  }
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;

  const previousTools = new Map(baseline.request.tools.map((tool) => [tool.name, JSON.stringify(tool)]));
  const nextTools = new Map(request.tools.map((tool) => [tool.name, JSON.stringify(tool)]));
  const commonBefore = [...previousTools.keys()].filter((name) => nextTools.has(name));
  const commonAfter = [...nextTools.keys()].filter((name) => previousTools.has(name));
  const system = (snapshot: RequestSnapshot) => snapshot.messages.filter((message) => message.role === "system").map((message) => message.content);
  result.previous = {
    id: baseline.entry.id, step: baseline.entry.meta.step, childStep: baseline.entry.meta.childStep,
    firstChanged: prefix === before.length && prefix === after.length ? undefined : prefix + 1,
    added: after.length - shared, removed: before.length - shared,
    systemChanged: JSON.stringify(system(baseline.request)) !== JSON.stringify(system(request)),
    toolsAdded: [...nextTools.keys()].filter((name) => !previousTools.has(name)),
    toolsRemoved: [...previousTools.keys()].filter((name) => !nextTools.has(name)),
    toolsChanged: commonAfter.filter((name) => nextTools.get(name) !== previousTools.get(name)),
    toolOrderChanged: commonAfter.some((name, index) => name !== commonBefore[index]),
  };
  return result;
}

const known = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const durationTotal = (): TraceDurationTotal => ({ count: 0, ms: 0 });
const usageTotal = (): TraceUsageTotal => ({ count: 0, input: 0, output: 0 });
const requestTotals = (): TraceRequestTotals => ({
  count: 0, phases: { chat: 0, compact: 0, research: 0 }, states: {},
  elapsed: durationTotal(), firstOutput: durationTotal(), decode: { ...durationTotal(), tokens: 0 },
  reported: usageTotal(), estimated: usageTotal(),
});

function measure(total: TraceDurationTotal, ms: number | undefined) {
  if (known(ms)) {
    total.count++;
    total.ms += ms;
  }
}

function addUsage(total: TraceUsageTotal, usage: Usage) {
  total.count++;
  total.input += usage.inputTokens;
  total.output += usage.outputTokens;
  if (known(usage.cacheHitTokens) && usage.cacheHitTokens <= usage.inputTokens) {
    total.cacheRead = (total.cacheRead ?? 0) + usage.cacheHitTokens;
    total.cacheReadInput = (total.cacheReadInput ?? 0) + usage.inputTokens;
  }
  if (known(usage.cacheWriteTokens) && usage.cacheWriteTokens <= usage.inputTokens) {
    total.cacheWrite = (total.cacheWrite ?? 0) + usage.cacheWriteTokens;
  }
  if (known(usage.reasoningTokens) && usage.reasoningTokens <= usage.outputTokens) {
    total.reasoning = (total.reasoning ?? 0) + usage.reasoningTokens;
  }
}

function addRequest(totals: TraceRequestTotals, entry: TraceEntry, state: TraceRequestState) {
  if (entry.meta.kind !== "request") return;
  totals.count++;
  totals.phases[entry.meta.phase]++;
  totals.states[state] = (totals.states[state] ?? 0) + 1;
  const metrics: RequestMetrics | undefined = entry.meta.metrics;
  const elapsed = metrics?.streamMs ?? (entry.finishedAt === null ? undefined : entry.finishedAt - entry.at);
  measure(totals.elapsed, elapsed);
  measure(totals.firstOutput, metrics?.firstOutputMs);
  const usage = metrics?.usage;
  if (!usage || !known(usage.inputTokens) || !known(usage.outputTokens)) return;
  addUsage(usage.estimated ? totals.estimated : totals.reported, usage);
  // 速度分母只使用和上报输出 token 来自同一次请求的有效解码时长。
  if (!usage.estimated && known(elapsed) && known(metrics?.firstOutputMs) && elapsed > metrics.firstOutputMs) {
    measure(totals.decode, elapsed - metrics.firstOutputMs);
    totals.decode.tokens += usage.outputTokens;
  }
}

/**
 * 会话统计来自完整记录。模型只计请求，助手回复仍可展开但不重复计数。
 * 工具累计耗时可能包含并行和嵌套调用，和某一轮的墙钟时长分别计算。
 */
export function analyzeSessionTrace({ rows, entries, projection, work, events, turnNumbers }: {
  rows: readonly TraceRow[];
  entries: readonly TraceEntry[];
  projection: AgentSessionProjection;
  work: readonly AgentConsumedInput[];
  events: ReadonlyMap<number, AgentLogEntry>;
  turnNumbers: ReadonlyMap<string, number>;
}): TraceAnalysis {
  const requests = requestTotals();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const models = new Map<string, TraceAnalysis["models"][number]>();
  const tools = new Map<string, TraceAnalysis["tools"][number]>();
  const issues: TraceAnalysis["issues"] = [];
  const scope = (runId: string, inputId: string) => JSON.stringify([runId, inputId]);
  const requestsByTurn = new Map<string, number>();
  const toolsByTurn = new Map<number, number>();
  const guidanceByTurn = new Map<string, { total: number; consumed: number }>();

  for (const entry of entries) {
    const { meta } = entry;
    if (meta.kind !== "request") continue;
    const state = byId.get(entry.id)?.requestState ?? entry.outcome ?? "interrupted";
    addRequest(requests, entry, state);
    const turnKey = scope(meta.runId, meta.inputId);
    requestsByTurn.set(turnKey, (requestsByTurn.get(turnKey) ?? 0) + 1);

    const key = JSON.stringify([meta.model, meta.effort]);
    let model = models.get(key);
    if (!model) {
      model = { model: meta.model, effort: meta.effort, totals: requestTotals(), rowId: entry.id };
      models.set(key, model);
    }
    addRequest(model.totals, entry, state);
    model.rowId = entry.id;
    const finishReason = meta.metrics?.finishReason;
    if ((state !== "completed" && state !== "running") || finishReason === "refusal" || finishReason === "content_filter") {
      issues.push({ rowId: entry.id, state, finishReason, error: meta.metrics?.error });
    }
  }

  let legacyModelRows = 0;
  for (const row of rows) {
    if (row.kind === "model" && !row.traceId && !row.requestId) legacyModelRows++;
    if (row.kind !== "tool") continue;
    if (row.turn !== undefined) toolsByTurn.set(row.turn, (toolsByTurn.get(row.turn) ?? 0) + 1);
    const name = row.tool ?? "未记录工具名";
    let tool = tools.get(name);
    if (!tool) {
      tool = { name, count: 0, started: 0, children: 0, elapsed: durationTotal(), states: {}, rowId: row.id };
      tools.set(name, tool);
    }
    tool.count++;
    if (row.parentId) tool.children++;
    if (row.toolStarted) {
      tool.started++;
      measure(tool.elapsed, row.durationMs);
    }
    const state = row.toolState ?? "unknown";
    tool.states[state] = (tool.states[state] ?? 0) + 1;
    tool.rowId = row.id;
  }

  let consumed = 0;
  let dropped = 0;
  const byInput = new Map(work.map((input) => [input.inputId, input]));
  for (const input of work) {
    if (input.consumed) consumed++;
    if (input.droppedUnrun) dropped++;
    if (input.kind !== "guidance" || !input.runId || !input.turnInputId) continue;
    const key = scope(input.runId, input.turnInputId);
    const count = guidanceByTurn.get(key) ?? { total: 0, consumed: 0 };
    count.total++;
    if (input.consumed) count.consumed++;
    guidanceByTurn.set(key, count);
  }
  const turns = projection.turns.map((turn) => {
    const key = scope(turn.runId, turn.inputId);
    const input = byInput.get(turn.inputId);
    const guidance = guidanceByTurn.get(key);
    const at = events.get(turn.startEventId)?.at;
    const end = turn.endEventId === null ? undefined : events.get(turn.endEventId)?.at;
    const number = turnNumbers.get(turn.inputId);
    return {
      inputId: turn.inputId, number, at,
      durationMs: at !== undefined && end !== undefined && end >= at ? end - at : undefined,
      status: input?.status ?? turn.outcome ?? "unknown", historical: byId.get(turn.inputId)?.historical ?? input?.truncated ?? false,
      consumed: input?.consumed ?? false, guidance: guidance?.total ?? 0, consumedGuidance: guidance?.consumed ?? 0,
      steps: turn.steps.length, closedSteps: turn.steps.filter((step) => step.endEventId !== null).length,
      requests: requestsByTurn.get(key) ?? 0, tools: number === undefined ? 0 : toolsByTurn.get(number) ?? 0,
      rowId: byId.has(turn.inputId) ? turn.inputId : undefined,
    };
  });

  return {
    requests, legacyModelRows, models: [...models.values()], tools: [...tools.values()], turns, issues,
    inputs: { total: work.length, consumed, dropped, counts: countConsumedWork(work) },
  };
}
