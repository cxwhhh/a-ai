import { db, tx } from "../../storage/src/db";
import type { Agent } from "../../agent-core/agent/src/runtime-types";
import { recordAgentLog } from "./log";

export type ArchiveTarget = "session" | "project";

/** 项目归档期间，它的对话也暂停接收输入；恢复项目不改变单独归档的对话。 */
export function isSessionArchived(sessionId: string, userId: string): boolean {
  const row = db().prepare(`SELECT COALESCE(s.archived_at,p.archived_at) AS archived_at
    FROM sessions s LEFT JOIN projects p ON p.id=s.project_id AND p.user_id=s.user_id
    WHERE s.id=? AND s.user_id=?`).get(sessionId, userId);
  return row?.archived_at != null;
}

/**
 * 更新会话或项目的归档标记，并为受影响的会话记录事件。
 * 项目归档前检查所有会话的在线占用。发现运行或收尾中的实例时返回 busy。
 * 标记和事件在同一事务内提交，日志写入失败时一并回滚。
 */
export function setArchive(lookup: (id: string, userId: string) => Agent | undefined,
  target: ArchiveTarget, id: string, userId: string, archived: boolean): "ok" | "missing" | "busy" {
  const table = target === "session" ? "sessions" : "projects";
  return tx(() => {
    const row = db().prepare(`SELECT archived_at FROM ${table} WHERE id=? AND user_id=?`).get(id, userId);
    if (!row) return "missing";
    // 重复提交同一归档状态时直接成功，保留原时间并避免重复写日志。
    if ((row.archived_at != null) === archived) return "ok";
    const ids = target === "session" ? [id] : db().prepare("SELECT id FROM sessions WHERE project_id=? AND user_id=?").all(id, userId).map((s) => String(s.id));
    if (archived && ids.some((sid) => {
      const status = lookup(sid, userId)?.status;
      return status === "running" || status === "closing";
    })) return "busy";
    db().prepare(`UPDATE ${table} SET archived_at=? WHERE id=? AND user_id=?`).run(archived ? Date.now() : null, id, userId);
    for (const sid of ids) recordAgentLog(sid, {
      kind: archived ? "archived" : "restored",
      detail: {
        target,
        targetId: id
      }
    });
    return "ok";
  });
}
