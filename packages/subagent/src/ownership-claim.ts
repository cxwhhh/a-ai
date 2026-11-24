import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { db } from "../../storage/src/db";
import type { StoredMessage } from "../../protocol/src/lib/shared";
import { emptyProgress, type TaskProgress, type TaskStatus } from "./progress-blockers";
import { assessResult, type Evidence, type TaskResult } from "./result-contract";
import { DEFAULT_IDLE_TIMEOUT_MS, type BudgetLimits, type SubagentRole } from "./role-budget";
import { SubagentRequestError, type TaskContract } from "./task-contract";

export interface TaskOwner {
  sessionId: string;
  userId: string;
}

export interface TaskOrigin {
  runId: string;
  inputId: string;
  parentCallId?: string;
  retryOf?: string;
}

export interface TaskRecord extends TaskOrigin {
  id: string;
  sessionId: string;
  role: SubagentRole;
  status: TaskStatus;
  contract: TaskContract;
  limits: BudgetLimits;
  progress: TaskProgress;
  evidence: Evidence[];
  messages?: StoredMessage[];
  pendingMessages?: StoredMessage[];
  result?: TaskResult;
  createdAt: number;
  updatedAt: number;
}

type Row = Record<string, SQLOutputValue>;
type Checkpoint = Pick<TaskRecord, "progress" | "evidence" | "messages" | "pendingMessages">;

const worker = randomUUID();
const owned = "t.session_id = ? AND EXISTS(SELECT 1 FROM sessions s WHERE s.id = t.session_id AND s.user_id = ?)";

export function canAccessTasks(owner: TaskOwner) {
  return !!db().prepare("SELECT 1 FROM sessions WHERE id=? AND user_id=?").get(owner.sessionId, owner.userId);
}

