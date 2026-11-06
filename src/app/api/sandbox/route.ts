import { currentUser, unauthorized } from "@/lib/server/auth";
import { listAudit } from "@/lib/server/audit";
import { dockerProblem, sandboxInfo } from "@/lib/server/sandbox";
import { canManageNetwork, saveNetworkPolicy } from "@/lib/server/sandbox-network";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET：沙箱状态（隔离方式、授权目录、是否联网）+ 当前用户最近 200 条审计记录。设置页「沙箱」「审计日志」用 */
export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();
  // docker 模式下顺便实际检查一次 Docker 能不能用，有问题放进 warnings 显示在设置页
  const info = sandboxInfo();
  const problem = await dockerProblem();
  const warning = problem && `Docker 沙箱现在不可用，run_command / run_python 已暂时停用：${problem}`;
  return Response.json({ info: warning ? { ...info, warnings: [warning, ...info.warnings] } : info, canManageNetwork: canManageNetwork(user.id), audit: listAudit(user.id, 200) });
}

/** 仅更新全局 Docker 联网策略，不接受目录、隔离方式等部署参数。 */
export async function PUT(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (!canManageNetwork(user.id)) return Response.json({ error: "请使用最早注册的管理账号修改" }, { status: 403 });
  if (sandboxInfo().mode !== "docker") return Response.json({ error: "此开关仅用于 Docker 沙箱" }, { status: 409 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.network !== "boolean") return Response.json({ error: "network 必须是布尔值" }, { status: 400 });
  saveNetworkPolicy(user.id, body.network);
  return Response.json({ network: sandboxInfo().network });
}
