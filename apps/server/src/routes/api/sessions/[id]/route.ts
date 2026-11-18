import { deleteSession, getSession, renameSession } from "../../../../../../../packages/storage/src/store";
import type { RouteContext } from "../../../../router";
import { moveSession } from "../../../../../../../packages/application/projects/src/projects";
import { currentUser, notFound, unauthorized } from "../../../../../../../packages/application/users/src/auth";
import { setArchive } from "../../../../../../../packages/session/src/archive-admission";
import { parseModelSelection, setModelSelection } from "../../../../../../../packages/session/src/model-selection";
import { getSettings } from "../../../../../../../packages/application/settings/src/settings";


type Ctx = { runtime: RouteContext["runtime"]; params: Promise<{ id: string }> };

/**
 * 读、改名、删除都带上 user.id：别人的会话和不存在的会话一样，统一返回 404。
 * 不返回 403 是因为 403 等于告诉对方“这个 id 存在，只是你没权限”。
 */
export async function GET(req: Request, { params, runtime }: Ctx) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const s = getSession((await params).id, user.id);
  return s ? Response.json(s) : notFound();
}

export async function PATCH(req: Request, { params, runtime }: Ctx) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const body = ((await req.json().catch(() => null)) ?? {}) as { title?: string; projectId?: string | null; archived?: unknown; modelSelection?: unknown };
  const id = (await params).id;
  if (typeof body.archived === "boolean") {
    const result = setArchive((sid, uid) => runtime.agents.get(sid, uid), "session", id, user.id, body.archived);
    if (result === "busy") return Response.json({ error: "请等对话停止并收尾后再归档" }, { status: 409 });
    return result === "ok" ? Response.json({ ok: true }) : notFound();
  }
  if (body.modelSelection !== undefined) {
    const selection = parseModelSelection(body.modelSelection, getSettings(user.id));
    if (!selection) return Response.json({ error: "所选模型或思考强度不可用" }, { status: 400 });
    return setModelSelection(id, user.id, selection) ? Response.json(selection) : notFound();
  }
  // { projectId }：移进项目 / 移出项目（null）
  if (Object.hasOwn(body, "projectId")) return moveSession(id, body.projectId || null, user.id) ? Response.json({ ok: true }) : notFound();
  const { title } = body;
  if (typeof title !== "string" || !title.trim()) return Response.json({ error: "标题不能为空" }, { status: 400 });
  const meta = renameSession(id, user.id, title.trim().slice(0, 80));
  return meta ? Response.json(meta) : notFound();
}

export async function DELETE(req: Request, { params, runtime }: Ctx) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const { id } = await params;
  if (!deleteSession(id, user.id)) return notFound();
  await runtime.agents.dispose(id, user.id);
  return new Response(null, { status: 204 });
}
