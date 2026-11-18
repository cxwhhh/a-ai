import { getGroups, saveGroups } from "../../../../../../packages/application/groups/src/groups";
import { currentUser, unauthorized } from "../../../../../../packages/application/users/src/auth";
import type { Groups } from "../../../../../../packages/protocol/src/lib/shared";


export async function GET(req: Request) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  return Response.json(getGroups(user.id));
}

/** PUT 整份分组数据（数据很小，整体覆盖最简单） */
export async function PUT(req: Request) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const g = (await req.json().catch(() => null)) as Groups | null;
  if (!g || !Array.isArray(g.groups) || typeof g.assign !== "object") return Response.json({ error: "格式不对" }, { status: 400 });
  return Response.json(saveGroups(user.id, g));
}
