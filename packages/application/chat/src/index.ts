import type { Scheduler } from "../../../scheduler/src/index";
import type { SubagentOrchestrator } from "../../../subagent/src/subagent";
import { runAgent } from "../../../agent-loop/src/run";
import { createConversationTrace } from "../../../conversation-trace/src/recorder";
import { HistoryConflict, type AgentSessionService } from "../../../session/src/agent-session";
import { getSettings } from "../../settings/src/settings";
import { workspaceOf } from "../../../tools/src/files";
import { openSessionWorkspace } from "../../../workspace/src/session-workspace";
import { reflect } from "../../../memory/src/reflect";
import { getMemory, memoryPrompt, saveMemory } from "../../../memory/src/memory";
import { getProject, getProjectMemory, projectPrompt, saveProjectMemory } from "../../projects/src/projects";
import { readProjectRules } from "../../projects/src/rules";
import { learnSkills } from "../../../skills/src/learn";
import { activeSkills, skillsPrompt } from "../../../skills/src/skills";
import { sandboxInfo, sandboxPrompt, unavailableTools } from "../../../sandbox/src/sandbox";
import type { StorageManager } from "../../../storage-manager/src/index";
import { AgentUnavailable, type AgentRegistry } from "../../../agent-registry/src/index";
import { bindAgentDispatch } from "../../../protocol/src/dispatch";
import { recordAgentLog } from "../../../session/src/log";
import { readFileRecoveries, recoverInterruptedTurn } from "../../../session/session-recovery/src/file-recovery";
import { parseModelSelection, resolveModelSelection, setModelSelection } from "../../../session/src/model-selection";
import { toolStatus, type AgentEvent, type StoredMessage } from "../../../protocol/src/lib/shared";
import type { AgentTurnOutcome } from "../../../protocol/src/agent-events";
import { splitAttachments } from "../../../protocol/src/lib/attachments";
import { currentOption } from "../../../protocol/src/lib/settings";
import { MAX_TASK_REQUIREMENTS_CHARS, taskRequirementsUpdate } from "../../../protocol/src/lib/task-requirements";
import { addMessage, newId, setMultiAgent } from "../../../storage/src/store";
import { openChatAgent } from "./agent-session";

/** 版本冲突需要在页面内同步会话，其他 409 仍保留各自的处理方式。 */
function historyConflictResponse(error = new HistoryConflict()) {
  return Response.json({ code: "history_conflict", error: error.message }, { status: 409 });
}

/**
 * 发送新消息，或用 queuedId 继续已暂停的队首；每轮仍单独提交到会话历史。
 * truncateFrom：旧记录退出当前视图并保存在历史，新问题与这次切换在同一事务提交。
 */
