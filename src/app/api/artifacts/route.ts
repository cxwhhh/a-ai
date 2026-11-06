import { promises as fs } from "node:fs";
import path from "node:path";
import { listArtifacts, listDocFiles } from "@/lib/server/store";
import { currentUser, unauthorized } from "@/lib/server/auth";
import { safePath, workspaceOf } from "@/lib/agent/tools/files";
import type { ArtifactMeta } from "@/lib/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OFFICE: Record<string, string> = { ".docx": "Word 文档", ".xlsx": "Excel 表格", ".pptx": "PPT 演示文稿" };

/**
 * GET 当前用户全部产出物的概要（左栏“产出物”页面）。
 * 除了 create_artifact 的产出物，还加上 write_document 生成的 Word / Excel / PPT 文件（2026-10-29），
 * 这样“对话里的输出”和“产出物页”看到的东西是一致的。文件已经被删掉的不列出。
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();
  const list: ArtifactMeta[] = listArtifacts(user.id);
  const ws = workspaceOf(user.id);
  const seen = new Set<string>();
  for (const f of listDocFiles(user.id)) {
    const ext = path.extname(f.path).toLowerCase();
    if (!OFFICE[ext] || seen.has(f.path)) continue; // 同一个文件生成多次只列最新的一次（按时间倒序，先遇到的就是最新的）
    seen.add(f.path);
    let size = 0;
    try {
      size = (await fs.stat(/*turbopackIgnore: true*/ safePath(ws, f.path))).size;
    } catch {
      continue;
    }
    list.push({
      id: `f:${f.sessionId}:${f.path}`,
      title: path.basename(f.path),
      kind: "markdown",
      createdAt: f.createdAt,
      sessionId: f.sessionId,
      sessionTitle: f.sessionTitle,
      ...(f.projectId ? { projectId: f.projectId } : {}),
      snippet: OFFICE[ext],
      size,
      file: f.path,
    });
  }
  list.sort((a, b) => b.createdAt - a.createdAt);
  return Response.json(list);
}
