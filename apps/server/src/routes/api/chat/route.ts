import type { RouteContext } from "../../../router";
import { currentUser, unauthorized } from "../../../../../../packages/application/users/src/auth";
import { submitChat } from "../../../../../../packages/application/chat/src/index";

export async function POST(req: Request, context: RouteContext) {
  const user = await currentUser(req);
  return user ? submitChat(req, user.id, context.runtime) : unauthorized();
}
