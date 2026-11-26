import path from "node:path";
import { artifactSourceComparison, getSession, listArtifacts, listFileOutputSessions } from "../../../../../../packages/storage/src/store";
import { currentUser, notFound, unauthorized } from "../../../../../../packages/application/users/src/auth";
import { getProject } from "../../../../../../packages/application/projects/src/projects";
import { openSessionWorkspace } from "../../../../../../packages/workspace/src/session-workspace";
import { statWorkspaceOutput } from "../../../../../../packages/workspace/src/output-files";
import { collectOutputs, extOf } from "../../../../../../packages/protocol/src/lib/outputs";
import type { ArtifactMeta } from "../../../../../../packages/protocol/src/lib/shared";


const OFFICE: Record<string, string> = { ".docx": "Word 文档", ".xlsx": "Excel 表格", ".pptx": "PPT 演示文稿" };

/**
 * GET 当前用户全部产出物的概要（左栏“产出物”页面）。
 * 除了 create_artifact 的产出物，还加上 write_document 生成的 Word / Excel / PPT 文件（2026-10-29），
 * 磁盘副本缺失时，仍可从产出物库访问会话快照。
 */
export async function GET(req: Request) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const query = new URL(req.url).searchParams;
  if (query.has("artifactId")) {
    const source = artifactSourceComparison(user.id, query.get("sessionId") ?? "", query.get("artifactId") ?? "");
    return source ? Response.json(source, { headers: { "Cache-Control": "private, no-store" } }) : notFound();
  }
  const projectId = query.get("projectId") ?? undefined;
  if (projectId !== undefined && !getProject(projectId, user.id)) return notFound();
  const workspaces = new Map<string, ReturnType<typeof openSessionWorkspace>>();
  const scopeFor = (sessionId: string) => {
    if (!workspaces.has(sessionId)) workspaces.set(sessionId, openSessionWorkspace(user.id, sessionId));
    return workspaces.get(sessionId);
  };
  // 历史 HTML 只有所在会话部署过应用时才需要进一步判断。同一会话的历史只读一次。
  const sessions = new Map<string, ReturnType<typeof getSession>>();
  const outputsBySession = new Map<string, ReturnType<typeof collectOutputs>["outputs"]>();
  const sessionFor = (id: string) => {
    if (!sessions.has(id)) sessions.set(id, getSession(id, user.id));
    return sessions.get(id);
  };
  const outputsFor = (id: string) => {
    if (!outputsBySession.has(id)) {
      const session = sessionFor(id);
      outputsBySession.set(id, session ? collectOutputs(session.messages, session.artifacts).outputs : []);
    }
    return outputsBySession.get(id)!;
  };
  const candidates = await Promise.all(listArtifacts(user.id, projectId).map(async ({ backingFile, hasWorkspaceApp, ...meta }) => {
    if (meta.kind === "html" && hasWorkspaceApp) {
      if (!outputsFor(meta.sessionId).some(({ key }) => key === `a:${meta.id}`)) return;
    }
    const scope = backingFile ? scopeFor(meta.sessionId) : undefined;
    if (!backingFile) return { ...meta, snapshotOnly: true };
    return scope && await statWorkspaceOutput(scope.workspace, backingFile) ? meta : { ...meta, snapshotOnly: true };
  }));
  const list: ArtifactMeta[] = candidates.filter((item) => item !== undefined);
  for (const sessionId of listFileOutputSessions(user.id, projectId)) {
    const session = sessionFor(sessionId);
    if (!session) continue;
    const seen = new Set<string>();
    for (const { view, ts, icon } of outputsFor(sessionId)) {
      if (view.type !== "file" || seen.has(view.path)) continue;
      seen.add(view.path);
      const scope = scopeFor(sessionId);
      const stat = scope && await statWorkspaceOutput(scope.workspace, view.path);
      if (!stat) continue;
      const ext = extOf(view.path);
      list.push({
        id: `f:${sessionId}:${view.path}`,
        title: path.basename(view.path),
        kind: icon === "web" ? "html" : icon === "code" ? "code" : "markdown",
        createdAt: ts,
        sessionId,
        sessionTitle: session.title,
        projectId: session.projectId,
        snippet: OFFICE[`.${ext}`] ?? "",
        size: stat.size,
        file: view.path,
      });
    }
  }
  list.sort((a, b) => b.createdAt - a.createdAt);
  return Response.json(list);
}
