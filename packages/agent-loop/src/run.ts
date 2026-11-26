import type { ChatMessage, LLMProvider, ToolCall, ToolSpec } from "../../llm/src/types";
import { ModelStreamInterrupted, requireModelEnd } from "../../llm/src/stream";
import { inferStatus, type AgentEvent, type Artifact, type ErrorKind, type Session, type StoredMessage, type ToolStatus } from "../../protocol/src/lib/shared";
import { addArtifact, addMessage, newId, replaceArtifact } from "../../storage/src/store";
import { describeToolResult } from "../../storage/src/tool-results";
import { searchHistory } from "../../storage/src/history";
import { historyReaders } from "../../storage/src/history-index";
import { allowSession, isSessionAllowed, waitApproval } from "../../permissions/src/approvals";
import { DEFAULT_MODEL_CONTEXT_WINDOW, type Settings } from "../../protocol/src/lib/settings";
import { DELEGATION_PROMPT, SYSTEM_PROMPT } from "../../system-prompt/src/prompt";
import { deferredCatalog, findTool, toolSpecs, toolsFor } from "../../tool-runtime/src/index";
import type { ApprovalRequest, ToolRegistry } from "../../tool-runtime/src/types";
import { FEEDBACK_TAG, limitFeedback, Verifier } from "../../verifier/src/verify";
import type { AgentRun } from "../../agent-core/agent/src/runtime-types";
import { NOTE_TAG } from "../../protocol/src/lib/message-tags";
import type { AgentModelSelection, AgentStepLogEvent } from "../../protocol/src/agent-events";
import { recordFileWrite, type FileRecovery } from "../../session/session-recovery/src/file-recovery";
import { normalizeArgs, parseToolArgs } from "./args";
import { CallGuard } from "./guard";
import { logUsage } from "../../application/usage/src/usage";
import { buildContext, compactThreshold, estimateRequest, estimateUsage, planCompact, summarize, withFileRecoveries } from "../../context-engine/src/context";
import { envPrompt, turnEnv } from "./env";
import { budgetHint, isPlanOnly, Progress, selfCheck } from "./steer";
import { DELEGATE_SPEC, RESEARCH_SPEC, runSubagentTool, type SubagentOrchestrator } from "../../subagent/src/subagent";
import { ParentDelegation } from "../../subagent/src/delegation-policy";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import nodePath from "node:path";
import { resolvePath } from "../../workspace/src/access";
import { replaceWorkspaceFile } from "../../workspace/src/file-write";
import { artifactExt } from "../../protocol/src/lib/outputs";
import type { ConversationTraceRecorder } from "../../conversation-trace/src/recorder";

/** 防止模型无限调用工具：一轮对话最多走这么多步（可在设置里改） */
const DEFAULT_MAX_STEPS = 25;
const DEFAULT_MAX_FIX_ROUNDS = 3;
/** 每轮自动修复额外多给的步数：一步改代码并运行，一步看结果后回答 */
const STEPS_PER_FIX = 2;
/** 一组最多同时跑几个只读工具：模型一次发 20 个网页抓取时分几组跑，避免占满连接和内存（M1-03） */
const MAX_PARALLEL = 6;
const isDelegation = (name: string) => name === RESEARCH_SPEC.name || name === DELEGATE_SPEC.name;
// 这些工具的正文用于当前步骤的指令、交付或有界回读，沿用原协议。
const inlineToolResults = new Set(["load_skill", "load_tools", "ask_user", "todo_write", ...historyReaders]);

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
 * - 用户引导由运行服务标为下一步输入；每次请求模型前写入历史，再确认消费。
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
 * - 委派工具：把只读调研或完整分工交给子 Agent，父轮收到结构化结果。
 *
 * 按需加载工具（tools/index.ts、tools/load-tools.ts）：每一步只发“常用工具 + 这个会话加载过的工具”的说明书，
 * 其余工具在系统提示词里只有一行目录；模型要用时先调 load_tools，下一步 toolsFor() 就会把它加进来。
 *
 * 调用方先通过 Agent Registry 取得运行权，再为每个输入调用一次本函数。
 * 这里负责一轮内的模型和工具执行，并产出流式事件。调用方写轮次结果并释放运行占用。
 */
export async function* runAgent(opts: Parameters<typeof executeTurn>[0]): AsyncGenerator<AgentEvent> {
  const parent = new ParentDelegation();
  let done;
  try {
    done = yield* executeTurn(opts, parent);
  } finally {
    // 提前关闭时取消本轮委派，等各任务在清理宽限内写入终态。
    await parent.close();
  }
  if (done) yield done;
}

