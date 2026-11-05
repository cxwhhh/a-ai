import { deleteSession, getSession, renameSession } from "@/lib/server/store";
import { moveSession } from "@/lib/server/projects";
import { currentUser, notFound, unauthorized } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 读、改名、删除都带上 user.id：别人的会话和不存在的会话一样，统一返回 404。
 * 不返回 403 是因为 403 等于告诉对方“这个 id 存在，只是你没权限”。
 */
export async function GET(_: Request, { params }: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const s = getSession((await params).id, user.id);
  return s ? Response.json(s) : notFound();
}

export async function PATCH(req: Request, { params }: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const body = (await req.json().catch(() => ({}))) as { title?: string; projectId?: string | null };
  const id = (await params).id;
  // { projectId }：移进项目 / 移出项目（null）
  if ("projectId" in body) return moveSession(id, body.projectId || null, user.id) ? Response.json({ ok: true }) : notFound();
  const { title } = body;
  if (!title?.trim()) return Response.json({ error: "标题不能为空" }, { status: 400 });
  const meta = renameSession(id, user.id, title.trim().slice(0, 80));
  return meta ? Response.json(meta) : notFound();
}

export async function DELETE(_: Request, { params }: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();
  return deleteSession((await params).id, user.id) ? new Response(null, { status: 204 }) : notFound();
}
