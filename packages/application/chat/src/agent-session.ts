import type { AgentRegistry } from "../../../agent-registry/src/index";
import type { Session } from "../../../protocol/src/lib/shared";
import type { AgentSessionService } from "../../../session/src/agent-session";

/** 调用方提供已核验的旧会话。构造失败时只回收这次新建的会话。 */
export async function openChatAgent(sessions: AgentSessionService, registry: AgentRegistry, userId: string, restored: Session | null, title?: string, projectId?: string, multiAgent?: boolean) {
  const session = restored ?? sessions.create(userId, title, projectId, multiAgent);
  try {
    const pluginIds = restored ? sessions.pluginIds(session.id, userId) ?? [] : [];
    const handle = await registry.getOrCreate(session.id, userId, pluginIds);
    return { session, handle };
  } catch (error) {
    if (!restored) sessions.remove(session.id, userId);
    throw error;
  }
}
