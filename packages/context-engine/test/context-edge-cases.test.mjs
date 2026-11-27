import assert from "node:assert/strict";
import { test } from "node:test";
import { data, db, load, runAgent, store } from "../../../tests/fixtures/agent-runtime.mjs";

const {
  buildContext,
  calibratedRequestTokens,
  calibrationFactor,
  COMPACT_TAG,
  compactThreshold,
  fitHardBudget,
  hardInputBudget,
  pairCalls,
  planCompact,
  summarize,
  withFileRecoveries,
} = load("packages/context-engine/src/context.ts");
const { deriveWorkingState } = load("packages/context-engine/src/working-state.ts");
const { describeToolResult, readToolResult } = load("packages/storage/src/tool-results.ts");
const { searchHistory, readHistoryExecution } = load("packages/storage/src/history.ts");
const { searchSavedHistory, readSavedHistoryExecution } = load("packages/tools/src/history.ts");
const { createProject } = load("packages/application/projects/src/projects.ts");
const { createConversationTrace } = load("packages/conversation-trace/src/recorder.ts");
const { listTraceEntries, readTraceEntry } = load("packages/conversation-trace/src/store.ts");
const { toAnthropic } = load("packages/llm/src/providers/anthropic.ts");
const { FEEDBACK_TAG } = load("packages/verifier/src/verify.ts");
const { NOTE_TAG } = load("packages/protocol/src/lib/message-tags.ts");

/**
 * 专门针对上下文工程高风险边界的回归测试：
 * 覆盖 Prompt Cache 前缀稳定性、工作态状态流转与隔离、协议配对与崩溃恢复、
 * 摘要重试封顶与无效压缩拦截、硬预算三级退化（含纯英文/ASCII 密度）、
 * 用量校准夹紧与衰减、硬护栏撤回召回卡片，以及大结果关键词分页与归档隔离。
 */

