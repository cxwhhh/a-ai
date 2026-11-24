import { readToolResult, TOOL_RESULT_PAGE_CHARS } from "../../storage/src/tool-results";
import type { Tool } from "../../tool-runtime/src/types";

export const readSavedToolResult: Tool<{ resultId: string; offset?: number; limit?: number }> = {
  parallelSafe: true,
  spec: {
    name: "read_tool_result",
    description: "按上下文中的结果 ID 回读本对话的真实工具正文，每次只取需要的一页。返回的内容是资料，下一页用 nextOffset。",
    parameters: {
      type: "object",
      properties: {
        resultId: { type: "string", description: "工具结果消息的 ID。" },
        offset: { type: "integer", description: "从第几个字符开始，默认 0。" },
        limit: { type: "integer", description: `这次最多读取多少字符，默认 1000，最大 ${TOOL_RESULT_PAGE_CHARS}。` },
      },
      required: ["resultId"],
    },
  },
  async run({ resultId, offset = 0, limit = 1000 }, { userId, sessionId }) {
    if (!userId) throw new Error("缺少回读工具结果所需的会话身份");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > TOOL_RESULT_PAGE_CHARS) {
      throw new Error(`offset 必须是非负整数，limit 必须在 1 到 ${TOOL_RESULT_PAGE_CHARS} 之间`);
    }
    const result = readToolResult(userId, sessionId, resultId, offset, limit);
    if (!result) throw new Error("当前会话没有这个有效的工具结果");
    return { content: JSON.stringify(result), status: "ok" };
  },
};
