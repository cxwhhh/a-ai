import { searchHistory, readHistoryExecution } from "../../storage/src/history";
import type { Tool } from "../../tool-runtime/src/types";

export const searchSavedHistory: Tool<{ query: string; limit?: number }> = {
  parallelSafe: true,
  spec: {
    name: "search_history",
    description: "从本对话按主题、文件名、标识符或关键实体搜索旧段落。返回简短卡片和 segmentId。要看其中实际调用了哪些工具，用 read_history_execution。",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "一两个有区分度的历史关键词，例如文件名或问题主题。" },
        limit: { type: "integer", description: "最多多少条，默认 3，最大 5。" } },
      required: ["query"],
    },
  },
  async run({ query, limit = 3 }, { userId, sessionId, inputId }) {
    if (!userId) throw new Error("缺少检索历史所需的会话身份");
    if (query.trim().length === 0 || query.length > 1600 || !Number.isSafeInteger(limit) || limit < 1 || limit > 5) {
      throw new Error("query 须为 1 到 1600 字符，limit 须为 1 到 5 的整数");
    }
    return { content: JSON.stringify({ matches: searchHistory(userId, sessionId, query, limit, inputId) }), status: "ok" };
  },
};

export const readSavedHistoryExecution: Tool<{ segmentId: string; offset?: number; limit?: number }> = {
  parallelSafe: true,
  spec: {
    name: "read_history_execution",
    description: "按 segmentId 分页读取本对话段落的历史工具调用清单。清单包括顺序、工具名、目的、关键参数、状态和 resultId。用 read_tool_result 按需读取对应正文；不要为查历史而重跑工具。",
    parameters: {
      type: "object",
      properties: { segmentId: { type: "string", description: "来自上下文历史卡片或 search_history 的段落 ID。" },
        offset: { type: "integer", description: "跳过多少条调用，首页为 0，后续使用 nextOffset。" },
        limit: { type: "integer", description: "每页数量，默认 6，最大 10。" } },
      required: ["segmentId"],
    },
  },
  async run({ segmentId, offset = 0, limit = 6 }, { userId, sessionId }) {
    if (!userId) throw new Error("缺少回读调用清单所需的会话身份");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
      throw new Error("offset 须为非负整数，limit 须为 1 到 10 的整数");
    }
    const result = readHistoryExecution(userId, sessionId, segmentId, offset, limit);
    if (!result) throw new Error("当前会话没有这个有效的历史段落");
    return { content: JSON.stringify(result), status: "ok" };
  },
};