async function* executeTurn(opts: {
  provider: LLMProvider;
  tools?: ToolRegistry;
  session: Session;
  /** 当前用户的工作区目录，文件工具只能在这里读写 */
  workspace: string;
  sessionWorkspace?: boolean;
  /** 当前用户 id：确认请求按用户隔离，别人不能替你点“允许” */
  userId: string;
  /** 终端命令什么时候要用户确认（设置页“命令确认”） */
  commandApproval?: Settings["commandApproval"];
  signal?: AbortSignal;
  /** 来自设置页：自定义系统提示词（空 = 用内置）和最大步数 */
  systemPrompt?: string;
  /** 用户绑定的项目规则在每轮开始时读取，也传给本轮派出的子 Agent。 */
  projectRules?: string;
  maxSteps?: number;
  /** 反馈闭环最多自动修复几轮，0 = 关闭 */
  maxFixRounds?: number;
  /** 长期记忆（已经排好版的一段文字），接在系统提示词后面 */
  memory?: string;
  /** 本次运行的下一步输入；提交成功前仍保留在收件箱里。 */
  steering?: AgentRun["steering"];
  /** 调用方绑定会话、运行和输入 ID。步骤日志只保存可展示的摘要。 */
  trace?: {
    selection: AgentModelSelection;
    emit(event: AgentStepLogEvent): void
  };
  /** 正文快照与摘要日志分开，只记录当前会话这一轮。 */
  conversationTrace?: ConversationTraceRecorder;
  /** 聊天入口绑定的执行身份。文件工具用它把检查点关联到当前步骤和原调用。 */
  execution?: { runId: string; inputId: string };
  /** 已保存的核验结论仅进入请求上下文。上一轮中断时，提示模型依据已有结果继续。 */
  recovery?: { interruptedInputId?: string; files: readonly FileRecovery[] };
  /** 这次运行用不了的工具：名字 → 原因（例如 Docker 沙箱不可用时的 run_command / run_python）。不发给模型，并在提示词里说明 */
  disabledTools?: Record<string, string>;
  /** 当前模型的上下文长度（token），决定什么时候压缩历史。默认 128k */
  contextWindow?: number;
  subagents?: SubagentOrchestrator;
  /** 产品入口明确传入普通会话的设置或项目默认；底层直接调用仍可委派。 */
  multiAgent?: boolean;
}, parentDelegation: ParentDelegation): AsyncGenerator<AgentEvent, Extract<AgentEvent, { type: "done" }> | void> {
  const { provider, session, signal, trace } = opts;
  const disabled: Record<string, string> = { ...opts.disabledTools };
  if (opts.multiAgent === false) disabled.research = disabled.delegate_tasks = "当前对话未开启多agent智能体模式";
  const env = await envPrompt(opts.workspace).catch(() => "");
  const registry = opts.tools ?? { deferredCatalog, findTool, toolSpecs, toolsFor };
  const catalog = registry.deferredCatalog(disabled);
  const recoveryHint = opts.recovery?.interruptedInputId
    ? "\n\n上一轮运行已中断。用户若要继续，请从保存的消息、工具结果和恢复核验结论接着处理。先核对结果未知的操作，避免重复写入。"
    : "";
  const custom = opts.systemPrompt?.trim();
  const prompt = (custom || SYSTEM_PROMPT) + (disabled.research ? "" : `\n\n子任务规则\n${DELEGATION_PROMPT}`);
  const system = [prompt, opts.projectRules, catalog, env, opts.memory].filter(Boolean).join("\n\n") + disabledNote(disabled) + recoveryHint;
  /** 这一步发给模型的工具：每一步重新从历史里算（上一步刚调用了 load_tools，这一步就带上新加载的说明书） */
  const delegationSpecs = disabled.research ? [] : [RESEARCH_SPEC, ...(!disabled.delegate_tasks ? [DELEGATE_SPEC] : [])];
  const toolsNow = () => [...registry.toolsFor(session.messages, disabled).filter(({ name }) => !isDelegation(name)), ...delegationSpecs];
  // 本轮的环境快照只取一次：同一轮的每一步都一样，请求前缀不变，缓存才能命中
  const snapshot = await turnEnv(opts.workspace).catch(() => "");
  const contextWindow = opts.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW;
  const threshold = compactThreshold(contextWindow);
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const currentInputId = opts.execution?.inputId ??
    session.messages[lastIndex(session.messages, (message) => message.role === "user" && !message.feedback)]?.id;
  const subagentOrigin = opts.execution ?? { runId: newId("run-"), inputId: newId("input-") };
  // 运行代码的工具都用不了时，反馈闭环没法要求“运行验证”，干脆关掉，免得逼模型去调不存在的工具
  const canRun = !disabled.run_python || !disabled.run_command;
  const verifier = new Verifier(canRun ? (opts.maxFixRounds ?? DEFAULT_MAX_FIX_ROUNDS) : 0);
  const guard = new CallGuard();
  const progress = new Progress();
  let failedCompactKeepFrom: string | undefined;
  let recalled: { retainedFrom: string; cards: ReturnType<typeof searchHistory> } | undefined;
  let planned = false; // 这一轮第一步写了规划
  let warmup = 0; // 本轮开头只读了技能（load_skill）的步数：读完技能后的第一步仍然可以只写规划
  let checked = false; // 已经自检过
  let toolRuns = 0;
  const pending: Artifact[] = [];
  const made = new Map<string, string>(); // 这一轮做出的产出物：“类型:标题” → id
  let awaitingUser = false;
  let interrupted = false;
  // 修复反馈可以追加步数，下方用 maxFixRounds 限制修复能扩展的预算。
  let budget = maxSteps;

  /**
   * 工具执行期间产生的事件（实时输出、确认请求）。
   * generator 只能在自己的代码里 yield，工具的回调里不能直接 yield，所以先放进队列，
   * 再调用 wake() 唤醒第 4 步的消费端，把事件 yield 出去。
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
    // 模型的 callId 可能在不同会话重复。用服务端生成的确认 ID 唤醒本次等待。
    const approvalId = crypto.randomUUID();
    emit({
      type: "approval",
      callId,
      approvalId,
      command: req.command,
      reason: req.reason
    });
    const d = await waitApproval(opts.userId, approvalId, signal);
    if (d === "allow_session") allowSession(session.id);
    emit({
      type: "approval_end",
      callId,
      allowed: d !== "deny"
    });
    return d !== "deny";
  };

  for (let step = 0; step < budget; step++) {
    if (signal?.aborted) break;

    // step 包含输入注入、模型请求和工具收尾。finally 只证明边界关闭，不代表工作成功。
    trace?.emit({
      kind: "step-start",
      detail: {
        step: step + 1,
        ...trace.selection
      }
    });
    try {
      // 用户刚补充的想法：调用模型前加进历史
      const guidanceIds = yield* injectNotes();

      // 最后一步：不再给工具，先告诉模型“步数用完了，直接总结”，避免发出了工具调用却没机会执行
      const lastStep = step === budget - 1 && step > 0;
      if (lastStep) yield* sendFeedback(session, limitFeedback(budget));

      // ---- 1~2. 调用模型 ----
      const t0 = Date.now();
      let finishReason: string | undefined;
      const assistant: StoredMessage = {
        id: newId("m"),
        role: "assistant",
        content: "",
        createdAt: t0
      };
      const calls: ToolCall[] = [];
      let thinkStart = 0;
      const endThinking = () => {
        if (thinkStart && assistant.reasoningMs === undefined) assistant.reasoningMs = Date.now() - thinkStart;
      };

      const stepTools = lastStep ? undefined : toolsNow();
      let messages: ChatMessage[];
      let turnStart: number | null;
      try {
        ({ messages, turnStart } = yield* prepareContext(step + 1, stepTools));
      } catch (e) {
        if (signal?.aborted) break;
        throw e;
      }
      // 步数用了一半以上：请求末尾提醒还剩几步（只发给模型，不存进历史）
      const hint = lastStep ? null : budgetHint(step, budget);
      if (hint) messages = [...messages, {
        role: "user",
        content: hint
      }];

      try {
        trace?.emit({
          kind: "model-request",
          detail: {
            step: step + 1,
            ...trace.selection,
          guidanceIds: guidanceIds.join(","),
            messageCount: messages.length,
            toolCount: stepTools?.length ?? 0
          }
        });
        const request = {
          messages,
          tools: stepTools,
          signal
        };
        const observed = opts.conversationTrace?.request(provider, request, {
          phase: "chat",
          step: step + 1,
          assistantId: assistant.id,
          turnStart,
          agent: {
            contextWindow,
            compactAt: threshold,
            stepBudget: budget,
            guidanceIds
          },
        });
        for await (const chunk of observed?.stream ?? requireModelEnd(provider.stream(request), signal)) {
          if (chunk.type === "done") finishReason = chunk.finishReason;
          if (chunk.type === "reasoning") {
            if (!thinkStart) thinkStart = Date.now();
            assistant.reasoning = (assistant.reasoning ?? "") + chunk.delta;
            yield {
              type: "reasoning",
              messageId: assistant.id,
              createdAt: t0,
              delta: chunk.delta
            };
          } else if (chunk.type === "text") {
            endThinking();
            assistant.content += chunk.delta;
            yield {
              type: "text",
              messageId: assistant.id,
              createdAt: t0,
              delta: chunk.delta
            };
          } else if (chunk.type === "tool_call_delta") {
            endThinking();
            yield {
              type: "tool_input",
              messageId: assistant.id,
              createdAt: t0,
              index: chunk.index,
              name: chunk.name,
              delta: chunk.delta
            };
          } else if (chunk.type === "tool_call") {
            endThinking();
            calls.push({
              ...chunk.call,
              arguments: normalizeArgs(chunk.call.arguments)
            });
          } else if (chunk.type === "raw") {
            assistant.raw = chunk.raw; // Claude 的原始回复（含思考签名），下次请求原样发回
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
        trace?.emit({
          kind: "model-result",
          detail: {
            step: step + 1,
            ...trace.selection,
          guidanceIds: guidanceIds.join(","),
            outcome: signal?.aborted ? "cancelled" : "failed",
          durationMs: assistant.durationMs,
            messageId: assistant.id
          }
        });
        if (!signal?.aborted) yield {
          type: "error",
          message: e instanceof Error ? e.message : String(e)
        };
        if (assistant.content || assistant.reasoning) {
          addMessage(session, assistant);
          yield {
            type: "assistant_end",
            message: assistant
          };
        }
        if (signal?.aborted) break;
        if (e instanceof ModelStreamInterrupted) {
          interrupted = true;
          break;
        }
        return;
      }

      endThinking();
      assistant.durationMs = Date.now() - t0;
      // 有的服务（本地模型、部分代理）不返回用量：按字数估算，并标记为估算值
      assistant.usage ??= estimateUsage(JSON.stringify(messages), (assistant.reasoning ?? "") + assistant.content + calls.map((c) => c.arguments).join(""));
      logUsage(opts.userId, session.id, "chat", assistant.usage, t0);
      if (calls.length && !lastStep && finishReason !== "length") assistant.toolCalls = calls;
      // 先保存调用声明，执行结果再用 callId 配对。进程退出时可能只留下声明，工具副作用需另行核对。
      addMessage(session, assistant);
      trace?.emit({
        kind: "model-result",
        detail: {
          step: step + 1,
          ...trace.selection,
          guidanceIds: guidanceIds.join(","),
          outcome: signal?.aborted ? "cancelled" : finishReason === "length" ? "output-truncated" : "completed",
        finishReason: finishReason ?? null,
          durationMs: assistant.durationMs,
          messageId: assistant.id,
        inputTokens: assistant.usage.inputTokens,
          outputTokens: assistant.usage.outputTokens,
          estimatedUsage: assistant.usage.estimated ?? false,
        toolCalls: assistant.toolCalls?.length ?? 0
        }
      });
      yield {
        type: "assistant_end",
        message: assistant
      };

      // 模型刚发出工具调用就被停止：每个调用都补一条“已取消”的结果，历史里不能有没结果的调用（M1-03）
      if (signal?.aborted) {
        yield* closeCalls(assistant.toolCalls ?? [], "cancelled", "用户点了停止，这个操作没有执行。");
        break;
      }

      // 输出达到模型上限时先收尾，避免执行本次可能被截断的调用或自动领取下一条输入。
      if (finishReason === "length") break;

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
          if (!lastStep && opts.steering?.pending().length) {
            budget = Math.max(budget, step + 2);
            continue;
          }
          break; // 通过（或修复轮数用完）：交付
        }
        yield* sendFeedback(session, fb);
        const fixLimit = maxSteps + Number(planned) + STEPS_PER_FIX * verifier.maxRounds;
        budget = Math.max(budget, Math.min(budget + STEPS_PER_FIX, fixLimit));
        continue;
      }

      // ---- 4. 执行工具，把结果写回历史 ----
      // ask_user 要单独一步：和别的操作混在一起时都不执行，让模型重新安排（先问、等回答，再做别的）（M1-03）
      const asks = calls.filter((c) => registry.findTool(c.name)?.endsTurn);
      if (asks.length && calls.length > 1) {
        yield* closeCalls(calls, "skipped", "ask_user 必须单独一步调用。这一步的所有操作都没有执行：需要问用户就只调用 ask_user，等用户回答后再做其他操作；不需要问就去掉 ask_user 重新调用。", "protocol");
        continue;
      }

      // 相邻的只读工具一起并行执行，有副作用的工具（写文件、跑代码）单独按顺序执行
      const execution = opts.execution;
      const recovery = opts.recovery;
      const ctx: ExecCtx = {
        registry,
        sessionId: session.id,
        inputId: currentInputId,
        userId: opts.userId,
        workspace: opts.workspace,
        signal,
        pending,
        made,
        emit,
        confirm,
        checkpointFileWrite: execution && ((callId, path, before, expected) => {
          if (recovery?.files.some((file) => file.inputId === recovery.interruptedInputId &&
            file.path === path && (file.verification === "changed" || file.verification === "unreadable"))) {
            throw new Error(`恢复核验发现 ${path} 已变化或无法读取。本轮请先核对文件内容，再请用户决定如何处理。`);
          }
          recordFileWrite({
            sessionId: session.id,
            runId: execution.runId,
            inputId: execution.inputId,
            assistantId: assistant.id,
            step: step + 1,
            callId
          }, path, before, expected, opts.sessionWorkspace);
        }),
        disabled,
        provider
      };
      const batches = toBatches(calls, registry);
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
        let running = 0;
        const completed: { call: ToolCall; result: StoredMessage }[] = [];
        const track = (call: ToolCall, execution: Promise<StoredMessage>) => {
          running++;
          const finish = (result: StoredMessage) => {
            completed.push({ call, result });
            wake();
          };
          // 每个工具只订阅一次完成事件。高并发下不会在每个实时片段重新监听所有未完成调用。
          void execution.then(finish, (error) => finish(errorResult(call, error instanceof Error ? error.message : String(error))));
        };
        for (const call of batch) {
          if (isDelegation(call.name) && (disabled.research || disabled[call.name])) {
            track(call, Promise.resolve({ ...errorResult(call, "当前运行已禁用子 Agent", "blocked"), status: "denied" }));
            continue;
          }
          // 同样的调用已经失败过两次：不再执行，直接把拦截原因作为结果（见 guard.ts）
          const blocked = guard.before(call);
          if (blocked) {
            track(call, Promise.resolve(errorResult(call, blocked, "blocked")));
            continue;
          }
          yield {
            type: "tool_start",
            callId: call.id,
            name: call.name,
            startedAt: Date.now()
          };
          const exec = isDelegation(call.name)
            ? executeDelegation(call, ctx, session, {
              orchestrator: opts.subagents, parent: parentDelegation, contextWindow,
              projectRules: opts.projectRules,
              origin: { ...subagentOrigin, parentCallId: `${assistant.id}:${call.id}` },
              trace: opts.conversationTrace && { recorder: opts.conversationTrace, step: step + 1 },
            })
            : execTool(call, session, ctx);
          track(call, exec.then((r) => guard.after(call, r)));
        }
        // 谁先完成谁先推给前端，不用等最慢的那个。
        // 同时等“有新的实时事件”（tick）：工具还在跑时，也能把终端输出、确认请求推出去
        while (running) {
          while (live.length) yield* live.splice(0);
          if (!completed.length) {
            await new Promise<void>((resolve) => { wake = resolve; });
            continue;
          }
          for (const { call, result } of completed.splice(0)) {
            running--;
            if (signal?.aborted) markStopped(call, result, registry);
            if (result.status !== "ok" && !isReadOnly(call.name, registry)) failed ??= call;
            verifier.observe(call, result);
            progress.observe(call, result);
            toolRuns++;
            while (pending.length) yield { type: "artifact", artifact: pending.shift()! };
            if (!inlineToolResults.has(call.name) && !isDelegation(call.name)) {
              const reference = describeToolResult(call.name, result.content);
              if (reference) result.toolResult = reference;
            }
            addMessage(session, result);
            yield { type: "message", message: result };
          }
        }
      }
      if (signal?.aborted) break;

      if (step === warmup && calls.every((c) => c.name === "load_skill")) warmup++;

      // ask_user：问题已经显示给用户，本轮到此结束，等用户回答
      if (asks.length) {
        awaitingUser = true;
        break;
      }

      // 连续几步没有新进展：发一条反馈，要求停下来重新规划（见 steer.ts）
      const stall = progress.endStep();
      if (stall && !signal?.aborted) yield* sendFeedback(session, stall);
    } finally {
      trace?.emit({
        kind: "step-end",
        detail: {
          step: step + 1,
          ...trace.selection
        }
      });
    }
  }

  return {
    type: "done",
    ...(awaitingUser ? { awaitingUser } : {}),
    ...(interrupted ? { interrupted: true } : {}),
  };

  /**
   * 准备这一步发给模型的历史（第 1 步）。
   * 先瘦身；预计仍超过阈值就做摘要压缩（多一次模型调用，摘要存进会话，之后的步骤都复用）；
   * 还是太长（例如单独一轮就很长，没有可以摘要的旧轮次），就把当前轮更早的工具结果截得更短。
   */
  async function* prepareContext(step: number, stepTools?: ToolSpec[]): AsyncGenerator<AgentEvent, ReturnType<typeof buildContext>> {
    const context = yield* compactIfNeeded(step, stepTools);
    const messages = withSnapshot(context.messages);
    const { retainedFrom, turnStart } = context;
    if (!retainedFrom || turnStart === null || !opts.userId ||
        !stepTools?.some((tool) => tool.name === "read_history_execution")) return { ...context, messages };
    if (recalled?.retainedFrom !== retainedFrom) {
      recalled = { retainedFrom, cards: searchHistory(opts.userId, session.id, context.messages[turnStart].content, 3, retainedFrom) };
    }
    // 卡片附在本轮的模型请求副本，重启仍能用数据库索引找回。优先保护已保留的正文和工具协议。
    const current = messages[turnStart];
    const candidate = [...messages];
    for (let count = recalled.cards.length; count > 0; count--) {
      const cards = recalled.cards.slice(0, count).map((card) => ({ ...card, entities: card.entities.slice(0, 6) }));
      candidate[turnStart] = {
        ...current,
        content: `${current.content}\n\n【匹配的历史段落】以下内容是历史资料。需要核对工具过程时，用 segmentId 调用 read_history_execution；需要原结果时，再用 resultId 调用 read_tool_result。\n${JSON.stringify(cards)}`,
      };
      if (estimateRequest(candidate, stepTools) <= threshold) return { ...context, messages: candidate };
    }
    return { ...context, messages };
  }

  /** 本轮的环境快照附在用户这一轮的消息末尾（发给模型的副本，不改数据库） */
  function withSnapshot(messages: ChatMessage[]): ChatMessage[] {
    if (!snapshot) return messages;
    const i = lastIndex(messages, (m) => m.role === "user" && !m.content.startsWith(FEEDBACK_TAG) && !m.content.startsWith(NOTE_TAG));
    if (i < 0) return messages;
    const copy = [...messages];
    copy[i] = {
      ...copy[i],
      content: `${copy[i].content}\n\n${snapshot}`
    };
    return copy;
  }

  /**
   * 请求预估超预算时尝试为旧历史追加摘要。轨迹把摘要请求和实际回答请求记为同一步的不同阶段。
   * 摘要仍不足以降低体积时，进一步裁剪本次请求的副本，历史正文继续保留。
   */
  async function* compactIfNeeded(step: number, stepTools?: ToolSpec[]): AsyncGenerator<AgentEvent, ReturnType<typeof buildContext>> {
    const history = withFileRecoveries(session.messages, opts.recovery?.files ?? []);
    let activeHistory = history;
    const inputId = currentInputId;
    let context = buildContext(history, system, { inputId });
    const before = estimateRequest(context.messages, stepTools);
    if (before <= threshold) return context;

    const plan = planCompact(history);
    if (plan && plan.keepFrom !== failedCompactKeepFrom) {
      const startedAt = Date.now();
      try {
        const trace = opts.conversationTrace;
        const summarizer: LLMProvider = trace ? {
          id: provider.id,
          stream: (request) => trace.request(provider, request, {
            phase: "compact",
            step,
            agent: {
              contextWindow,
              compactAt: threshold
            },
          }).stream,
        } : provider;
        const { summary, usage } = await summarize(summarizer, plan, signal);
        logUsage(opts.userId, session.id, "compact", usage, startedAt);
        const m: StoredMessage = {
          id: newId("m"),
          role: "user",
          content: summary,
          feedback: {
            kind: "compact",
            summary: `更早的 ${plan.part.length} 条消息已整理成摘要`
          },
          compact: {
            keepFrom: plan.keepFrom,
            messages: plan.part.length,
            tokensBefore: before,
            tokensAfter: 0
          },
          usage,
          createdAt: startedAt,
          durationMs: Date.now() - startedAt,
        };
        const nextHistory = [...history, m];
        const candidate = buildContext(nextHistory, system, { inputId });
        m.compact!.tokensAfter = estimateRequest(candidate.messages, stepTools);
        if (m.compact!.tokensAfter >= before) throw new Error("摘要未缩小请求上下文");
        m.feedback!.summary += `（约 ${fmtK(before)} → ${fmtK(m.compact!.tokensAfter)} tokens）`;
        // 提交失败时继续使用上一份活动视图，避免这一步看到重启后无法恢复的摘要。
        addMessage(session, m);
        activeHistory = nextHistory;
        context = candidate;
        yield {
          type: "message",
          message: m
        };
      } catch (e) {
        if (signal?.aborted) throw e;
        failedCompactKeepFrom = plan.keepFrom;
        // 摘要失败不影响回答：用瘦身后的历史继续，只打日志
        console.warn("[context] 压缩失败：", e instanceof Error ? e.message : e);
      }
    }
    if (estimateRequest(context.messages, stepTools) > threshold) context = buildContext(activeHistory, system, { tight: true, inputId });
    return context;
  }

  /**
   * 给没有执行的调用补上结果（取消 / 跳过），写进历史并推给前端。
   * 模型的每个 tool_call 都必须有一条对应的 tool 结果，否则下次请求会被 API 拒绝（400）。
   */
  function* closeCalls(list: ToolCall[], status: ToolStatus, why: string, errorKind?: ErrorKind): Generator<AgentEvent> {
    for (const call of list) {
      if (session.messages.some((m) => m.role === "tool" && m.toolCallId === call.id)) continue;
      const m: StoredMessage = {
        ...errorResult(call, `未执行（${status === "cancelled" ? "已取消" : "已跳过"}）：${why}`),
        status,
        errorKind
      };
      addMessage(session, m);
      yield {
        type: "message",
        message: m
      };
    }
  }

  /**
   * 在模型请求前将引导写入历史，沿用排队时的消息 ID。正文写入失败时保留队列项。
   * 正文提交后确认出队。后续 model-request 用返回的 ID 记录哪些引导实际进入了请求。
   */
  function* injectNotes(): Generator<AgentEvent, string[]> {
    const steering = opts.steering;
    const ids: string[] = [];
    if (!steering) return ids;
    for (const { id, message: text } of steering.pending()) {
      if (signal?.aborted) return ids;
      const m: StoredMessage = {
        id,
        role: "user",
        content: NOTE_TAG + text,
        feedback: {
          kind: "note",
          summary: text
        },
        createdAt: Date.now(),
      };
      addMessage(session, m);
      steering.committed(id);
      ids.push(id);
      yield {
        type: "message",
        message: m
      };
    }
    return ids;
  }
}