test("同轮新建产出物不击穿系统提示词缓存；本轮补充即时使旧计划/验证过期；重试成功自动消错且不泄漏已压缩正文", () => {
  const history = [
    // 已压缩区间：包含一条失败尝试和敏感旧正文，不应经由 workingStatePrompt 泄漏回系统提示词
    { id: "old-u", role: "user", content: "早年历史任务：旧正文 LEAK_GUARD_SECRET", createdAt: 1 },
    { id: "old-a", role: "assistant", content: "", createdAt: 2, toolCalls: [
      { id: "old-c1", name: "web_fetch", arguments: JSON.stringify({ url: "https://legacy.invalid/old" }) },
    ] },
    { id: "old-r1", role: "tool", toolCallId: "old-c1", status: "error", isError: true, createdAt: 3, content: '{"error":"旧历史报错"}' },
    // 保留区间的上一轮：计划 + 写/验证/再编辑 + 先失败后成功重试
    { id: "keep-u", role: "user", content: "生成指标汇总脚本并验证", createdAt: 10 },
    { id: "keep-a1", role: "assistant", content: "", createdAt: 11, toolCalls: [
      { id: "k-plan", name: "todo_write", arguments: "{}" },
      { id: "k-w1", name: "write_file", arguments: JSON.stringify({ path: "scripts/report.py", content: "print(1)" }) },
      { id: "k-w2", name: "write_file", arguments: JSON.stringify({ path: "scripts/helper.py", content: "x = 1" }) },
      { id: "k-run1", name: "run_python", arguments: JSON.stringify({ code: "exec(open('scripts/report.py').read())" }) },
      { id: "k-run2", name: "run_python", arguments: JSON.stringify({ code: "exec(open('scripts/helper.py').read())" }) },
      { id: "k-fail", name: "read_file", arguments: JSON.stringify({ path: "data/retry.csv" }) },
    ] },
    { id: "k-r-plan", role: "tool", toolCallId: "k-plan", status: "ok", createdAt: 12, content: JSON.stringify({
      todos: [{ content: "输出季度汇总", status: "in_progress" }],
    }) },
    { id: "k-r-w1", role: "tool", toolCallId: "k-w1", status: "ok", createdAt: 13, content: '{"path":"scripts/report.py"}' },
    { id: "k-r-w2", role: "tool", toolCallId: "k-w2", status: "ok", createdAt: 14, content: '{"path":"scripts/helper.py"}' },
    { id: "k-r-run1", role: "tool", toolCallId: "k-run1", status: "ok", createdAt: 15, content: '{"exitCode":0}' },
    { id: "k-r-run2", role: "tool", toolCallId: "k-run2", status: "ok", createdAt: 16, content: '{"exitCode":0}' },
    { id: "k-r-fail", role: "tool", toolCallId: "k-fail", status: "error", isError: true, createdAt: 17, content: '{"error":"暂时锁表"}' },
    // 同一轮后续步骤：retry.csv 重试成功（应清除旧失败）；helper.py 被再次编辑（应重置为未验证）
    { id: "keep-a2", role: "assistant", content: "", createdAt: 18, toolCalls: [
      { id: "k-ok", name: "read_file", arguments: JSON.stringify({ path: "data/retry.csv" }) },
      { id: "k-edit", name: "edit_file", arguments: JSON.stringify({ path: "scripts/helper.py" }) },
    ] },
    { id: "k-r-ok", role: "tool", toolCallId: "k-ok", status: "ok", createdAt: 19, content: "id,val\n1,2" },
    { id: "k-r-edit", role: "tool", toolCallId: "k-edit", status: "ok", createdAt: 20, content: '{"ok":true}' },
    // 压缩记录覆盖到 keep-u
    { id: "cmp-1", role: "user", content: '{"goal":"旧目标","constraints":[],"confirmed":[],"progress":[],"pending":[]}', createdAt: 21,
      feedback: { kind: "compact", summary: "已压缩" }, compact: { keepFrom: "keep-u", messages: 3, tokensBefore: 4000, tokensAfter: 600 } },
    // 当前轮第 1 步
    { id: "cur-u", role: "user", content: "继续完善输出", createdAt: 30 },
  ];

  const prevArtifact = { id: "art-prev", title: "历史初稿", kind: "markdown", content: "# v1", file: "out/v1.md", createdAt: 15, sourceToolCallId: "k-w1" };
  const step1Ctx = buildContext(history, "固定系统提示", { inputId: "cur-u", artifacts: [prevArtifact] });
  const sys1 = step1Ctx.messages[0].content;

  // 1. 不泄漏已压缩掉的旧正文与旧失败，且重试成功的 read_file(data/retry.csv) 已从失败列表消除
  assert.ok(!sys1.includes("LEAK_GUARD_SECRET"));
  assert.ok(!sys1.includes("legacy.invalid"));
  assert.ok(!sys1.includes("暂时锁表"));
  assert.match(sys1, /scripts\/report\.py\(写·已验证\)/);
  assert.match(sys1, /scripts\/helper\.py 已修改但尚未运行验证/);
  assert.match(sys1, /历史初稿\(out\/v1\.md\)/);

  // 2. 当前轮中途新增普通步骤与新产出物，系统提示词必须逐字节不变以保护 Prompt Cache
  const step2History = [
    ...history,
    { id: "cur-a1", role: "assistant", content: "", createdAt: 31, toolCalls: [
      { id: "cur-c1", name: "write_file", arguments: JSON.stringify({ path: "out/v2.md", content: "# v2" }) },
    ] },
    { id: "cur-r1", role: "tool", toolCallId: "cur-c1", status: "ok", createdAt: 32, content: '{"path":"out/v2.md"}' },
  ];
  const midTurnArtifact = { id: "art-cur", title: "本轮新稿", kind: "markdown", content: "# v2", file: "out/v2.md", createdAt: 32, sourceToolCallId: "cur-c1" };
  const step2Ctx = buildContext(step2History, "固定系统提示", { inputId: "cur-u", artifacts: [prevArtifact, midTurnArtifact] });
  assert.equal(step2Ctx.messages[0].content, sys1);
  assert.ok(!step2Ctx.messages[0].content.includes("本轮新稿"));

  // 3. 当前轮中途收到运行中补充（feedback.kind === "note"），旧计划与旧代码验证立即标为过时
  const step3History = [
    ...step2History,
    { id: "cur-note", role: "user", content: NOTE_TAG + "改成按周统计", feedback: { kind: "note", summary: "改成按周统计" }, createdAt: 33 },
  ];
  const step3Ctx = buildContext(step3History, "固定系统提示", { inputId: "cur-u", artifacts: [prevArtifact, midTurnArtifact] });
  assert.match(step3Ctx.messages[0].content, /已过时：生成于最新约束之前/);
  assert.match(step3Ctx.messages[0].content, /scripts\/report\.py\(写·验证已过时\)/);

  // 同步核对 deriveWorkingState 结构字段本身
  const state = deriveWorkingState(history.slice(3, -1), [prevArtifact], [step3History.at(-1)]);
  assert.equal(state.failedApproaches.length, 0);
  assert.equal(state.plan.stale, true);
  assert.equal(state.files.find((f) => f.path === "scripts/report.py").staleVerification, true);
  assert.equal(state.files.find((f) => f.path === "scripts/helper.py").verified, false);
});

