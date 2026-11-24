import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

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
