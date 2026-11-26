import type { ToolSpec } from "../../llm/src/types";
import { withPurpose } from "../../tool-runtime/src/validate";
import { DEFAULT_TASK_TOKENS, MAX_TASK_TIMEOUT_MS, MAX_TASK_TOKENS, MIN_TASK_TIMEOUT_MS, ROLES } from "./role-budget";
import type { BudgetLimits, SubagentRole } from "./role-budget";

export interface TaskContract {
  task: string;
  name?: string;
  role?: SubagentRole;
  purpose?: string;
  acceptance?: string[];
  plan?: string[];
  factKeys?: string[];
  tools?: string[];
  paths?: string[];
  writePaths?: string[];
  hosts?: string[];
  contextMessages?: string[];
  contextArtifacts?: string[];
  contextFiles?: string[];
  budget?: Partial<BudgetLimits>;
  idempotencyKey?: string;
}

const strings = (description: string) => ({ type: "array" as const, description, items: { type: "string" as const } });

export const RESEARCH_SPEC: ToolSpec = withPurpose({
  name: "research",
  description: "把需要多次读取或搜索的任务交给只读子 Agent。用 task 说明具体目标，给出验收项和必要的资源范围。简单的一次读取请直接调用工具。",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "完整任务说明。只会继承明确引用的上下文。" },
      name: { type: "string", description: "根据分工起一个最多 24 字的短名称，例如搜索日期。" },
      role: { type: "string", enum: ["research", "review", "analysis"], description: "调研研究、资料审阅或材料分析。" },
      acceptance: strings("可分别核对的验收项。子 Agent 按顺序用实际证据逐项报告。"),
      plan: strings("给子 Agent 的有序执行计划。"),
      factKeys: strings("归本子任务发布的事实键，例如 weather:tokyo:2026-11-20:temp:c。"),
      tools: strings("执行本项所需的工具名。列出的工具须在当前会话启用，并符合角色与资源范围。省略时用角色默认清单，空列表表示不开放工具。"),
      paths: strings("允许读取的文件或目录，仅限当前用户的已有授权。空列表禁用文件访问。"),
      hosts: strings("允许直接访问的网页主机名，包含重定向检查。指定后关闭通用网页搜索。"),
      contextMessages: strings("当前会话中要交给子 Agent 的有效消息 ID。"),
      contextArtifacts: strings("当前会话中要交给子 Agent 的有效产物 ID。"),
      contextFiles: strings("允许范围内要指给子 Agent 的文件路径，按需用工具读取。"),
      budget: {
        type: "object",
        properties: {
          steps: { type: "integer", description: "执行角色最多 24 步。按任务规模分配，预留修改、运行测试和修正的步骤。" }, toolCalls: { type: "integer" },
          tokens: { type: "integer", description: `整项累计输入和输出额度。省略时使用模型上下文长度与 ${DEFAULT_TASK_TOKENS} 中的较大值。仅需主动收紧预算时填写，手动值上限 ${MAX_TASK_TOKENS}。` },
          timeoutMs: { type: "integer", description: `单项总时限，单位为毫秒，范围 ${MIN_TASK_TIMEOUT_MS}–${MAX_TASK_TIMEOUT_MS}，省略时用 ${MIN_TASK_TIMEOUT_MS}。` },
          idleTimeoutMs: { type: "integer", description: "单个子任务持续无有效进展的毫秒数。默认 30000。" },
        },
      },
      idempotencyKey: { type: "string", description: "同一会话和来源下去重。重用时任务内容需要相同。" },
    },
    required: ["task"],
  },
});

const listLimits = {
  acceptance: [8, 500], plan: [8, 500], factKeys: [8, 120], tools: [12, 64], paths: [12, 500], writePaths: [12, 500], hosts: [12, 253],
  contextMessages: [8, 120], contextArtifacts: [8, 120], contextFiles: [8, 500],
} as const;

