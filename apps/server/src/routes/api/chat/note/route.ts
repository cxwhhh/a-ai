import { currentUser, unauthorized } from "../../../../../../../packages/application/users/src/auth";
import type { RouteContext } from "../../../../router";


/**
 * POST { sessionId, message }：agent 运行中补充想法。
 * 返回 { queued: true } = 已放进队列，agent 下一步会看到；
 * 返回 409 = 当前运行未接纳这条输入。新版聊天框通过队列接口引导指定消息。
 */
export async function POST(req: Request, { runtime }: RouteContext) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const b = (await req.json().catch(() => ({}))) as { sessionId?: string; message?: string };
  const text = String(b.message ?? "").trim();
  if (!b.sessionId || !text) return Response.json({ error: "sessionId 和 message 不能为空" }, { status: 400 });
  if (!runtime.agents.get(b.sessionId, user.id)?.enqueueInput(undefined, text.slice(0, 4000), "next-step")) return Response.json({ queued: false }, { status: 409 });
  return Response.json({ queued: true });
}
