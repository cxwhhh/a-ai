import type { TaskContract } from "./task-contract";
import { parseTaskContract, SubagentRequestError } from "./task-contract";
import { MAX_TASK_TIMEOUT_MS, ROLES, budgetLimits } from "./role-budget";

/** 只接受顶层委派。默认沿用调研角色，声明的角色和额度由执行层最终裁决。 */
export function admitDelegation(task: TaskContract, disabled: Record<string, string>, depth = 0) {
  if (disabled.research) throw new SubagentRequestError("当前运行已禁用子 Agent", 403);
  if (depth !== 0) throw new SubagentRequestError("子 Agent 无权再次委派", 403);
  const role = task.role ?? "research";
  const definition = ROLES[role];
  if (task.tools?.some((name) => !(definition.tools as readonly string[]).includes(name))) {
    throw new SubagentRequestError("请求的工具超出子 Agent 角色范围", 403);
  }
  return { role, definition, limits: budgetLimits(role, task.budget ?? {}) };
}

/** 父 Agent 提交整份分工后才开始工作。按同一口径命名的事实只能由一个分工交付。 */
export function parseDelegationPlan(raw: Record<string, unknown>) {
  for (const key of Object.keys(raw)) {
    if (!["objective", "reason", "synthesis", "assignments", "purpose"].includes(key)) {
      throw new SubagentRequestError(`未知分工计划字段：${key}`);
    }
  }
  const { objective, reason, synthesis, assignments } = raw;
  if (typeof objective !== "string" || typeof reason !== "string" || typeof synthesis !== "string" ||
      [objective, reason, synthesis].some((text) => !text.trim() || text.length > 2_000)) {
    throw new SubagentRequestError("分工计划需要整体目标、分工理由和汇总方式");
  }
  if (!Array.isArray(assignments) || assignments.length < 2) {
    throw new SubagentRequestError("分工计划至少需要两项可独立执行的任务");
  }
  const tasks = assignments.map(parseTaskContract);
  if (tasks.some((task) => !task.role || !task.plan?.length || !task.acceptance?.length || !task.factKeys?.length)) {
    throw new SubagentRequestError("每项分工需要角色、步骤、验收项和负责的事实键");
  }
  const keys = tasks.flatMap((task) => task.factKeys ?? []);
  if (new Set(keys).size !== keys.length || new Set(tasks.map(({ task }) => task.normalize("NFKC").replace(/\s+/g, "").toLowerCase())).size !== tasks.length) {
    throw new SubagentRequestError("同一主题或事实出现重复分工，请合并后明确唯一负责人", 409);
  }
  const requestKeys = tasks.flatMap(({ idempotencyKey }) => idempotencyKey ? [idempotencyKey] : []);
  if (new Set(requestKeys).size !== requestKeys.length) throw new SubagentRequestError("分工的幂等键必须互不相同", 409);
  return { objective: objective.trim(), reason: reason.trim(), synthesis: synthesis.trim(), tasks };
}

/** 同一分工计划的只读工具调用先登记再执行。相同参数只由第一个子任务执行。 */
export class DelegatedLookups {
  private readonly owners = new Map<string, string>();

  claim(signature: string, taskId: string) {
    const owner = this.owners.get(signature);
    if (owner && owner !== taskId) return false;
    this.owners.set(signature, taskId);
    return true;
  }
}

/** 一轮共享委派截止时间。派出第一项时开始计时，后续委派沿用同一截止时间。 */
export class ParentDelegation {
  readonly lookups = new DelegatedLookups();
  private readonly owners = new Map<string, string>();
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private deadline?: ReturnType<typeof setTimeout>;

  constructor(private readonly timeoutMs = MAX_TASK_TIMEOUT_MS) {}

  get signal() { return this.lifetime.signal; }

  assertOpen() {
    if (this.signal.aborted) throw new SubagentRequestError("父轮已经结束，不能再委派子任务", 409);
  }

  track(finished: Promise<unknown>) {
    this.deadline ??= setTimeout(() => {
      this.lifetime.abort(new DOMException("父轮等待子任务达到时间上限", "TimeoutError"));
    }, this.timeoutMs).unref();
    this.pending.add(finished);
    const remove = () => { this.pending.delete(finished); };
    void finished.then(remove, remove);
  }

  async close() {
    clearTimeout(this.deadline);
    this.lifetime.abort();
    await Promise.allSettled(this.pending);
  }

  validate(records: { id: string; contract: TaskContract }[]) {
    for (const { id, contract } of records) {
      for (const key of contract.factKeys ?? []) {
        const owner = this.owners.get(key);
        if (owner && owner !== id) throw new SubagentRequestError(`事实 ${key} 已分配给本轮的另一子任务`, 409);
      }
    }
  }

  assign(records: { id: string; contract: TaskContract }[]) {
    for (const { id, contract } of records) {
      for (const key of contract.factKeys ?? []) this.owners.set(key, id);
    }
  }
}
