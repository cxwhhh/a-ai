import { randomUUID } from "node:crypto";
import { db } from "./db";

/** 调用前须确认会话归属。同名文件在不同对话里有独立的 ID。 */
export function registerWorkspaceFile(sessionId: string, relativePath: string): string {
  const find = db().prepare("SELECT id FROM session_workspace_files WHERE session_id = ? AND relative_path = ?");
  const existing = find.get(sessionId, relativePath);
  if (existing) return existing.id as string;
  db().prepare("INSERT INTO session_workspace_files (id, session_id, relative_path) VALUES (?, ?, ?) ON CONFLICT (session_id, relative_path) DO NOTHING")
    .run(randomUUID(), sessionId, relativePath);
  return find.get(sessionId, relativePath)!.id as string;
}

export function workspaceFilePath(sessionId: string, id: string): string | undefined {
  return db().prepare("SELECT relative_path FROM session_workspace_files WHERE session_id = ? AND id = ?")
    .get(sessionId, id)?.relative_path as string | undefined;
}