/** 把一条自动反馈写进历史（发给模型时是 user 消息），并推给前端显示在过程里 */
function* sendFeedback(session: Session, fb: {
  content: string;
  feedback: StoredMessage["feedback"]
}): Generator<AgentEvent> {
  const m: StoredMessage = {
    id: newId("m"),
    role: "user",
    content: fb.content,
    feedback: fb.feedback,
    createdAt: Date.now()
  };
  addMessage(session, m);
  yield {
    type: "message",
    message: m
  };
}

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/**
 * 把一轮里的工具调用按副作用分组。连续只读段内的全部委派一起启动，普通工具仍按批次运行。
 * 例：[read, read, write, read] → [[read, read], [write], [read]]
 * 保留原顺序，所以“先写文件再运行”这类有依赖的调用不会乱。
 */
function toBatches(calls: ToolCall[], registry: ToolRegistry): ToolCall[][] {
  const batches: ToolCall[][] = [];
  let first: ToolCall[] = [];
  let extra: ToolCall[] = [];
  let ordinary = 0;
  const flush = () => {
    if (first.length) batches.push(first);
    for (let i = 0; i < extra.length; i += MAX_PARALLEL) batches.push(extra.slice(i, i + MAX_PARALLEL));
    first = [];
    extra = [];
    ordinary = 0;
  };
  for (const call of calls) {
    if (!isReadOnly(call.name, registry)) {
      flush();
      batches.push([call]);
    } else if (isDelegation(call.name) || ordinary++ < MAX_PARALLEL) first.push(call);
    else extra.push(call);
  }
  flush();
  return batches;
}

