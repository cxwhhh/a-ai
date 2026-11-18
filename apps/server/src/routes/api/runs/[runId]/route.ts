import { currentUser, notFound, unauthorized } from "../../../../../../../packages/application/users/src/auth";
import type { RouteContext } from "../../../../router";

export async function GET(req: Request, { runtime, params }: RouteContext) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const run = runtime.scheduler.get(user.id, (await params).runId);
  if (!run) return notFound();
  const after = Number(new URL(req.url).searchParams.get("after") ?? req.headers.get("last-event-id") ?? "0");
  if (!Number.isSafeInteger(after) || after < 0) return Response.json({ error: "无效的事件游标" }, { status: 400 });
  return run.subscribe(after);
}

/** 明确的停止操作针对用户看见的运行 ID，迟到的停止请求无法取消同一会话的新任务。 */
export async function DELETE(req: Request, { runtime, params }: RouteContext) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const run = runtime.scheduler.get(user.id, (await params).runId);
  if (!run) return notFound();
  if (!run.done) run.cancellation.abort();
  return new Response(null, { status: 204 });
}