test("pairCalls 与 withFileRecoveries 兜底孤立/缺失调用并保持真实结果优先，planCompact 排除合成恢复 ID", () => {
  // 1. pairCalls 丢弃孤立 tool 结果，为中断漏结果的 toolCall 补全占位并满足 Anthropic 协议
  const broken = [
    { role: "system", content: "sys" },
    { role: "user", content: "执行两步" },
    { role: "tool", toolCallId: "orphan-call", content: "孤立遗留结果" },
    { role: "assistant", content: "", toolCalls: [
      { id: "c-done", name: "read_file", arguments: '{"path":"a.txt"}' },
      { id: "c-lost", name: "write_file", arguments: '{"path":"b.txt","content":"1"}' },
    ] },
    { role: "tool", toolCallId: "c-done", content: "a内容" },
    { role: "tool", toolCallId: "wrong-id", content: "不匹配的脏结果" },
    { role: "user", content: "继续" },
  ];
  const paired = pairCalls(broken);
  assert.ok(!paired.some((m) => m.toolCallId === "orphan-call" || m.toolCallId === "wrong-id"));
  const toolIds = paired.filter((m) => m.role === "tool").map((m) => m.toolCallId);
  assert.deepEqual(toolIds, ["c-done", "c-lost"]);
  const synthesized = paired.find((m) => m.toolCallId === "c-lost");
  assert.match(synthesized.content, /没有结果/);
  // 验证转换到 Anthropic 消息体后 tool_use / tool_result 合法配对
  const anthropic = toAnthropic(paired);
  assert.equal(anthropic.messages[0].role, "user");
  const resultBlocks = anthropic.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result") : []));
  assert.deepEqual(resultBlocks.map((b) => b.tool_use_id), ["c-done", "c-lost"]);

  // 2. withFileRecoveries：真实已保存结果优先，缺失调用补 recovery:* 且非 matches-expected 标记 isError
  const longHistory = [
    { id: "u1", role: "user", content: "修改三个配置文件 " + "背景说明".repeat(900), createdAt: 1 },
    { id: "a1", role: "assistant", content: "", createdAt: 2, toolCalls: [
      { id: "w-saved", name: "write_file", arguments: '{"path":"a.json"}' },
      { id: "w-ok", name: "write_file", arguments: '{"path":"b.json"}' },
      { id: "w-changed", name: "write_file", arguments: '{"path":"c.json"}' },
    ] },
    { id: "r-saved", role: "tool", toolCallId: "w-saved", status: "ok", content: "真实落库结果", createdAt: 3 },
    { id: "u2", role: "user", content: "继续检查", createdAt: 4 },
    { id: "a2", role: "assistant", content: "好", createdAt: 5 },
    { id: "u3", role: "user", content: "第三轮", createdAt: 6 },
    { id: "a3", role: "assistant", content: "收到", createdAt: 7 },
    { id: "u4", role: "user", content: "第四轮", createdAt: 8 },
  ];
  const recovered = withFileRecoveries(longHistory, [
    { assistantId: "a1", callId: "w-saved", inputId: "u1", path: "a.json", verification: "changed", checkedAt: 10 },
    { assistantId: "a1", callId: "w-ok", inputId: "u1", path: "b.json", verification: "matches-expected", checkedAt: 11 },
    { assistantId: "a1", callId: "w-changed", inputId: "u1", path: "c.json", verification: "changed", checkedAt: 12 },
    { assistantId: "a1", callId: "not-in-calls", inputId: "u1", path: "d.json", verification: "unreadable", checkedAt: 13 },
  ]);
  const rSavedList = recovered.filter((m) => m.toolCallId === "w-saved");
  assert.equal(rSavedList.length, 1);
  assert.equal(rSavedList[0].content, "真实落库结果");
  const recOk = recovered.find((m) => m.id === "recovery:a1:w-ok");
  const recChanged = recovered.find((m) => m.id === "recovery:a1:w-changed");
  assert.equal(recOk.isError, false);
  assert.equal(recChanged.isError, true);
  assert.equal(recovered.find((m) => m.toolCallId === "not-in-calls"), undefined);

  // 3. planCompact 构造 sources 时必须过滤掉 recovery:* 合成消息 ID
  const plan = planCompact(recovered);
  assert.ok(plan);
  assert.equal(plan.sources.has("r-saved"), true);
  assert.equal(plan.sources.has("recovery:a1:w-ok"), false);
  assert.equal(plan.sources.has("recovery:a1:w-changed"), false);
});

