import path from "node:path";
import { getSession, listArtifacts, listDocFiles } from "../../../../../../packages/storage/src/store";
import { currentUser, notFound, unauthorized } from "../../../../../../packages/application/users/src/auth";
import { getProject } from "../../../../../../packages/application/projects/src/projects";
import { workspaceOf } from "../../../../../../packages/tools/src/files";
import { statWorkspaceOutput } from "../../../../../../packages/workspace/src/output-files";
import { collectOutputs } from "../../../../../../packages/protocol/src/lib/outputs";
import type { ArtifactMeta } from "../../../../../../packages/protocol/src/lib/shared";


const OFFICE: Record<string, string> = { ".docx": "Word 文档", ".xlsx": "Excel 表格", ".pptx": "PPT 演示文稿" };

/**
 * GET 当前用户全部产出物的概要（左栏“产出物”页面）。
 * 除了 create_artifact 的产出物，还加上 write_document 生成的 Word / Excel / PPT 文件（2026-10-29），
 * 这样“对话里的输出”和“产出物页”看到的东西是一致的。文件已经被删掉的不列出。
 */
export async function GET(req: Request) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const projectId = new URL(req.url).searchParams.get("projectId") ?? undefined;
  if (projectId !== undefined && !getProject(projectId, user.id)) return notFound();
  const ws = workspaceOf(user.id);
  // 历史 HTML 只有所在会话部署过应用时才需要进一步判断。同一会话的历史只读一次。
  const visibleWeb = new Map<string, Set<string>>();
  const candidates = await Promise.all(listArtifacts(user.id, projectId).map(async ({ backingFile, hasWorkspaceApp, ...meta }) => {
    if (meta.kind === "html" && hasWorkspaceApp) {
      let visible = visibleWeb.get(meta.sessionId);
      if (!visible) {
        const session = getSession(meta.sessionId, user.id);
        const outputs = session ? collectOutputs(session.messages, session.artifacts).outputs : [];
        visible = new Set(outputs.map((output) => output.key));
        visibleWeb.set(meta.sessionId, visible);
      }
      if (!visible.has(`a:${meta.id}`)) return;
    }
    if (!backingFile || await statWorkspaceOutput(ws, backingFile)) return meta;
  }));
  const list: ArtifactMeta[] = candidates.filter((item) => item !== undefined);
  const seen = new Set<string>();
  for (const f of listDocFiles(user.id)) {
    if (projectId && f.projectId !== projectId) continue;
    const ext = path.extname(f.path).toLowerCase();
    if (!OFFICE[ext] || seen.has(f.path)) continue; // 同一个文件生成多次只列最新的一次（按时间倒序，先遇到的就是最新的）
    seen.add(f.path);
    const stat = await statWorkspaceOutput(ws, f.path);
    if (!stat) continue;
    list.push({
      id: `f:${f.sessionId}:${f.path}`,
      title: path.basename(f.path),
      kind: "markdown",
      createdAt: f.createdAt,
      sessionId: f.sessionId,
      sessionTitle: f.sessionTitle,
      ...(f.projectId ? { projectId: f.projectId } : {}),
      snippet: OFFICE[ext],
      size: stat.size,
      file: f.path,
    });
  }
  list.sort((a, b) => b.createdAt - a.createdAt);
  return Response.json(list);
}
