import type { AgentConsumedInput, AgentLogEntry, AgentQueueSnapshot, AgentSessionProjection, AgentWorkSnapshot, AgentWorkStatus } from "../../protocol/src/agent-events";
import { orderedSessionEvents } from "./projection";

/**
 * 对账输入、模型请求和轮次结果。队列的取消与运行中的取消分开记录；
 * 进程重启后没有结束记录的轮次为 interrupted，遗失的内存排队项为 unknown。
 * 投影与实时快照必须属于同一会话；这里只计算事实，不自动重跑、删除或回滚文件。
 */
export function foldConsumedWork(projection: AgentSessionProjection, entries: readonly AgentLogEntry[],
  live: {
    activeRunId: string | null;
    queue: AgentQueueSnapshot | null
  }): AgentConsumedInput[] {
  const inputs = new Map<string, AgentConsumedInput>();
  const get = (id: string) => {
    let input = inputs.get(id);
    if (!input) {
      input = {
        inputId: id,
        kind: "unknown",
        claimed: false,
        consumed: false,
        status: "unknown",
        droppedUnrun: false,
        truncated: false,
        inCurrentHistory: false
      };
      inputs.set(id, input);
    }
    return input;
  };
  for (const event of orderedSessionEvents(projection.sessionId, entries)) {
    if (!event.inputId) continue;
    // 模型/工具等事件以主输入为所有者；这里只处理输入本身的生命周期。
    if (!["queued", "accepted", "guidance", "cancelled", "truncated"].includes(event.kind)) continue;
    const input = get(event.inputId);
    if (event.kind === "queued") input.kind = "queued";
    if (event.kind === "accepted" || event.kind === "guidance") {
      input.kind = event.kind === "guidance" ? "guidance" : "turn";
      input.claimed = true;
      input.runId = event.runId;
      input.turnInputId = event.kind === "guidance" ? event.detail.turnInputId ?? event.inputId : event.inputId;
    }
    if (event.kind === "cancelled") {
      input.status = "cancelled";
      input.droppedUnrun = true;
    }
    if (event.kind === "truncated") input.truncated = true;
  }
  // 先按运行和主输入归组。一个 runId 下可以处理多轮，只按运行归组会把引导关联到别的轮。
  const byTurn = new Map<string, string[]>();
  for (const input of inputs.values()) {
    if (!input.runId || !input.turnInputId) continue;
    const key = JSON.stringify([input.runId, input.turnInputId]);
    const group = byTurn.get(key) ?? [];
    group.push(input.inputId);
    byTurn.set(key, group);
  }
  for (const turn of projection.turns) {
    const primary = get(turn.inputId);
    primary.kind = "turn";
    primary.claimed = true;
    primary.runId = turn.runId;
    primary.turnInputId = turn.inputId;
    const relevant = new Set([turn.inputId, ...byTurn.get(JSON.stringify([turn.runId, turn.inputId])) ?? []]);
    // 有模型请求才记录输入已消费。引导必须出现在该步的 guidanceIds 中才获得相同证据。
    for (const step of turn.steps) {
      if (!step.modelRequested) continue;
      primary.consumed = true;
      for (const id of step.guidanceIds) {
        const input = get(id);
        Object.assign(input, {
          kind: "guidance",
          claimed: true,
          consumed: true,
          runId: turn.runId,
          turnInputId: turn.inputId
        });
        relevant.add(id);
      }
    }
    for (const id of relevant) {
      const input = get(id);
      input.inCurrentHistory = turn.inCurrentHistory && !input.truncated;
      input.droppedUnrun = false;
      if (turn.endEventId !== null) {
        // 引导进入模型请求后才共享该轮结果。仅被领取的引导没有独立的执行结果。
        const withoutResult = !input.consumed && (input.kind === "guidance" || turn.outcome === "completed");
        input.status = withoutResult ? "unknown" : turn.outcome ?? "unknown";
      } else {
        // 有开始记录但没有结束记录，且实时占用已不存在时，保留中断事实供排查。
        input.status = live.activeRunId === turn.runId ? input.consumed ? "running" : "accepted" : "interrupted";
      }
    }
  }
  for (const id of projection.untrackedInputIds) {
    const input = get(id);
    input.inCurrentHistory = true;
    // 历史中的正文只证明消息存在。没有领取或请求证据的输入保持 unknown。
  }
  // 只有同一会话的实时队列能确认输入还在等待。单独的 queued 日志可能来自已结束的进程。
  if (live.queue?.sessionId === projection.sessionId) {
    for (const item of live.queue.items) {
      const input = get(item.id);
      if (!input.claimed && !input.droppedUnrun) {
        input.kind = "queued";
        input.status = "queued";
      }
    }
  }
  return [...inputs.values()];
}

/** 相同口径的数量便于比较不同 Agent；取消与失败仍可展开查看各自执行过的工具。 */
export function countConsumedWork(inputs: readonly AgentConsumedInput[]): AgentWorkSnapshot["counts"] {
  const counts: Record<AgentWorkStatus, number> = {
    queued: 0,
    accepted: 0,
    running: 0,
    completed: 0,
    cancelled: 0,
    failed: 0,
    "waiting-for-answer": 0,
    "output-truncated": 0,
    interrupted: 0,
    unknown: 0
  };
  for (const input of inputs) counts[input.status]++;
  return counts;
}