test("summarize 剥离 <think> 并拦截超长输出；连续两次校验失败停在上限 2，runAgent 记住失败边界后降级 tight 不死循环", async () => {
  const sourceUser = { id: "u-src", role: "user", content: "核对清单 ALPHA-99", createdAt: 1 };
  const fakePlan = {
    previous: "",
    part: [sourceUser],
    sources: new Map([[sourceUser.id, sourceUser]]),
    keepFrom: "u-keep",
    tokens: 3000,
  };

  // 1. 剥离 <think>...</think> 后能正常通过结构校验
  const thinkProvider = {
    id: "test-think",
    async *stream() {
      yield {
        type: "text",
        delta: `<think>先分析一下原始需求</think>\n${JSON.stringify({
          goal: "核对清单",
          constraints: [],
          confirmed: [{ sourceId: "u-src", quote: "ALPHA-99" }],
          progress: [],
          pending: [],
        })}`,
      };
      yield { type: "done", finishReason: "stop", usage: { inputTokens: 100, outputTokens: 50 } };
    },
  };
  const ok = await summarize(thinkProvider, fakePlan);
  assert.equal(JSON.parse(ok.summary).confirmed[0].quote, "ALPHA-99");

  // 2. 摘要输出超过 16,000 字符上限时直接拒绝，且最多尝试 2 次后抛出
  let oversizedAttempts = 0;
  const oversizedProvider = {
    id: "test-oversized",
    async *stream() {
      oversizedAttempts++;
      yield { type: "text", delta: "x".repeat(16_050) };
      yield { type: "done", finishReason: "stop" };
    },
  };
  await assert.rejects(() => summarize(oversizedProvider, fakePlan), /摘要正文超出保存上限/);
  assert.equal(oversizedAttempts, 2);

  // 3. runAgent 中摘要连续 2 次失败后，记下 failedCompactKeepFrom，同轮后续步不再重复调摘要，降级 tight 正常收尾
  const s = store.createSession("u");
  for (let i = 1; i <= 4; i++) {
    store.addMessage(s, { id: `u${i}`, role: "user", content: `第 ${i} 轮长任务 ` + "历史说明".repeat(380), createdAt: i * 10 });
    if (i < 4) store.addMessage(s, { id: `a${i}`, role: "assistant", content: `第 ${i} 轮答复 ` + "详细细节".repeat(380), createdAt: i * 10 + 1 });
  }
  const stepTool = {
    spec: { name: "noop_tool", description: "测试工具", parameters: { type: "object", properties: {} } },
    parallelSafe: true,
    run: async () => ({ content: "工具返回" }),
  };
  const specs = () => [stepTool.spec];
  let compactCalls = 0;
  let chatCalls = 0;
  const trace = createConversationTrace({ sessionId: s.id, runId: "run-compact-fail", inputId: "u4", model: "test", effort: "default" });
  const provider = {
    id: "test-fail-compact",
    async *stream({ messages }) {
      if (messages[0].content.startsWith(COMPACT_TAG)) {
        compactCalls++;
        yield { type: "text", delta: "不是合法JSON" };
        yield { type: "done", finishReason: "stop", usage: { inputTokens: 200, outputTokens: 20 } };
        return;
      }
      chatCalls++;
      if (chatCalls === 1) {
        yield { type: "tool_call", call: { id: "c1", name: "noop_tool", arguments: "{}" } };
        yield { type: "done", finishReason: "tool_calls", usage: { inputTokens: 10_000, outputTokens: 30 } };
        return;
      }
      yield { type: "text", delta: "降级完成后正常回答" };
      yield { type: "done", finishReason: "stop", usage: { inputTokens: 10_200, outputTokens: 20 } };
    },
  };
  for await (const event of runAgent({
    session: s,
    provider,
    userId: "u",
    workspace: data,
    multiAgent: false,
    contextWindow: 16_000,
    maxSteps: 4,
    conversationTrace: trace,
    execution: { runId: "run-compact-fail", inputId: "u4" },
    tools: { toolsFor: specs, toolSpecs: specs, deferredCatalog: () => "", findTool: () => stepTool },
  })) {
    assert.notEqual(event.type, "error", event.message);
  }
  // 2 步对话里只在第 1 步尝试了 2 次摘要（1 次首试 + 1 次纠错），第 2 步因 failedCompactKeepFrom 直接跳过
  assert.equal(compactCalls, 2);
  assert.equal(chatCalls, 2);
  assert.equal(store.getSession(s.id, "u").messages.some((m) => m.feedback?.kind === "compact"), false);
  const chatEntries = listTraceEntries(s.id, "u")
    .filter((e) => e.meta.kind === "request" && e.meta.phase === "chat")
    .map((e) => readTraceEntry(s.id, "u", e.id, true));
  assert.equal(chatEntries.length, 2);
  assert.equal(chatEntries[0].request.agent.budgetMode, "tight");
  assert.equal(chatEntries[1].request.agent.budgetMode, "tight");
});

