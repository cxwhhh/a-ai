import "server-only";
import type { ChatMessage, LLMProvider, ToolCall, ToolSpec } from "../llm/types";
import { inferStatus, type AgentEvent, type Artifact, type ErrorKind, type Session, type StoredMessage, type QueuedMessage, type ToolStatus } from "../shared";
import { addArtifact, addMessage, newId } from "../server/store";
import { allowSession, isSessionAllowed, waitApproval } from "../server/approvals";
import type { Settings } from "../settings";
import { SYSTEM_PROMPT } from "./prompt";
import { deferredCatalog, findTool, toolSpecs, toolsFor } from "./tools/index";
import type { ApprovalRequest } from "./tools/types";
import { FEEDBACK_TAG, limitFeedback, Verifier } from "./verify";
import { NOTE_TAG } from "../server/notes";
import { normalizeArgs, parseToolArgs } from "./args";
import { CallGuard } from "./guard";
import { logUsage } from "../server/usage";
import { buildContext, compactThreshold, estimateRequest, estimateUsage, planCompact, summarize } from "./context";
import { envPrompt, turnEnv } from "./env";
import { budgetHint, isPlanOnly, Progress, selfCheck } from "./steer";
import { RESEARCH_SPEC, runResearch } from "./subagent";

/** 防止模型无限调用工具：一轮对话最多走这么多步（可在设置里改） */
const DEFAULT_MAX_STEPS = 25;
const DEFAULT_MAX_FIX_ROUNDS = 3;
/** 每轮自动修复额外多给的步数：一步改代码并运行，一步看结果后回答 */
const STEPS_PER_FIX = 2;
/** 一组最多同时跑几个只读工具：模型一次发 20 个网页抓取时分几组跑，避免占满连接和内存（M1-03） */
const MAX_PARALLEL = 6;

/**
 * Agent 主循环（也叫 ReAct 循环：Reason → Act → Observe）
 *
 *   ┌─────────────────────────────────────────────┐
 *   │ 1. 把对话历史 + 工具说明书发给模型          │
 *   │ 2. 模型流式返回：思考 / 文字 / 工具调用      │
 *   │ 3. 没有工具调用？→ 结束                      │
 *   │ 4. 有工具调用？→ 执行（只读的并行），结果作为│
 *   │    role=tool 消息加进历史 → 回到第 1 步      │
 *   └─────────────────────────────────────────────┘
 *
 * 反馈闭环（verify.ts）：第 3 步“模型想交付”时先过一道检查——
 * 最近一次运行报错、或写了代码没运行，就把报错作为一条反馈消息发回模型，回到第 1 步继续改，
 * 直到通过或用完 maxFixRounds 轮。步数用完时，最后一步不给工具，要求模型直接总结。
 *
 * 和用户互动：
 * - 模型调用 ask_user（endsTurn 的工具）→ 写入结果后本轮立即结束，等用户回答（回答是下一条用户消息）。
 * - 运行中用户补充的想法（notes）→ 每次调用模型前取出来，作为“【用户补充】…”加进历史，模型下一步就能看到。
 *
 * 每发生一件事就 yield 一个 AgentEvent，由 /api/chat 转成 SSE 推给浏览器，
 * 所以前端能实时看到完整的思维链路和工具链路。
 * 工具执行期间也能推事件（终端的实时输出、请用户确认）：工具把事件放进 live 队列并“叫醒”循环，见第 4 步。
 * 每条消息生成完就写进数据库（addMessage），中途点“停止”也不会丢消息。
 *
 * 上下文管理（context.ts）：第 1 步发给模型的不是完整历史，而是“瘦身”后的历史；
 * 预计超过阈值时先把更早的对话压缩成摘要（prepareContext），再调用模型。
 *
 * 让模型少走弯路（env.ts、steer.ts、subagent.ts）：
 * - 环境：日期、沙箱里的包接在系统提示词后面；当前时间和工作区文件附在本轮用户消息后面。
 * - 规划：复杂任务第一步以「【规划】」开头只写计划，不算交付；做过规划的任务交付前再自检一次。
 * - 步数过半后每步提醒“还剩几步”；连续 3 步没有新进展，要求停下来重新规划或问用户。
 * - research 工具：把调研子任务交给只读的子 agent，主 agent 只拿回结论。
 *
 * 按需加载工具（tools/index.ts、tools/load-tools.ts）：每一步只发“常用工具 + 这个会话加载过的工具”的说明书，
 * 其余工具在系统提示词里只有一行目录；模型要用时先调 load_tools，下一步 toolsFor() 就会把它加进来。
 */
