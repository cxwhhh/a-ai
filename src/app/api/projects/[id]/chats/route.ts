import { projectChats } from "@/lib/server/projects";
import { currentUser, notFound, unauthorized } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET 项目页下面的对话列表（只能看自己的项目，别人的项目当作不存在） */
export async function GET(_: Request, { params }: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const list = projectChats((await params).id, user.id);
  return list ? Response.json(list) : notFound();
}
