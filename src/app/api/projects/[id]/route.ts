import { cleanProject, deleteProject, updateProject } from "@/lib/server/projects";
import { currentUser, notFound, unauthorized } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH 改项目设置（整份传）；DELETE 删项目，里面的对话不删，回到“分组” */
export async function PATCH(req: Request, { params }: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const p = cleanProject(await req.json().catch(() => null));
  if (!p) return Response.json({ error: "项目名字不能为空" }, { status: 400 });
  const r = updateProject((await params).id, user.id, p);
  return r ? Response.json(r) : notFound();
}

export async function DELETE(_: Request, { params }: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();
  return deleteProject((await params).id, user.id) ? new Response(null, { status: 204 }) : notFound();
}
