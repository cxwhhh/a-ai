import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorkspaceAppCommand, WorkspaceAppReply } from "../../protocol/src/workspace-app";
import { DATA_DIR, db, tx } from "../../storage/src/db";
import { assertRegularDatabase, executeWorkspaceApp } from "./app-runtime";

/** 活跃数据库在主服务目录，命令容器只挂载账号工作区。 */
export async function workspaceAppRequest(workspace: string, command: WorkspaceAppCommand, signal?: AbortSignal): Promise<WorkspaceAppReply> {
  try {
    signal?.throwIfAborted();
    return executeWorkspaceApp(prepareWorkspaceApps(workspace), command);
  } catch {
    // 不在接口错误和日志中暴露表单内容或主机文件路径。
    return { status: 503, error: "账号应用存储暂不可用，请稍后重试" };
  }
}

/** 启动时先迁移旧库，再接受工具请求。失败的快照可在下次访问应用时重试。 */
export function prepareAccountApps(workspaceOf: (userId: string) => string) {
  for (const { id } of db().prepare("SELECT id FROM users").iterate()) {
    try { prepareWorkspaceApps(workspaceOf(String(id))); } catch {
      console.error("[workspace-apps] 账号应用存储迁移失败，将在访问时重试");
    }
  }
}

function prepareWorkspaceApps(workspace: string) {
  // 使用相对位置标识逻辑工作区，整套数据搬往另一个 DATA_DIR 后仍能打开。
  const key = createHash("sha256").update(path.relative(DATA_DIR, path.resolve(workspace)).split(path.sep).join("/")).digest("hex");
  const directory = path.join(DATA_DIR, "workspace-apps", key);
  const filename = path.join(directory, "apps.sqlite");
  const legacy = path.join(workspace, ".aai-apps");
  const archived = path.join(directory, "legacy");
  if (!existsSync(filename) && (existsSync(path.join(legacy, "apps.sqlite")) || existsSync(archived))) {
    tx(() => migrateWorkspaceApps(filename, legacy, archived));
  }
  return filename;
}

function migrateWorkspaceApps(filename: string, legacy: string, archived: string) {
  if (existsSync(filename)) return;
  if (!existsSync(archived)) {
    mkdirSync(path.dirname(archived), { recursive: true, mode: 0o700 });
    // 把原库和 WAL 一起移出工具挂载。中断后可从封存的原库重试。
    renameSync(legacy, archived);
  }
  const previous = path.join(archived, "apps.sqlite");
  assertRegularDatabase(previous);
  const temporary = path.join(path.dirname(filename), `migration-${randomUUID()}.sqlite`);
  const db = new DatabaseSync(previous, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=4000; PRAGMA trusted_schema=OFF;");
    // SQLite 以一致快照复制。已有打开句柄或硬链接不会指向新库。
    db.prepare("VACUUM INTO ?").run(temporary);
    renameSync(temporary, filename);
  } finally {
    db.close();
    rmSync(temporary, { force: true });
  }
}
