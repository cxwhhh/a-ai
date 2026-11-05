import { listSkills, normalizeSkill, putSkill } from "@/lib/server/skills";
import { currentUser, unauthorized } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET：当前用户的全部技能（设置 → 技能 页面）。
 * GET ?since=时间戳：只要这之后自动新建 / 改进的技能 —— 对话结束后界面用它提示“学会了新技能”。
 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const since = Number(new URL(req.url).searchParams.get("since"));
  const all = listSkills(user.id);
  if (!Number.isFinite(since) || since <= 0) return Response.json(all);
  return Response.json(all.filter((s) => s.updatedAt > since && s.history[0]?.at > since && s.history[0].note.startsWith("自动")));
}

/** POST：自己新建一个技能（直接启用） */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const s = normalizeSkill({ ...body, status: "active", source: "user", history: [{ at: Date.now(), note: "手动新建" }] });
  if (!s.name) return Response.json({ error: "名字不能为空" }, { status: 400 });
  try {
    return Response.json(putSkill(user.id, s));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
