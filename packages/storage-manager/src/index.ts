import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

export const MiB = 1024 ** 2;
const DAY = 24 * 60 * 60_000;
const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const KINDS = ["test", "evaluation", "report", "run", "cache"] as const;
type Kind = typeof KINDS[number];
type State = "active" | "retained" | "deleting";
interface RecordEntry {
  id: string;
  kind: Kind;
  owner: string;
  state: State;
  pid: number;
  touched: number;
  expires: number | null;
  pinned: boolean;
}

export interface ResourceScope {
  id: string;
  directory: string;
  finish(options?: { retainMs?: number; pinned?: boolean }): void;
}

/** 运行身份由应用层绑定。沙箱可复用同一轮的临时环境，运行结束时统一释放。 */
export interface RunScope extends ResourceScope {
  owner: string;
  limitMiB: number;
  projectWrite: boolean;
  active: boolean;
  onClose(cleanup: () => Promise<void>): void;
}

const runs = new AsyncLocalStorage<RunScope>();
export const currentRunScope = () => runs.getStore();
export function useTemporaryStorage(requested?: boolean) {
  const scope = runs.getStore();
  return scope ? !scope.projectWrite || requested !== false : requested === true;
}

export function validOutputName(name: string) {
  return name.length > 0 && name.length <= 120 && !name.startsWith(".") && !/[\\/:*?"<>|\x00-\x1f]/.test(name) && name.trim() === name;
}

/** 成品先在目标卷暂存，全部验证成功后一次公布。不能覆盖现有文件或跟随外部链接。 */
export function publishRunFiles(scope: RunScope, workspace: string, staged: string, names: string[]) {
  if (!scope.active || path.dirname(staged) !== scope.directory || names.some((name) => !validOutputName(name))) throw new Error("无效的运行产出");
  const account = realpathSync(workspace);
  const output = path.join(account, "output");
  mkdirSync(output, { recursive: true });
  if (realpathSync(output) !== output) throw new Error("产出目录超出对话工作区");
  const batch = randomUUID();
  const partial = path.join(output, `.publishing-${batch}`);
  let bytes = 0;
  mkdirSync(partial, { mode: 0o700 });
  try {
    for (const name of names) {
      const source = path.join(staged, name);
      const stat = lstatSync(source);
      bytes += stat.size;
      if (!stat.isFile() || bytes > scope.limitMiB * MiB) throw new Error("产出必须是配额内的普通文件");
      copyFileSync(source, path.join(partial, name));
    }
    if (!scope.active || realpathSync(output) !== output) throw new Error("运行已结束或产出目录已变化");
    renameSync(partial, path.join(output, batch));
    return names.map((name) => `output/${batch}/${name}`);
  } finally {
    if (realpathSync(output) === output) rmSync(partial, { recursive: true, force: true });
  }
}

/** 不跟随符号链接，避免统计或清扫某个资源时越过它的所有权边界。 */
export async function storageBytes(target: string): Promise<number> {
  const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return 0;
  if (!stat.isDirectory() || stat.isSymbolicLink()) return stat.size;
  let total = 0;
  for (const name of await readdir(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })) total += await storageBytes(path.join(target, name));
  return total;
}

function isAlive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** 每个资源只管理注册时创建的目录。元数据放在 payload 外面，工具生成的内容不能决定清扫路径。 */
export class StorageManager {
  readonly root: string;
  private timer?: ReturnType<typeof setInterval>;
  private readonly now: () => number;

  constructor(root: string, now = Date.now) {
    this.now = now;
    mkdirSync(root, { recursive: true });
    this.root = realpathSync(root);
  }

  create(kind: Kind, owner: string): ResourceScope {
    const id = randomUUID();
    const directory = this.directory(id);
    const touched = this.now();
    const entry: RecordEntry = { id, kind, owner, state: "active", pid: process.pid, touched, expires: touched + DAY, pinned: false };
    mkdirSync(path.join(this.root, id), { mode: 0o700 });
    try {
      this.save(entry);
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      rmSync(path.join(this.root, id), { recursive: true, force: true });
      throw error;
    }
    let finished = false;
    return { id, directory, finish: ({ retainMs, pinned = false } = {}) => {
      if (finished) return;
      const touched = this.now();
      this.save({ ...entry, state: retainMs ? "retained" : "deleting", touched, expires: retainMs === Infinity ? null : touched + (retainMs ?? 0), pinned });
      if (!retainMs) this.remove(id);
      finished = true;
    } };
  }

  async withRun<T>(owner: string, operation: () => Promise<T>, projectWrite = false): Promise<T> {
    const limitMiB = this.runLimit();
    const resource = this.create("run", owner);
    const cleanup = new Set<() => Promise<void>>();
    const scope: RunScope = { ...resource, owner, limitMiB, projectWrite, active: true, onClose: (close) => { cleanup.add(close); } };
    try { return await runs.run(scope, operation); }
    finally {
      scope.active = false;
      try {
        await Promise.allSettled([...cleanup].map((close) => Promise.resolve().then(close)));
        scope.finish();
      } catch (error) { console.warn("[storage-manager] 本轮临时资源回收失败，将由下次清扫重试", error); }
    }
  }

  runLimit(): number {
    try {
      const value: unknown = JSON.parse(readFileSync(path.join(this.root, "quota.json"), "utf8"));
      return typeof value === "number" && validRunLimit(value) ? value : 512;
    } catch { return 512; }
  }