test("摘要后 token 不降反升时拒绝落库；旧轮工具裁剪始终保留【A.ai 自动检查】尾部提示", async () => {
  // 1. 压缩后 tokensAfter >= tokensBefore：不得写入 SQLite
  const s = store.createSession("u");
  store.addMessage(s, { id: "nu1", role: "user", content: "简短旧轮 " + "测试词".repeat(720), createdAt: 1 });
  store.addMessage(s, { id: "na1", role: "assistant", content: "已读", createdAt: 2 });
  store.addMessage(s, { id: "nu2", role: "user", content: "当前轮继续", createdAt: 3 });

  let compactTried = 0;
  const provider = {
    id: "test-no-gain",
    async *stream({ messages }) {
      if (messages[0].content.startsWith(COMPACT_TAG)) {
        compactTried++;
        // 构造合法但比压缩前还膨胀的摘要（多条长 pending，使 tokensAfter >= before）
        const bloated = {
          goal: "简短旧轮",
          constraints: Array.from({ length: 12 }, (_, i) => `约束${i}：` + "超长展开说明".repeat(80)),
          confirmed: [{ sourceId: "nu1", quote: "简短旧轮" }],
          progress: [],
          pending: Array.from({ length: 12 }, (_, i) => `待办${i}：` + "超长待办详情".repeat(80)),
        };
        yield { type: "text", delta: JSON.stringify(bloated) };
        yield { type: "done", finishReason: "stop", usage: { inputTokens: 300, outputTokens: 400 } };
        return;
      }
      yield { type: "text", delta: "已完成" };
      yield { type: "done", finishReason: "stop", usage: { inputTokens: 800, outputTokens: 20 } };
    },
  };
  const emptyTools = { toolsFor: () => [], toolSpecs: () => [], deferredCatalog: () => "", findTool: () => undefined };
  for await (const event of runAgent({
    session: s,
    provider,
    userId: "u",
    workspace: data,
    multiAgent: false,
    contextWindow: 3_000,
    maxSteps: 3,
    tools: emptyTools,
  })) {
    assert.notEqual(event.type, "error", event.message);
  }
  assert.equal(compactTried, 1);
  assert.equal(store.getSession(s.id, "u").messages.some((m) => m.feedback?.kind === "compact"), false);

  // 2. clip() 裁剪旧轮超长工具正文时必须原样保留【A.ai 自动检查】提示
  const feedbackTail = `${FEEDBACK_TAG} 检测到语法错误，请先修复再交付`;
  const history = [
    { id: "u1", role: "user", content: "跑脚本", createdAt: 1 },
    { id: "a1", role: "assistant", content: "", createdAt: 2, toolCalls: [{ id: "c1", name: "run_python", arguments: "{}" }] },
    { id: "r1", role: "tool", toolCallId: "c1", status: "error", isError: true, content: "日志行".repeat(900) + "\n\n" + feedbackTail, createdAt: 3 },
    { id: "u2", role: "user", content: "再看一下", createdAt: 4 },
  ];
  const ctx = buildContext(history, "系统提示", { inputId: "u2" });
  const clippedTool = ctx.messages.find((m) => m.role === "tool");
  assert.match(clippedTool.content, /上下文压缩：此处省略/);
  assert.ok(clippedTool.content.endsWith(feedbackTail));
});

