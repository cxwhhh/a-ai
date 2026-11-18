import { currentUser, notFound, unauthorized } from "../../../../../../../../../../packages/application/users/src/auth";
import { readTraceEntry } from "../../../../../../../../../../packages/conversation-trace/src/store";


export async function GET(req: Request, { params }: { params: Promise<{ id: string; recordId: string }> }) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const { id, recordId } = await params;
  const detail = readTraceEntry(id, user.id, recordId, new URL(req.url).searchParams.get("compare") === "1");
  return detail ? Response.json(detail, { headers: { "Cache-Control": "private, no-store" } }) : notFound();
}
