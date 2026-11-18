import type { Scheduler } from "../../../scheduler/src/index";
import { getProvider } from "../../../llm/src/index";
import { runAgent, type ToolRegistry } from "../../../agent-loop/src/run";
import { createConversationTrace } from "../../../conversation-trace/src/recorder";
import { getSession, HistoryConflict, newId, renameSession } from "../../../storage/src/store";
import { getSettings } from "../../settings/src/settings";
import { workspaceOf } from "../../../tools/src/files";
import { reflect } from "../../../memory/src/reflect";
import { getMemory, memoryPrompt, saveMemory } from "../../../memory/src/memory";
import { getProject, getProjectMemory, projectPrompt, saveProjectMemory } from "../../projects/src/projects";
import { learnSkills } from "../../../skills/src/learn";
import { activeSkills, skillsPrompt } from "../../../skills/src/skills";
import { sandboxPrompt, unavailableTools } from "../../../sandbox/src/sandbox";
import type { AgentRegistry } from "../../../agent-registry/src/index";
import { isSessionArchived } from "../../../session/src/archive-admission";
import { bindAgentDispatch } from "../../../protocol/src/dispatch";
import { recordAgentLog } from "../../../session/src/log";
import { readFileRecoveries, recoverInterruptedTurn } from "../../../session/session-recovery/src/file-recovery";
import { parseModelSelection, resolveModelSelection, setModelSelection } from "../../../session/src/model-selection";
import { toolStatus, type AgentEvent, type StoredMessage } from "../../../protocol/src/lib/shared";
import type { AgentTurnOutcome } from "../../../protocol/src/agent-events";
import { splitAttachments } from "../../../protocol/src/lib/attachments";
import { currentOption } from "../../../protocol/src/lib/settings";


/**
 * 发送新消息，或用 queuedId 继续已暂停的队首；每轮仍单独提交到会话历史。
 * truncateFrom：旧记录退出当前视图并保存在历史，新问题与这次切换在同一事务提交。
 */
