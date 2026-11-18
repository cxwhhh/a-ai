import { register, startLogin } from "../../../../../../../packages/application/users/src/auth";


/** POST { username, password } → 注册并直接登录 */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { username?: string; password?: string };
  const r = register(String(b.username ?? "").trim(), String(b.password ?? ""));
  if (typeof r === "string") return Response.json({ error: r }, { status: 400 });
  return Response.json({ user: r }, { headers: startLogin(req, r.id) });
}
