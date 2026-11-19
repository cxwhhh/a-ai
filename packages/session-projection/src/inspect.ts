import type { Agent } from "../../agent-core/agent/src/runtime-types";
import type { AgentWorkSnapshot } from "../../protocol/src/agent-events";
import { readAgentEvents } from "../../session/src/log";
import { getSession } from "../../storage/src/store";
import { countConsumedWork, foldConsumedWork } from "./consumed-work";
import { projectSession } from "./projection";

/** 用持久化事件核对实时队列和运行。无登记实例时仍可读历史，查询不会恢复或启动 Agent。 */
export function inspectAgentWork(sessionId: string, userId: string, live?: Agent): AgentWorkSnapshot | null {
  const session = getSession(sessionId, userId);
  if (!session) return null;
  const events = readAgentEvents(userId, sessionId);
  const projection = projectSession(session, events);
  const agent = live?.id === sessionId && live.userId === userId ? live : undefined;
  const activeRunId = agent?.activeRunId ?? null;
  const inputs = foldConsumedWork(projection, events, {
    activeRunId,
    queue: agent?.queueSnapshot() ?? null
  });
  return {
    projection,
    inputs,
    // offline 表示当前 Host 没有登记该实例。连接状态由接入层判断。
    lifecycle: agent?.status ?? "offline",
    activeRunId,
    counts: countConsumedWork(inputs)
  };
}
