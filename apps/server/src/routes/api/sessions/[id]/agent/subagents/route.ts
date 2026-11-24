import { randomUUID } from "node:crypto";
import type { RouteContext } from "../../../../../../router";
import { currentUser, notFound, unauthorized } from "../../../../../../../../../packages/application/users/src/auth";
import { getSettings } from "../../../../../../../../../packages/application/settings/src/settings";
import { unavailableTools } from "../../../../../../../../../packages/sandbox/src/sandbox";
import { currentOption } from "../../../../../../../../../packages/protocol/src/lib/settings";
import { resolveModelSelection } from "../../../../../../../../../packages/session/src/model-selection";
import { createConversationTrace } from "../../../../../../../../../packages/conversation-trace/src/recorder";
import { workspaceOf } from "../../../../../../../../../packages/tools/src/files";
import { canAccessTasks, getSubagentTask, listRunningDelegations, listSubagentTasks, listSubagentThreads } from "../../../../../../../../../packages/subagent/src/ownership-claim";
import { SubagentRequestError } from "../../../../../../../../../packages/subagent/src/task-contract";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

function requestFailure(error: unknown) {
  if (error instanceof SubagentRequestError) return json({ error: error.message }, error.status);
  throw error;
}

export async function GET(req: Request, { params }: RouteContext) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const owner = { sessionId: (await params).id, userId: user.id };
  if (!canAccessTasks(owner)) return notFound();
  const query = new URL(req.url).searchParams;
  const id = query.get("taskId");
  if (id) {
    const task = getSubagentTask(owner, id);
    return task ? json({ task }) : notFound();
  }
  const runId = query.get("runId");
  if (runId) return json({ tasks: listRunningDelegations(owner, runId) });
  try {
    const before = query.get("before") ?? undefined;
    const threadMode = query.get("threads");
    const tasks = threadMode === "active" || threadMode === "1" ? listSubagentThreads(owner, before, threadMode === "active")
      : listSubagentTasks(owner, before)
      .map(({ messages: _messages, pendingMessages: _pending, ...task }) => task);
    return json({ tasks, nextBefore: tasks.length === 50 ? tasks.at(-1)?.id : undefined });
  } catch (error) {
    return requestFailure(error);
  }
}

/** 独立任务只读当前会话的显式引用。HTTP 返回登记结果后，运行由 Host 持有。 */
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
    const text = "message" in body && typeof body.message === "string" ? body.message.trim() : "";
    if (!text || text.length > 4_000 || Object.keys(body).length !== 1) return json({ error: "请输入 1 至 4000 字的消息" }, 400);
    try { return json({ message: runtime.subagents.sendMessage(owner, taskId, text) }, 202); }
    catch (error) { return requestFailure(error); }
  }
  const retryOf = "retryTaskId" in body ? body.retryTaskId : undefined;
  if (retryOf !== undefined && (typeof retryOf !== "string" || !retryOf.trim() || Object.keys(body).length !== 1)) {
    return json({ error: "重试只接受一个有效的 retryTaskId" }, 400);
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
  const runId = `subagent-run:${randomUUID()}`;
  const inputId = `subagent-input:${randomUUID()}`;
  try {
    const { record, finished } = runtime.subagents.start(body, {
      ...owner, session, disabled, workspace: workspaceOf(user.id), provider: runtime.models(settings),
      contextWindow: currentOption(settings).contextWindow,
      trace: { recorder: createConversationTrace({ sessionId: session.id, runId, inputId, ...selection }), step: 1 },
    }, { runId, inputId, retryOf });
    void finished.catch(() => console.warn("[subagent] 无法保存独立任务终态"));
    return json({ task: record }, 202);
  } catch (error) {
    return requestFailure(error);
  }
}

export async function DELETE(req: Request, { params, runtime }: RouteContext) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const owner = { sessionId: (await params).id, userId: user.id };
  const id = new URL(req.url).searchParams.get("taskId");
  if (!id) return json({ error: "需要 taskId" }, 400);
  if (!getSubagentTask(owner, id)) return notFound();
  runtime.subagents.cancel(owner, id);
  return new Response(null, { status: 204 });
}
