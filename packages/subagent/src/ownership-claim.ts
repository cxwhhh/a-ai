import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { db } from "../../storage/src/db";
import type { StoredMessage } from "../../protocol/src/lib/shared";
import type { ApprovalNotice } from "../../permissions/src/approvals";
import { emptyProgress, type TaskProgress, type TaskStatus } from "./progress-blockers";
import { assessResult, readReviewConcern, savedToolExcerpts, type Evidence, type TaskResult, type TaskVerification } from "./result-contract";
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

interface TaskAssignment {
  /** 批内标识与整体目标供线程回读。子 Agent 仍只接收自己的执行契约。 */
  key?: string;
  objective?: string;
  mode?: "retry" | "followup" | "revision";
  recoveryInputId?: string;
  tools?: string[];
  revisionPath?: string;
}

export interface TaskRecord extends TaskOrigin {
  id: string;
  sessionId: string;
  role: SubagentRole;
  status: TaskStatus;
  /** 对话可继续时为 true，执行结果仍由 status 单独记录。 */
  chatActive: boolean;
  contract: TaskContract;
  assignment?: TaskAssignment;
  /** 保存同会话内的直接上游 ID，续跑时沿原分工查找已验收的尝试。 */
  dependencyIds?: string[];
  limits: BudgetLimits;
  progress: TaskProgress;
  evidence: Evidence[];
  messages?: StoredMessage[];
  pendingMessages?: StoredMessage[];
  /** 活跃执行器内的待审批请求。中断后重新发起审批。 */
  pendingApproval?: ApprovalNotice;
  unansweredMessages?: StoredMessage[];
  interruptedFrom?: "queued" | "running";
  writeAttempts?: string[];
  revisionVerification?: { path?: string; status: "matches-expected" | "matches-before" | "changed" | "unreadable" | "not-started" | "unknown" };
  result?: TaskResult;
  createdAt: number;
  updatedAt: number;
}

type Row = Record<string, SQLOutputValue>;
export type TaskFileWrite = { path: string; beforeHash: string | null; expectedHash: string };
type TaskWrites = { fileWrite?: TaskFileWrite; fileWrites?: TaskFileWrite[]; writtenPaths?: string[]; verification?: TaskVerification[] };
type Checkpoint = Pick<TaskRecord, "progress" | "evidence" | "messages" | "pendingMessages" | "unansweredMessages" | "interruptedFrom"> & {
  /** 只记完整结束的候选，半截流和待执行调用没有候选资格。 */
  candidate?: string;
  carried?: Pick<TaskResult, "facts" | "acceptance">;
  references?: [string, string][];
} & TaskWrites;

const worker = randomUUID();
const owned = "t.session_id = ? AND EXISTS(SELECT 1 FROM sessions s WHERE s.id = t.session_id AND s.user_id = ?)";

export function canAccessTasks(owner: TaskOwner) {
  return !!db().prepare("SELECT 1 FROM sessions WHERE id=? AND user_id=?").get(owner.sessionId, owner.userId);
}

function chatActive(row: Row) {
  return row.chat_active == null ? row.status !== "cancelled" && row.status !== "interrupted" : row.chat_active === 1;
}

