import type { TaskContract } from "./task-contract";
import { parseTaskContract, SubagentRequestError } from "./task-contract";
import { MAX_TASK_TIMEOUT_MS, ROLES, budgetLimits } from "./role-budget";

/** 只接受顶层委派。默认沿用调研角色，声明的角色和额度由执行层最终裁决。 */
export function admitDelegation(task: TaskContract, disabled: Record<string, string>, contextWindow: number, depth = 0) {
  if (disabled.research) throw new SubagentRequestError("当前运行已禁用子 Agent", 403);
  if (depth !== 0) throw new SubagentRequestError("子 Agent 无权再次委派", 403);
  const role = task.role ?? "research";
  const definition = ROLES[role];
  if (task.tools?.some((name) => !(definition.tools as readonly string[]).includes(name))) {
    throw new SubagentRequestError("请求的工具超出子 Agent 角色范围", 403);
  }
  return { role, definition, limits: budgetLimits(role, task.budget ?? {}, contextWindow) };
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
  if (!Array.isArray(assignments) || !assignments.length) {
    throw new SubagentRequestError("分工计划需要至少一个任务");
  }
  const entries = assignments.map((assignment: unknown) => {
    if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)) {
      throw new SubagentRequestError("子任务参数必须是对象");
    }
    const { taskKey, dependsOn, ...contract } = assignment as Record<string, unknown>;
    if (taskKey !== undefined && !validTaskKey(taskKey)) throw new SubagentRequestError("taskKey 必须是 1 至 64 位字母、数字、下划线或短横线");
    if (dependsOn !== undefined && (!Array.isArray(dependsOn) || dependsOn.length > 8 ||
        !dependsOn.every(validTaskKey) || new Set(dependsOn).size !== dependsOn.length)) {
      throw new SubagentRequestError("dependsOn 最多包含 8 个互不重复的有效 taskKey");
    }
    return { taskKey, dependsOn: (dependsOn ?? []) as string[], contract: parseTaskContract(contract) };
  });
  const tasks = entries.map(({ contract }) => contract);
  if (tasks.length === 1 && tasks[0].role !== "implementation") throw new SubagentRequestError("单项只读调研请用 research");
  if (tasks.some((task) => !task.role || !task.plan?.length || !task.acceptance?.length || (task.role !== "implementation" && !task.factKeys?.length))) {
    throw new SubagentRequestError("每项分工需要角色、步骤、验收项和负责的事实键");
  }
  const keys = tasks.flatMap((task) => task.factKeys ?? []);
  if (new Set(keys).size !== keys.length || new Set(tasks.map(({ task }) => task.normalize("NFKC").replace(/\s+/g, "").toLowerCase())).size !== tasks.length) {
    throw new SubagentRequestError("同一主题或事实出现重复分工，请合并后明确唯一负责人", 409);
  }
  const requestKeys = tasks.flatMap(({ idempotencyKey }) => idempotencyKey ? [idempotencyKey] : []);
  if (new Set(requestKeys).size !== requestKeys.length) throw new SubagentRequestError("分工的幂等键必须互不相同", 409);
  const byKey = new Map<string, number>();
  entries.forEach(({ taskKey }, index) => {
    if (taskKey === undefined) return;
    if (byKey.has(taskKey)) throw new SubagentRequestError(`分工标识 ${taskKey} 重复`);
    byKey.set(taskKey, index);
  });
  const downstream: number[][] = entries.map(() => []);
  const dependencies = entries.map(({ taskKey, dependsOn }, index) => dependsOn.map((key) => {
    const upstream = byKey.get(key);
    if (upstream === undefined) throw new SubagentRequestError(`dependsOn 引用了不存在的分工 ${key}`);
    if (upstream === index) throw new SubagentRequestError(`分工 ${taskKey} 不能依赖自身`);
    downstream[upstream].push(index);
    return upstream;
  }));
  // 从没有上游的任务开始编号。无法排入的分工形成了循环或依赖该循环，整批登记前即退回。
  const outstanding = dependencies.map((items) => items.length);
  const order = entries.flatMap((_, index) => outstanding[index] === 0 ? [index] : []);
  for (let i = 0; i < order.length; i++) {
    for (const next of downstream[order[i]]) {
      if (--outstanding[next] === 0) order.push(next);
    }
  }
  if (order.length !== tasks.length) throw new SubagentRequestError("分工存在循环依赖，请检查 taskKey 和 dependsOn");
  return { objective: objective.trim(), reason: reason.trim(), synthesis: synthesis.trim(), tasks,
    taskKeys: entries.map(({ taskKey }) => taskKey as string | undefined), dependencies, order };
}

function validTaskKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

/** 同一父轮的只读调用先认领再执行。去重键由执行层按工具、参数和事实归属决定。 */
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
    const owners = new Map(this.owners);
    for (const { id, contract } of records) {
      for (const key of contract.factKeys ?? []) {
        const owner = owners.get(key);
        if (owner && owner !== id) throw new SubagentRequestError(`事实 ${key} 已分配给本轮的另一子任务`, 409);
        owners.set(key, id);
      }
    }
  }

  assign(records: { id: string; contract: TaskContract }[]) {
    for (const { id, contract } of records) {
      for (const key of contract.factKeys ?? []) this.owners.set(key, id);
    }
  }
}
