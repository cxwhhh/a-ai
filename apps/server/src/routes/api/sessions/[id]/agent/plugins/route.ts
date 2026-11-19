import type { RouteContext } from "../../../../../../router";
import { currentUser, notFound, unauthorized } from "../../../../../../../../../packages/application/users/src/auth";
import { configureAgentPlugins, getAgentPluginSettings } from "../../../../../../../../../packages/application/chat/src/agent-plugins";

export async function GET(req: Request, { params, runtime }: RouteContext) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const settings = getAgentPluginSettings((await params).id, user.id, runtime.agentPlugins);
  return settings ? Response.json(settings) : notFound();
}

export async function PUT(req: Request, { params, runtime }: RouteContext) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const body = await req.json().catch(() => null);
  const { id } = await params;
  const result = await configureAgentPlugins(id, user.id, body?.enabled, runtime.agentPlugins, runtime.agents);
  if (result.status === "missing") return notFound();
  if (result.status === "invalid") return Response.json({ error: "插件配置包含未知或无效的 ID" }, { status: 400 });
  if (result.status === "busy") return Response.json({ error: "请等 Agent 空闲并处理完待办，再修改插件" }, { status: 409 });
  return Response.json(result.settings);
}
