import { createSession, listSessions } from "../../../../../../packages/storage/src/store";
import { currentUser, notFound, unauthorized } from "../../../../../../packages/application/users/src/auth";
import { getProject } from "../../../../../../packages/application/projects/src/projects";


/** 只返回当前用户自己的对话 */
export async function GET(req: Request) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  return Response.json(listSessions(user.id));
}

export async function POST(req: Request) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const body = await req.json().catch(() => null);
  const projectId: unknown = body?.projectId;
  if (projectId !== undefined && typeof projectId !== "string") return Response.json({ error: "无效的项目 ID" }, { status: 400 });
  const project = getProject(projectId, user.id);
  if (projectId !== undefined && !project) return notFound();
  if (project?.archivedAt) return Response.json({ error: "项目已归档，请先恢复" }, { status: 409 });
  return Response.json(createSession(user.id, undefined, project?.id));
}
