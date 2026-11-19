import type { AgentLogEvent } from "../../protocol/src/agent-events";
import type { Session, StoredMessage } from "../../protocol/src/lib/shared";
import { beginTurn, createSession, deleteSession, getSession, newId, renameSession } from "../../storage/src/store";
import { readAgentPlugins } from "./agent-plugins";
import { isSessionArchived } from "./archive-admission";
import { recordAgentLog } from "./log";

export { HistoryConflict } from "../../storage/src/store";

/** Agent 按当前状态推进轮次。会话服务负责把输入和事件写入相应会话。 */
export interface AgentSession {
  isArchived(): boolean;
  newInputId(): string;
  beginTurn(session: Session, message: StoredMessage, runId: string, truncateFrom?: string): void;
  record(event: AgentLogEvent): void;
}

function newInputId() {
  return newId("m");
}

/** 绑定会话身份的持久化适配。SQLite 事务由存储层执行。 */
function bind(sessionId: string, userId: string): AgentSession {
  return {
    isArchived: () => isSessionArchived(sessionId, userId),
    newInputId,
    beginTurn(session, message, runId, truncateFrom) {
      if (session.id !== sessionId) throw new Error("轮次与 Agent 会话不匹配");
      beginTurn(session, message, truncateFrom, runId);
    },
    record: (event) => recordAgentLog(sessionId, event)
  };
}

/** 应用层通过同一个会话服务加载历史、建立会话及回滚失败的创建。 */
export const agentSessions = {
  bind,
  newInputId,
  get: getSession,
  create: createSession,
  rename: renameSession,
  remove: deleteSession,
  isArchived: isSessionArchived,
  pluginIds: readAgentPlugins
};

export type AgentSessionService = typeof agentSessions;