export async function* runAgent(opts: {
  provider: LLMProvider;
  session: Session;
  /** 当前用户的工作区目录，文件工具只能在这里读写 */
  workspace: string;
  /** 当前用户 id：确认请求按用户隔离，别人不能替你点“允许” */
  userId: string;
  /** 终端命令什么时候要用户确认（设置页“命令确认”） */
  commandApproval?: Settings["commandApproval"];
  signal?: AbortSignal;
  /** 来自设置页：自定义系统提示词（空 = 用内置）和最大步数 */
  systemPrompt?: string;
  maxSteps?: number;
  /** 反馈闭环最多自动修复几轮，0 = 关闭 */
  maxFixRounds?: number;
  /** 长期记忆（已经排好版的一段文字），接在系统提示词后面 */
  memory?: string;
  /** 查看用户明确选择插队的持久草稿；尚未选择的内容不发送给模型。 */
  notes?: () => QueuedMessage[];
  /** 写入历史后记录关联；模型响应到达后，才确认本次实际发送的补充内容。 */
  noteSaved?: (id: string, messageId: string) => void;
  notesSent?: (messages: ChatMessage[]) => void;
  onClosing?: () => void;
  /** 这次运行用不了的工具：名字 → 原因（例如 Docker 沙箱不可用时的 run_command / run_python）。不发给模型，并在提示词里说明 */
  disabledTools?: Record<string, string>;
  /** 当前模型的上下文长度（token），决定什么时候压缩历史。默认 128k */
  contextWindow?: number;
}): AsyncGenerator<AgentEvent> {
  const { provider, session, signal } = opts;
  const disabled = opts.disabledTools ?? {};
  const env = await envPrompt(opts.workspace).catch(() => "");
  const catalog = deferredCatalog(disabled);
  const system = (opts.systemPrompt?.trim() || SYSTEM_PROMPT) + (catalog ? `\n\n${catalog}` : "") + (env ? `\n\n${env}` : "") + (opts.memory ? `\n\n${opts.memory}` : "") + disabledNote(disabled);
  /** 这一步发给模型的工具：每一步重新从历史里算（上一步刚调用了 load_tools，这一步就带上新加载的说明书） */
  const toolsNow = () => [...toolsFor(session.messages, disabled), ...(disabled[RESEARCH_SPEC.name] ? [] : [RESEARCH_SPEC])];
  // 本轮的环境快照只取一次：同一轮的每一步都一样，请求前缀不变，缓存才能命中
  const snapshot = await turnEnv(opts.workspace).catch(() => "");
  const threshold = compactThreshold(opts.contextWindow ?? 128_000);
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  // 运行代码的工具都用不了时，反馈闭环没法要求“运行验证”，干脆关掉，免得逼模型去调不存在的工具
  const canRun = !disabled.run_python || !disabled.run_command;
  const verifier = new Verifier(canRun ? (opts.maxFixRounds ?? DEFAULT_MAX_FIX_ROUNDS) : 0);
  const guard = new CallGuard();
  const progress = new Progress();
  let planned = false; // 这一轮第一步写了规划
  let warmup = 0; // 本轮开头只读了技能（load_skill）的步数：读完技能后的第一步仍然可以只写规划
  let checked = false; // 已经自检过
  let toolRuns = 0;
  const pending: Artifact[] = [];
  const held: QueuedMessage[] = []; // 已取出、还没写进历史的补充想法
  let budget = maxSteps;

  /**
   * 工具执行期间产生的事件（实时输出、确认请求）。
   * generator 只能在自己的代码里 yield，工具的回调里不能直接 yield，所以先放进队列，
   * 再调用 wake() 让第 4 步里正在 await 的 Promise.race 醒过来，把队列里的事件 yield 出去。
   */
  const live: AgentEvent[] = [];
  let wake = () => {};
  const emit = (e: AgentEvent) => {
    live.push(e);
    wake();
  };
  /** 工具请求确认：按设置决定直接放行还是问用户（问的话循环停在这里，等 /api/approve） */
  const confirm = async (callId: string, req: ApprovalRequest) => {
    const mode = opts.commandApproval ?? "readonly";
    if (mode === "auto" || (mode === "readonly" && req.readonly) || isSessionAllowed(session.id)) return true;
    emit({ type: "approval", callId, command: req.command, reason: req.reason });
    const d = await waitApproval(opts.userId, callId, signal);
    if (d === "allow_session") allowSession(session.id);
    emit({ type: "approval_end", callId, allowed: d !== "deny" });
    return d !== "deny";
  }; // 每发一次修复反馈，预算加 STEPS_PER_FIX

  for (let step = 0; step < budget; step++) {
    if (signal?.aborted) break;

    // 用户刚补充的想法：调用模型前加进历史
    yield* injectNotes();

    // 最后一步：不再给工具，先告诉模型“步数用完了，直接总结”，避免发出了工具调用却没机会执行
    const lastStep = step === budget - 1 && step > 0;
    if (lastStep) yield* sendFeedback(session, limitFeedback(budget));

    // ---- 1~2. 调用模型 ----
    const t0 = Date.now();
    const assistant: StoredMessage = { id: newId("m"), role: "assistant", content: "", createdAt: t0 };
    const calls: ToolCall[] = [];
    let thinkStart = 0;
    const endThinking = () => {
      if (thinkStart && assistant.reasoningMs === undefined) assistant.reasoningMs = Date.now() - thinkStart;
    };

    const stepTools = lastStep ? undefined : toolsNow();
    let messages: ChatMessage[];
    try {
      messages = yield* prepareContext(stepTools);
    } catch (e) {
      if (signal?.aborted) break;
      throw e;
    }
    // 步数用了一半以上：请求末尾提醒还剩几步（只发给模型，不存进历史）
    const hint = lastStep ? null : budgetHint(step, budget);
    if (hint) messages = [...messages, { role: "user", content: hint }];

    let received = false;
    try {
      for await (const chunk of provider.stream({ messages, tools: stepTools, signal })) {
        // 请求有响应才确认送达；仅写入消息历史不能证明模型接收过。
        if (!received) { opts.notesSent?.(messages); received = true; }
        if (chunk.type === "reasoning") {
          if (!thinkStart) thinkStart = Date.now();
          assistant.reasoning = (assistant.reasoning ?? "") + chunk.delta;
          yield { type: "reasoning", messageId: assistant.id, createdAt: t0, delta: chunk.delta };
        } else if (chunk.type === "text") {
          endThinking();
          assistant.content += chunk.delta;
          yield { type: "text", messageId: assistant.id, createdAt: t0, delta: chunk.delta };
        } else if (chunk.type === "tool_call_delta") {
          endThinking();
          yield { type: "tool_input", messageId: assistant.id, createdAt: t0, index: chunk.index, name: chunk.name, delta: chunk.delta };
        } else if (chunk.type === "tool_call") {
          endThinking();
          calls.push({ ...chunk.call, arguments: normalizeArgs(chunk.call.arguments) });
        } else if (chunk.type === "raw") {
          assistant.raw = chunk.raw;
        } else if (chunk.type === "done" && chunk.usage) {
          assistant.usage = chunk.usage; // 记下 token 用量，“用量”页面据此统计
        }
      }
    } catch (e) {
      endThinking();
      assistant.durationMs = Date.now() - t0;
      // 中途停止或出错：API 不会再发来用量，但已经生成的部分照样计费，所以按字数估算一个。
      // 已经生成的文字也存下来（以前点“停止”会把这一步整个丢掉，用量统计也跟着漏掉）
      if (assistant.content || assistant.reasoning) assistant.usage = estimateUsage(JSON.stringify(messages), (assistant.reasoning ?? "") + assistant.content);
      logUsage(opts.userId, session.id, "chat", assistant.usage, t0);
      if (!signal?.aborted) yield { type: "error", message: e instanceof Error ? e.message : String(e) };
      if (assistant.content || assistant.reasoning) {
        addMessage(session, assistant);
        yield { type: "assistant_end", message: assistant };
      }
      if (signal?.aborted) break;
      return;
    }

    endThinking();
    assistant.durationMs = Date.now() - t0;
    // 有的服务（本地模型、部分代理）不返回用量：按字数估算，并标记为估算值
    assistant.usage ??= estimateUsage(JSON.stringify(messages), (assistant.reasoning ?? "") + assistant.content + calls.map((c) => c.arguments).join(""));
    logUsage(opts.userId, session.id, "chat", assistant.usage, t0);
    if (calls.length && !lastStep) assistant.toolCalls = calls; // 最后一步没给工具，万一模型还是发了调用也丢掉（没有结果的调用会让下次请求报 400）
    addMessage(session, assistant);
    yield { type: "assistant_end", message: assistant };

    // 模型刚发出工具调用就被停止：每个调用都补一条“已取消”的结果，历史里不能有没结果的调用（M1-03）
    if (signal?.aborted) {
      yield* closeCalls(assistant.toolCalls ?? [], "cancelled", "用户点了停止，这个操作没有执行。");
      break;
    }

    // ---- 3. 没有工具调用 = 模型认为任务完成 → 先过反馈闭环的检查 ----
    if (!calls.length || lastStep) {
      // 第一步只写了规划：不是交付，接着执行（这一步不占用户设置的步数）
      if (!lastStep && isPlanOnly(step - warmup, assistant.content, calls)) {
        planned = true;
        budget++;
        continue;
      }
      // 先看代码有没有运行通过；通过了，做过规划的任务再对照要求自检一次
      let fb = lastStep ? null : verifier.check();
      if (!fb && !lastStep && planned && !checked && toolRuns > 0) {
        checked = true;
        fb = selfCheck();
      }
      if (!fb) {
        // 模型刚写完回答，用户又补充了想法：不结束，带上补充再来一步
        if (opts.notes && hasNotes()) {
          budget = Math.max(budget, step + 4);
          continue;
        }
        break; // 通过（或修复轮数用完）：交付
      }
      yield* sendFeedback(session, fb);
      budget = Math.min(budget + STEPS_PER_FIX, maxSteps + STEPS_PER_FIX * verifier.maxRounds);
      continue;
    }

    // ---- 4. 执行工具，把结果写回历史 ----
    // ask_user 要单独一步：和别的操作混在一起时都不执行，让模型重新安排（先问、等回答，再做别的）（M1-03）
    const asks = calls.filter((c) => findTool(c.name)?.endsTurn);
    if (asks.length && calls.length > 1) {
      yield* closeCalls(calls, "skipped", "ask_user 必须单独一步调用。这一步的所有操作都没有执行：需要问用户就只调用 ask_user，等用户回答后再做其他操作；不需要问就去掉 ask_user 重新调用。", "protocol");
      continue;
    }

    // 相邻的只读工具一起并行执行，有副作用的工具（写文件、跑代码）单独按顺序执行
    const ctx: ExecCtx = { sessionId: session.id, userId: opts.userId, workspace: opts.workspace, signal, pending, emit, confirm, disabled, provider };
    const batches = toBatches(calls);
    /** 这一步里失败的有副作用操作：后面的操作可能依赖它（例如写文件失败后再运行这个文件），一律跳过 */
    let failed: ToolCall | null = null;
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      if (signal?.aborted || failed) {
        const rest = batches.slice(b).flat();
        if (signal?.aborted) yield* closeCalls(rest, "cancelled", "用户点了停止，这个操作没有执行。");
        else yield* closeCalls(rest, "skipped", `前面的 ${failed!.name} 没有成功，这一步后面的操作可能依赖它，都没有执行。先看失败原因、处理好，再重新调用需要的操作。`, "dependency");
        break;
      }
      const running = new Map<string, Promise<StoredMessage>>();
      for (const call of batch) {
        yield { type: "tool_start", callId: call.id, name: call.name, startedAt: Date.now() };
        // 同样的调用已经失败过两次：不再执行，直接把拦截原因作为结果（见 guard.ts）
        const blocked = guard.before(call);
        const exec = call.name === RESEARCH_SPEC.name ? research(call, ctx) : execTool(call, session, ctx);
        running.set(call.id, blocked ? Promise.resolve(errorResult(call, blocked, "blocked")) : exec.then((r) => guard.after(call, r)));
      }
      // 谁先完成谁先推给前端，不用等最慢的那个。
      // 同时等“有新的实时事件”（tick）：工具还在跑时，也能把终端输出、确认请求推出去
      while (running.size) {
        while (live.length) yield live.shift()!;
        const tick = new Promise<null>((r) => (wake = () => r(null)));
        const result = await Promise.race([...running.values(), tick]);
        while (live.length) yield live.shift()!; // 先推完这个工具的实时输出，再推它的结果
        if (!result) continue; // 只是被叫醒，工具还没跑完
        running.delete(result.toolCallId!);
        const done = batch.find((c) => c.id === result.toolCallId)!;
        if (signal?.aborted) markStopped(done, result);
        if (result.status !== "ok" && !isReadOnly(done.name)) failed ??= done;
        verifier.observe(done, result);
        progress.observe(done, result);
        toolRuns++;
        while (pending.length) yield { type: "artifact", artifact: pending.shift()! };
        addMessage(session, result);
        yield { type: "message", message: result };
      }
    }
    if (signal?.aborted) break;

    if (step === warmup && calls.every((c) => c.name === "load_skill")) warmup++;

    // ask_user：问题已经显示给用户，本轮到此结束，等用户回答
    if (asks.length) {
      if (opts.notes && hasNotes()) { budget = Math.max(budget, step + 4); continue; }
      break;
    }

    // 连续几步没有新进展：发一条反馈，要求停下来重新规划（见 steer.ts）
    const stall = progress.endStep();
    if (stall && !signal?.aborted) yield* sendFeedback(session, stall);
  }

  // 在发 done 之前关闭插队入口，避免最后一次检查后又接受一条永远等不到下一步的消息。
  opts.onClosing?.();
  yield { type: "done" };

  /**
   * 准备这一步发给模型的历史（第 1 步）。
   * 先瘦身；预计仍超过阈值就做摘要压缩（多一次模型调用，摘要存进会话，之后的步骤都复用）；
   * 还是太长（例如单独一轮就很长，没有可以摘要的旧轮次），就把当前轮更早的工具结果截得更短。
   */
  async function* prepareContext(stepTools?: ToolSpec[]): AsyncGenerator<AgentEvent, ChatMessage[]> {
    return withSnapshot(yield* compactIfNeeded(stepTools));
  }

  /** 本轮的环境快照附在用户这一轮的消息末尾（发给模型的副本，不改数据库） */
  function withSnapshot(messages: ChatMessage[]): ChatMessage[] {
    if (!snapshot) return messages;
    const i = lastIndex(messages, (m) => m.role === "user" && !m.content.startsWith(FEEDBACK_TAG) && !m.content.startsWith(NOTE_TAG));
    if (i < 0) return messages;
    const copy = [...messages];
    copy[i] = { ...copy[i], content: `${copy[i].content}\n\n${snapshot}` };
    return copy;
  }

  async function* compactIfNeeded(stepTools?: ToolSpec[]): AsyncGenerator<AgentEvent, ChatMessage[]> {
    let messages = buildContext(session.messages, system);
    const before = estimateRequest(messages, stepTools);
    if (before <= threshold) return messages;

    const plan = planCompact(session.messages);
    if (plan) {
      const startedAt = Date.now();
      try {
        const { summary, usage } = await summarize(provider, plan, signal);
        logUsage(opts.userId, session.id, "compact", usage, startedAt);
        const m: StoredMessage = {
          id: newId("m"),
          role: "user",
          content: summary,
          feedback: { kind: "compact", summary: `更早的 ${plan.part.length} 条消息已整理成摘要` },
          compact: { keepFrom: plan.keepFrom, messages: plan.part.length, tokensBefore: before, tokensAfter: 0 },
          usage,
          createdAt: startedAt,
          durationMs: Date.now() - startedAt,
        };
        messages = buildContext([...session.messages, m], system);
        m.compact!.tokensAfter = estimateRequest(messages, stepTools);
        m.feedback!.summary += `（约 ${fmtK(before)} → ${fmtK(m.compact!.tokensAfter)} tokens）`;
        addMessage(session, m);
        yield { type: "message", message: m };
      } catch (e) {
        if (signal?.aborted) throw e;
        // 摘要失败不影响回答：用瘦身后的历史继续，只打日志
        console.warn("[context] 压缩失败：", e instanceof Error ? e.message : e);
      }
    }
    if (estimateRequest(messages, stepTools) > threshold) messages = buildContext(session.messages, system, { tight: true });
    return messages;
  }

  /**
   * 给没有执行的调用补上结果（取消 / 跳过），写进历史并推给前端。
   * 模型的每个 tool_call 都必须有一条对应的 tool 结果，否则下次请求会被 API 拒绝（400）。
   */
  function* closeCalls(list: ToolCall[], status: ToolStatus, why: string, errorKind?: ErrorKind): Generator<AgentEvent> {
    for (const call of list) {
      if (session.messages.some((m) => m.role === "tool" && m.toolCallId === call.id)) continue;
      const m: StoredMessage = { ...errorResult(call, `未执行（${status === "cancelled" ? "已取消" : "已跳过"}）：${why}`), status, errorKind };
      addMessage(session, m);
      yield { type: "message", message: m };
    }
  }

  /** 队列读取不删除：按 ID 去重暂存，成功保存正式消息后才推进投递状态。
   * 崩溃发生在“保存消息”和“确认队列”之间时，用稳定 ID 找回已写入消息，不重复插入。 */
  function hasNotes() {
    const known = new Set(held.map((n) => n.id));
    for (const n of opts.notes?.() ?? []) if (!known.has(n.id)) { held.push(n); known.add(n.id); }
    return held.length > 0;
  }
  function* injectNotes(): Generator<AgentEvent> {
    hasNotes();
    for (const note of held.splice(0)) {
      const text = note.text;
      const existing = session.messages.find((m) => m.id === (note.messageId ?? "mq_" + note.id));
      if (existing) { opts.noteSaved?.(note.id, existing.id); continue; }
      const m: StoredMessage = {
        id: note.messageId ?? "mq_" + note.id,
        role: "user",
        content: NOTE_TAG + text,
        feedback: { kind: "note", summary: text },
        createdAt: Date.now(),
      };
      addMessage(session, m);
      opts.noteSaved?.(note.id, m.id);
      yield { type: "message", message: m };
    }
  }
}

