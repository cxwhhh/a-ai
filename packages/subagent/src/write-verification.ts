import { resolvePath } from "../../workspace/src/access";
import { readFileHash } from "../../workspace/src/file-fingerprint";
import { isFileRevision, type FileWriteVerification, type TaskFileWrite, type TaskRecord } from "./ownership-claim";

const VERIFIABLE_STATUS = new Set(["interrupted", "cancelled", "timed-out", "failed", "partial"]);

/**
 * 逐文件核验子任务记录的写入检查点，只读取磁盘指纹，不改写文件或任务终态。
 * - `matches-expected`：当前磁盘字节与最近一次写入检查点的预期一致（已落盘）。
 * - `matches-before`：当前磁盘字节仍停留在写入前版本（未落盘或未覆盖）。
 * - `changed` / `unreadable`：磁盘被外部修改或路径不可读，禁止自动恢复。
 */
export async function verifyTaskWrites(
  workspace: string,
  task: TaskRecord,
  writes: readonly TaskFileWrite[],
  signal?: AbortSignal,
): Promise<FileWriteVerification[]> {
  if (!VERIFIABLE_STATUS.has(task.status)) return [];
  if (!writes.length) {
    if (!isFileRevision(task)) return [];
    const fallbackPath = task.assignment?.revisionPath;
    return fallbackPath
      ? [{ path: fallbackPath, status: task.assignment?.mode === "revision" ? "not-started" : "unknown" }]
      : [];
  }
  const results: FileWriteVerification[] = [];
  for (const write of writes) {
    try {
      const file = resolvePath(workspace, write.path, "read");
      if (!file.inWorkspace || file.shown !== write.path) {
        results.push({ path: write.path, status: "unreadable" });
        continue;
      }
      const hash = await readFileHash(file.full, signal);
      results.push({
        path: write.path,
        status: hash === write.expectedHash ? "matches-expected"
          : hash === write.beforeHash ? "matches-before" : "changed",
      });
    } catch {
      results.push({ path: write.path, status: "unreadable" });
    }
  }
  return results;
}

/**
 * 只有当所有已记录写入都处于确定的安全状态（预期已落盘或仍停留在写入前）时，
 * 才允许对非单文件微调的执行分支进行受控恢复，避免静默覆盖用户外部修改。
 */
export function canSafelyRecoverWrites(verifications: readonly FileWriteVerification[]) {
  return verifications.length > 0 && verifications.every(({ status }) => status === "matches-expected" || status === "matches-before");
}
