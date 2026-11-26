import { randomUUID } from "node:crypto";
import type { RouteContext } from "../../../../../../router";
import { currentUser, notFound, unauthorized } from "../../../../../../../../../packages/application/users/src/auth";
import { getSettings } from "../../../../../../../../../packages/application/settings/src/settings";
import { getProject } from "../../../../../../../../../packages/application/projects/src/projects";
import { readProjectRules } from "../../../../../../../../../packages/application/projects/src/rules";
import { unavailableTools } from "../../../../../../../../../packages/sandbox/src/sandbox";
import { currentOption } from "../../../../../../../../../packages/protocol/src/lib/settings";
import { resolveModelSelection } from "../../../../../../../../../packages/session/src/model-selection";
import { createConversationTrace } from "../../../../../../../../../packages/conversation-trace/src/recorder";
import { workspaceOf } from "../../../../../../../../../packages/tools/src/files";
import { openSessionWorkspace } from "../../../../../../../../../packages/workspace/src/session-workspace";
import { resolvePath } from "../../../../../../../../../packages/workspace/src/access";
import { readFileHash } from "../../../../../../../../../packages/workspace/src/file-fingerprint";
import { canAccessTasks, getInterruptedWrite, getSubagentTask, isFileRevision, listRunningDelegations, listSubagentTasks,
  listSubagentThreads, setSubagentChatActive, type TaskOwner, type TaskRecord } from "../../../../../../../../../packages/subagent/src/ownership-claim";
import { SubagentRequestError } from "../../../../../../../../../packages/subagent/src/task-contract";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

function requestFailure(error: unknown) {
  if (error instanceof SubagentRequestError) return json({ error: error.message }, error.status);
  throw error;
}

/** 详情查询按当前字节核验最近一次写入，不提交修改或改变中断终态。 */
async function verifyRevision(owner: TaskOwner, task: TaskRecord, signal: AbortSignal): Promise<TaskRecord["revisionVerification"]> {
  if (!["interrupted", "cancelled", "timed-out"].includes(task.status) || !isFileRevision(task)) return;
  const write = getInterruptedWrite(owner, task.id);
  if (!write) return { path: task.assignment?.revisionPath, status: task.assignment?.mode === "revision" ? "not-started" : "unknown" };
  const path = write.path;
  try {
    const scope = openSessionWorkspace(owner.userId, owner.sessionId);
    if (!scope) return { path, status: "unreadable" };
    const file = resolvePath(scope.workspace, path, "read");
    if (!file.inWorkspace || file.shown !== path) return { path, status: "unreadable" };
    const hash = await readFileHash(file.full, signal);
    return { path, status: hash === write.expectedHash ? "matches-expected" : hash === write.beforeHash ? "matches-before" : "changed" };
  } catch { return { path, status: "unreadable" }; }
}

export async function GET(req: Request, { params, runtime }: RouteContext) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const owner = { sessionId: (await params).id, userId: user.id };
  if (!canAccessTasks(owner)) return notFound();
  const query = new URL(req.url).searchParams;
  const id = query.get("taskId");
  if (id) {
    const task = getSubagentTask(owner, id);
    if (!task) return notFound();
    return json({ task: { ...task, pendingApproval: runtime?.subagents?.pendingApproval(owner, id),
      revisionVerification: await verifyRevision(owner, task, req.signal) } });
  }
  const runId = query.get("runId");
  if (runId) return json({ tasks: listRunningDelegations(owner, runId) });
  try {
    const before = query.get("before") ?? undefined;
    const threadMode = query.get("threads");
    const tasks = threadMode === "active" || threadMode === "1" ? listSubagentThreads(owner, before, threadMode === "active")
      : listSubagentTasks(owner, before)
      .map(({ messages: _messages, pendingMessages: _pending, unansweredMessages: _unanswered, ...task }) =>
        ({ ...task, pendingApproval: runtime?.subagents?.pendingApproval(owner, task.id) }));
    return json({ tasks, nextBefore: tasks.length === 50 ? tasks.at(-1)?.id : undefined });
  } catch (error) {
    return requestFailure(error);
  }
}