/** 把一条自动反馈写进历史（发给模型时是 user 消息），并推给前端显示在过程里 */
function* sendFeedback(session: Session, fb: { content: string; feedback: StoredMessage["feedback"] }): Generator<AgentEvent> {
  const m: StoredMessage = { id: newId("m"), role: "user", content: fb.content, feedback: fb.feedback, createdAt: Date.now() };
  addMessage(session, m);
  yield { type: "message", message: m };
}

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/**
 * 把一轮里的工具调用分组：连续的 parallelSafe 工具合成一组并行跑，其余每个单独一组。
 * 例：[read, read, write, read] → [[read, read], [write], [read]]
 * 保留原顺序，所以“先写文件再运行”这类有依赖的调用不会乱。
 */
function toBatches(calls: ToolCall[]): ToolCall[][] {
  const batches: ToolCall[][] = [];
  // research 子 agent 只用只读工具，几个调研可以同时跑
  const isSafe = (name: string) => name === RESEARCH_SPEC.name || (findTool(name)?.parallelSafe ?? false);
  for (const call of calls) {
    const last = batches.at(-1);
    const safe = isSafe(call.name);
    if (safe && last && isSafe(last[0].name) && last.length < MAX_PARALLEL) last.push(call);
    else batches.push([call]);
  }
  return batches;
}

