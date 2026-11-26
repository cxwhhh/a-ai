import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { isSensitivePath } from "../../sandbox/src/sandbox";
import { DATA_DIR } from "../../storage/src/db";
import { StorageManager } from "../../storage-manager/src/index";
import type { ToolContext } from "../../tool-runtime/src/types";
import { commitWorkspaceFile } from "../../workspace/src/file-write";

const INPUT_BYTES = 64 * 1024 * 1024;
const OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 8_192;
const reserved = new Set([".git", ".runs", ".task-home", ".npmrc", ".pypirc", ".git-credentials"]);

async function fileBytes(file: string, limit: number, signal?: AbortSignal) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error("项目副本仅接受配额内的普通文件");
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size) throw new Error("项目文件在读取期间发生变化，请重试");
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

async function currentFile(file: string, signal?: AbortSignal) {
  try { return await fileBytes(file, OUTPUT_BYTES, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** 审批前记下真实目标的版本。声明的输出必须来自执行分支已经持有的精确路径。 */
export async function commandOutputs(ctx: ToolContext, outputs: string[]) {
  const entries = new Map<string, { full: string; before: Buffer | null }>();
  for (const requested of outputs) {
    if (!ctx.writePath || !ctx.checkpointFileWrite) throw new Error("当前执行分支没有文件提交权限");
    const { full, shown } = ctx.writePath(requested);
    if (!entries.has(shown)) entries.set(shown, { full, before: await currentFile(full, ctx.signal) });
  }
  return entries;
}

/** 将已授权的常规文件原样复制到项目副本。子进程始终操作自己的副本。 */
export async function scopedCommandWorkspace<T>(context: ToolContext, run: (directory: string) => Promise<T>) {
  if (!context.isolatedCommand || !context.readPath) throw new Error("缺少子任务的项目范围");
  const { signal, readPath, isolatedCommand } = context;
  const storage = new StorageManager(process.env.A_STORAGE_MANAGER_DIR || path.join(DATA_DIR, "storage-manager"));
  const resource = storage.create("run", context.userId ?? "");
  try {
    const directory = path.join(resource.directory, "project");
    const added = new Set<string>();
    let remaining = INPUT_BYTES;
    let entries = 0;
    const createDirectory = async (dir: string) => {
      await fs.mkdir(dir, { recursive: true, mode: 0o777 });
      // 桌面 Docker 和主服务可能不是同一个 UID。副本的外层资源目录仍只对服务账号开放。
      await fs.chmod(dir, 0o777);
    };
    const copy = async (requested: string, optional = false) => {
      if (++entries > MAX_FILES) throw new Error("项目副本条目过多，请缩小任务的 paths 范围");
      signal?.throwIfAborted();
      if (isSensitivePath(requested) || requested.split("/").some((part) => reserved.has(part.toLowerCase()))) return;
      const item = readPath(requested);
      if (!item.inWorkspace) throw new Error("子任务的命令只接收会话工作区内的输入");
      if (added.has(item.shown)) return;
      added.add(item.shown);
      const info = await fs.lstat(item.full).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" && optional) return undefined;
        throw error;
      });
      if (!info) return;
      const destination = path.join(directory, item.shown);
      if (info.isDirectory()) {
        await createDirectory(destination);
        for (const child of await fs.readdir(item.full, { withFileTypes: true })) {
          if (!child.isSymbolicLink()) await copy(path.posix.join(item.shown, child.name));
        }
      } else if (info.isFile()) {
        const bytes = await fileBytes(item.full, remaining, signal);
        remaining -= bytes.length;
        await createDirectory(path.dirname(destination));
        await fs.writeFile(destination, bytes, { flag: "wx" });
        await fs.chmod(destination, info.mode & 0o111 ? 0o777 : 0o666);
      }
    };
    await createDirectory(directory);
    for (const input of isolatedCommand.inputs) await copy(input);
    for (const file of isolatedCommand.ownedFiles) await copy(file, true);
    await createDirectory(path.join(directory, ".task-home"));
    return await run(directory);
  } finally { resource.finish(); }
}

/** Docker 退出后没有进程可以更新副本。先核对所有输出和版本，再按实际成功的文件记回执。 */
export async function publishCommandOutputs(directory: string, outputs: Awaited<ReturnType<typeof commandOutputs>>, ctx: ToolContext) {
  const ready = [];
  let remaining = 2 * OUTPUT_BYTES;
  const root = await fs.realpath(directory);
  for (const [name, { full, before }] of outputs) {
    const staged = path.join(root, name);
    if (await fs.realpath(staged) !== staged) throw new Error(`输出 ${name} 包含链接，无法提交`);
    const bytes = await fileBytes(staged, Math.min(OUTPUT_BYTES, remaining), ctx.signal);
    remaining -= bytes.length;
    const target = ctx.writePath?.(name);
    if (target?.full !== full) throw new Error(`输出 ${name} 的授权目标已变化`);
    const current = await currentFile(full, ctx.signal);
    if (before ? !current?.equals(before) : current !== null) throw new Error(`输出 ${name} 在执行期间发生变化，请重新读取`);
    if (!before?.equals(bytes)) ready.push({ name, full, before, bytes });
  }
  for (const { name, full, before, bytes } of ready) {
    ctx.signal?.throwIfAborted();
    if (ctx.writePath?.(name).full !== full) throw new Error(`输出 ${name} 的授权目标已变化`);
    commitWorkspaceFile(full, before, bytes, (previous, expected) => ctx.checkpointFileWrite?.(name, previous, expected));
    ctx.fileCommitted?.(name);
  }
  return ready.map(({ name }) => name);
}
