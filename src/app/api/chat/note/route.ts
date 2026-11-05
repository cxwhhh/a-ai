import { currentUser, unauthorized } from "@/lib/server/auth";
import { isRunning } from "@/lib/server/notes";
import { changeQueue, enqueue, listQueue } from "@/lib/server/message-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 队列与正式对话分开读取；所有操作先校验登录及会话归属。 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const sessionId = new URL(req.url).searchParams.get("sessionId") || "";
  try {
    return Response.json({ queue: listQueue(sessionId, user.id), running: isRunning(sessionId) });
  } catch {
    return Response.json({ error: "会话不存在" }, { status: 404 });
  }
}

/** enqueue 只保存草稿；steer 才请求插入当前任务。编辑/删除和领取的状态检查在同一事务中完成。 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const b = await req.json().catch(() => null);
  if (!b || typeof b.sessionId !== "string") return Response.json({ error: "缺少会话编号" }, { status: 400 });
  const { sessionId } = b;
  try {
    // 先检查归属，不能通过 running 暴露别人的会话状态。
    listQueue(sessionId, user.id);
    const action = b.action ?? "enqueue";
    if (action === "enqueue") {
      if (typeof b.message !== "string" || (b.id !== undefined && typeof b.id !== "string")) throw new Error("消息参数无效");
      enqueue(sessionId, user.id, b.message, b.id);
    } else {
      if (!["edit", "remove", "up", "steer"].includes(action) || typeof b.id !== "string") throw new Error("队列操作无效");
      if (action === "edit" && typeof b.message !== "string") throw new Error("消息参数无效");
      if (action === "steer" && !isRunning(sessionId)) return Response.json({ error: "当前任务已结束，可作为新任务发送", idle: true }, { status: 409 });
      changeQueue(sessionId, user.id, b.id, action, b.message);
    }
    return Response.json({ queue: listQueue(sessionId, user.id), running: isRunning(sessionId) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "队列操作失败" }, { status: 400 });
  }
}