interface ExecCtx {
  sessionId: string;
  userId: string;
  workspace: string;
  signal?: AbortSignal;
  pending: Artifact[];
  emit(e: AgentEvent): void;
  confirm(callId: string, req: ApprovalRequest): Promise<boolean>;
  disabled: Record<string, string>;
  provider: LLMProvider;
}

/** research 工具：交给调研子 agent（subagent.ts），进度作为实时输出推给前端 */
async function research(call: ToolCall, ctx: ExecCtx): Promise<StoredMessage> {
  const startedAt = Date.now();
  const r = await runResearch(call, {
    provider: ctx.provider,
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    workspace: ctx.workspace,
    signal: ctx.signal,
    disabled: ctx.disabled,
    onOutput: (text) => ctx.emit({ type: "tool_output", callId: call.id, stream: "out", delta: text }),
  }).catch((e) => ({ content: `工具执行失败：${e instanceof Error ? e.message : String(e)}`, isError: true }));
  return {
    id: newId("m"), role: "tool", toolCallId: call.id, content: r.content, isError: r.isError,
    status: r.isError ? "error" : "ok", ...(r.isError ? { errorKind: "tool" as const } : {}),
    createdAt: startedAt, durationMs: Date.now() - startedAt,
  };
}

function lastIndex<T>(arr: T[], fn: (x: T) => boolean) {
  for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i])) return i;
  return -1;
}