/** 产品聊天规则复用于各种接入。宿主装配服务，业务层持有已核验的用户身份。 */
export async function submitChat(req: Request, userId: string, services: {
  agents: AgentRegistry;
  scheduler?: Scheduler;
  models?: typeof getProvider;
  tools?: ToolRegistry;
}) {
  const registry = services.agents;
  const scheduler = services.scheduler;
  const body = ((await req.json().catch(() => null)) ?? {}) as { sessionId?: string; message?: string; truncateFrom?: string; projectId?: string; revision?: number; queuedId?: string; modelSelection?: unknown };
  const text = typeof body.message === "string" ? body.message.trim() : "";
  if (body.sessionId !== undefined && typeof body.sessionId !== "string") return Response.json({ error: "无效的会话 ID" }, { status: 400 });
  if (body.queuedId !== undefined && (typeof body.queuedId !== "string" || !body.queuedId || !body.sessionId || text || body.truncateFrom)) {
    return Response.json({ error: "继续队列需要会话和队首消息，不能同时发送新消息" }, { status: 400 });
  }
  if (!text && !body.queuedId) return Response.json({ error: "message 不能为空" }, { status: 400 });
  if (body.revision !== undefined && (!Number.isSafeInteger(body.revision) || body.revision < 0))
    return Response.json({ error: "无效的会话版本" }, { status: 400 });
  const initialModel = body.modelSelection === undefined ? undefined : parseModelSelection(body.modelSelection, getSettings(userId));
  if (initialModel === null || (initialModel && body.sessionId)) return Response.json({ error: "无效的新会话模型选择" }, { status: 400 });

  // 指定会话时必须属于当前用户；过期或无权访问的请求不能悄悄创建另一个会话。
  // 同一个会话同一时间只能有一个 agent 在跑：两个运行同时往一个会话里写，消息顺序会乱，还可能互相覆盖文件（M1-03）
  if (body.sessionId && !(await registry.waitIdle(body.sessionId, userId, { signal: req.signal })))
    return Response.json({ error: "这个对话还有任务在运行，先等它结束或点停止" }, { status: 409 });
  if (body.sessionId && isSessionArchived(body.sessionId, userId)) {
    return Response.json({ error: "对话或项目已归档，请先恢复" }, { status: 409 });
  }
  const restored = body.sessionId ? registry.resume(body.sessionId, userId) : null;
  if ((body.sessionId || body.truncateFrom) && !restored) return Response.json({ error: "会话不存在" }, { status: 404 });
  if (restored && body.projectId !== undefined && body.projectId !== restored.session.projectId) {
    return Response.json({ error: "对话与项目不匹配" }, { status: 409 });
  }
  const project = restored ? undefined : getProject(body.projectId, userId);
  if (!restored && body.projectId !== undefined && !project) return Response.json({ error: "项目不存在" }, { status: 404 });
  if (project?.archivedAt) {
    return Response.json({ error: "对话或项目已归档，请先恢复" }, { status: 409 });
  }
  if (body.revision !== undefined && body.revision !== restored?.session.revision)
    return Response.json({ error: "会话已更新，请刷新后重试" }, { status: 409 });
  // 新对话由注册表同时建立持久会话和在线实例；续聊只刷新会话快照，沿用在线实例。
  const { session, handle } = restored ?? registry.create({ userId, title: titleFrom(text), projectId: project?.id });
  // 截断重发时标题保持不变（哪怕截到只剩 0 条消息），免得用户改过的标题被覆盖
  if (restored && text && session.messages.length === 0 && !body.truncateFrom) {
    session.title = titleFrom(text);
    renameSession(session.id, userId, session.title);
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
  let firstMessage: StoredMessage;
  let interruptedInputId: string | undefined;
  try {
    // 续聊前取得会话运行权，再核对上一轮。显式编辑重发走选中的历史分支。
    if (restored && !body.truncateFrom) interruptedInputId = await recoverInterruptedTurn(session, userId, workspaceOf(userId), signal);
    if (initialModel) {
      setModelSelection(session.id, userId, initialModel);
      session.modelSelection = initialModel;
    }
    if (body.queuedId) {
      const claimed = lease.beginNext(session, body.queuedId);
      if (!claimed) {
        finish();
        return Response.json({ error: "队首消息已变化，请刷新后再继续" }, { status: 409 });
      }
      firstMessage = claimed;
    } else {
      firstMessage = { id: newId("m"), role: "user", content: text, createdAt: Date.now() };
      lease.begin(session, firstMessage, body.truncateFrom);
    }
  } catch (error) {
    finish();
    if (error instanceof HistoryConflict) return Response.json({ error: error.message }, { status: 409 });
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
      const send = bindAgentDispatch({ sessionId: session.id, runId }, (e: AgentEvent) => {
        if (scheduled) { scheduled.emit(e); return; }
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          closed = true;
        }
      });
      try {
        let turn = initial;
        let observing = false;
        for (;;) {
          const { session: s, message } = turn;
          send({ type: "session", runId, session: { id: s.id, revision: s.revision, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, projectId: s.projectId, modelSelection: s.modelSelection } });
          send({ type: "message", message });
          if (!observing) {
            observing = true;
            lease.observeQueue((queue) => send({ type: "queue", queue }));
          }
          let outcome: AgentTurnOutcome = "failed";
          try {
            outcome = await executeTurn(s, message.id);
          } finally {
            lease.endTurn(outcome);
          }
          if (outcome !== "completed") break;
          // 迟到的引导、等待用户回答、失败和停止都会暂停队列。每条队列消息都有自己的用户轮次。
          if (signal.aborted || lease.parkSteering() || !lease.hasNext()) break;
          const fresh = getSession(s.id, userId);
          if (!fresh) break;
          const next = lease.beginNext(fresh);
          if (!next) break;
          turn = { session: fresh, message: next };
        }
      } catch (e) {
        if (!signal.aborted) send({ type: "error", message: e instanceof Error ? e.message : String(e) });
        send({ type: "done" });
      } finally {
        try { finish(); }
        catch (error) { console.warn("[agent-registry] 收尾日志写入失败", error); }
        try {
          controller.close();
        } catch {
          /* 客户端已断开 */
        }
      }

      /** 每轮重新准备模型与会话配置，只有正常完成才允许继续领取下一条。 */
      async function executeTurn(s: typeof initial.session, inputId: string): Promise<AgentTurnOutcome> {
        const turnStart = s.messages.length - 1;
        const defaults = getSettings(userId);
        const selection = resolveModelSelection(s.id, userId, defaults);
        const settings = { ...defaults, currentModel: selection.model, reasoningEffort: selection.effort };
        const provider = (services.models ?? getProvider)(settings);
        // 项目：决定用哪份记忆（全局 / 项目自己的 / 不用），并把项目说明和共享内容接进系统提示词
        const project = getProject(s.projectId, userId);
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
          tools: services.tools,
          session: s,
          workspace: workspaceOf(userId),
          execution: { runId, inputId },
          recovery: {
            interruptedInputId: inputId === firstMessage.id ? interruptedInputId : undefined,
            files: readFileRecoveries(s.id, userId)
          },
          userId,
          commandApproval: settings.commandApproval,
          signal,
          systemPrompt: settings.systemPrompt,
          maxSteps: settings.maxSteps,
          maxFixRounds: settings.maxFixRounds,
          // 长期记忆 + 技能目录 + 运行环境说明（断网、授权目录，第 7.27 步）都接在系统提示词后面
          memory: [project ? projectPrompt(project, userId, s.id) : "", memMode !== "off" ? memoryPrompt(memStore.get()) : "", settings.skills ? skillsPrompt(activeSkills(userId)) : "", sandboxPrompt()]
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
          send(ev);
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