/** Host 持有独立任务。用户从子线程提交后续消息时，可以指定一个已引用的文件。 */
export async function POST(req: Request, { params, runtime }: RouteContext) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const owner = { sessionId: (await params).id, userId: user.id };
  if (!canAccessTasks(owner)) return notFound();
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "子任务参数必须是对象" }, 400);
  const taskId = new URL(req.url).searchParams.get("taskId");
  if (taskId) {
    const task = getSubagentTask(owner, taskId);
    if (!task) return notFound();
    if (runtime.agentSessions.isArchived(owner.sessionId, owner.userId)) return json({ error: "对话或项目已归档" }, 409);
    if (!task.chatActive) return json({ error: "子 Agent 对话已暂停，请先恢复对话" }, 409);
    const text = "message" in body && typeof body.message === "string" ? body.message.trim() : "";
    if (!text || text.length > 4_000 || Object.keys(body).length !== 1) return json({ error: "请输入 1 至 4000 字的消息" }, 400);
    try { return json({ message: runtime.subagents.sendMessage(owner, taskId, text) }, 202); }
    catch (error) { return requestFailure(error); }
  }
  const retryOf = "retryTaskId" in body ? body.retryTaskId : undefined;
  if (retryOf !== undefined && (typeof retryOf !== "string" || !retryOf.trim() || Object.keys(body).length !== 1)) {
    return json({ error: "重试只接受一个有效的 retryTaskId" }, 400);
  }
  const continuation = "continueTaskId" in body ? body.continueTaskId : undefined;
  const message = "message" in body && typeof body.message === "string" ? body.message.trim() : "";
  const file = "path" in body ? body.path : undefined;
  if (continuation !== undefined && (typeof continuation !== "string" || !continuation.trim() || !message || message.length > 4_000 ||
    (file !== undefined && (typeof file !== "string" || !file.trim() || file.length > 500)) ||
    Object.keys(body).some((key) => !["continueTaskId", "message", "path"].includes(key)))) {
    return json({ error: "请输入 1 至 4000 字的子线程消息，并选择有效文件" }, 400);
  }
  const disabled = await unavailableTools();
  const session = runtime.agentSessions.get(owner.sessionId, owner.userId);
  if (!session) return notFound();
  if (runtime.agentSessions.isArchived(owner.sessionId, owner.userId)) return json({ error: "对话或项目已归档，请先恢复" }, 409);
  if (!session.projectId && !session.multiAgent) return json({ error: "请先开启多agent智能体模式" }, 409);
  const defaults = getSettings(user.id);
  let selection;
  try { selection = resolveModelSelection(session.id, user.id, defaults); }
  catch (error) { return json({ error: error instanceof Error ? error.message : "模型选择不可用" }, 409); }
  const settings = { ...defaults, currentModel: selection.model, reasoningEffort: selection.effort };
  const scope = openSessionWorkspace(user.id, session.id);
  if (!scope) return Response.json({ error: "会话不存在" }, { status: 404 });
  const { workspace } = scope;
  let projectRules: string;
  try { projectRules = await readProjectRules(workspaceOf(user.id), getProject(session.projectId, user.id)?.rulesFile); }
  catch (error) { return json({ error: error instanceof Error ? error.message : "项目规则不可用" }, 409); }
  const runId = `subagent-run:${randomUUID()}`;
  const inputId = `subagent-input:${randomUUID()}`;
  try {
    const context = {
      ...owner, session, disabled, workspace, projectRules, provider: runtime.models(settings),
      commandApproval: settings.commandApproval,
      contextWindow: currentOption(settings).contextWindow,
      trace: { recorder: createConversationTrace({ sessionId: session.id, runId, inputId, ...selection }), step: 1 },
    };
    const { record, finished } = typeof continuation === "string"
      ? runtime.subagents.continueTask(message, typeof file === "string" ? file : undefined, context, { runId, inputId, retryOf: continuation })
      : runtime.subagents.start(body, context, { runId, inputId, retryOf });
    void finished.catch(() => console.warn("[subagent] 无法保存独立任务终态"));
    return json({ task: record }, 202);
  } catch (error) {
    return requestFailure(error);
  }
}

/** 恢复的是子线程的对话状态，模型收到实际消息后再运行。 */
export async function PATCH(req: Request, { params, runtime }: RouteContext) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const owner = { sessionId: (await params).id, userId: user.id };
  const id = new URL(req.url).searchParams.get("taskId");
  if (!id) return json({ error: "需要 taskId" }, 400);
  if (!getSubagentTask(owner, id)) return notFound();
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || !("active" in body) || body.active !== true || Object.keys(body).length !== 1) {
    return json({ error: "恢复子 Agent 对话需要 active=true" }, 400);
  }
  const session = runtime.agentSessions.get(owner.sessionId, owner.userId);
  if (!session) return notFound();
  if (runtime.agentSessions.isArchived(owner.sessionId, owner.userId)) return json({ error: "对话或项目已归档，请先恢复" }, 409);
  if (!session.projectId && !session.multiAgent) return json({ error: "请先开启多agent智能体模式" }, 409);
  const task = setSubagentChatActive(owner, id, true);
  return task ? json({ task }) : json({ error: "子 Agent 已开始新的轮次，请重新打开线程" }, 409);
}

export async function DELETE(req: Request, { params, runtime }: RouteContext) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const owner = { sessionId: (await params).id, userId: user.id };
  const id = new URL(req.url).searchParams.get("taskId");
  if (!id) return json({ error: "需要 taskId" }, 400);
  if (!getSubagentTask(owner, id)) return notFound();
  if (!setSubagentChatActive(owner, id, false)) return json({ error: "子 Agent 已开始新的轮次，请重新打开线程" }, 409);
  runtime.subagents.cancel(owner, id);
  return new Response(null, { status: 204 });
}
