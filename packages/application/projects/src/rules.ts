import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { resolvePath } from "../../../workspace/src/access";

const MAX_RULE_BYTES = 16_000;

/** 每轮读取用户绑定的规则文件。绑定失效时暂停该轮，避免在缺少项目规则时继续执行。 */
export async function readProjectRules(workspace: string, file: string | undefined) {
  if (!file) return "";
  if (path.basename(file) !== "AGENTS.md") throw new Error("项目规则文件须为 AGENTS.md，请检查项目设置");

  try {
    const { full } = resolvePath(workspace, file, "read");
    if (path.basename(full) !== "AGENTS.md") throw new Error("项目规则链接目标须为 AGENTS.md");
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("规则路径必须指向普通文件");
      if (info.size > MAX_RULE_BYTES) throw new Error(`规则正文超过 ${MAX_RULE_BYTES} 字节，请精简后重试`);
      // 文件在打开后也可能增长。限制读取量，避免只加载半条约束却继续执行。
      const bytes = Buffer.alloc(MAX_RULE_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_RULE_BYTES) throw new Error(`规则正文超过 ${MAX_RULE_BYTES} 字节，请精简后重试`);
      const rules = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)).trim();
      if (!rules) throw new Error("规则文件为空");
      return `## 项目规则（用户绑定的 AGENTS.md）\n${rules}`;
    } finally {
      await handle.close();
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取项目规则。请检查项目设置和工作区权限。 ${detail}`, { cause: error });
  }
}