/** 没有执行就失败的工具结果（被拦截、跳过、取消） */
function errorResult(call: ToolCall, content: string, errorKind: ErrorKind = "tool"): StoredMessage {
  return { id: newId("m"), role: "tool", toolCallId: call.id, content, isError: true, status: "error", errorKind, createdAt: Date.now(), durationMs: 0 };
}

/** 只读工具（可以并行的那些）：停止或失败都不会改坏东西 */
const isReadOnly = (name: string) => name === RESEARCH_SPEC.name || !!findTool(name)?.parallelSafe;

/**
 * 工具执行期间用户点了停止，工具带着失败结果返回：
 * 只读操作 → 已取消；写文件、跑命令 → 结果不确定（可能已经改了一部分），提醒先检查，不能当成“没执行”直接重做。
 * 停止前就已经成功的结果保持成功。
 */
function markStopped(call: ToolCall, r: StoredMessage) {
  if (r.status === "ok") return;
  if (isReadOnly(call.name)) {
    r.status = "cancelled";
    return;
  }
  r.status = "unknown";
  r.content += "\n\n（这个操作执行到一半被用户停止了，可能已经改了文件或产生了输出。继续之前先检查实际状态，不要直接重做。）";
}

/** 工具抛出的错误属于哪一类：给界面显示、给统计分类用 */
function classify(message: string): ErrorKind {
  if (/^参数有误|参数.*(JSON|解析)|缺少必填参数/.test(message)) return "args";
  if (/现在不可用|没有叫 .+ 的工具/.test(message)) return "unavailable";
  if (/ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|网络|连接超时|域名解析/.test(message)) return "network";
  if (/被拦截|不允许|拒绝访问|敏感/.test(message)) return "blocked";
  return "tool";
}

