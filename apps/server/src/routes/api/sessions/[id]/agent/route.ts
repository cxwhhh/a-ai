import { currentUser, notFound, unauthorized } from "../../../../../../../../packages/application/users/src/auth";
import { inspectAgentWork } from "../../../../../../../../packages/session-projection/src/inspect";
import type { RouteContext } from "../../../../../router";


/** 按会话返回可对比的运行事实；读历史不会创建在线实例，也不暴露其他用户的数据。 */
export async function GET(req: Request, { params, runtime }: { runtime: RouteContext["runtime"]; params: Promise<{ id: string }> }) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const { id } = await params;
  const agent = runtime.agents.get(id, user.id);
  const snapshot = inspectAgentWork(id, user.id, agent);
  return snapshot ? Response.json(snapshot) : notFound();
}
