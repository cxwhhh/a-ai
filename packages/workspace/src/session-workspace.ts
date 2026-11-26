import { constants, copyFileSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { toolStatus } from "../../protocol/src/lib/shared";
import { DATA_DIR, db } from "../../storage/src/db";
import { getSession } from "../../storage/src/store";

const idPattern = /^[a-z0-9_-]+$/i;
const batchPattern = /^output\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/[^/\\]+$/;
class InvalidWorkspacePath extends Error {}

export function sessionWorkspacesOf(userId: string) {
  if (!idPattern.test(userId)) throw new Error("非法用户 ID");
  return path.join(DATA_DIR, "users", userId, "session-workspaces");
}

/** 名字和真实路径必须一致，拒绝链接到其他工作区或账号的数据。 */
function entryPath(workspace: string, relativePath: string) {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).some((part) => part === "..") ||
      (process.platform === "win32" && relativePath.includes(":"))) throw new InvalidWorkspacePath("路径超出工作区");
  const target = path.resolve(workspace, relativePath);
  const relative = path.relative(workspace, target);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new InvalidWorkspacePath("路径超出工作区");
  return target;
}

function workspaceEntry(workspace: string, relativePath: string) {
  const target = entryPath(workspace, relativePath);
  const realDataDir = realpathSync(DATA_DIR);
  const expected = path.join(realDataDir, path.relative(DATA_DIR, target));
  if (path.relative(expected, realpathSync(target))) throw new InvalidWorkspacePath("工作区路径不能包含链接");
  return target;
}

/** 逐层验证父目录，避免创建附件目录时跟着别的目录的链接走。 */
export function ensureWorkspaceDirectory(workspace: string, name = ".") {
  const target = entryPath(workspace, name);
  const parts = path.relative(DATA_DIR, target).split(path.sep);
  let current = DATA_DIR;
  for (const part of parts) {
    current = path.join(current, part);
    try { mkdirSync(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (!lstatSync(current).isDirectory()) throw new InvalidWorkspacePath("工作区路径必须是普通目录");
  }
  return target;
}

/** 只接受当前账号的会话。首次打开老对话时复制由该对话的产出记录明确指向的文件。 */
export function openSessionWorkspace(userId: string, sessionId: string) {
  if (!idPattern.test(sessionId)) return;
  const row = db().prepare("SELECT workspace_ready_at FROM sessions WHERE id=? AND user_id=?").get(sessionId, userId);
  if (!row) return;
  const workspace = path.join(sessionWorkspacesOf(userId), sessionId);
  ensureWorkspaceDirectory(workspace);
  if (row.workspace_ready_at !== null) return { workspace };

  const session = getSession(sessionId, userId);
  if (!session) return;
  const legacy = legacyWorkspaceOf(userId);
  const paths = new Set(session.artifacts.flatMap(({ file }) => typeof file === "string" && file.startsWith(`output/${sessionId}/`) ? [file] : []));
  let calls = new Set<string>();
  for (const message of session.messages) {
    if (message.role !== "tool") {
      calls = new Set(message.toolCalls?.filter(({ name }) => name === "run_command" || name === "run_python").map(({ id }) => id));
      continue;
    }
    if (!message.toolCallId || !calls.has(message.toolCallId) || toolStatus(message) !== "ok") continue;
    try {
      const outputs: unknown = JSON.parse(message.content)?.outputs;
      if (Array.isArray(outputs)) for (const file of outputs) {
        if (typeof file === "string" && batchPattern.test(file)) paths.add(file);
      }
    } catch { /* 文本结果没有受管产出路径。 */ }
  }
  for (const name of paths) {
    let source: string;
    try {
      source = workspaceEntry(legacy, name);
      if (!lstatSync(source).isFile()) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof InvalidWorkspacePath) continue;
      throw error;
    }
    const parent = ensureWorkspaceDirectory(workspace, path.dirname(name));
    try {
      // 重启或另一个进程已经完成复制时，保留目标当前版本。
      copyFileSync(source, path.join(parent, path.basename(name)), constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const readyAt = Date.now();
  db().prepare("UPDATE sessions SET workspace_ready_at=? WHERE id=? AND user_id=? AND workspace_ready_at IS NULL").run(readyAt, sessionId, userId);
  return { workspace };
}

/** 旧文件由用户显式导入，也保留已配置的项目规则和已发布应用的账号级数据。 */
export function legacyWorkspaceOf(userId: string) {
  return path.join(path.dirname(sessionWorkspacesOf(userId)), "workspace");
}

/** 旧目录只提供普通文件导入，隐藏的运行数据和应用数据库不能通过导入读取。 */
export function legacyFilePath(userId: string, relativePath: string) {
  if (relativePath !== "." && relativePath.split(/[\\/]/).some((part) => !part || part.startsWith("."))) throw new Error("无效的旧文件路径");
  return workspaceEntry(legacyWorkspaceOf(userId), relativePath);
}