/** 接在系统提示词后面：告诉模型哪些工具这次用不了、为什么，免得它从历史里看到又去调 */
function disabledNote(disabled: Record<string, string>) {
  const list = Object.entries(disabled);
  if (!list.length) return "";
  return `\n\n## 当前不可用的工具\n${list.map(([n, why]) => `- ${n}：${why}`).join("\n")}\n不要调用它们。需要的话换别的工具完成；确实做不了就告诉用户原因。`;
}

/** 执行一个工具调用。不会抛错：失败也变成一条 isError 的 tool 消息 */
async function execTool(call: ToolCall, session: Session, ctx: ExecCtx): Promise<StoredMessage> {
  const startedAt = Date.now();
  const result: StoredMessage = { id: newId("m"), role: "tool", toolCallId: call.id, content: "", createdAt: startedAt };
  try {
    const tool = findTool(call.name);
    if (!tool) throw new Error(`没有叫 ${call.name} 的工具。能用的工具：${toolSpecs().filter((t) => !ctx.disabled[t.name]).map((t) => t.name).join("、")}`);
    if (ctx.disabled[call.name]) throw new Error(`${call.name} 现在不可用：${ctx.disabled[call.name]}。换别的工具完成，做不了就告诉用户原因`);
    // 宽容解析：重复两遍、套了代码块、末尾多逗号都能修；修不了时报错里带上原文（见 args.ts）
    const parsed = parseToolArgs(call.arguments);
    if (!parsed.ok) throw new Error(parsed.error);
    const args = parsed.args;
    const r = await tool.run(args, {
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      workspace: ctx.workspace,
      signal: ctx.signal,
      // 绑定 callId：工具里只管调用 onOutput / confirm，不用关心自己是哪次调用
      onOutput: (delta, stream) => ctx.emit({ type: "tool_output", callId: call.id, stream, delta }),
      confirm: (req) => ctx.confirm(call.id, req),
      emitArtifact: (a) => {
        // 来源由执行器绑定，工具只提供内容，不需要自己拼调用 ID。
        // 先记来源再保存：即使工具产出后报错、没有留下 artifactId 结果，也能定位到这次调用。
        const art: Artifact = { ...a, sourceToolCallId: call.id, id: newId("a"), createdAt: Date.now() };
        addArtifact(session, art);
        ctx.pending.push(art);
        return art;
      },
    });
    result.content = r.content;
    result.artifactId = r.artifactId;
    // 工具没抛错也不一定成功：命令退出码 1、超时、用户拒绝都在返回内容里。工具可以自己给 status，没给就按内容判断
    const st = r.status ? { status: r.status, errorKind: r.errorKind } : inferStatus(r.content);
    result.status = st.status;
    if (st.errorKind) result.errorKind = st.errorKind;
  } catch (e) {
    // 失败也要回给模型：让它知道出错并自行修正（换参数重试或换方案）
    const msg = e instanceof Error ? e.message : String(e);
    result.content = `工具执行失败：${msg}`;
    result.isError = true;
    result.status = "error";
    result.errorKind = classify(msg);
  }
  result.durationMs = Date.now() - startedAt;
  return result;
}
