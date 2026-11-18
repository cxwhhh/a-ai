import type { RouteContext } from "../../../../../../router";
import { currentUser, notFound, unauthorized } from "../../../../../../../../../packages/application/users/src/auth";
import { readSessionTrace } from "../../../../../../../../../packages/conversation-trace/src/projection";


export async function GET(req: Request, { params, runtime }: { params: Promise<{ id: string }>; runtime?: RouteContext["runtime"] }) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const id = (await params).id;
  const trace = readSessionTrace(id, user.id, new URL(req.url).searchParams.get("stats") === "1", runtime?.agents.get(id, user.id));
  return trace ? Response.json(trace, { headers: { "Cache-Control": "private, no-store" } }) : notFound();
}
