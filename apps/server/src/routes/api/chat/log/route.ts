import { currentUser, notFound, unauthorized } from "../../../../../../../packages/application/users/src/auth";
import { readAgentLog } from "../../../../../../../packages/session/src/log";


export async function GET(req: Request) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const query = new URL(req.url).searchParams;
  const sessionId = query.get("sessionId") || undefined;
  const inputId = query.get("inputId") || undefined;
  if (inputId && !sessionId) return Response.json({ error: "按输入查询需要指定会话" }, { status: 400 });
  const cursor = query.get("before");
  const before = cursor ? Number(cursor) : undefined;
  if (before !== undefined && (!Number.isSafeInteger(before) || before <= 0)) return Response.json({ error: "无效的日志游标" }, { status: 400 });
  const entries = readAgentLog(user.id, sessionId, before, inputId);
  return entries ? Response.json(entries) : notFound();
}
