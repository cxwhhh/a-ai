import { projectChats } from "../../../../../../../../packages/application/projects/src/projects";
import { currentUser, notFound, unauthorized } from "../../../../../../../../packages/application/users/src/auth";


type Ctx = { params: Promise<{ id: string }> };

/** GET 项目页下面的对话列表（只能看自己的项目，别人的项目当作不存在） */
export async function GET(req: Request, { params }: Ctx) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const list = projectChats((await params).id, user.id);
  return list ? Response.json(list) : notFound();
}
