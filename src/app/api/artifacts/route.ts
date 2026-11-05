import { listArtifacts } from "@/lib/server/store";
import { currentUser, unauthorized } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET 当前用户全部产出物的概要（左栏“产出物”页面） */
export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();
  return Response.json(listArtifacts(user.id));
}
