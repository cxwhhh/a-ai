import { currentUser, unauthorized } from "../../../../../../packages/application/users/src/auth";
import { answerApproval, type ApprovalDecision } from "../../../../../../packages/permissions/src/approvals";


const DECISIONS: ApprovalDecision[] = ["allow", "allow_session", "deny"];

/** 确认卡片携带这次服务端生成的 approvalId，避免答复命中其他运行。 */
export async function POST(req: Request) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const body = (await req.json().catch(() => null)) as { approvalId?: unknown; decision?: unknown } | null;
  const decision = DECISIONS.find((d) => d === body?.decision);
  if (typeof body?.approvalId !== "string" || !decision) return Response.json({ error: "参数不对" }, { status: 400 });
  if (!answerApproval(user.id, body.approvalId, decision)) return Response.json({ error: "这个确认已经过期" }, { status: 404 });
  return Response.json({ ok: true });
}
