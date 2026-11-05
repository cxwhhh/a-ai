import { getGroups, saveGroups } from "@/lib/server/groups";
import { currentUser, unauthorized } from "@/lib/server/auth";
import type { Groups } from "@/lib/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();
  return Response.json(getGroups(user.id));
}

/** PUT 整份分组数据（数据很小，整体覆盖最简单） */
export async function PUT(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const g = (await req.json().catch(() => null)) as Groups | null;
  if (!g || !Array.isArray(g.groups) || typeof g.assign !== "object") return Response.json({ error: "格式不对" }, { status: 400 });
  return Response.json(saveGroups(user.id, g));
}
