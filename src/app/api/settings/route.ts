import { getSettings, maskSettings, saveSettings } from "@/lib/server/settings";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";
import { currentUser, unauthorized } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET：当前设置 + 内置系统提示词（设置页里作为占位参考） */
export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();
  return Response.json({ settings: maskSettings(getSettings(user.id)), defaultSystemPrompt: SYSTEM_PROMPT });
}

/** PUT：部分更新，例如 { theme: "dark" } */
export async function PUT(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const patch = await req.json().catch(() => ({}));
  return Response.json({ settings: maskSettings(saveSettings(user.id, patch)) });
}