function read(row: Row): TaskRecord {
  const { progress, evidence, messages, pendingMessages } = JSON.parse(String(row.snapshot)) as Checkpoint;
  return {
    id: String(row.id), sessionId: String(row.session_id), runId: String(row.run_id), inputId: String(row.input_id),
    parentCallId: row.parent_call_id ? String(row.parent_call_id) : undefined,
    retryOf: row.retry_of ? String(row.retry_of) : undefined,
    role: row.role as SubagentRole, status: row.status as TaskStatus,
    contract: JSON.parse(String(row.contract)), limits: { idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS, ...JSON.parse(String(row.limits)) },
    progress, evidence, messages, pendingMessages, result: row.result ? JSON.parse(String(row.result)) : undefined,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

/** 当前部署为单个服务进程。重启后上一进程未结算的只读任务标为中断，等待显式重试。 */
export function settleInterrupted(owner: TaskOwner) {
  const records = db().prepare(`SELECT t.* FROM subagent_tasks t WHERE ${owned} AND executor <> ? AND status IN ('queued','running')`)
    .all(owner.sessionId, owner.userId, worker);
  for (const row of records) {
    const task = read(row);
    task.progress.blockers.push({ code: "interrupted", detail: "原执行进程已结束，请检查已保存的进度或显式重试" });
    const result: TaskResult = {
      status: "interrupted", ...assessResult("", task.contract.acceptance ?? [], task.evidence, task.contract.factKeys),
      progress: task.progress, evidence: task.evidence,
    };
    db().prepare(`UPDATE subagent_tasks AS t SET status='interrupted', result=?, snapshot=?, updated_at=?
      WHERE ${owned} AND id=? AND executor=? AND status IN ('queued','running')`).run(
        JSON.stringify(result), JSON.stringify({ progress: task.progress, evidence: task.evidence, messages: task.messages, pendingMessages: task.pendingMessages }),
        Date.now(), owner.sessionId, owner.userId, task.id, row.executor);
  }
}

/** 右侧列表仅查询当前运行中的委派分支，正文按任务详情另读。 */
export function listRunningDelegations(owner: TaskOwner, runId: string) {
  return db().prepare(`SELECT t.* FROM subagent_tasks t WHERE ${owned} AND run_id=? AND parent_call_id IS NOT NULL
    AND executor=? AND status='running' ORDER BY created_at, id`).all(owner.sessionId, owner.userId, runId, worker).map((row) => {
    const { id, contract, createdAt, progress } = read(row);
    const name = contract.name || (contract.purpose || contract.task).split(/[。！？\n]/, 1)[0].trim().slice(0, 24) || "子任务";
    return { id, name, createdAt, tokens: progress.inputTokens + progress.outputTokens, estimated: progress.estimated };
  });
}

export type RunningDelegation = ReturnType<typeof listRunningDelegations>[number];

/** 线程列表只读每条分支最近的尝试。重新尝试前的对话仍归属于该分支。 */
export function listSubagentThreads(owner: TaskOwner, before?: string, currentOnly = false) {
  settleInterrupted(owner);
  const cursor = before ? lookup(owner, before) : undefined;
  if (before && !cursor) throw new SubagentRequestError("任务分页游标不存在", 404);
  const rows = db().prepare(`SELECT t.id, t.status, t.role, t.contract, t.created_at, t.updated_at,
    json_extract(t.snapshot, '$.progress') AS progress
    FROM subagent_tasks t WHERE ${owned}
      AND NOT EXISTS (SELECT 1 FROM subagent_tasks next WHERE next.session_id=t.session_id AND next.retry_of=t.id)
      ${currentOnly ? "AND t.status IN ('queued','running')" : ""}
      ${cursor ? "AND (t.created_at, t.id) < (?, ?)" : ""}
    ORDER BY t.created_at DESC, t.id DESC LIMIT 50`)
    .all(owner.sessionId, owner.userId, ...(cursor ? [cursor.createdAt, cursor.id] : []));
  const attempts = currentOnly ? undefined : threadAttempts(owner.sessionId, rows.map(({ id }) => String(id)));
  const now = Date.now();
  return rows.map((row) => {
    const { task, name, purpose } = JSON.parse(String(row.contract)) as TaskContract;
    const progress = JSON.parse(String(row.progress)) as TaskProgress;
    return {
      id: String(row.id), name: name || (purpose || task).split(/[。！？\n]/, 1)[0].trim().slice(0, 24) || "子任务",
      role: row.role as SubagentRole,
      status: row.status as TaskStatus, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      tokens: progress.inputTokens + progress.outputTokens, estimated: progress.estimated,
      metrics: attempts && summarizeAttempts(attempts.get(String(row.id)) ?? [], now),
    };
  });
}

export type SubagentThread = ReturnType<typeof listSubagentThreads>[number];

/** 重试仍属于同一线程。按本页的最新尝试回溯，跨会话的旧记录不会参与统计。 */
function threadAttempts(sessionId: string, ids: string[]) {
  const groups = new Map<string, Row[]>();
  if (!ids.length) return groups;
  const rows = db().prepare(`WITH RECURSIVE history(thread, attempt) AS (
    SELECT value, value FROM json_each(?)
    UNION
    SELECT history.thread, t.retry_of FROM history
      JOIN subagent_tasks t ON t.id=history.attempt AND t.session_id=? WHERE t.retry_of IS NOT NULL
  )
  SELECT history.thread, t.id, t.status, t.created_at, t.updated_at, t.snapshot FROM history
    JOIN subagent_tasks t ON t.id=history.attempt AND t.session_id=?`)
    .all(JSON.stringify(ids), sessionId, sessionId);
  for (const row of rows) {
    const thread = String(row.thread);
    const group = groups.get(thread);
    if (group) group.push(row);
    else groups.set(thread, [row]);
  }
  return groups;
}

function summarizeAttempts(attempts: Row[], now: number) {
  const starters = new Set(attempts.map(({ id }) => String(id)));
  const userMessages = new Set<string>();
  const replies = new Set<string>();
  let modelCalls = 0;
  let toolCalls = 0;
  let durationMs = 0;
  let tokens = 0;
  let estimated = false;
  let hasDialogue = false;
  for (const attempt of attempts) {
    const { progress, messages, pendingMessages } = JSON.parse(String(attempt.snapshot)) as Checkpoint;
    const running = attempt.status === "running" || attempt.status === "queued";
    durationMs += Math.max(0, (running ? now : Number(attempt.updated_at)) - Number(attempt.created_at));
    modelCalls += progress.steps;
    toolCalls += progress.toolCalls;
    tokens += progress.inputTokens + progress.outputTokens;
    estimated ||= progress.estimated;
    hasDialogue ||= !!messages;
    // 恢复会复制已保存的对话。按消息 ID 去重，排除任务描述和系统生成的“恢复任务”消息。
    for (const message of [...(messages ?? []), ...(pendingMessages ?? [])]) {
      if (message.role === "user" && !starters.has(message.id)) userMessages.add(message.id);
      else if (message.role === "assistant" && message.content.trim()) replies.add(message.id);
    }
  }
  return {
    attempts: attempts.length, modelCalls, toolCalls, durationMs, tokens, estimated,
    dialogue: hasDialogue ? { user: userMessages.size, agent: replies.size } : undefined,
  };
}

export function getSubagentTask(owner: TaskOwner, id: string) {
  settleInterrupted(owner);
  return lookup(owner, id);
}

function lookup(owner: TaskOwner, id: string) {
  const row = db().prepare(`SELECT t.* FROM subagent_tasks t WHERE ${owned} AND id=?`).get(owner.sessionId, owner.userId, id);
  return row && read(row);
}

export function listSubagentTasks(owner: TaskOwner, before?: string) {
  settleInterrupted(owner);
  const cursor = before ? lookup(owner, before) : undefined;
  if (before && !cursor) throw new SubagentRequestError("任务分页游标不存在", 404);
  const rows = db().prepare(`SELECT t.* FROM subagent_tasks t WHERE ${owned}
    ${cursor ? "AND (created_at, id) < (?, ?)" : ""} ORDER BY created_at DESC, id DESC LIMIT 50`)
    .all(owner.sessionId, owner.userId, ...(cursor ? [cursor.createdAt, cursor.id] : []));
  return rows.map(read);
}

/** 同一会话/去重键只登记一次。已有键的合法性由权限和契约快照共同决定。 */
export function registerTask(owner: TaskOwner, origin: TaskOrigin, contract: TaskContract,
  role: SubagentRole, limits: BudgetLimits, key: string, fingerprint: string) {
  const id = randomUUID();
  const at = Date.now();
  const inserted = db().prepare(`INSERT INTO subagent_tasks (
    id, session_id, run_id, input_id, parent_call_id, retry_of, dedupe_key, fingerprint, executor,
    role, status, contract, limits, snapshot, created_at, updated_at)
    SELECT ?, s.id, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ? FROM sessions s WHERE s.id=? AND s.user_id=?
    ON CONFLICT(session_id, dedupe_key) DO NOTHING RETURNING *`).get(
    id, origin.runId, origin.inputId, origin.parentCallId ?? null, origin.retryOf ?? null, key,
    fingerprint, worker, role, JSON.stringify(contract), JSON.stringify(limits),
    JSON.stringify({ progress: emptyProgress(), evidence: [] }), at, at, owner.sessionId, owner.userId);
  if (inserted) return { record: read(inserted), created: true };
  const row = db().prepare(`SELECT t.* FROM subagent_tasks t WHERE ${owned} AND dedupe_key=?`).get(owner.sessionId, owner.userId, key);
  if (!row) throw new SubagentRequestError("会话不存在", 404);
  if (row.fingerprint !== fingerprint) throw new SubagentRequestError("该去重键已用于不同的子任务、上下文或权限范围", 409);
  return { record: read(row), created: false };
}

export function checkpointTask(owner: TaskOwner, id: string, snapshot: Checkpoint) {
  return !!db().prepare(`UPDATE subagent_tasks AS t SET snapshot=?, updated_at=?
    WHERE ${owned} AND id=? AND executor=? AND status='running'`).run(
      JSON.stringify(snapshot), Date.now(), owner.sessionId, owner.userId, id, worker).changes;
}

/** 比较状态再结算，迟到的进度或重复取消无法覆盖已经提交的结果。 */
export function settleTask(owner: TaskOwner, id: string, result: TaskResult, messages?: StoredMessage[]) {
  return !!db().prepare(`UPDATE subagent_tasks AS t SET status=?, snapshot=?, result=?, updated_at=?
    WHERE ${owned} AND id=? AND executor=? AND status IN ('queued','running')`).run(
    result.status, JSON.stringify({ progress: result.progress, evidence: result.evidence, messages }), JSON.stringify(result),
      Date.now(), owner.sessionId, owner.userId, id, worker).changes;
}
