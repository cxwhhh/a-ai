import type { Session } from "../../protocol/src/lib/shared";
import type { AgentLogEntry, AgentSessionProjection, AgentStepProjection, AgentTurnProjection } from "../../protocol/src/agent-events";

/**
 * 从会话的完整事件序列投影轮次与步骤，不写库、不恢复运行，也不解析回答文字猜结果。
 * 输入可以来自倒序日志，但不能只给分页中的一页。消息只用于判断当前历史归属。
 * runId + inputId 唯一定位一轮：同一条 SSE 可以顺序处理多个排队输入。
 */
export function projectSession(session: Pick<Session, "id" | "revision" | "messages">, entries: readonly AgentLogEntry[]): AgentSessionProjection {
  const events = orderedSessionEvents(session.id, entries);
  const visible = new Set(session.messages.map((message) => message.id));
  const turns = new Map<string, AgentTurnProjection>();
  for (const event of events) {
    const { runId, inputId, detail } = event;
    if (!runId || !inputId) continue;
    const key = JSON.stringify([runId, inputId]);
    // 领取和轮次开始可能相邻出现，保留先到的事件作为起点。
    if ((event.kind === "accepted" || event.kind === "turn-start") && !turns.has(key)) {
      turns.set(key, {
        sessionId: session.id,
        runId,
        inputId,
        startEventId: event.id,
        endEventId: null,
        outcome: null,
        inCurrentHistory: visible.has(inputId),
        steps: []
      });
    }
    const turn = turns.get(key);
    if (!turn) continue;
    if (event.kind === "turn-end") {
      turn.endEventId = event.id;
      turn.outcome = event.detail.outcome;
      continue;
    }
    // 已结束的轮次拒绝迟到步骤，避免旧事件改变下一轮的边界。
    if (turn.endEventId !== null) continue;
    const number = "step" in detail ? detail.step : undefined;
    let step = number ? turn.steps.find((item) => item.step === number) : turn.steps.at(-1);
    // 已观测到模型请求时也能定位一步。缺少显式开始事件时保留证据来源，避免补造边界。
    if ((event.kind === "step-start" || event.kind === "model-request") && number && !step) {
      step = {
        step: number,
        startEventId: event.id,
        endEventId: null,
        explicitBoundary: event.kind === "step-start",
        modelRequested: false,
        modelOutcome: null,
        guidanceIds: [],
        tools: []
      };
      turn.steps.push(step);
    }
    if (!step) continue;
    switch (event.kind) {
      case "step-end": step.endEventId = event.id; break;
      case "model-request":
        step.modelRequested = true;
        step.guidanceIds = event.detail.guidanceIds.split(",").filter(Boolean);
        break;
      case "model-result": step.modelOutcome = event.detail.outcome; break;
      case "tool-start":
      case "tool-result": {
        let tool = step.tools.find((item) => item.callId === event.detail.callId);
        // 仅有结果也可展示，例如工具在启动前被拦截。只有 tool-start 能确认工具进入执行阶段。
        if (!tool) {
          tool = {
            callId: event.detail.callId,
            started: false,
            status: "unknown"
          };
          step.tools.push(tool);
        }
        if (event.kind === "tool-start") {
          tool.name = event.detail.name;
          tool.started = true;
          tool.startEventId = event.id;
        }
        else {
          tool.status = event.detail.status;
          tool.resultEventId = event.id;
        }
        break;
      }
    }
  }
  const tracked = new Set(events.filter((event) => event.kind === "accepted" || event.kind === "guidance" || event.kind === "turn-start").map((event) => event.inputId));
  const untrackedInputIds = session.messages.filter((message) => message.role === "user" && (!message.feedback || message.feedback.kind === "note") && !tracked.has(message.id)).map((message) => message.id);
  return {
    sessionId: session.id,
    revision: session.revision ?? 0,
    lastEventId: events.at(-1)?.id ?? 0,
    turns: [...turns.values()],
    untrackedInputIds
  };
}

/**
 * 从投影末尾读取尚无结束事件的轮次和步骤。较新的边界关闭后，较早的开放记录仍留在历史中。
 * 这里只反映日志边界，调用方要核对实时 activeRunId 才能判断是否仍在执行。
 */
export function getCurrentPosition(projection: AgentSessionProjection): {
  turn: AgentTurnProjection | null;
  step: AgentStepProjection | null;
} {
  const latest = projection.turns.at(-1);
  const turn = latest?.endEventId === null ? latest : null;
  const lastStep = turn?.steps.at(-1);
  return {
    turn,
    step: lastStep?.endEventId === null ? lastStep : null
  };
}

/** 按持久化序号折叠，过滤其他会话并去重；时间戳相同不影响先后顺序。 */
export function orderedSessionEvents(sessionId: string, entries: readonly AgentLogEntry[]): AgentLogEntry[] {
  return [...new Map(entries.filter((event) => event.sessionId === sessionId).map((event) => [event.id, event])).values()].sort((a, b) => a.id - b.id);
}
