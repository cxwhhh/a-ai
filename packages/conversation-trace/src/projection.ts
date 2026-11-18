import { splitAttachments } from "../../protocol/src/lib/attachments";
import { toolStatus, STATUS_LABEL, type StoredMessage } from "../../protocol/src/lib/shared";
import { db } from "../../storage/src/db";
import { getSession } from "../../storage/src/store";
import { parseToolArgs } from "../../agent-loop/src/args";
import { RESEARCH_SPEC } from "../../subagent/src/subagent";
import { toolSpecs } from "../../tool-runtime/src/index";
import { foldConsumedWork } from "../../session-projection/src/consumed-work";
import type { Agent } from "../../agent/src/runtime-types";
import { readAgentEvents } from "../../session/src/log";
import { fileRecoveryLabel, fileRecoveryMessage, readFileRecoveries } from "../../session/session-recovery/src/file-recovery";
import { getCurrentPosition, projectSession } from "../../session-projection/src/projection";
import type { SessionTrace, TraceRequestState, TraceRow, TraceToolState } from "./types";
import type { AgentLogEntry, AgentLogKind } from "../../protocol/src/agent-events";
import { listTraceEntries } from "./store";
import { analyzeSessionTrace } from "./analysis";

const eventTitles: Partial<Record<AgentLogKind, string>> = {
  queued: "输入排队", steered: "调整为引导", deferred: "引导转回队列", cancelled: "取消未执行的输入",
  truncated: "退出当前历史", "stop-requested": "请求停止", "turn-end": "轮次结束",
  artifact: "生成产出", archived: "归档", restored: "恢复归档", "model-selected": "切换模型",
};
const outcomes: Record<string, string> = {
  queued: "排队中", accepted: "已领取", running: "执行中", completed: "已完成",
  cancelled: "已取消", failed: "失败", "waiting-for-answer": "等待回答",
  "output-truncated": "输出截断", interrupted: "已中断", unknown: "结果未知",
};

/** 步骤号只在一轮内有效，同一轮的请求和返回必须用同一个作用域关联。 */
const stepKey = (event: Extract<AgentLogEntry, { kind: "model-request" | "model-result" }>) =>
  JSON.stringify([event.runId, event.inputId, event.detail.step]);

/**
 * 正文按保存顺序取全部版本，日志用来补齐取消、耗时和模型步骤。
 * 工具结果只关联当前助手消息下的调用，避免不同步骤复用 callId 时串结果。
 * 旧数据缺少精确边界时，使用已保存的消息顺序，缺失的结果保持未知。
 */
