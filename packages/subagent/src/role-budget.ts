import type { Usage } from "../../llm/src/types";

const FILE_TOOLS = ["read_file", "read_document", "grep", "glob", "list_files"];
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
export const MIN_TASK_TIMEOUT_MS = 10 * 60_000;
export const MAX_TASK_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_TASK_TOKENS = 48_000;
export const MAX_TASK_TOKENS = 64_000;
export const ROLES = {
  research: {
    prompt: "检索资料并汇总结论，逐项区分已找到的证据和仍不确定的问题。",
    tools: ["web_search", "web_fetch", ...FILE_TOOLS, "calculator", "current_time"],
    steps: 8,
  },
  review: {
    prompt: "审阅指定本地资料，对照验收项报告发现、依据和缺口。指出不确定性。",
    tools: [...FILE_TOOLS, "calculator"],
    steps: 6,
  },
  analysis: {
    prompt: "整理任务指定的材料，比较方案或指标，说明推导过程、假设及其局限。",
    tools: [...FILE_TOOLS, "calculator"],
    steps: 7,
  },
} as const;

export type SubagentRole = keyof typeof ROLES;
export interface BudgetLimits {
  steps: number;
  tokens: number;
  timeoutMs: number;
  idleTimeoutMs: number;
  toolCalls: number;
}

export function budgetLimits(role: SubagentRole, input: Partial<BudgetLimits>): BudgetLimits {
  return {
    steps: Math.min(input.steps ?? ROLES[role].steps, ROLES[role].steps),
    tokens: Math.min(input.tokens ?? DEFAULT_TASK_TOKENS, MAX_TASK_TOKENS),
    timeoutMs: Math.max(MIN_TASK_TIMEOUT_MS, Math.min(input.timeoutMs ?? MIN_TASK_TIMEOUT_MS, MAX_TASK_TIMEOUT_MS)),
    toolCalls: Math.min(input.toolCalls ?? 16, 24),
    idleTimeoutMs: input.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
  };
}

/** 每个子任务单独结算，其他分支发出请求时不会扣减本任务额度。 */
export class TokenBudget {
  constructor(private available: number) {}

  /** 给最低可用输出预留空间，剩余部分可通过缩短历史工具片段满足。 */
  get inputRoom() { return this.available - 128; }

  reserve(input: number, maxOutput = 2_048, keep = 0) {
    const output = Math.min(maxOutput, this.available - input - keep);
    if (output < 128) return null;
    const amount = input + output;
    this.available -= amount;
    return {
      output,
      settle: (usage: Usage) => { this.available += amount - usage.inputTokens - usage.outputTokens; },
    };
  }

  exhausted() { return this.available <= 0; }
}
