import { currentUser, unauthorized } from "@/lib/server/auth";
import { addNote } from "@/lib/server/notes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { sessionId, message }：agent 运行中补充想法。
 * 返回 { queued: true } = 已放进队列，agent 下一步会看到；
 * 返回 409 = 这个会话已经不在运行了，前端应该当作普通消息发送。
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const b = (await req.json().catch(() => ({}))) as { sessionId?: string; message?: string };
  const text = String(b.message ?? "").trim();
  if (!b.sessionId || !text) return Response.json({ error: "sessionId 和 message 不能为空" }, { status: 400 });
  if (!addNote(b.sessionId, user.id, text)) return Response.json({ queued: false }, { status: 409 });
  return Response.json({ queued: true });
}