interface ExecCtx {
  registry: ToolRegistry;
  sessionId: string;
  inputId?: string;
  userId: string;
  workspace: string;
  signal?: AbortSignal;
  pending: Artifact[];
  /** 这一轮已经做出的产出物（“类型:标题” → id）。同一轮里同类型同标题再提交 = 修改那一份，不新建 */
  made: Map<string, string>;
  emit(e: AgentEvent): void;
  confirm(callId: string, req: ApprovalRequest): Promise<boolean>;
  checkpointFileWrite?(callId: string, path: string, before: string | null, expected: string): void;
  disabled: Record<string, string>;
  provider: LLMProvider;
}

/** 委派结果沿用主工具消息格式；实时进度归属发起委派的工具调用。 */
async function executeDelegation(call: ToolCall, ctx: ExecCtx, session: Session, options: Pick<Parameters<typeof runSubagentTool>[1],
  "orchestrator" | "parent" | "origin" | "trace" | "contextWindow" | "projectRules">): Promise<StoredMessage> {
  const startedAt = Date.now();
  const r = await runSubagentTool(call, {
    ...options,
    provider: ctx.provider,
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    workspace: ctx.workspace,
    signal: ctx.signal,
    disabled: ctx.disabled,
    session,
    registry: ctx.registry,
    onOutput: (text) => ctx.emit({
      type: "tool_output",
      callId: call.id,
      stream: "out",
      delta: text
    }),
    // 收到的是已独立结算的记录。即时输出沿用工具进度，模型仍收到原调用的一条完整结果。
    onSettlement: ({ record, failed }) => ctx.emit({
      type: "tool_output",
      callId: call.id,
      stream: "out",
      delta: `子任务 ${record.id} ${failed ? "无法保存终态" : `已结算（${record.status}）`}\n`
    }),
  });
  return {
    id: newId("m"),
    role: "tool",
    toolCallId: call.id,
    content: r.content,
    isError: r.isError,
    status: r.status,
    ...(r.isError ? { errorKind: r.errorKind ?? "tool" as const } : {}),
    createdAt: startedAt,
    durationMs: Date.now() - startedAt,
  };
}