  setRunLimit(mib: number) {
    if (!validRunLimit(mib)) throw new RangeError("配额必须是 32 到 512 MiB 的整数");
    this.atomicWrite(path.join(this.root, "quota.json"), JSON.stringify(mib));
  }

  /** 容器可能在异常终止时来不及归还资源。活动进程及明确保留的基线不会被自动回收。 */
  sweep() {
    for (const entry of this.entries()) {
      if (entry.state === "active" && isAlive(entry.pid)) continue;
      if (entry.state === "deleting" || (!entry.pinned && entry.expires !== null && entry.expires <= this.now())) this.tryRemove(entry.id);
    }
  }

  start() {
    if (this.timer) return;
    this.sweep();
    this.timer = setInterval(() => {
      try { this.sweep(); } catch (error) { console.warn("[storage-manager] 周期清扫失败", error); }
    }, 15 * 60_000);
    this.timer.unref();
  }

  close() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  retained(kind: Kind, owner?: string) {
    return this.entries().filter((entry) => entry.kind === kind && (owner === undefined || entry.owner === owner) && entry.state === "retained")
      .sort((a, b) => b.touched - a.touched || b.id.localeCompare(a.id));
  }

  pin(id: string) {
    const entry = this.entries().find((candidate) => candidate.id === id && candidate.kind === "report" && candidate.state === "retained");
    if (entry) this.save({ ...entry, pinned: true });
  }

  touch(id: string, owner: string) {
    const entry = this.entries().find((candidate) => candidate.id === id && candidate.owner === owner && candidate.kind === "cache" && candidate.state === "retained");
    if (entry) this.save({ ...entry, touched: this.now() });
  }

  async trimCache(owner: string, maxBytes: number) {
    const entries = this.retained("cache", owner).reverse();
    const sizes = await Promise.all(entries.map((value) => storageBytes(this.directory(value.id))));
    let total = sizes.reduce((sum, size) => sum + size, 0);
    for (const [index, entry] of entries.entries()) {
      if (total <= maxBytes) break;
      if (this.tryRemove(entry.id)) total -= sizes[index];
    }
    return total;
  }

  trimReports(owner: string, keep: number) {
    for (const entry of this.retained("report", owner).slice(keep)) if (!entry.pinned) this.tryRemove(entry.id);
  }

  clear(kind: "cache" | "test" | "evaluation", owner?: string) {
    let removed = 0;
    for (const entry of this.retained(kind, owner)) if (this.tryRemove(entry.id)) removed++;
    return removed;
  }

  async usage(owner: string, administrative: boolean) {
    const counts = Object.fromEntries(KINDS.map((kind) => [kind, { bytes: 0, count: 0 }])) as Record<Kind, { bytes: number; count: number }>;
    for (const entry of this.entries()) {
      const system = entry.kind === "test" || entry.kind === "evaluation" || entry.kind === "report";
      if (system ? !administrative : entry.owner !== owner) continue;
      counts[entry.kind].bytes += await storageBytes(this.directory(entry.id));
      counts[entry.kind].count++;
    }
    return counts;
  }

  directory(id: string) {
    if (!ID.test(id)) throw new Error("无效的存储资源标识");
    return path.join(this.root, id, "payload");
  }

  private entries(): RecordEntry[] {
    return readdirSync(this.root, { withFileTypes: true }).flatMap((dir) => {
      if (!dir.isDirectory() || !ID.test(dir.name)) return [];
      try {
        const entry = JSON.parse(readFileSync(path.join(this.root, dir.name, "resource.json"), "utf8")) as RecordEntry;
        if (entry.id !== dir.name || !KINDS.includes(entry.kind) || !["active", "retained", "deleting"].includes(entry.state) || !Number.isSafeInteger(entry.pid) || entry.pid < 1) return [];
        return [entry];
      } catch { return []; }
    });
  }

  private save(entry: RecordEntry) {
    this.atomicWrite(path.join(this.root, entry.id, "resource.json"), JSON.stringify(entry));
  }

  private atomicWrite(file: string, data: string) {
    const staged = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(staged, data, { flag: "wx", mode: 0o600 });
      renameSync(staged, file);
    } finally { rmSync(staged, { force: true }); }
  }

  private tryRemove(id: string) {
    try { this.remove(id); return true; }
    catch (error) { console.warn("[storage-manager] 资源回收失败", id, error); return false; }
  }

  private remove(id: string) {
    const target = path.dirname(this.directory(id));
    const info = lstatSync(target, { throwIfNoEntry: false });
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(target) !== target) throw new Error("资源目录已变化");
    rmSync(target, { recursive: true, force: true, maxRetries: 2 });
  }
}

export function validRunLimit(mib: number) {
  return Number.isSafeInteger(mib) && mib >= 32 && mib <= 512;
}

/** node:test 子进程退出时已有最终结果，断言或初始化失败时保留夹具供排查。 */
export function createTestDirectory(root: string, label: string) {
  const manager = new StorageManager(process.env.A_TEST_STORAGE_DIR || path.join(root, "aai-test-storage"));
  manager.sweep();
  const scope = manager.create("test", label);
  process.once("exit", (code) => {
    try { scope.finish({ retainMs: code || process.exitCode ? DAY : 0 }); }
    catch (error) { console.warn("[storage-manager] 测试夹具回收失败", error); }
  });
  return scope.directory;
}

export const failedFixtureRetention = DAY;
