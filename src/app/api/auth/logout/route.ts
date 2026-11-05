import { logout } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  await logout();
  return new Response(null, { status: 204 });
}
