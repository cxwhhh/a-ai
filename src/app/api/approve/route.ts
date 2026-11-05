import { currentUser, unauthorized } from "@/lib/server/auth";
import { answerApproval, type ApprovalDecision } from "@/lib/server/approvals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DECISIONS: ApprovalDecision[] = ["allow", "allow_session", "deny"];

/** POST { callId, decision: "allow" | "allow_session" | "deny" }：用户在确认卡片上点了按钮 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const body = (await req.json().catch(() => ({}))) as { callId?: unknown; decision?: unknown };
  const decision = DECISIONS.find((d) => d === body.decision);
  if (typeof body.callId !== "string" || !decision) return Response.json({ error: "参数不对" }, { status: 400 });
  if (!answerApproval(user.id, body.callId, decision)) return Response.json({ error: "这个确认已经过期" }, { status: 404 });
  return Response.json({ ok: true });
}
