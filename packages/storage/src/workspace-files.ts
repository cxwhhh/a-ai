import { randomUUID } from "node:crypto";
import { db } from "./db";

/** 已有文件也可按原路径登记。应用对外只在当前账号下解析文件 ID。 */
export function registerWorkspaceFile(userId: string, relativePath: string): string {
  const find = db().prepare("SELECT id FROM workspace_files WHERE user_id = ? AND relative_path = ?");
  const existing = find.get(userId, relativePath);
  if (existing) return existing.id as string;
  db().prepare("INSERT INTO workspace_files (id, user_id, relative_path) VALUES (?, ?, ?) ON CONFLICT (user_id, relative_path) DO NOTHING")
    .run(randomUUID(), userId, relativePath);
  return find.get(userId, relativePath)!.id as string;
}

export function workspaceFilePath(userId: string, id: string): string | undefined {
  return db().prepare("SELECT relative_path FROM workspace_files WHERE user_id = ? AND id = ?")
    .get(userId, id)?.relative_path as string | undefined;
}