/** 产品聊天规则复用于各种接入。宿主装配服务，业务层持有已核验的用户身份。 */
export async function submitChat(req: Request, userId: string, services: {
  agents: AgentRegistry;
  agentSessions: AgentSessionService;
  scheduler?: Scheduler;
  subagents?: SubagentOrchestrator;
  storageManager?: StorageManager;
}) {
  const registry = services.agents;
  const sessions = services.agentSessions;
  const scheduler = services.scheduler;
  const body = ((await req.json().catch(() => null)) ?? {}) as { sessionId?: string; message?: string; truncateFrom?: string; projectId?: string; revision?: number; queuedId?: string; modelSelection?: unknown; multiAgent?: unknown };
  const text = typeof body.message === "string" ? body.message.trim() : "";
  if (body.sessionId !== undefined && typeof body.sessionId !== "string") return Response.json({ error: "无效的会话 ID" }, { status: 400 });
  if (body.queuedId !== undefined && (typeof body.queuedId !== "string" || !body.queuedId || !body.sessionId || text || body.truncateFrom)) {
    return Response.json({ error: "继续队列需要会话和队首消息，不能同时发送新消息" }, { status: 400 });
  }
  if (!text && !body.queuedId) return Response.json({ error: "message 不能为空" }, { status: 400 });
  if ((taskRequirementsUpdate(text)?.length ?? 0) > MAX_TASK_REQUIREMENTS_CHARS)
    return Response.json({ error: `任务要求最多 ${MAX_TASK_REQUIREMENTS_CHARS} 字符` }, { status: 400 });
  if (body.revision !== undefined && (!Number.isSafeInteger(body.revision) || body.revision < 0))
    return Response.json({ error: "无效的会话版本" }, { status: 400 });
  const initialModel = body.modelSelection === undefined ? undefined : parseModelSelection(body.modelSelection, getSettings(userId));
  if (initialModel === null) return Response.json({ error: "无效的新会话模型选择" }, { status: 400 });
  if (body.multiAgent !== undefined && typeof body.multiAgent !== "boolean") {
    return Response.json({ error: "只能在新对话请求中指定多 Agent 模式" }, { status: 400 });
  }

  // 指定会话时必须属于当前用户；过期或无权访问的请求不能悄悄创建另一个会话。
  // 同一个会话同一时间只能有一个 agent 在跑：两个运行同时往一个会话里写，消息顺序会乱，还可能互相覆盖文件（M1-03）
  if (body.sessionId) {
    const agent = registry.get(body.sessionId, userId);
    const idle = agent ? await agent.waitIdle({ signal: req.signal }) : !req.signal.aborted;
    if (!idle) {
      return Response.json({ error: "这个对话还有任务在运行，先等它结束或点停止" }, { status: 409 });
    }
  }
  if (body.sessionId && sessions.isArchived(body.sessionId, userId)) {
    return Response.json({ error: "对话或项目已归档，请先恢复" }, { status: 409 });
  }
  const restored = body.sessionId ? sessions.get(body.sessionId, userId) : null;
  if ((body.sessionId || body.truncateFrom) && !restored) return Response.json({ error: "会话不存在" }, { status: 404 });
  if (restored && body.projectId !== undefined && body.projectId !== restored.projectId) {
    return Response.json({ error: "对话与项目不匹配" }, { status: 409 });
  }
  const project = restored ? undefined : getProject(body.projectId, userId);
  if (!restored && body.projectId !== undefined && !project) return Response.json({ error: "项目不存在" }, { status: 404 });
  if (project?.archivedAt) {
    return Response.json({ error: "对话或项目已归档，请先恢复" }, { status: 409 });
  }
  if (body.revision !== undefined && body.revision !== restored?.revision)
    return historyConflictResponse();
  const opened = await openChatAgent(sessions, registry, userId, restored, titleFrom(text), project?.id, project ? undefined : body.multiAgent).catch((error) => {
    if (error instanceof AgentUnavailable) return null;
    throw error;
  });
  if (!opened) return Response.json({ error: "Agent 正在关闭，请稍后重试" }, { status: 409 });
  const { handle } = opened;
  // 插件可能异步初始化，期间会话可能被修改。取得运行权前使用当时的最新快照。
  const session = sessions.get(opened.session.id, userId);
  if (!session) return Response.json({ error: "会话不存在" }, { status: 404 });
  // 附件可在首条消息之前创建空会话，仍接受首轮模型和多 Agent 选项。
  if (restored && (initialModel || body.multiAgent !== undefined) && (session.messages.length || body.queuedId || body.truncateFrom)) {
    return Response.json({ error: "只能在新对话请求中指定初始设置" }, { status: 400 });
  }
  if (body.projectId !== undefined && body.projectId !== session.projectId)
    return Response.json({ error: "对话与项目不匹配" }, { status: 409 });
  if (body.revision !== undefined && body.revision !== session.revision)
    return historyConflictResponse();
  const runtime = handle.agent.runtime;
  // 截断重发时标题保持不变（哪怕截到只剩 0 条消息），免得用户改过的标题被覆盖
  if (restored && text && session.messages.length === 0 && !body.truncateFrom) {
    session.title = titleFrom(text);
    sessions.rename(session.id, userId, session.title);
  }

  const streamAbort = new AbortController();
  const scheduled = scheduler?.acquire(handle.agent);
  const lease = scheduler ? scheduled?.lease : handle.agent.openRun(AbortSignal.any([req.signal, streamAbort.signal]));
  if (!lease) return Response.json({ error: "会话正在运行，请稍后重试" }, { status: 409 });
  const finish = () => {
    try { lease.finish(); }
    finally { if (scheduled) scheduler!.finish(scheduled); }
  };
  const { signal, id: runId } = lease;
  let workspace: string;
  let firstMessage: StoredMessage;
  let interruptedInputId: string | undefined;
  try {
    // 续聊前取得会话运行权，再核对上一轮。显式编辑重发走选中的历史分支。
    const scope = openSessionWorkspace(userId, session.id);
    if (!scope) throw new Error("会话工作区不存在");
    workspace = scope.workspace;
    if (restored && !body.truncateFrom) interruptedInputId = await recoverInterruptedTurn(session, userId, workspace, signal, true);
    if (initialModel) {
      setModelSelection(session.id, userId, initialModel);
      session.modelSelection = initialModel;
    }
    if (restored && !session.projectId && body.multiAgent !== undefined) {
      setMultiAgent(session.id, userId, body.multiAgent);
      session.multiAgent = body.multiAgent;
    }
    if (body.queuedId) {
      const claimed = lease.beginNext(session, body.queuedId);
      if (!claimed) {
        finish();
        return Response.json({ error: "队首消息已变化，请刷新后再继续" }, { status: 409 });
      }
      firstMessage = claimed;
    } else {
      firstMessage = { id: sessions.newInputId(), role: "user", content: text, createdAt: Date.now() };
      lease.begin(session, firstMessage, body.truncateFrom);
    }
  } catch (error) {
    finish();
    if (error instanceof HistoryConflict) return historyConflictResponse(error);
    throw error;
  }
  const encoder = new TextEncoder();
  const initial = { session, message: firstMessage };
  const { steering } = lease;

  const stream = new ReadableStream({
    async start(controller) {
      // 浏览器断开（点了停止）后 enqueue 会抛错。不能让它抛出去：那样 agent 循环会在下一个 yield 处被直接结束，
      // 来不及给没执行的调用补“已取消”的结果，历史里就会留下没结果的调用（M1-03）。断开后的事件直接丢掉，循环自己收尾
      let closed = false;
      const send = bindAgentDispatch({ sessionId: session.id, runId }, runtime.emitEvent);
      const forward = (e: AgentEvent) => {
        if (e.scope?.sessionId !== session.id || e.scope.runId !== runId) return;
        if (scheduled) { scheduled.emit(e); return; }
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          closed = true;
        }
      };
      let unsubscribe: (() => void) | undefined;
      try {
        unsubscribe = runtime.onEvent(forward);
        let turn = initial;
        let observing = false;
        for (;;) {
          const { session: s, message } = turn;
          send({ type: "session", runId, session: { id: s.id, revision: s.revision, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, projectId: s.projectId, modelSelection: s.modelSelection, multiAgent: s.multiAgent } });
          send({ type: "message", message });
          if (!observing) {
            observing = true;
            lease.observeQueue((queue) => send({ type: "queue", queue }));
          }
          let outcome: AgentTurnOutcome = "failed";
          try {
            const execute = () => executeTurn(s, message);
            outcome = services.storageManager && sandboxInfo().mode === "docker"
              ? await services.storageManager.withRun(userId, execute, Boolean(s.projectId))
              : await execute();
          } finally {
            lease.endTurn(outcome);
          }
          if (outcome !== "completed") break;
          // 迟到的引导、等待用户回答、失败和停止都会暂停队列。每条队列消息都有自己的用户轮次。
          if (signal.aborted || lease.parkSteering() || !lease.hasNext()) break;
          const fresh = sessions.get(s.id, userId);
          if (!fresh) break;
          const next = lease.beginNext(fresh);
          if (!next) break;
          turn = { session: fresh, message: next };
        }
      } catch (e) {
        if (!signal.aborted) send({ type: "error", message: e instanceof Error ? e.message : String(e) });
        send({ type: "done", interrupted: signal.aborted || undefined });
      } finally {
        try { finish(); }
        catch (error) { console.warn("[agent-registry] 收尾日志写入失败", error); }
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          /* 客户端已断开 */
        }
      }

      /** 每轮重新准备模型与会话配置，只有正常完成才允许继续领取下一条。 */
      async function executeTurn(s: typeof initial.session, input: StoredMessage): Promise<AgentTurnOutcome> {
        if (input.taskRequirements !== undefined) {
          // 独立的设置指令已经落库。由应用直接确认，避免为配置更新调用模型或触发工具。
          const reply: StoredMessage = {
            id: newId("m"), role: "assistant", createdAt: Date.now(),
            content: input.taskRequirements ? "已更新本次任务要求。" : "已清除本次任务要求。",
          };
          addMessage(s, reply);
          send({ type: "assistant_end", message: reply });
          send({ type: "done" });
          return "completed";
        }
        const inputId = input.id;
        const turnStart = s.messages.length - 1;
        const defaults = getSettings(userId);
        const selection = resolveModelSelection(s.id, userId, defaults);
        const settings = { ...defaults, currentModel: selection.model, reasoningEffort: selection.effort };
        const provider = runtime.models(settings);
        const pluginPrompt = await runtime.setupTurn(runId, inputId, signal);
        // 项目：决定用哪份记忆（全局 / 项目自己的 / 不用），并把项目说明和共享内容接进系统提示词
        const project = getProject(s.projectId, userId);
        const projectRules = await readProjectRules(workspaceOf(userId), project?.rulesFile);
        const memMode = !settings.memory ? "off" : project?.memory ?? "global";
        const memStore =
          memMode === "project" && project
            ? { get: () => getProjectMemory(project.id), save: (m: unknown) => saveProjectMemory(project.id, m) }
            : { get: () => getMemory(userId), save: (m: unknown) => saveMemory(userId, m) };
        let outcome: AgentTurnOutcome = "failed";
        let step = 0;
        let lastModelOutcome: string | null = null;
        for await (const ev of runAgent({
          provider,
          tools: runtime.tools,
          session: s,
          workspace,
          sessionWorkspace: true,
          execution: { runId, inputId },
          recovery: {
            interruptedInputId: inputId === firstMessage.id ? interruptedInputId : undefined,
            files: readFileRecoveries(s.id, userId)
          },
          userId,
          commandApproval: settings.commandApproval,
          signal,
          systemPrompt: settings.systemPrompt,
          projectRules,
          maxSteps: settings.maxSteps,
          maxFixRounds: settings.maxFixRounds,
          // 长期记忆 + 技能目录 + 运行环境说明（断网、授权目录，第 7.27 步）都接在系统提示词后面
          memory: [project ? projectPrompt(project, userId, s.id) : "", memMode !== "off" ? memoryPrompt(memStore.get()) : "", settings.skills ? skillsPrompt(activeSkills(userId)) : "", sandboxPrompt(), pluginPrompt]
            .filter(Boolean)
            .join("\n\n"),
          steering,
          conversationTrace: createConversationTrace({ sessionId: s.id, runId, inputId, ...selection }),
          trace: {
            selection,
            emit(event) {
              step = event.detail.step;
              if (event.kind === "model-result") lastModelOutcome = event.detail.outcome;
              recordAgentLog(s.id, { ...event, runId, inputId });
            },
          },
          // Docker 沙箱坏了：这次不给模型 run_command / run_python，免得一调就报错（见 sandbox.ts unavailableTools）
          // 技能功能关掉时 load_skill 也不给模型
          disabledTools: { ...(await unavailableTools()), ...(settings.skills ? {} : { load_skill: "技能功能已在设置里关闭" }) },
          // 上下文长度决定什么时候压缩历史（见 src/lib/agent/context.ts）
          contextWindow: currentOption(settings).contextWindow,
          subagents: services.subagents,
          multiAgent: !!(project || s.multiAgent),
        })) {
          if (ev.type === "done") outcome = ev.interrupted ? "interrupted" : ev.awaitingUser ? "waiting-for-answer"
            : lastModelOutcome === "output-truncated" ? "output-truncated" : "completed";
          if (ev.type === "tool_start") recordAgentLog(s.id, { kind: "tool-start", runId, inputId,
            detail: { step, callId: ev.callId, name: ev.name } });
          if (ev.type === "message" && ev.message.role === "tool" && ev.message.toolCallId) {
            recordAgentLog(s.id, { kind: "tool-result", runId, inputId, detail: {
              step, callId: ev.message.toolCallId, status: toolStatus(ev.message), durationMs: ev.message.durationMs ?? null,
              errorKind: ev.message.errorKind ?? null, artifactId: ev.message.artifactId ?? null,
            } });
          }
          if (ev.type === "artifact") recordAgentLog(s.id, { kind: "artifact", runId, inputId,
            detail: { artifactId: ev.artifact.id, title: ev.artifact.title, path: ev.artifact.file ?? null } });
          // 停止信号和输出上限同样会结束流，带上原因供仍在订阅的页面识别。
          if (ev.type === "done" && signal.aborted) send({ ...ev, interrupted: true });
          else if (ev.type === "done" && outcome === "output-truncated") send({ ...ev, outputTruncated: true });
          else send(ev);
        }
        // 半截回答保留供查看，后续重新生成后再学习这轮内容。
        if (outcome === "interrupted") return outcome;
        // 回答已经发完，再在后台反思、更新长期记忆：不 await，用户不用等它。
        // 不用 req.signal（浏览器断开后它会被中止），而是单独限时 90 秒
        if (memMode !== "off")
          reflect({ provider, userId, session: s, turnStart, store: memStore, signal: AbortSignal.timeout(90_000) }).catch((e) =>
            console.warn("[memory] 反思失败：", e instanceof Error ? e.message : e),
          );
        // 同样在后台：记录用到的技能顺不顺利，值得的话总结新技能 / 改进旧技能（见 src/lib/agent/learn.ts）
        if (settings.skills)
          learnSkills({ provider, userId, session: s, turnStart, autoEnable: settings.skillAutoEnable, signal: AbortSignal.timeout(90_000) }).catch((e) =>
            console.warn("[skills] 技能学习失败：", e instanceof Error ? e.message : e),
          );
        return outcome;
      }
    },
    cancel() {
      streamAbort.abort();
    },
  });

  return scheduled?.subscribe(0) ?? new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

function titleFrom(t: string) {
  // 标题只用正文；只发了附件没写字时，用第一个附件的文件名
  const { text, files } = splitAttachments(t);
  const one = (text || files[0]?.split("/").pop() || "").replace(/\s+/g, " ").trim();
  return one.length > 28 ? one.slice(0, 28) + "…" : one;
}
