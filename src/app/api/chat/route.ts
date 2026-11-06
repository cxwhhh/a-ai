import { getProvider } from "@/lib/llm";
import { runAgent } from "@/lib/agent/run";
import { addMessage, createSession, getSession, newId, renameSession, truncateFrom } from "@/lib/server/store";
import { getSettings } from "@/lib/server/settings";
import { currentUser, unauthorized } from "@/lib/server/auth";
import { workspaceOf } from "@/lib/agent/tools/files";
import { reflect } from "@/lib/agent/reflect";
import { getMemory, memoryPrompt, saveMemory } from "@/lib/server/memory";
import { getProject, getProjectMemory, projectPrompt, saveProjectMemory } from "@/lib/server/projects";
import { learnSkills } from "@/lib/agent/learn";
import { activeSkills, skillsPrompt } from "@/lib/server/skills";
import { sandboxPrompt, unavailableTools } from "@/lib/server/sandbox";
import { closeRun, openRun, takeNotes, waitIdle } from "@/lib/server/notes";
import type { AgentEvent, StoredMessage } from "@/lib/shared";
import { splitAttachments } from "@/lib/attachments";
import { currentOption } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { sessionId?: string, message: string, truncateFrom?: string } → text/event-stream of AgentEvent
 * truncateFrom：重新生成 / 编辑后重发时，先把这条用户消息和它之后的内容删掉，再当作新消息发出
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const body = (await req.json().catch(() => ({}))) as { sessionId?: string; message?: string; truncateFrom?: string; projectId?: string };
  const text = (body.message ?? "").trim();
  if (!text) return Response.json({ error: "message 不能为空" }, { status: 400 });

  // 只能往自己的会话里发消息：别人的会话 id 会被当成不存在，直接新建一个
  // 同一个会话同一时间只能有一个 agent 在跑：两个运行同时往一个会话里写，消息顺序会乱，还可能互相覆盖文件（M1-03）
  if (body.sessionId && !(await waitIdle(body.sessionId)))
    return Response.json({ error: "这个对话还有任务在运行，先等它结束或点停止" }, { status: 409 });
  let session = body.sessionId ? getSession(body.sessionId, user.id) : null;
  // 截断重发时标题保持不变（哪怕截到只剩 0 条消息），免得用户改过的标题被覆盖
  const truncated = !!(session && body.truncateFrom && truncateFrom(session, body.truncateFrom));
  // 在项目里新建对话：projectId 必须是自己的项目，否则当作普通对话
  if (!session) session = createSession(user.id, titleFrom(text), getProject(body.projectId, user.id)?.id);
  else if (session.messages.length === 0 && !truncated) {
    session.title = titleFrom(text);
    renameSession(session.id, user.id, session.title);
  }

  const userMsg: StoredMessage = { id: newId("m"), role: "user", content: text, createdAt: Date.now() };
  addMessage(session, userMsg);
  const turnStart = session.messages.length - 1; // 本轮从这条用户消息开始，反思时只看这之后的内容

  const encoder = new TextEncoder();
  const s = session;

  const stream = new ReadableStream({
    async start(controller) {
      // 浏览器断开（点了停止）后 enqueue 会抛错。不能让它抛出去：那样 agent 循环会在下一个 yield 处被直接结束，
      // 来不及给没执行的调用补“已取消”的结果，历史里就会留下没结果的调用（M1-03）。断开后的事件直接丢掉，循环自己收尾
      let closed = false;
      const send = (e: AgentEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          closed = true;
        }
      };
      openRun(s.id, user.id); // 登记“正在运行”：运行期间 /api/chat/note 才能补充想法
      try {
        send({ type: "session", session: { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, ...(s.projectId ? { projectId: s.projectId } : {}) } });
        send({ type: "message", message: userMsg });
        const settings = getSettings(user.id);
        const provider = getProvider(settings);
        // 项目：决定用哪份记忆（全局 / 项目自己的 / 不用），并把项目说明和共享内容接进系统提示词
        const project = getProject(s.projectId, user.id);
        const memMode = !settings.memory ? "off" : project?.memory ?? "global";
        const memStore =
          memMode === "project" && project
            ? { get: () => getProjectMemory(project.id), save: (m: unknown) => saveProjectMemory(project.id, m) }
            : { get: () => getMemory(user.id), save: (m: unknown) => saveMemory(user.id, m) };
        for await (const ev of runAgent({
          provider,
          session: s,
          workspace: workspaceOf(user.id),
          userId: user.id,
          commandApproval: settings.commandApproval,
          signal: req.signal,
          systemPrompt: settings.systemPrompt,
          maxSteps: settings.maxSteps,
          maxFixRounds: settings.maxFixRounds,
          // 长期记忆 + 技能目录 + 运行环境说明（断网、授权目录，第 7.27 步）都接在系统提示词后面
          memory: [project ? projectPrompt(project, user.id, s.id) : "", memMode !== "off" ? memoryPrompt(memStore.get()) : "", settings.skills ? skillsPrompt(activeSkills(user.id)) : "", sandboxPrompt()]
            .filter(Boolean)
            .join("\n\n"),
          notes: () => takeNotes(s.id),
          // Docker 沙箱坏了：这次不给模型 run_command / run_python，免得一调就报错（见 sandbox.ts unavailableTools）
          // 技能功能关掉时 load_skill 也不给模型
          disabledTools: { ...(await unavailableTools()), ...(settings.skills ? {} : { load_skill: "技能功能已在设置里关闭" }) },
          // 上下文长度决定什么时候压缩历史（见 src/lib/agent/context.ts）
          contextWindow: currentOption(settings).contextWindow,
        }))
          send(ev);
        // 回答已经发完，再在后台反思、更新长期记忆：不 await，用户不用等它。
        // 不用 req.signal（浏览器断开后它会被中止），而是单独限时 90 秒
        if (memMode !== "off")
          reflect({ provider, userId: user.id, session: s, turnStart, store: memStore, signal: AbortSignal.timeout(90_000) }).catch((e) =>
            console.warn("[memory] 反思失败：", e instanceof Error ? e.message : e),
          );
        // 同样在后台：记录用到的技能顺不顺利，值得的话总结新技能 / 改进旧技能（见 src/lib/agent/learn.ts）
        if (settings.skills)
          learnSkills({ provider, userId: user.id, session: s, turnStart, autoEnable: settings.skillAutoEnable, signal: AbortSignal.timeout(90_000) }).catch((e) =>
            console.warn("[skills] 技能学习失败：", e instanceof Error ? e.message : e),
          );
      } catch (e) {
        if (!req.signal.aborted) send({ type: "error", message: e instanceof Error ? e.message : String(e) });
        send({ type: "done" });
      } finally {
        closeRun(s.id);
        try {
          controller.close();
        } catch {
          /* 客户端已断开 */
        }
      }
    },
  });

  return new Response(stream, {
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
