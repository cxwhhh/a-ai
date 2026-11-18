import { login, startLogin } from "../../../../../../../packages/application/users/src/auth";


/** POST { username, password } → 登录成功写 Cookie */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { username?: string; password?: string };
  const r = login(String(b.username ?? "").trim(), String(b.password ?? ""));
  if (typeof r === "string") return Response.json({ error: r }, { status: 401 });
  return Response.json({ user: r }, { headers: startLogin(req, r.id) });
}
