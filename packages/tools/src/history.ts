import { searchHistory, readHistoryExecution, type HistoryScope } from "../../storage/src/history";
import type { Tool } from "../../tool-runtime/src/types";

export const searchSavedHistory: Tool<{ query: string; limit?: number; scope?: HistoryScope }> = {
  parallelSafe: true,
  spec: {
    name: "search_history",
    description: "按主题、文件名、标识符或关键实体搜索旧段落。默认检索本对话（scope=session）；项目开启“对话互相可见”时可传 scope=project 检索同项目其他对话。返回简短卡片和 segmentId，再按需调用 read_history_execution。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "一两个有区分度的历史关键词，例如文件名或问题主题（也支持单字中文）。" },
        limit: { type: "integer", description: "最多多少条，默认 3，最大 5。" },
        scope: { type: "string", enum: ["session", "project"], description: "检索范围：session（当前对话，默认）或 project（同项目共享对话）。" },
      },
      required: ["query"],
    },
  },
  async run({ query, limit = 3, scope = "session" }, { userId, sessionId, inputId }) {
    if (!userId) throw new Error("缺少检索历史所需的会话身份");
    if (query.trim().length === 0 || query.length > 1600 || !Number.isSafeInteger(limit) || limit < 1 || limit > 5) {
      throw new Error("query 须为 1 到 1600 字符，limit 须为 1 到 5 的整数");
    }
    if (scope !== "session" && scope !== "project") throw new Error("scope 只能是 session 或 project");
    return { content: JSON.stringify({ scope, matches: searchHistory(userId, sessionId, query, limit, inputId, scope) }), status: "ok" };
  },
};

export const readSavedHistoryExecution: Tool<{ segmentId: string; offset?: number; limit?: number; sessionId?: string }> = {
  parallelSafe: true,
  spec: {
    name: "read_history_execution",
    description: "按 segmentId 分页读取历史段落的工具调用清单。若段落来自同项目其他对话（search_history scope=project），一并传入该卡片的 sessionId。用 read_tool_result 按需读取对应正文；不要为查历史而重跑工具。",
    parameters: {
      type: "object",
      properties: {
        segmentId: { type: "string", description: "来自上下文历史卡片或 search_history 的段落 ID。" },
        sessionId: { type: "string", description: "可选：当段落来自同项目其他共享对话时传入对应 sessionId。" },
        offset: { type: "integer", description: "跳过多少条调用，首页为 0，后续使用 nextOffset。" },
        limit: { type: "integer", description: "每页数量，默认 6，最大 10。" },
      },
      required: ["segmentId"],
    },
  },
  async run({ segmentId, offset = 0, limit = 6, sessionId: targetSessionId }, { userId, sessionId }) {
    if (!userId) throw new Error("缺少回读调用清单所需的会话身份");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
      throw new Error("offset 须为非负整数，limit 须为 1 到 10 的整数");
    }
    const result = readHistoryExecution(userId, sessionId, segmentId, offset, limit, targetSessionId);
    if (!result) throw new Error("没有这个可访问的有效历史段落");
    return { content: JSON.stringify(result), status: "ok" };
  },
};
