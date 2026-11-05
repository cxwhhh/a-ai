import { cleanProject, createProject, listProjects } from "@/lib/server/projects";
import { currentUser, unauthorized } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET 自己的全部项目；POST { name, description, memory, share } 新建一个 */
export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();
  return Response.json(listProjects(user.id));
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const p = cleanProject(await req.json().catch(() => null));
  if (!p) return Response.json({ error: "项目名字不能为空" }, { status: 400 });
  return Response.json(createProject(user.id, p));
}