test("fitHardBudget 三级退化覆盖纯英文/ASCII 超长输入，始终守住硬上限并保持合法 JSON 参数与 Anthropic 协议", () => {
  const longArgs = JSON.stringify({ path: "src/big.ts", content: "const x = 1;\n".repeat(400) });
  const asciiPrompt = "HEADER_ANCHOR\n" + "error: failed to parse chunk at offset 12345\n".repeat(600) + "\nTAIL_ANCHOR";
  const msgs = [
    { role: "system", content: "固定系统指令" },
    { role: "user", content: "第一轮需求 " + "A".repeat(2_000) },
    { role: "assistant", content: "分析过程 " + "B".repeat(2_000), reasoning: "长思考链".repeat(500), raw: [{ type: "thinking" }], toolCalls: [
      { id: "c1", name: "write_file", arguments: longArgs },
    ] },
    { role: "tool", toolCallId: "c1", content: "TOOL_HEAD " + "line\n".repeat(1_200) + " TOOL_TAIL" },
    { role: "user", content: asciiPrompt },
  ];
  const hardLimit = 1_500;
  const guarded = fitHardBudget(msgs, undefined, hardLimit, 1.3);

  assert.equal(guarded[0].content, "固定系统指令");
  assert.ok(calibratedRequestTokens(guarded, undefined, 1.3) <= hardLimit);
  // 第 2 级应清空较早 assistant 的 reasoning/raw 并把超长参数换成合法 JSON
  const a1 = guarded.find((m) => m.role === "assistant");
  assert.equal(a1.reasoning, undefined);
  assert.equal(a1.raw, undefined);
  const parsedArgs = JSON.parse(a1.toolCalls[0].arguments);
  assert.match(parsedArgs._omitted, /已在上下文中省略/);
  // 第 3 级应裁短纯 ASCII 末尾 user 并保留头尾锚点
  const lastUser = guarded.at(-1);
  assert.ok(lastUser.content.includes("HEADER_ANCHOR"));
  assert.ok(lastUser.content.includes("TAIL_ANCHOR"));
  assert.ok(lastUser.content.length < asciiPrompt.length);
  // assistant/tool 协议配对和 Anthropic 转换仍然完整
  const anthropic = toAnthropic(guarded);
  assert.equal(anthropic.messages[0].role, "user");
  const uses = anthropic.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_use") : []));
  const results = anthropic.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result") : []));
  assert.deepEqual(uses.map((b) => b.id), ["c1"]);
  assert.deepEqual(results.map((b) => b.tool_use_id), ["c1"]);
});

test("calibrationFactor 夹紧、平滑衰减与非法输入免疫；A_COMPACT_TOKENS 不得超过 hardInputBudget", () => {
  // 非法或无意义输入返回夹紧后的原系数
  assert.equal(calibrationFactor(0, 1000, 1.3), 1.3);
  assert.equal(calibrationFactor(1000, -5, 1.3), 1.3);
  assert.equal(calibrationFactor(Number.NaN, 1000, 1.3), 1.3);
  assert.equal(calibrationFactor(1000, 500, 0.4), 1.0);
  assert.equal(calibrationFactor(1000, 500, 5.0), 2.0 * 0.7 + 1.0 * 0.3);

  // 低估时立即抬升（封顶 2.0），后续真实占比回落时平滑衰减（0.7 * base + 0.3 * ratio）
  const spiked = calibrationFactor(1000, 2600, 1.0);
  assert.equal(spiked, 2.0);
  const decayed = calibrationFactor(1000, 1000, spiked);
  assert.ok(Math.abs(decayed - 1.7) < 1e-9);

  // A_COMPACT_TOKENS 环境变量超过窗口硬上限时，compactThreshold 必须封顶在 hardInputBudget
  const prevEnv = process.env.A_COMPACT_TOKENS;
  try {
    process.env.A_COMPACT_TOKENS = "999999";
    assert.equal(compactThreshold(8_000), hardInputBudget(8_000));
    process.env.A_COMPACT_TOKENS = "2048";
    assert.equal(compactThreshold(8_000), 2_048);
  } finally {
    if (prevEnv === undefined) delete process.env.A_COMPACT_TOKENS;
    else process.env.A_COMPACT_TOKENS = prevEnv;
  }
});