function read(row: Row): TaskRecord {
  const { progress, evidence, messages, pendingMessages, unansweredMessages, interruptedFrom, fileWrites } = JSON.parse(String(row.snapshot)) as Checkpoint;
  const { dependencyIds, assignment, ...contract } = JSON.parse(String(row.contract)) as TaskContract & {
    dependencyIds?: string[]; assignment?: TaskAssignment;
  };
  return {
    id: String(row.id), sessionId: String(row.session_id), runId: String(row.run_id), inputId: String(row.input_id),
    parentCallId: row.parent_call_id ? String(row.parent_call_id) : undefined,
    retryOf: row.retry_of ? String(row.retry_of) : undefined,
    role: row.role as SubagentRole, status: row.status as TaskStatus,
    chatActive: chatActive(row),
    contract, assignment, dependencyIds, limits: { idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS, ...JSON.parse(String(row.limits)) },
    progress, evidence, messages, pendingMessages, interruptedFrom, writeAttempts: fileWrites?.map(({ path }) => path),
    unansweredMessages: interruptedFrom ? unansweredMessages : undefined, result: row.result ? JSON.parse(String(row.result)) : undefined,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

/** 当前部署为单个服务进程。保留上一进程退出前的阶段和可验收内容。 */
export function settleInterrupted(owner: TaskOwner) {
  const records = db().prepare(`SELECT t.* FROM subagent_tasks t WHERE ${owned} AND executor <> ? AND status IN ('queued','running')`)
    .all(owner.sessionId, owner.userId, worker);
  for (const row of records) {
    const task = read(row);
    const snapshot = JSON.parse(String(row.snapshot)) as Checkpoint;
    const revision = isFileRevision(task);
    const detail = revision ? "文件微调已中断。请打开当前文件核对实际内容，再发送新的修改要求。"
      : task.status === "queued" ? "原执行进程在等待上游期间结束，子任务尚未启动" : "原执行进程已结束，可从已保存的证据恢复任务";
    snapshot.progress.blockers.push({ code: "interrupted", detail });
    snapshot.interruptedFrom = task.status === "queued" ? "queued" : "running";
    const evidence = snapshot.evidence;
    const excerpts = savedToolExcerpts(snapshot.messages);
    // 最新任务的引用节选保存在检查点，工具正文也能从已配对的回执找回。
    for (const [id, excerpt] of snapshot.references ?? []) excerpts.set(id, excerpt);
    const assessed = assessResult(snapshot.candidate ?? "", task.contract.acceptance ?? [], evidence, task.contract.factKeys, excerpts, snapshot.carried);
    if (snapshot.candidate && readReviewConcern(snapshot.candidate, excerpts)) assessed.unresolved.push("候选结果的证据歧义仍需复核");
    const result: TaskResult = { status: "interrupted", ...assessed, progress: snapshot.progress, evidence,
      writtenPaths: snapshot.writtenPaths, verification: snapshot.verification };
    db().prepare(`UPDATE subagent_tasks AS t SET status='interrupted', result=?, snapshot=?, updated_at=?
      WHERE ${owned} AND id=? AND executor=? AND status IN ('queued','running')`).run(
        JSON.stringify(result), JSON.stringify(snapshot),
        Date.now(), owner.sessionId, owner.userId, task.id, row.executor);
  }
}

/** 旧记录没有执行模式，存在写调用时仍按可能已写入处理。 */
export function isFileRevision(task: TaskRecord) {
  return task.assignment?.mode === "revision" || (!task.assignment?.mode &&
    !!task.messages?.some(({ toolCalls }) => toolCalls?.some(({ name }) => name === "edit_file")));
}

/** 同一线程的后续聊天可改变目标，上游引用只跟随原契约的重试。 */
export function latestTaskRetry(owner: TaskOwner, task: TaskRecord): TaskRecord {
  let latest = task;
  const next = db().prepare(`SELECT t.* FROM subagent_tasks t WHERE ${owned} AND retry_of=?`);
  for (let row = next.get(owner.sessionId, owner.userId, latest.id); row; row = next.get(owner.sessionId, owner.userId, latest.id)) {
    const attempt = read(row);
    // 未保存执行模式的旧记录用后续用户消息的 ID 区分续聊与重试。缺少历史时保留原分工。
    const legacyRetry = !attempt.assignment && attempt.contract.task === latest.contract.task &&
      attempt.messages?.length && !attempt.messages.some(({ id }) => id === `${attempt.id}:followup`);
    if (attempt.assignment?.mode !== "retry" && !legacyRetry) break;
    latest = attempt;
  }
  return latest;
}

/** 父轮恢复只读取当前历史链上由服务端识别为中断的输入。连着中断时仍可追溯原分工。 */
export function listRecoverableDelegations(owner: TaskOwner, inputId: string) {
  settleInterrupted(owner);
  const rows = db().prepare(`SELECT t.* FROM subagent_tasks t WHERE ${owned} AND input_id=? AND parent_call_id IS NOT NULL
    ORDER BY created_at, id`);
  const previous = rows.all(owner.sessionId, owner.userId, inputId).map(read);
  const originalInputs = new Set(previous.flatMap(({ assignment }) => assignment?.recoveryInputId ? [assignment.recoveryInputId] : []));
  const candidates = [...previous, ...[...originalInputs].flatMap((id) => rows.all(owner.sessionId, owner.userId, id).map(read))];
  const originals = new Map(candidates.filter(({ assignment }) => !assignment?.recoveryInputId).map((task) => [task.id, task]));
  const chatState = db().prepare(`SELECT chat_active FROM subagent_tasks t WHERE ${owned} AND id=?`);
  return [...originals.values()].map((task) => {
    const latest = latestTaskRetry(owner, task);
    return { task, latest, paused: chatState.get(owner.sessionId, owner.userId, latest.id)?.chat_active === 0 };
  });
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
  const rows = db().prepare(`SELECT t.id, t.status, t.chat_active, t.role, t.contract, t.created_at, t.updated_at,
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
    const contract = JSON.parse(String(row.contract)) as TaskContract;
    const progress = JSON.parse(String(row.progress)) as TaskProgress;
    return {
      id: String(row.id), name: subagentName(contract),
      role: row.role as SubagentRole,
      status: row.status as TaskStatus, chatActive: chatActive(row), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      tokens: progress.inputTokens + progress.outputTokens, estimated: progress.estimated,
      metrics: attempts && summarizeAttempts(attempts.get(String(row.id)) ?? [], now),
    };
  });
}

export type SubagentThread = ReturnType<typeof listSubagentThreads>[number];

export function subagentName({ name, purpose, task }: TaskContract) {
  return name || (purpose || task).split(/[。！？\n]/, 1)[0].trim().slice(0, 24) || "子任务";
}

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
    // 后续轮次复用历史，按消息 ID 去重，排除初始任务描述和旧版的恢复占位消息。
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

export function getInterruptedWrite(owner: TaskOwner, id: string) {
  const row = db().prepare(`SELECT snapshot FROM subagent_tasks t WHERE ${owned} AND id=? AND status IN ('interrupted','cancelled','timed-out')`)
    .get(owner.sessionId, owner.userId, id);
  return row ? (JSON.parse(String(row.snapshot)) as Checkpoint).fileWrite : undefined;
}

/** 暂停和恢复仅切换最新尝试的对话状态，保持历史执行结果、时间和预算。 */
export function setSubagentChatActive(owner: TaskOwner, id: string, active: boolean) {
  const row = db().prepare(`UPDATE subagent_tasks AS t SET chat_active=? WHERE ${owned} AND id=?
    AND NOT EXISTS (SELECT 1 FROM subagent_tasks next WHERE next.session_id=t.session_id AND next.retry_of=t.id)
    RETURNING *`).get(Number(active), owner.sessionId, owner.userId, id);
  return row && read(row);
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
  role: SubagentRole, limits: BudgetLimits, key: string, fingerprint: string,
  dependencies?: { ids: string[]; queued: boolean }, assignment?: TaskAssignment) {
  const id = randomUUID();
  const at = Date.now();
  const inserted = db().prepare(`INSERT INTO subagent_tasks (
    id, session_id, run_id, input_id, parent_call_id, retry_of, dedupe_key, fingerprint, executor,
    role, status, contract, limits, snapshot, created_at, updated_at)
    SELECT ?, s.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM sessions s WHERE s.id=? AND s.user_id=?
    ON CONFLICT(session_id, dedupe_key) DO NOTHING RETURNING *`).get(
    id, origin.runId, origin.inputId, origin.parentCallId ?? null, origin.retryOf ?? null, key,
    fingerprint, worker, role, dependencies?.queued ? "queued" : "running",
    JSON.stringify({ ...contract, dependencyIds: dependencies?.ids, assignment }), JSON.stringify(limits),
    JSON.stringify({ progress: emptyProgress(), evidence: [] }), at, at, owner.sessionId, owner.userId);
  if (inserted) return { record: read(inserted), created: true };
  const row = db().prepare(`SELECT t.* FROM subagent_tasks t WHERE ${owned} AND dedupe_key=?`).get(owner.sessionId, owner.userId, key);
  if (!row) throw new SubagentRequestError("会话不存在", 404);
  if (row.fingerprint !== fingerprint) throw new SubagentRequestError("该去重键已用于不同的子任务、上下文或权限范围", 409);
  return { record: read(row), created: false };
}

/** 只有当前执行器可以领取仍在等待的任务。取消或结算后，迟到的上游无法重新启动它。 */
export function startQueuedTask(owner: TaskOwner, id: string) {
  const row = db().prepare(`UPDATE subagent_tasks AS t SET status='running', updated_at=?
    WHERE ${owned} AND id=? AND executor=? AND status='queued' RETURNING *`)
    .get(Date.now(), owner.sessionId, owner.userId, id, worker);
  return row && read(row);
}

export function checkpointTask(owner: TaskOwner, id: string, snapshot: Checkpoint) {
  return !!db().prepare(`UPDATE subagent_tasks AS t SET snapshot=?, updated_at=?
    WHERE ${owned} AND id=? AND executor=? AND status='running'`).run(
      JSON.stringify(snapshot), Date.now(), owner.sessionId, owner.userId, id, worker).changes;
}

/** 比较状态再结算，迟到的进度或重复取消无法覆盖已经提交的结果。 */
export function settleTask(owner: TaskOwner, id: string, result: TaskResult, messages?: StoredMessage[], writes?: TaskWrites) {
  return !!db().prepare(`UPDATE subagent_tasks AS t SET status=?, snapshot=?, result=?, updated_at=?
    WHERE ${owned} AND id=? AND executor=? AND status IN ('queued','running')`).run(
    result.status, JSON.stringify({ progress: result.progress, evidence: result.evidence, messages, ...writes }), JSON.stringify(result),
      Date.now(), owner.sessionId, owner.userId, id, worker).changes;
}
