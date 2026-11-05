import { clearMemory, getMemory, saveMemory } from "@/lib/server/memory";
import { currentUser, unauthorized } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET：当前用户的长期记忆（设置 → 记忆 页面展示） */
export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();
  return Response.json(getMemory(user.id));
}

/** PUT：整份替换（用户在设置页删掉某一条、改了职业） */
export async function PUT(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  return Response.json(saveMemory(user.id, await req.json().catch(() => ({}))));
}

/** DELETE：清空记忆 */
export async function DELETE() {
  const user = await currentUser();
  if (!user) return unauthorized();
  clearMemory(user.id);
  return Response.json(getMemory(user.id));
}