export function readSessionTrace(sessionId: string, userId: string, includeStats = false, active?: Agent): SessionTrace | null {
  const session = getSession(sessionId, userId);
  if (!session) return null;
  const events = readAgentEvents(userId, sessionId);
  const recoveries = new Map(readFileRecoveries(sessionId, userId)
    .map((recovery) => [JSON.stringify([recovery.assistantId, recovery.callId]), recovery]));
  const activeRunId = active?.activeRunId ?? null;
  const projection = projectSession(session, events);
  const { turn: currentTurn, step: currentStep } = getCurrentPosition(projection);
  const work = foldConsumedWork(projection, events, { activeRunId, queue: active?.queueSnapshot() ?? null });
  const byInput = new Map(work.map((item) => [item.inputId, item]));
  const byEventId = new Map(events.map((event) => [event.id, event]));
  const modelByMessage = new Map(events.flatMap((event) =>
    event.kind === "model-result" && typeof event.detail.messageId === "string" ? [[event.detail.messageId, event] as const] : []));
  const requests = new Map(events.filter((event) => event.kind === "model-request").map((event) => [stepKey(event), event]));
  const returned = new Set(events.filter((event) => event.kind === "model-result").map(stepKey));
  const entries = listTraceEntries(sessionId, userId, includeStats, !includeStats);
  const traceByAssistant = new Map(entries.flatMap((entry) =>
    entry.meta.kind === "request" && entry.meta.assistantId ? [[entry.meta.assistantId, entry] as const] : []));
  const tracedMainSteps = new Set(entries.flatMap(({ meta }) =>
    meta.kind === "request" && meta.phase === "chat" ? [JSON.stringify([meta.runId, meta.inputId, meta.step])] : []));
  const turns = new Map(projection.turns.map((turn) => [turn.inputId, turn]));
  const saved = db().prepare(`SELECT m.data, m.superseded_by FROM messages m JOIN sessions s ON s.id=m.session_id
    WHERE s.id=? AND s.user_id=? ORDER BY m.seq`).all(sessionId, userId);
  const rows: TraceRow[] = [];
  const turnNumbers = new Map<string, number>();
  const matchedModels = new Set<number>();
  const pending = new Map<string, TraceRow>();
  let turn = 0;
  let step = 0;
  let inputId = "";
  for (const item of saved) {
    const message = JSON.parse(String(item.data)) as StoredMessage;
    const historical = item.superseded_by != null;
    const base = { id: message.id, at: message.createdAt, historical };
    if (message.role === "user" && !message.feedback) {
      inputId = message.id;
      turnNumbers.set(inputId, ++turn);
      step = 0;
      pending.clear();
    }
    if (message.role === "user") {
      const input = byInput.get(message.id);
      const { text, files } = splitAttachments(message.content);
      rows.push({ ...base, kind: message.feedback && message.feedback.kind !== "note" ? "event" : "input",
        title: message.feedback?.summary || text || files.join("、") || "用户输入",
        body: text, paths: files, turn: turn || undefined, status: input && outcomes[input.status], input,
        durationMs: message.compact ? message.durationMs : undefined, detail: message.compact });
    }
    if (message.role === "assistant") {
      pending.clear();
      const event = modelByMessage.get(message.id);
      const request = traceByAssistant.get(message.id);
      if (includeStats && request?.meta.kind === "request" && request.finishedAt !== null && !request.meta.metrics?.usage && message.usage) {
        request.meta.metrics = { ...request.meta.metrics, usage: message.usage };
      }
      if (event) matchedModels.add(event.id);
      step = typeof event?.detail.step === "number" ? event.detail.step : step + 1;
      rows.push({ ...base, at: request?.finishedAt ?? base.at, kind: "model", title: message.content || message.reasoning || "模型响应", body: message.content,
        requestId: request?.id, reasoning: message.reasoning || request?.meta.preview?.reasoning, durationMs: message.durationMs, turn: turn || undefined, step,
        status: outcomes[String(event?.detail.outcome)], detail: event?.detail });
      const projected = turns.get(inputId);
      const toolFacts = projected?.steps.find((item) => item.step === step)?.tools;
      for (const call of message.toolCalls ?? []) {
        const args = parseToolArgs(call.arguments);
        const values = args.ok ? args.args : {};
        const paths = [...new Set([values.path, values.cwd].filter((value): value is string => typeof value === "string" && !!value))];
        if (!paths.length && call.name === "list_files" && args.ok) paths.push(".");
        const label = [values.purpose, values.description, paths[0], values.command].find((value): value is string => typeof value === "string" && !!value);
        const fact = toolFacts?.find((tool) => tool.callId === call.id);
        const start = fact?.startEventId === undefined ? undefined : byEventId.get(fact.startEventId);
        const end = fact?.resultEventId === undefined ? undefined : byEventId.get(fact.resultEventId);
        const running = !!(fact?.started && !end && projected?.runId === activeRunId && projected?.inputId === currentTurn?.inputId);
        const recovery = recoveries.get(JSON.stringify([message.id, call.id]));
        const row: TraceRow = { id: `${message.id}:${call.id}`, kind: "tool", tool: call.name,
          title: label || call.name, at: start?.at ?? ((message.durationMs ?? 0) + message.createdAt),
          turn: turn || undefined, step, historical, args: call.arguments, paths, requestId: request?.id,
          status: running ? "执行中" : recovery ? fileRecoveryLabel(recovery.verification) : STATUS_LABEL[fact?.status ?? "unknown"],
          callId: call.id, toolState: running ? "running" : fact?.status ?? "unknown", toolStarted: !!start,
          durationMs: end?.kind === "tool-result" ? end.detail.durationMs ?? undefined : undefined,
          result: recovery ? fileRecoveryMessage(recovery) : undefined,
          detail: recovery ? { verification: recovery.verification, checkedAt: recovery.checkedAt, path: recovery.path } : end?.detail };
        pending.set(call.id, row);
        rows.push(row);
      }
    }
    if (message.role === "tool") {
      const row = message.toolCallId ? pending.get(message.toolCallId) : undefined;
      const state = toolStatus(message);
      const result = {
        at: message.createdAt, durationMs: message.durationMs, result: message.content, status: STATUS_LABEL[state],
        callId: message.toolCallId, toolState: state, toolStarted: state !== "skipped" && (message.durationMs ?? 0) > 0,
      };
      if (row) {
        Object.assign(row, result, {
          at: row.toolStarted ? row.at : result.at - (result.durationMs ?? 0),
          toolStarted: row.toolStarted || result.toolStarted, durationMs: result.durationMs ?? row.durationMs,
          detail: message.errorKind ? { ...row.detail, errorKind: message.errorKind } : row.detail,
        });
        pending.delete(message.toolCallId!);
      } else {
        rows.push({ ...base, ...result, kind: "tool", title: "工具结果", turn: turn || undefined, step: step || undefined });
      }
    }
  }
  for (const event of events) {
    const workItem = event.inputId ? byInput.get(event.inputId) : undefined;
    const turn = turnNumbers.get(workItem?.turnInputId ?? event.inputId ?? "");
    const { detail } = event;
    const step = "step" in detail ? detail.step : undefined;
    const outcome = "outcome" in detail ? outcomes[detail.outcome] : undefined;
    const base = { id: `event:${event.id}`, at: event.at, turn, step, historical: workItem?.truncated, detail };
    if (event.kind === "model-result" && !matchedModels.has(event.id) && !tracedMainSteps.has(stepKey(event))) {
      const durationMs = event.detail.durationMs;
      rows.push({ ...base, kind: "model", title: "模型响应", at: requests.get(stepKey(event))?.at ?? event.at - (durationMs ?? 0), durationMs, status: outcome });
    } else if (event.kind === "model-request" && !returned.has(stepKey(event)) && !tracedMainSteps.has(stepKey(event))) {
      const running = event.runId === activeRunId && event.inputId === currentTurn?.inputId && step === currentStep?.step;
      const status = running ? "执行中" : workItem?.status === "cancelled" ? "已取消" : "未记录结果";
      rows.push({ ...base, kind: "model", title: "模型请求", status });
    } else if (eventTitles[event.kind]) {
      const title = eventTitles[event.kind]!;
      const summary = ["preview" in detail && detail.preview, "title" in detail && detail.title, "reason" in detail && detail.reason].find(Boolean);
      rows.push({ ...base, kind: "event", title: summary ? `${title} · ${summary}` : title, status: outcome, input: workItem,
        paths: "path" in detail && detail.path ? [detail.path] : undefined });
    }
  }
  for (const { id, at, finishedAt, outcome, meta } of entries) {
    const live = meta.runId === activeRunId && meta.inputId === currentTurn?.inputId;
    const state: TraceRequestState = outcome ?? (live ? "running" : "interrupted");
    const base = {
      id, at, traceId: id, parentId: meta.parentId, childStep: meta.childStep,
      turn: turnNumbers.get(meta.inputId), step: meta.step,
      historical: byInput.get(meta.inputId)?.truncated,
      durationMs: finishedAt === null ? undefined : finishedAt - at,
    };
    if (meta.kind === "tool") {
      const toolState: TraceToolState = meta.toolStatus
        ?? (state === "completed" ? "ok" : state === "failed" ? "error" : state === "output-truncated" ? "unknown" : state);
      const status = toolState === "running" || toolState === "interrupted" ? outcomes[toolState] : STATUS_LABEL[toolState];
      rows.push({ ...base, kind: "tool", title: "子工具调用", tool: meta.name, requestId: meta.parentId, callId: meta.callId,
        status, toolState, toolStarted: true, args: meta.preview?.arguments, result: meta.preview?.result,
        detail: meta.errorKind ? { errorKind: meta.errorKind } : undefined });
    } else {
      const phase = meta.phase === "compact" ? "历史压缩请求" : meta.phase === "research" ? "子 Agent 请求" : "模型请求";
      rows.push({ ...base, kind: "model", title: `${phase} · ${meta.model}`, status: outcomes[state],
        requestState: state, durationMs: meta.metrics?.streamMs ?? base.durationMs, detail: { model: meta.model, effort: meta.effort },
        preview: meta.preview, requestMetrics: meta.metrics });
    }
  }
  const used = new Set(rows.map((row) => row.tool));
  const schemas = Object.fromEntries([...toolSpecs(), RESEARCH_SPEC].filter((spec) => used.has(spec.name)).map((spec) => [spec.name, spec]));
  // 同一毫秒内按输入、请求、响应、工具、事件排列；同类记录保留原有顺序。
  const position = (row: TraceRow) => {
    if (row.kind === "input") return 0;
    if (row.kind === "model") return row.traceId ? 1 : 2;
    return row.kind === "tool" ? 3 : 4;
  };
  rows.sort((a, b) => a.at - b.at || position(a) - position(b));
  return { rows, schemas, running: activeRunId !== null,
    analysis: includeStats ? analyzeSessionTrace({ rows, entries, projection, work, events: byEventId, turnNumbers }) : undefined };
}
