import { cleanProject, deleteProject, updateProject } from "../../../../../../../packages/application/projects/src/projects";
import type { RouteContext } from "../../../../router";
import { currentUser, notFound, unauthorized } from "../../../../../../../packages/application/users/src/auth";
import { setArchive } from "../../../../../../../packages/session/src/archive-admission";


type Ctx = { runtime: RouteContext["runtime"]; params: Promise<{ id: string }> };

/** PATCH 改项目设置（整份传）；DELETE 删项目，里面的对话不删，回到“分组” */
export async function PATCH(req: Request, { params, runtime }: Ctx) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const body = await req.json().catch(() => null);
  const { id } = await params;
  if (typeof body?.archived === "boolean") {
    const result = setArchive((sid, uid) => runtime.agents.get(sid, uid), "project", id, user.id, body.archived,
      (sessionId, userId) => !!runtime.subagents?.isBusy({ sessionId, userId }));
    if (result === "busy") return Response.json({ error: "项目还有对话在运行，请停止并等待收尾后再归档" }, { status: 409 });
    return result === "ok" ? Response.json({ ok: true }) : notFound();
  }
  const p = cleanProject(body);
  if (!p) return Response.json({ error: "项目名字不能为空" }, { status: 400 });
  const r = updateProject(id, user.id, p);
  return r ? Response.json(r) : notFound();
}

export async function DELETE(req: Request, { params, runtime }: Ctx) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  return deleteProject((await params).id, user.id) ? new Response(null, { status: 204 }) : notFound();
}
