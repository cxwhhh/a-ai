import { promises as fs } from "node:fs";
import { resolvePath } from "./access";

/** 列表只显示用户能打开的工作区文件，删除文件后会话快照仍可以回看。 */
export async function statWorkspaceOutput(workspace: string, name: string) {
  try {
    const target = resolvePath(workspace, name, "read");
    if (!target.inWorkspace) return;
    const stat = await fs.stat(target.full);
    if (stat.isFile()) return stat;
  } catch {
    // 文件可能已被删除，或软链接已经超出工作区。
  }
}
