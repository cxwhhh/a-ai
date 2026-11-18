import { currentUser, notFound, unauthorized } from "../../../../../../../../packages/application/users/src/auth";
import type { RouteContext } from "../../../../../router";


/** 按会话返回可对比的运行事实；读历史不会创建在线实例，也不暴露其他用户的数据。 */
export async function GET(req: Request, { params, runtime }: { runtime: RouteContext["runtime"]; params: Promise<{ id: string }> }) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const snapshot = runtime.agents.inspect((await params).id, user.id);
  return snapshot ? Response.json(snapshot) : notFound();
}
