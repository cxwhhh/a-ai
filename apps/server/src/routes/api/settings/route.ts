import { getSettings, maskSettings, saveSettings } from "../../../../../../packages/application/settings/src/settings";
import { SYSTEM_PROMPT } from "../../../../../../packages/system-prompt/src/prompt";
import { currentUser, unauthorized } from "../../../../../../packages/application/users/src/auth";


/** GET：当前设置 + 内置系统提示词（设置页里作为占位参考） */
export async function GET(req: Request) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  return Response.json({ settings: maskSettings(getSettings(user.id)), defaultSystemPrompt: SYSTEM_PROMPT });
}

/** PUT：部分更新，例如 { theme: "dark" } */
export async function PUT(req: Request) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const patch = await req.json().catch(() => ({}));
  return Response.json({ settings: maskSettings(saveSettings(user.id, patch)) });
}
