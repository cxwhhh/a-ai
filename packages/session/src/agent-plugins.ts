import { db, tx } from "../../storage/src/db";

/** 老会话默认没有专属插件。按用户读取也区分空配置与无权访问的会话。 */
export function readAgentPlugins(sessionId: string, userId: string): string[] | null {
  const rows = db().prepare(`
    SELECT p.plugin_id FROM sessions s
    LEFT JOIN agent_plugin_selection p ON p.session_id = s.id
    WHERE s.id = ? AND s.user_id = ?
    ORDER BY p.plugin_id
  `).all(sessionId, userId);
  if (!rows.length) return null;
  return rows.flatMap(({ plugin_id }) => typeof plugin_id === "string" ? [plugin_id] : []);
}

/** 在同一事务内校验所有权并替换整份配置。 */
export function writeAgentPlugins(sessionId: string, userId: string, pluginIds: readonly string[]): boolean {
  return tx(() => {
    if (!db().prepare("SELECT 1 FROM sessions WHERE id = ? AND user_id = ?").get(sessionId, userId)) return false;
    db().prepare("DELETE FROM agent_plugin_selection WHERE session_id = ?").run(sessionId);
    const insert = db().prepare("INSERT INTO agent_plugin_selection (session_id, plugin_id) VALUES (?, ?)");
    for (const id of pluginIds) insert.run(sessionId, id);
    return true;
  });
}
