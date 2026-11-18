import type { AgentEvent } from "./lib/shared";
import type { AgentEventScope } from "./agent-events";

/**
 * 给一条流固定会话和运行。普通事件可以省略 scope，由绑定后的发送函数补齐。
 * session 和 queue 事件的正文也带归属，必须一并核对，防止前端收到其他对话的数据。
 */
export function bindAgentDispatch(scope: AgentEventScope, send: (event: AgentEvent) => void) {
  const owner = { ...scope };
  return (event: AgentEvent) => {
    if (event.scope && (event.scope.sessionId !== owner.sessionId || event.scope.runId !== owner.runId)) return;
    if (event.type === "session" && (event.session.id !== owner.sessionId || event.runId !== owner.runId)) return;
    if (event.type === "queue" && event.queue.sessionId !== owner.sessionId) return;
    send({
      ...event,
      scope: { ...owner }
    });
  };
}
