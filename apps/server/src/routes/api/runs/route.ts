import { currentUser, unauthorized } from "../../../../../../packages/application/users/src/auth";
import type { RouteContext } from "../../../router";

/** 刷新对话页时查询正在运行的任务。只有拥有此会话的用户能取得运行 ID。 */
export async function GET(req: Request, { runtime }: RouteContext) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const sessionId = new URL(req.url).searchParams.get("sessionId");
  if (!sessionId) return Response.json({ error: "缺少会话 ID" }, { status: 400 });
  const run = runtime.scheduler.current(user.id, sessionId);
  return Response.json(run ? { runId: run.id, sessionId } : null);
}
