import { register, startLogin } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST { username, password } → 注册并直接登录 */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { username?: string; password?: string };
  const r = register(String(b.username ?? "").trim(), String(b.password ?? ""));
  if (typeof r === "string") return Response.json({ error: r }, { status: 400 });
  await startLogin(r.id);
  return Response.json({ user: r });
}
