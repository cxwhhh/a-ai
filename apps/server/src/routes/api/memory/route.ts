import { clearMemory, getMemory, saveMemory } from "../../../../../../packages/memory/src/memory";
import { currentUser, unauthorized } from "../../../../../../packages/application/users/src/auth";


/** GET：当前用户的长期记忆（设置 → 记忆 页面展示） */
export async function GET(req: Request) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  return Response.json(getMemory(user.id));
}

/** PUT：整份替换（用户在设置页删掉某一条、改了职业） */
export async function PUT(req: Request) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  return Response.json(saveMemory(user.id, await req.json().catch(() => ({}))));
}

/** DELETE：清空记忆 */
export async function DELETE(req: Request) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  clearMemory(user.id);
  return Response.json(getMemory(user.id));
}