export class SubagentRequestError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** 结构化字段严格校验，防止拼错允许范围后退回到更宽的默认权限。 */
export function parseTaskContract(input: unknown): TaskContract {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SubagentRequestError("子任务参数必须是对象");
  const raw = input as Record<string, unknown>;
  const fields = ["task", "name", "role", "purpose", "budget", "idempotencyKey", ...Object.keys(listLimits)];
  for (const key of Object.keys(raw)) {
    if (!fields.includes(key)) throw new SubagentRequestError(`不支持的子任务字段：${key}`);
  }
  if (typeof raw.task !== "string" || !raw.task.trim() || raw.task.length > 4_000) throw new SubagentRequestError("task 必须是 1 至 4000 字的任务说明");
  const contract: TaskContract = { task: raw.task.trim() };
  if (raw.name !== undefined) {
    if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 120) throw new SubagentRequestError("子任务名称格式无效");
    contract.name = raw.name.trim().replace(/\s+/g, " ").slice(0, 24);
  }
  if (raw.role !== undefined) {
    if (typeof raw.role !== "string" || !Object.hasOwn(ROLES, raw.role)) throw new SubagentRequestError("未知子 Agent 角色");
    contract.role = raw.role as SubagentRole;
  }
  for (const [key, max] of [["purpose", 200], ["idempotencyKey", 120]] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > max || (key === "idempotencyKey" && !value.trim())) {
      throw new SubagentRequestError(`${key} 格式无效`);
    }
    contract[key] = value.trim();
  }
  for (const key of Object.keys(listLimits) as (keyof typeof listLimits)[]) {
    const value = raw[key];
    if (value === undefined) continue;
    const [count, length] = listLimits[key];
    if (!Array.isArray(value) || value.length > count || value.some((item) => typeof item !== "string" || !item.trim() || item.length > length)) {
      throw new SubagentRequestError(`${key} 必须是长度合规的字符串列表`);
    }
    contract[key] = Array.from(new Set(value.map((item: string) => item.trim())));
  }
  if (contract.factKeys) {
    contract.factKeys = contract.factKeys.map(normalizeFactKey);
    if (contract.factKeys.some((key) => !/^[\p{L}\p{N}_:./-]+$/u.test(key)) || new Set(contract.factKeys).size !== contract.factKeys.length) {
      throw new SubagentRequestError("事实键必须合法且互不重复");
    }
  }
  if (raw.budget !== undefined) {
    if (!raw.budget || typeof raw.budget !== "object" || Array.isArray(raw.budget)) throw new SubagentRequestError("budget 必须是对象");
    const limits = {
      steps: [1, contract.role === "implementation" ? ROLES.implementation.steps : 8], tokens: [512, MAX_TASK_TOKENS], timeoutMs: [MIN_TASK_TIMEOUT_MS, MAX_TASK_TIMEOUT_MS],
      toolCalls: [0, 24], idleTimeoutMs: [10, 180_000],
    } as const;
    const budget: Partial<BudgetLimits> = {};
    for (const [key, value] of Object.entries(raw.budget)) {
      if (!Object.hasOwn(limits, key)) throw new SubagentRequestError(`未知预算字段：${key}`);
      const field = key as keyof BudgetLimits;
      const [minimum, maximum] = limits[field];
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new SubagentRequestError(`预算 ${key} 必须是 ${minimum} 至 ${maximum} 的整数`);
      }
      budget[field] = value;
    }
    contract.budget = budget;
  }
  return contract;
}

export function normalizeFactKey(key: string) {
  return key.normalize("NFKC").trim().toLowerCase();
}

export const DELEGATE_SPEC: ToolSpec = withPurpose({
  name: "delegate_tasks",
  description: "复杂任务可拆成多个工作项时提交完整计划。能独立执行的并行，有前置输入的声明 dependsOn。每个事实指定唯一负责人。一次查询、天气和可直接回答的问题直接处理。",
  parameters: {
    type: "object",
    properties: {
      objective: { type: "string", description: "父 Agent 的整体目标。" },
      reason: { type: "string", description: "说明为什么需要分工，以及哪些工作可以并行。" },
      synthesis: { type: "string", description: "返回后如何按用户目标整合结果和缺口。" },
      assignments: {
        type: "array", items: {
          ...RESEARCH_SPEC.parameters,
          properties: {
            ...RESEARCH_SPEC.parameters.properties,
            role: { type: "string", enum: Object.keys(ROLES), description: "调研、审阅、分析，或 implementation 文件制作与验证。" },
            writePaths: strings("implementation 的精确可写文件，相对工作区。目录或通配符无效。同一批每个文件只有一个负责项。"),
            taskKey: { type: "string", description: "本次分工内唯一的任务标识，例如 requirements。被其它项依赖时必填。" },
            dependsOn: strings("写最多 8 个直接上游的 taskKey。所有上游交付已核验结果后才启动，独立分工省略。"),
          },
          required: ["task", "role", "plan", "acceptance"],
        },
      },
    },
    required: ["objective", "reason", "synthesis", "assignments"],
  },
});

export const RECOVER_DELEGATION_SPEC: ToolSpec = withPurpose({
  name: "recover_subagent_tasks",
  description: "读取当前主对话上一轮中断时的子任务和已核验结果。用户要求接着做时，传入仍需继续的任务 ID，沿原分工、依赖和权限补齐；省略 taskIds 只检查记录。",
  parameters: {
    type: "object",
    properties: { taskIds: strings("只填检查结果中的任务 ID。已验收的上游会直接复用，仍待补齐的必要上游会先恢复。每次最多选择 40 个任务。") },
  },
});
