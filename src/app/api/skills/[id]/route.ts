import { deleteSkill, getSkill, restoreSkill, updateSkill } from "@/lib/server/skills";
import { currentUser, notFound, unauthorized } from "@/lib/server/auth";
import type { Skill } from "@/lib/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const NOTE: Partial<Record<Skill["status"], string>> = { active: "启用", disabled: "手动停用" };

/**
 * PATCH：改名字 / 说明 / 正文，或者改状态（启用、停用）。
 * { restore: true }：恢复上一版（自动改进改坏了的时候）
 * 只接受这几个字段：使用次数、版本号这些由服务端维护，浏览器改不了
 */
export async function PATCH(req: Request, { params }: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const id = (await params).id;
  const body = (await req.json().catch(() => ({}))) as Partial<Skill> & { restore?: boolean };
  try {
    if (body.restore) return Response.json(restoreSkill(user.id, id) ?? null, { status: getSkill(user.id, id) ? 200 : 404 });
    const patch: Partial<Skill> = {};
    for (const k of ["name", "description", "body", "status"] as const) if (body[k] !== undefined) Object.assign(patch, { [k]: body[k] });
    const old = getSkill(user.id, id);
    if (!old) return notFound();
    const note = patch.status && patch.status !== old.status ? NOTE[patch.status] : undefined;
    return Response.json(updateSkill(user.id, id, patch, note));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export async function DELETE(_: Request, { params }: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();
  deleteSkill(user.id, (await params).id);
  return Response.json({ ok: true });
}
