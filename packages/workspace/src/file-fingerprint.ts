import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";

/** 写入检查点和续聊核验使用相同的字节指纹。 */
export function hashFileBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 按字节读现有普通文件。只有明确的不存在返回 null，权限错误与其他文件类型向上报告。 */
export async function readFileHash(file: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const stat = await fs.stat(/*turbopackIgnore: true*/ file);
    if (!stat.isFile()) throw new Error("只能核验普通文件");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(/*turbopackIgnore: true*/ file, { signal })) hash.update(chunk);
    return hash.digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
