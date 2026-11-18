import { createSession, listSessions } from "../../../../../../packages/storage/src/store";
import { currentUser, unauthorized } from "../../../../../../packages/application/users/src/auth";


/** 只返回当前用户自己的对话 */
export async function GET(req: Request) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  return Response.json(listSessions(user.id));
}

export async function POST(req: Request) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  return Response.json(createSession(user.id));
}