test("硬预算护栏触发时撤掉历史召回卡片，对话轨迹记录 budgetMode=hard-guard 与 recalledCards=0", async () => {
  const s = store.createSession("u");
  const old = { id: store.newId("m"), role: "user", content: "神户审计台账 audit_kobe.csv 明细核对", createdAt: 1 };
  store.addMessage(s, old);
  store.addMessage(s, { id: store.newId("m"), role: "assistant", content: "", createdAt: 2, toolCalls: [
    { id: "kobe-c1", name: "read_file", arguments: '{"path":"audit_kobe.csv"}' },
  ] });
  store.addMessage(s, { id: store.newId("m"), role: "tool", toolCallId: "kobe-c1", status: "ok", content: "核对完毕", createdAt: 3 });
  const keep = { id: store.newId("m"), role: "user", content: "近期补充", createdAt: 4 };
  store.addMessage(s, keep);
  store.addMessage(s, {
    id: store.newId("m"), role: "user", content: "已压缩摘要", createdAt: 5,
    feedback: { kind: "compact", summary: "已压缩" },
    compact: { keepFrom: keep.id, messages: 3, tokensBefore: 4000, tokensAfter: 600 },
  });
  const current = {
    id: store.newId("m"), role: "user", createdAt: 6,
    content: "请回查神户审计台账 audit_kobe.csv " + "超长现场数据".repeat(700),
  };
  store.addMessage(s, current);

  const known = [searchSavedHistory, readSavedHistoryExecution];
  const specs = () => known.map((t) => t.spec);
  const trace = createConversationTrace({ sessionId: s.id, runId: "run-hard-guard", inputId: current.id, model: "test", effort: "default" });

  let seenMessages = null;
  const provider = {
    id: "test-hard-guard",
    async *stream({ messages }) {
      seenMessages = messages;
      yield { type: "text", delta: "已在硬护栏下回答" };
      yield { type: "done", finishReason: "stop", usage: { inputTokens: 900, outputTokens: 20 } };
    },
  };

  for await (const event of runAgent({
    session: s,
    provider,
    userId: "u",
    workspace: data,
    multiAgent: false,
    contextWindow: 1_800,
    maxSteps: 3,
    conversationTrace: trace,
    execution: { runId: "run-hard-guard", inputId: current.id },
    tools: { toolsFor: specs, toolSpecs: specs, deferredCatalog: () => "", findTool: (name) => known.find((t) => t.spec.name === name) },
  })) {
    assert.notEqual(event.type, "error", event.message);
  }

  assert.ok(seenMessages);
  // 硬护栏触发后不应带入【匹配的历史段落】召回卡片
  assert.ok(!seenMessages.some((m) => m.content.includes("【匹配的历史段落】")));
  const entries = listTraceEntries(s.id, "u");
  assert.equal(entries.length, 1);
  const detail = readTraceEntry(s.id, "u", entries[0].id, true);
  assert.equal(detail.request.agent.budgetMode, "hard-guard");
  assert.equal(detail.request.agent.recalledCards, 0);
});

