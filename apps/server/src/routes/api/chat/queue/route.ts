import { currentUser, unauthorized } from "../../../../../../../packages/application/users/src/auth";
import type { RouteContext } from "../../../../router";
import { MAX_QUEUE_MESSAGE_LENGTH } from "../../../../../../../packages/agent-registry/src/index";


/** 只返回自己的收件箱。别人的会话与没有待处理输入的会话一样，返回空列表。 */
export async function GET(req: Request, { runtime }: RouteContext) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const sessionId = new URL(req.url).searchParams.get("sessionId");
  if (!sessionId) return Response.json({ error: "缺少会话 ID" }, { status: 400 });
  return Response.json(runtime.agents.queueSnapshot(sessionId, user.id));
}

/** 排队和引导都绑定客户端看到的运行 ID；删除按当前用户和消息 ID 定位。 */
export async function POST(req: Request, { runtime }: RouteContext) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const body = await req.json().catch(() => null);
  if (!body || typeof body.sessionId !== "string" || !body.sessionId) {
    return Response.json({ error: "缺少会话 ID" }, { status: 400 });
  }
  const { sessionId, action, id, runId } = body;
  const agent = runtime.agents.get(sessionId, user.id);
  let accepted: boolean;
  if (action === "enqueue" && typeof runId === "string" && runId && typeof body.message === "string") {
    const message = body.message.trim();
    if (!message || message.length > MAX_QUEUE_MESSAGE_LENGTH) {
      return Response.json({ error: "排队消息需为非空且不超过 32000 字符" }, { status: 400 });
    }
    accepted = agent?.enqueueInput(runId, message, "next-turn") === true;
  } else if (typeof id === "string" && id && (action === "remove" || (action === "steer" && typeof runId === "string" && runId))) {
    accepted = agent?.changeQueuedInput(id, action, typeof runId === "string" ? runId : undefined) === true;
  } else {
    return Response.json({ error: "无效的排队操作" }, { status: 400 });
  }
  if (!accepted) return Response.json({ error: "运行或排队消息已变化，或队列已满" }, { status: 409 });
  return Response.json(runtime.agents.queueSnapshot(sessionId, user.id));
}