function lastIndex<T>(arr: T[], fn: (x: T) => boolean) {
  for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i])) return i;
  return -1;
}

/** 没有执行就失败的工具结果（被拦截、跳过、取消） */
function errorResult(call: ToolCall, content: string, errorKind: ErrorKind = "tool"): StoredMessage {
  return {
    id: newId("m"),
    role: "tool",
    toolCallId: call.id,
    content,
    isError: true,
    status: "error",
    errorKind,
    createdAt: Date.now(),
    durationMs: 0
  };
}

/** 只读工具（可以并行的那些）：停止或失败都不会改坏东西 */
const isReadOnly = (name: string, registry: ToolRegistry) => isDelegation(name) || !!registry.findTool(name)?.parallelSafe;

/**
 * 工具执行期间用户点了停止，工具带着失败结果返回：
 * 只读操作 → 已取消；写文件、跑命令 → 结果不确定（可能已经改了一部分），提醒先检查，不能当成“没执行”直接重做。
 * 停止前就已经成功的结果保持成功。
 */
function markStopped(call: ToolCall, r: StoredMessage, registry: ToolRegistry) {
  if (r.status === "ok") return;
  if (isReadOnly(call.name, registry)) {
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
  const result: StoredMessage = {
    id: newId("m"),
    role: "tool",
    toolCallId: call.id,
    content: "",
    createdAt: startedAt
  };
  try {
    const tool = ctx.registry.findTool(call.name);
    if (!tool) throw new Error(`没有叫 ${call.name} 的工具。能用的工具：${ctx.registry.toolSpecs().filter((t) => !ctx.disabled[t.name]).map((t) => t.name).join("、")}`);
    if (ctx.disabled[call.name]) throw new Error(`${call.name} 现在不可用：${ctx.disabled[call.name]}。换别的工具完成，做不了就告诉用户原因`);
    // 宽容解析：重复两遍、套了代码块、末尾多逗号都能修；修不了时报错里带上原文（见 args.ts）
    const parsed = parseToolArgs(call.arguments);
    if (!parsed.ok) throw new Error(parsed.error);
    const args = parsed.args;
    const checkpoint = ctx.checkpointFileWrite;
    const r = await tool.run(args, {
      sessionId: ctx.sessionId,
      inputId: ctx.inputId,
      projectId: session.projectId,
      userId: ctx.userId,
      workspace: ctx.workspace,
      signal: ctx.signal,
      checkpointFileWrite: checkpoint && ((path, before, expected) => checkpoint(call.id, path, before, expected)),
      // 绑定 callId：工具里只管调用 onOutput / confirm，不用关心自己是哪次调用
      onOutput: (delta, stream) => ctx.emit({
        type: "tool_output",
        callId: call.id,
        stream,
        delta
      }),
      confirm: (req) => ctx.confirm(call.id, req),
      emitArtifact: (a) => {
        // create_artifact 的网页检查会让模型“改好后用同一个标题重新提交”，以前每次提交都新建一份，
        // 当前卡片 ID 保持不变，存储层追加正文版本，历史中的旧正文也能追溯。
        const key = a.workspaceApp ? `app:${a.workspaceApp.id}` : `${a.kind}:${a.title}`;
        const prev = session.artifacts.find((x) => x.id === ctx.made.get(key));
        const art: Artifact = prev ? {
          ...a,
          id: prev.id,
          createdAt: prev.createdAt
        } : {
          ...a,
          id: newId("a"),
          createdAt: Date.now()
        };
        art.sourceToolCallId = call.id;
        // 同时存一份到工作区 output/ 下，在文件夹里也能找到、下载（和 write_document 生成的文件放在一起）
        if (!art.workspaceApp) art.file = prev?.file ?? saveArtifactFile(ctx.workspace, session.id, art);
        if (art.file && !prev?.file) art.fileCreated = true;
        if (art.file && prev?.file && art.kind === "markdown") {
          const { full } = resolvePath(ctx.workspace, art.file, "write");
          // 用户勾选过的原文件可能比产出快照更新。这时让模型回读后局部修改。
          if (existsSync(full) && !replaceWorkspaceFile(full, Buffer.from(prev.content), Buffer.from(art.content))) {
            throw new Error(`计划文件已更新：${art.file}。请用 read_file 读取并用 edit_file 局部修改。`);
          }
          if (!existsSync(full) && !writeArtifactFile(ctx.workspace, art.file, art.content, true)) art.file = undefined;
        } else if (art.file && prev?.file && !writeArtifactFile(ctx.workspace, art.file, art.content)) {
          // 写入失败时仍保存正文，预览和下载可以使用会话快照。
          art.file = undefined;
        }
        if (prev) replaceArtifact(session, art);
        else addArtifact(session, art);
        ctx.made.set(key, art.id);
        ctx.pending.push(art);
        return art;
      },
    });
    result.content = r.content;
    result.artifactId = r.artifactId;
    // 工具没抛错也不一定成功：命令退出码 1、超时、用户拒绝都在返回内容里。工具可以自己给 status，没给就按内容判断
    const st = r.status ? {
      status: r.status,
      errorKind: r.errorKind
    } : inferStatus(r.content);
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

/* ---------------- 产出物同时保存成文件 ---------------- */

/** 自动保存的产出按会话分目录。同名标题各自分配文件，旧产出仍使用原路径。 */
function saveArtifactFile(workspace: string, sessionId: string, a: Artifact): string | undefined {
  try {
    const base = a.title.replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^[._]+|_+$/g, "").slice(0, 60) || "artifact";
    const ext = artifactExt(a);
    const scope = /^[a-zA-Z0-9_-]+$/.test(sessionId) ? sessionId : Buffer.from(sessionId).toString("base64url");
    for (let i = 1; i < 100; i++) {
      const rel = `output/${scope}/${base}${i > 1 ? ` (${i})` : ""}.${ext}`;
      const { full } = resolvePath(workspace, rel, "write");
      if (existsSync(full)) continue;
      if (writeArtifactFile(workspace, rel, a.content, true)) return rel;
      return;
    }
  } catch {
    /* 工作区不可写就只放在面板里 */
  }
  return undefined;
}

/** 尝试同步产出到工作区文件。写入失败时，执行方仍可把正文保存到会话产出面板。 */
function writeArtifactFile(workspace: string, rel: string, content: string, exclusive = false) {
  try {
    const { full } = resolvePath(workspace, rel, "write");
    mkdirSync(/*turbopackIgnore: true*/ nodePath.dirname(full), { recursive: true });
    writeFileSync(/*turbopackIgnore: true*/ full, content, { encoding: "utf8", flag: exclusive ? "wx" : "w" });
    return true;
  } catch {
    return false;
  }
}
