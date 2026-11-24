import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import {
  APP_HTML_BYTES, APP_RECORD_BYTES, isWorkspaceAppId,
  type WorkspaceApp, type WorkspaceAppCommand, type WorkspaceAppReply, type WorkspaceAppRecord, type WorkspaceRecordCommand,
} from "../../protocol/src/workspace-app.ts";

const TABLES = `
  CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, html TEXT NOT NULL,
    revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, project_id TEXT
  );
  CREATE TABLE IF NOT EXISTS app_records (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL REFERENCES apps(id),
    id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS app_records_page ON app_records(app_id, seq DESC);
`;
const PAGE = 50;
type Row = Record<string, SQLOutputValue>;
const missing = { status: 404, error: "应用不存在" } as const;

export function workspaceAppsPath(workspace: string) {
  return path.join(workspace, ".aai-apps", "apps.sqlite");
}

/**
 * 每个账号的应用和数据放在自己的工作区。Docker 驱动在容器内打开同一个挂载卷。
 * 重建容器时重新打开数据库即可。更新页面只替换该应用的 HTML，不触碰记录。
 */
export function executeWorkspaceApp(workspace: string, request: WorkspaceAppCommand): WorkspaceAppReply {
  const filename = workspaceAppsPath(workspace);
  const current = lstatSync(filename, { throwIfNoEntry: false });
  if (!current && request.type === "list-apps") return { apps: [] };
  if (!current && request.type !== "deploy-app") return missing;

  const directory = path.dirname(filename);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() ||
      [filename, filename + "-wal", filename + "-shm", filename + "-journal"].some((file) => {
        const info = lstatSync(file, { throwIfNoEntry: false });
        return info && !info.isFile();
      })) throw new Error("应用存储必须位于账号工作区");

  const db = new DatabaseSync(filename);
  try {
    db.exec("PRAGMA busy_timeout=4000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    db.exec(TABLES);
    if (!hasProjectColumn(db)) {
      // 来自旧版本的工作区首次打开时升级。加锁后重查，避免两个请求同时修改表。
      db.exec("BEGIN IMMEDIATE");
      if (!hasProjectColumn(db)) db.exec("ALTER TABLE apps ADD COLUMN project_id TEXT");
      db.exec("COMMIT");
    }
    if (request.type === "list-apps") {
      return { apps: db.prepare("SELECT id, title, revision, updated_at, project_id FROM apps ORDER BY updated_at DESC, id").all().map(appSummary) };
    }
    if (request.type === "deploy-app") return deploy(db, request);
    if (!isWorkspaceAppId(request.appId)) return missing;
    if (request.type === "read-app") {
      const row = db.prepare("SELECT * FROM apps WHERE id=?").get(request.appId);
      return row && (!request.projectId || !row.project_id || row.project_id === request.projectId) ? { app: appFromRow(row) } : missing;
    }
    if (!db.prepare("SELECT 1 FROM apps WHERE id=?").get(request.appId)) return missing;
    return operateRecords(db, request.appId, request.command);
  } finally {
    db.close();
  }
}

function hasProjectColumn(db: DatabaseSync) {
  return db.prepare("SELECT 1 FROM pragma_table_info('apps') WHERE name='project_id'").get();
}

function deploy(db: DatabaseSync, request: Extract<WorkspaceAppCommand, { type: "deploy-app" }>): WorkspaceAppReply {
  const title = typeof request.title === "string" ? request.title.trim() : "";
  if (!title || title.length > 120 || typeof request.html !== "string" || !request.html.trim()) {
    return { status: 400, error: "需要应用名称和完整的 HTML" };
  }
  if (Buffer.byteLength(request.html) > APP_HTML_BYTES) return { status: 413, error: "应用页面超过 512 KB" };
  if (request.appId !== undefined) {
    if (!isWorkspaceAppId(request.appId)) return missing;
    const row = db.prepare(`UPDATE apps SET title=?, html=?, revision=revision+1, updated_at=?, project_id=COALESCE(project_id, ?)
      WHERE id=? AND (? IS NULL OR project_id=? OR (project_id IS NULL AND ?=1)) RETURNING *`)
      .get(title, request.html, Date.now(), request.projectId ?? null, request.appId,
        request.projectId ?? null, request.projectId ?? null, Number(request.attachLegacy === true));
    return row ? { app: appFromRow(row) } : missing;
  }
  const row = db.prepare("INSERT INTO apps (id,title,html,revision,updated_at,project_id) VALUES (?, ?, ?, 1, ?, ?) RETURNING *")
    .get(randomUUID(), title, request.html, Date.now(), request.projectId ?? null)!;
  return { app: appFromRow(row) };
}

function operateRecords(db: DatabaseSync, appId: string, input: WorkspaceRecordCommand): WorkspaceAppReply {
  if (!input || !["list", "create", "update", "remove"].includes(input.action)) {
    return { status: 400, error: "无效的应用记录操作" };
  }
  if (input.action === "list") {
    if (input.before !== undefined && (!Number.isSafeInteger(input.before) || input.before < 1)) {
      return { status: 400, error: "无效的记录页码" };
    }
    const rows = db.prepare("SELECT * FROM app_records WHERE app_id=? AND seq < ? ORDER BY seq DESC LIMIT ?")
      .all(appId, input.before ?? Number.MAX_SAFE_INTEGER, PAGE + 1);
    return { records: rows.slice(0, PAGE).map(recordFromRow), ...(rows.length > PAGE ? { nextBefore: Number(rows[PAGE - 1].seq) } : {}) };
  }
  if (input.action !== "create" &&
      (!isWorkspaceAppId(input.id) || !Number.isSafeInteger(input.revision) || input.revision < 1)) {
    return { status: 400, error: "需要记录 ID 和当前版本" };
  }
  // 带版本的条件写入在一条 SQL 中完成，同一账号在两台设备上操作不会静默覆盖。
  const stale = { status: 409, error: "记录已更改或删除，请重新加载" } as const;
  if (input.action === "remove") {
    const { changes } = db.prepare("DELETE FROM app_records WHERE app_id=? AND id=? AND revision=?")
      .run(appId, input.id, input.revision);
    return changes ? { removed: true } : stale;
  }
  if (!input.data || typeof input.data !== "object" || Array.isArray(input.data)) {
    return { status: 400, error: "记录必须是 JSON 对象" };
  }
  const data = JSON.stringify(input.data);
  if (Buffer.byteLength(data) > APP_RECORD_BYTES) return { status: 413, error: "单条记录超过 16 KB" };
  const now = Date.now();
  if (input.action === "create") {
    const row = db.prepare(`INSERT INTO app_records(app_id,id,data,revision,created_at,updated_at)
      VALUES (?, ?, ?, 1, ?, ?) RETURNING *`).get(appId, randomUUID(), data, now, now)!;
    return { record: recordFromRow(row) };
  }
  const row = db.prepare(`UPDATE app_records SET data=?, revision=revision+1, updated_at=?
    WHERE app_id=? AND id=? AND revision=? RETURNING *`).get(data, now, appId, input.id, input.revision);
  return row ? { record: recordFromRow(row) } : stale;
}

function appSummary(row: Row) {
  return { id: String(row.id), title: String(row.title), revision: Number(row.revision), updatedAt: Number(row.updated_at),
    ...(typeof row.project_id === "string" ? { projectId: row.project_id } : {}) };
}
function appFromRow(row: Row): WorkspaceApp {
  return { ...appSummary(row), html: String(row.html) };
}
function recordFromRow(row: Row): WorkspaceAppRecord {
  return { id: String(row.id), data: JSON.parse(String(row.data)), revision: Number(row.revision),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