test("describeToolResult 提取 research 字段与无字段 preview；readToolResult 关键词分页不丢行尾；归档会话/项目严格阻断跨会话共享", () => {
  // 1. research 围栏 JSON 字段提取与未知非 JSON 工具回退 120 字单行 preview
  const researchBody = "```json\n" + JSON.stringify({
    taskId: "sub-01",
    status: "completed",
    facts: [{ k: "a", v: "1" }, { k: "b", v: "2" }],
    evidence: ["e1", "e2", "e3"],
    unresolved: ["u1"],
    rawDump: "调研正文".repeat(1_500),
  }) + "\n```";
  const researchMeta = describeToolResult("research", researchBody);
  assert.equal(researchMeta.fields.taskId, "sub-01");
  assert.equal(researchMeta.fields.status, "completed");
  assert.equal(researchMeta.fields.factCount, 2);
  assert.equal(researchMeta.fields.evidenceCount, 3);
  assert.equal(researchMeta.fields.unresolvedCount, 1);

  const plainMeta = describeToolResult("custom_plain", "  第一行   说明  \n" + "正文".repeat(1_500));
  assert.equal(typeof plainMeta.fields.preview, "string");
  assert.ok(plainMeta.fields.preview.startsWith("第一行 说明 "));
  assert.ok(plainMeta.fields.preview.length <= 120);

  // 2. readToolResult(query) 大小写不敏感、多页翻页不拦腰截断命中行、无命中返回空
  const s = store.createSession("u");
  store.addMessage(s, { id: "q-u1", role: "user", content: "检查日志", createdAt: 1 });
  store.addMessage(s, { id: "q-a1", role: "assistant", content: "", createdAt: 2, toolCalls: [{ id: "qc1", name: "read_file", arguments: "{}" }] });
  const logLines = [
    "INFO startup ok",
    "prefix-padding-001 target_hit alpha-tail-END1",
    "INFO middle line",
    "prefix-padding-002 TARGET_HIT beta-tail-END2",
    "TARGET_HIT gamma-END3",
  ].join("\n");
  const qRes = { id: "q-r1", role: "tool", toolCallId: "qc1", status: "ok", content: logLines, createdAt: 3 };
  store.addMessage(s, qRes);

  const page1 = readToolResult("u", s.id, qRes.id, 0, 55, "target_hit");
  assert.equal(page1.totalMatches, 3);
  assert.equal(page1.matches.length, 1);
  assert.ok(page1.matches[0].text.includes("alpha-tail-END1"));
  assert.notEqual(page1.nextOffset, null);

  const page2 = readToolResult("u", s.id, qRes.id, page1.nextOffset, 55, "target_hit");
  assert.equal(page2.matches.length, 1);
  assert.ok(page2.matches[0].text.includes("beta-tail-END2"));
  assert.notEqual(page2.nextOffset, null);

  const page3 = readToolResult("u", s.id, qRes.id, page2.nextOffset, 55, "target_hit");
  assert.equal(page3.matches.length, 1);
  assert.ok(page3.matches[0].text.includes("gamma-END3"));
  assert.equal(page3.nextOffset, null);

  const zero = readToolResult("u", s.id, qRes.id, 0, 100, "NO_SUCH_TOKEN");
  assert.equal(zero.totalMatches, 0);
  assert.equal(zero.matches.length, 0);
  assert.equal(zero.nextOffset, null);

  // 3. 开启 share=true 的项目：归档目标兄弟会话或归档整个项目后，跨会话检索与回读必须全部拒绝
  const proj = createProject("u", { name: "归档测试项目", description: "", memory: "off", share: true });
  const peer = store.createSession("u", "源会话", proj.id);
  const viewer = store.createSession("u", "查看会话", proj.id);
  const peerSeg = { id: store.newId("m"), role: "user", content: "核对 ARCHIVE_GUARD_KEY 报表", createdAt: 1 };
  store.addMessage(peer, peerSeg);
  store.addMessage(peer, { id: store.newId("m"), role: "assistant", content: "", createdAt: 2, toolCalls: [
    { id: "ag-c1", name: "read_file", arguments: '{"path":"archive_guard.csv"}' },
  ] });
  const peerTool = { id: store.newId("m"), role: "tool", toolCallId: "ag-c1", status: "ok", content: "ARCHIVE_GUARD_KEY=42", createdAt: 3 };
  store.addMessage(peer, peerTool);

  // 未归档前正常可跨会话读取
  assert.equal(searchHistory("u", viewer.id, "ARCHIVE_GUARD_KEY", 5, undefined, "project").length, 1);
  assert.ok(readHistoryExecution("u", viewer.id, peerSeg.id, 0, 5, peer.id));
  assert.ok(readToolResult("u", viewer.id, peerTool.id, 0, 100, undefined, peer.id));

  // 归档目标兄弟会话 peer：立即可见性归零
  db().prepare("UPDATE sessions SET archived_at = ? WHERE id = ?").run(Date.now(), peer.id);
  assert.deepEqual(searchHistory("u", viewer.id, "ARCHIVE_GUARD_KEY", 5, undefined, "project"), []);
  assert.equal(readHistoryExecution("u", viewer.id, peerSeg.id, 0, 5, peer.id), null);
  assert.equal(readToolResult("u", viewer.id, peerTool.id, 0, 100, undefined, peer.id), null);

  // 恢复 peer 但归档整个项目 proj：同样严格拒绝跨会话共享
  db().prepare("UPDATE sessions SET archived_at = NULL WHERE id = ?").run(peer.id);
  db().prepare("UPDATE projects SET archived_at = ? WHERE id = ?").run(Date.now(), proj.id);
  assert.deepEqual(searchHistory("u", viewer.id, "ARCHIVE_GUARD_KEY", 5, undefined, "project"), []);
  assert.equal(readHistoryExecution("u", viewer.id, peerSeg.id, 0, 5, peer.id), null);
  assert.equal(readToolResult("u", viewer.id, peerTool.id, 0, 100, undefined, peer.id), null);
});
