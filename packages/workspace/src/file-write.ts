import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hashFileBytes } from "./file-fingerprint";

/** 即时核对原字节，再用同目录临时文件替换。冲突时仍保留磁盘上的当前版。 */
export function replaceWorkspaceFile(file: string, previous: Buffer, next: Buffer, beforeWrite?: () => void): boolean {
  const staged = path.join(path.dirname(file), `.aai-${randomUUID()}.tmp`);
  try {
    writeFileSync(staged, next, { flag: "wx", mode: statSync(file).mode & 0o777 });
    if (!readFileSync(file).equals(previous)) return false;
    beforeWrite?.();
    renameSync(staged, file);
    return true;
  } finally {
    rmSync(staged, { force: true });
  }
}

/** 允许目标不存在。为新文件提交时不覆盖并发创建的同名文件，为已有文件核对原字节。 */
export function commitWorkspaceFile(file: string, previous: Buffer | null, next: Buffer, beforeWrite?: (before: string | null, expected: string) => void) {
  const record = () => beforeWrite?.(previous && hashFileBytes(previous), hashFileBytes(next));
  if (previous) {
    if (!replaceWorkspaceFile(file, previous, next, record)) throw new Error("文件已更新，请先重新读取");
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const staged = path.join(path.dirname(file), `.aai-${randomUUID()}.tmp`);
  try {
    writeFileSync(staged, next, { flag: "wx", mode: 0o600 });
    record();
    linkSync(staged, file);
  } finally { rmSync(staged, { force: true }); }
}

export function readWorkspaceFile(file: string) {
  try { return readFileSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
