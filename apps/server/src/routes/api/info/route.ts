import { deferredCatalog, isDeferred, toolSpecs, toolsFor } from "../../../../../../packages/tool-runtime/src/index";
import { SYSTEM_PROMPT } from "../../../../../../packages/system-prompt/src/prompt";
import { getSettings } from "../../../../../../packages/application/settings/src/settings";
import { currentUser, unauthorized } from "../../../../../../packages/application/users/src/auth";
import { currentOption } from "../../../../../../packages/protocol/src/lib/settings";
import { estimateTokens } from "../../../../../../packages/protocol/src/lib/tokens";
import { getMemory, memoryPrompt } from "../../../../../../packages/memory/src/memory";
import { activeSkills, skillsPrompt } from "../../../../../../packages/skills/src/skills";


/**
 * 给界面用的基础信息：
 * - tools：已注册的工具（左栏、设置页展示）
 * - systemTokens / toolsTokens：系统提示词和工具说明书大约占多少 token
 *   每次请求都会带上它们，所以它们是上下文里“固定占用”的部分（上下文环形图的拆分用）
 *   工具按需加载以后，固定占用的只有常用工具的说明书；按需工具的目录算在系统提示词里。
 *   会话里加载了按需工具后实际会多一些，这里给的是新会话开始时的数。
 */
export async function GET(req: Request) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const s = getSettings(user.id);
  const specs = toolSpecs();
  return Response.json({
    username: user.username,
    model: currentOption(s).label,
    tools: specs.map((t) => ({ name: t.name, description: t.description, deferred: isDeferred(t.name) })),
    // 长期记忆、技能目录接在系统提示词后面，也算固定占用
    systemTokens: estimateTokens((s.systemPrompt.trim() || SYSTEM_PROMPT) + deferredCatalog() + (s.memory ? memoryPrompt(getMemory(user.id)) : "") + (s.skills ? skillsPrompt(activeSkills(user.id)) : "")),
    toolsTokens: estimateTokens(JSON.stringify(toolsFor([]))),
  });
}
