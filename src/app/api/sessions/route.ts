import { createSession, listSessions } from "@/lib/server/store";
import { currentUser, unauthorized } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 只返回当前用户自己的对话 */
export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();
  return Response.json(listSessions(user.id));
}

export async function POST() {
  const user = await currentUser();
  if (!user) return unauthorized();
  return Response.json(createSession(user.id));
}
