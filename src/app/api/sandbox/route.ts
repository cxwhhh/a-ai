import { currentUser, unauthorized } from "@/lib/server/auth";
import { listAudit } from "@/lib/server/audit";
import { dockerProblem, sandboxInfo } from "@/lib/server/sandbox";

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
  return Response.json({ info: warning ? { ...info, warnings: [warning, ...info.warnings] } : info, audit: listAudit(user.id, 200) });
}
