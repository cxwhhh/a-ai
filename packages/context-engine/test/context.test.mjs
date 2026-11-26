import assert from "node:assert/strict";
import { test } from "node:test";
import { data, db, load, runAgent, store } from "../../../tests/fixtures/agent-runtime.mjs";

const { readSavedToolResult } = load("packages/tools/src/read-tool-result.ts");
const { describeToolResult, readToolResult } = load("packages/storage/src/tool-results.ts");
const {
  buildContext,
  calibratedRequestTokens,
  calibrationFactor,
  compactThreshold,
  estimateRequest,
  fitHardBudget,
  hardInputBudget,
  outputReserve,
  planCompact,
  summarize,
} = load("packages/context-engine/src/context.ts");
const { validateSummary } = load("packages/context-engine/src/summary.ts");
const { toAnthropic } = load("packages/llm/src/providers/anthropic.ts");

async function run(session, provider, options = {}) {
  for await (const event of runAgent({ session, provider, userId: "u", workspace: data, multiAgent: false, ...options })) {
    assert.notEqual(event.type, "error", event.message);
  }
}

test("长工具结果使用消息 ID，按页回读原文并拒绝非活动版本和其他会话", async () => {
  const session = store.createSession("u");
  const other = store.createSession("u");
  const input = { id: "read-back-input", role: "user", content: "查询表格并读回最后一行", createdAt: 1 };
  store.addMessage(session, input);
  const original = JSON.stringify({
    columns: ["名称", "金额"], rowCount: 2, truncated: false,
    rows: [["长记录".repeat(2_000), 30], ["最后一条🚀", 90]],
  });
  const query = { spec: { name: "query_data" }, parallelSafe: true, run: async () => ({ content: original }) };
  const tools = {
    deferredCatalog: () => "", toolSpecs: () => [query.spec, readSavedToolResult.spec],
    toolsFor: () => [query.spec, readSavedToolResult.spec],
    findTool: (name) => name === "read_tool_result" ? readSavedToolResult : query,
  };
  let calls = 0;
  let resultId;
  const provider = { id: "mock", async *stream({ messages }) {
    if (calls++ === 0) {
      yield { type: "tool_call", call: { id: "query-1", name: "query_data", arguments: "{}" } };
    } else if (calls === 2) {
      const result = session.messages.find((message) => message.toolCallId === "query-1");
      resultId = result.id;
      const pointer = messages.find((message) => message.toolCallId === "query-1").content;
      assert.match(pointer, /已完成 query_data/);
      assert.ok(pointer.includes(resultId));
      assert.match(pointer, /关键字段/);
      assert.ok(pointer.includes('"rowCount":2'));
      assert.ok(pointer.length < 480);
      assert.deepEqual(result.toolResult.fields.columns, ["名称", "金额"]);
      assert.equal(result.toolResult.fields.rowCount, 2);
      yield { type: "tool_call", call: { id: "read-1", name: "read_tool_result", arguments: JSON.stringify({
        resultId, offset: Array.from(original).length - 20, limit: 20,
      }) } };
    } else {
      const page = JSON.parse(messages.find((message) => message.toolCallId === "read-1").content);
      assert.match(page.content, /最后一条🚀/);
      assert.equal(page.nextOffset, null);
      yield { type: "text", delta: "已核对最后一行" };
    }
    yield { type: "done" };
  } };
  await run(session, provider, { tools, maxSteps: 4 });
  assert.equal(calls, 3);
  const saved = store.getSession(session.id, "u");
  assert.equal(saved.messages.find((message) => message.id === resultId).content, original);
  const first = readToolResult("u", session.id, resultId, 0, 12);
  assert.equal(first.nextOffset, 12);
  assert.equal(readToolResult("u", other.id, resultId, 0, 12), null);
  assert.equal(readToolResult("other-user", session.id, resultId, 0, 12), null);
  store.truncateFrom(saved, input.id);
  assert.equal(readToolResult("u", session.id, resultId, 0, 12), null);
  assert.ok(db().prepare("SELECT id FROM messages WHERE id = ?").get(resultId));
});

const state = (sourceId, status = "error") => JSON.stringify({
  goal: "检查原有测试", constraints: ["保留原文"],
  confirmed: [{ sourceId, quote: "exitCode" }],
  progress: [{ text: "执行测试", sourceId, status }],
  pending: ["处理失败后复测"],
});

for (const failure of ["正常", "错误状态", "截断", "落库失败"]) {
  test(`结构化摘要在${failure}时的持久化和实际请求`, async () => {
    const session = store.createSession("u");
    const added = [
      { id: `old-${failure}`, role: "user", content: "原始需求".repeat(1_000) },
      { id: `assistant-${failure}`, role: "assistant", content: "", toolCalls: [{ id: "test-run", name: "run_command", arguments: "{}" }] },
      { id: `result-${failure}`, role: "tool", toolCallId: "test-run", status: "error", content: '{"exitCode":1,"output":"TEST_FAIL"}' },
      { id: `near-${failure}`, role: "user", content: "近一轮问题" },
      { id: `new-${failure}`, role: "user", content: "继续处理" },
    ];
    for (const message of added) store.addMessage(session, { createdAt: 1, ...message });
    const actual = [];
    const provider = { id: "mock", async *stream({ messages }) {
      const compact = messages[0].content.startsWith("[A.ai:compact]");
      if (compact) {
        yield { type: "text", delta: state(added[2].id, failure === "错误状态" ? "ok" : "error") };
        yield { type: "done", finishReason: failure === "截断" ? "length" : "stop" };
      } else {
        actual.push(messages);
        yield { type: "text", delta: "已收到" };
        yield { type: "done" };
      }
    } };
    if (failure === "落库失败") {
      db().exec(`CREATE TEMP TRIGGER reject_compact BEFORE INSERT ON messages
        WHEN json_extract(NEW.data, '$.feedback.kind') = 'compact'
        BEGIN SELECT RAISE(ABORT, 'compaction fixture'); END`);
    }
    try {
      await run(session, provider, { contextWindow: 4096, maxSteps: 3 });
    } finally {
      if (failure === "落库失败") db().exec("DROP TRIGGER reject_compact");
    }
    assert.equal(actual.length, 1);
    const saved = store.getSession(session.id, "u");
    const digest = saved.messages.find((message) => message.feedback?.kind === "compact");
    assert.equal(saved.messages.find((message) => message.id === added[2].id).content, added[2].content);
    assert.equal(readToolResult("u", session.id, added[2].id, 0, 100).content, added[2].content);
    if (failure === "正常") {
      assert.equal(JSON.parse(digest.content).progress[0].status, "error");
      assert.ok(actual[0][0].content.includes(digest.content));
      assert.ok(buildContext(saved.messages, "system").messages[0].content.includes(digest.content));
    } else {
      assert.equal(digest, undefined);
      assert.ok(actual[0].some((message) => message.content.includes("TEST_FAIL")));
    }
    assert.ok(actual[0].some((message) => message.content.includes("继续处理")));
  });
}

test("失效的摘要边界回退到上一份有效摘要，并保留其后原文", () => {
  const history = [
    { id: "source", role: "user", content: "早期原文" },
    { id: "keep", role: "user", content: "仍要完整保留" },
    { id: "valid", role: "user", content: "上一份摘要", feedback: { kind: "compact" }, compact: { keepFrom: "keep" } },
    { id: "invalid", role: "user", content: "失效摘要", feedback: { kind: "compact" }, compact: { keepFrom: "missing" } },
    { id: "latest", role: "user", content: "本轮输入" },
  ];
  const context = buildContext(history, "system", { inputId: "latest" });
  assert.match(context.messages[0].content, /上一份摘要/);
  assert.doesNotMatch(context.messages[0].content, /失效摘要/);
  assert.deepEqual(context.messages.slice(1).map(({ content }) => content), ["仍要完整保留", "本轮输入"]);
  assert.equal(context.turnStart, 2);
});

test("单轮长任务按完整协议块压缩、支持连续二次压缩，并保持 Anthropic 首条为 user", async () => {
  const session = store.createSession("u");
  const input = { id: "single-turn", role: "user", content: "执行多步排查并汇总", createdAt: 1 };
  store.addMessage(session, input);
  const stepTool = {
    spec: { name: "probe", description: "返回一段较长但未卸载的检查日志", parameters: { type: "object", properties: { n: { type: "integer" } } } },
    parallelSafe: true,
    run: async ({ n }) => ({ content: `STEP_${n}_OK ` + "详细日志内容".repeat(160) }),
  };
  const tools = {
    deferredCatalog: () => "",
    toolSpecs: () => [stepTool.spec],
    toolsFor: () => [stepTool.spec],
    findTool: () => stepTool,
  };
  let chatCalls = 0;
  let compactCalls = 0;
  const seenRequests = [];
  const provider = { id: "mock", async *stream({ messages }) {
    if (messages[0].content.startsWith("[A.ai:compact]")) {
      compactCalls++;
      const source = session.messages.find((m) => m.role === "tool" && m.content.includes(`STEP_${compactCalls}_OK`));
      yield {
        type: "text",
        delta: JSON.stringify({
          goal: "执行多步排查并汇总",
          constraints: ["保留全部核查结论"],
          confirmed: source ? [{ sourceId: source.id, quote: `STEP_${compactCalls}_OK` }] : [],
          progress: source ? [{ text: `完成第 ${compactCalls} 步排查`, status: "ok", sourceId: source.id }] : [],
          pending: ["继续后续步骤并输出总结"],
        }),
      };
      yield { type: "done", finishReason: "stop" };
      return;
    }
    chatCalls++;
    seenRequests.push(messages);
    if (chatCalls <= 7) {
      yield { type: "tool_call", call: { id: `c-${chatCalls}`, name: "probe", arguments: JSON.stringify({ n: chatCalls }) } };
      yield { type: "done", finishReason: "tool_calls" };
    } else {
      yield { type: "text", delta: "全部步骤排查完成" };
      yield { type: "done", finishReason: "stop" };
    }
  } };

  await run(session, provider, { tools, contextWindow: 4096, maxSteps: 12 });
  assert.ok(compactCalls >= 2, `期望单轮长任务至少触发 2 次压缩，实际 ${compactCalls} 次`);
  const saved = store.getSession(session.id, "u");
  const compacts = saved.messages.filter((m) => m.feedback?.kind === "compact");
  assert.equal(compacts.length, compactCalls);
  assert.ok(compacts.every((m) => m.compact.tokensAfter < m.compact.tokensBefore));

  // 每次压缩后的真实请求都必须以 user 作为首条非系统消息，并保持合法 tool 配对和 Anthropic 协议
  const lastRequest = seenRequests.at(-1);
  assert.equal(lastRequest[0].role, "system");
  assert.match(lastRequest[0].content, /之前对话的摘要/);
  assert.equal(lastRequest[1].role, "user");
  assert.match(lastRequest[1].content, /执行多步排查并汇总/);
  assert.equal(toAnthropic(lastRequest).messages[0].role, "user");

  // retainedFrom 必须回指本轮真实用户消息 ID，保证历史召回索引可用
  const rebuilt = buildContext(saved.messages, "system", { inputId: input.id });
  assert.equal(rebuilt.turnStart, 1);
  assert.equal(rebuilt.retainedFrom, input.id);
});

test("单条超长用户输入与两轮长前文均可压缩，并保留末尾附件与边界校验", () => {
  const longPrompt = "需求开头说明：" + "长规格正文".repeat(900) + "\n\n<附件>\nuploads/spec.pdf\n</附件>";
  const singleHistory = [
    { id: "u-long", role: "user", content: longPrompt, createdAt: 1 },
    { id: "a-1", role: "assistant", content: "", toolCalls: [{ id: "tc-1", name: "read_file", arguments: "{}" }], createdAt: 2 },
    { id: "t-1", role: "tool", toolCallId: "tc-1", status: "ok", content: "ok", createdAt: 3 },
  ];
  const singlePlan = planCompact(singleHistory);
  assert.ok(singlePlan, "单条超长用户输入在有执行步骤后应触发压缩");
  assert.equal(singlePlan.keepFrom, "a-1");
  const withCompact = [
    ...singleHistory,
    { id: "cmp-1", role: "user", content: '{"goal":"处理长规格"}', feedback: { kind: "compact", summary: "已压缩" }, compact: { keepFrom: "a-1", messages: 1, tokensBefore: 5000, tokensAfter: 1800 }, createdAt: 4 },
  ];
  const ctx = buildContext(withCompact, "system", { inputId: "u-long" });
  assert.equal(ctx.turnStart, 1);
  assert.equal(ctx.retainedFrom, "u-long");
  assert.equal(ctx.messages[1].role, "user");
  assert.ok(ctx.messages[1].content.length < longPrompt.length);
  assert.match(ctx.messages[1].content, /需求开头说明/);
  assert.match(ctx.messages[1].content, /uploads\/spec\.pdf/);

  // 两轮对话（users.length === 2）：第 1 轮很长时应退回保留最新 1 轮完整对话
  const twoTurnHistory = [
    { id: "u-1", role: "user", content: longPrompt, createdAt: 1 },
    { id: "a-0", role: "assistant", content: "已读完规格", createdAt: 2 },
    { id: "u-2", role: "user", content: "开始实现第一步", createdAt: 3 },
  ];
  const twoTurnPlan = planCompact(twoTurnHistory);
  assert.ok(twoTurnPlan, "两轮且首轮很长时应触发跨轮压缩");
  assert.equal(twoTurnPlan.keepFrom, "u-2");

  // 指向 tool 消息或缺少前置真实 user 的无效边界会被跳过
  const badCompactHistory = [
    { id: "orphan-a", role: "assistant", content: "孤立回复", createdAt: 1 },
    { id: "bad-orphan", role: "user", content: "无效摘要1", feedback: { kind: "compact", summary: "bad" }, compact: { keepFrom: "orphan-a", messages: 0, tokensBefore: 100, tokensAfter: 50 }, createdAt: 2 },
    { id: "u-ok", role: "user", content: "正常问题", createdAt: 3 },
    { id: "a-ok", role: "assistant", content: "", toolCalls: [{ id: "c1", name: "list_files", arguments: "{}" }], createdAt: 4 },
    { id: "t-ok", role: "tool", toolCallId: "c1", status: "ok", content: "file.txt", createdAt: 5 },
    { id: "bad-tool", role: "user", content: "无效摘要2", feedback: { kind: "compact", summary: "bad" }, compact: { keepFrom: "t-ok", messages: 1, tokensBefore: 100, tokensAfter: 50 }, createdAt: 6 },
  ];
  const safeCtx = buildContext(badCompactHistory, "system", { inputId: "u-ok" });
  assert.doesNotMatch(safeCtx.messages[0].content, /无效摘要1|无效摘要2/);
  assert.equal(safeCtx.retainedFrom, null);
});

test("正常模式下第 7 步起不回头修改旧工具消息（保护 Prompt Cache），仅 tight 模式收紧", () => {
  const history = [{ id: "u1", role: "user", content: "连续检查 8 份记录", createdAt: 1 }];
  const snapshots = [];
  for (let i = 1; i <= 8; i++) {
    history.push(
      { id: `a-${i}`, role: "assistant", content: "", toolCalls: [{ id: `c-${i}`, name: "load_skill", arguments: "{}" }], createdAt: i * 2 },
      { id: `t-${i}`, role: "tool", toolCallId: `c-${i}`, status: "ok", content: `ITEM_${i}:` + "长文本内容".repeat(1_100), createdAt: i * 2 + 1 },
    );
    snapshots.push(buildContext(history, "system", { inputId: "u1" }).messages);
  }
  // 第 6、7、8 步之间，前面所有历史消息必须逐字完全一致，不能出现滑动窗口回头篡改
  assert.deepEqual(snapshots[6].slice(0, snapshots[5].length), snapshots[5]);
  assert.deepEqual(snapshots[7].slice(0, snapshots[6].length), snapshots[6]);
  assert.ok(snapshots[7][3].content.length > 5_000);

  // 紧急 tight 模式仍会收紧当前轮较早的非卸载工具结果
  const tightMessages = buildContext(history, "system", { tight: true, inputId: "u1" }).messages;
  assert.ok(tightMessages[3].content.length < 1_600);
});

test("摘要校验支持空白归一化与大结果字段回检，拒绝编造内容，并在首试失败时带错因重试 1 次", async () => {
  const multiline = { id: "m-src", role: "tool", toolCallId: "c1", status: "error", content: '{\r\n  "exitCode":   1,\r\n  "msg": "boom"\r\n}', createdAt: 1 };
  const offloaded = {
    id: "m-big", role: "tool", toolCallId: "c2", status: "ok", content: "非JSON大日志正文".repeat(1_000),
    toolResult: { name: "query_data", fields: { chars: 8000, columns: ["名称", "金额"], rowCount: 42 } }, createdAt: 2,
  };
  const sources = new Map([[multiline.id, multiline], [offloaded.id, offloaded]]);

  // 空白/换行微差与 toolResult.fields 均可命中
  const okSummary = validateSummary(JSON.stringify({
    goal: "排查错误",
    constraints: [],
    confirmed: [
      { sourceId: "m-src", quote: '"exitCode": 1, "msg": "boom"' },
      { sourceId: "m-big", quote: '"rowCount":42' },
    ],
    progress: [{ text: "执行命令失败", status: "error", sourceId: "m-src" }],
    pending: [],
  }), sources);
  assert.equal(JSON.parse(okSummary).confirmed.length, 2);

  // 修改数字或编造内容仍必须被严格拦截
  assert.throws(() => validateSummary(JSON.stringify({
    goal: "排查错误", constraints: [],
    confirmed: [{ sourceId: "m-src", quote: '"exitCode": 0' }],
    progress: [], pending: [],
  }), sources), /引语和来源原文不一致/);

  // summarize 首试给出错误状态，带错因重试 1 次后修正成功并累计用量
  const plan = {
    previous: "", part: [multiline], sources, keepFrom: "next", tokens: 3000,
  };
  let attempts = 0;
  let retryPrompt = "";
  const retryingProvider = {
    id: "mock",
    async *stream({ messages }) {
      attempts++;
      if (attempts === 1) {
        yield { type: "text", delta: JSON.stringify({ goal: "修错", constraints: [], confirmed: [], progress: [{ text: "运行", status: "ok", sourceId: "m-src" }], pending: [] }) };
        yield { type: "done", finishReason: "stop", usage: { inputTokens: 100, outputTokens: 20 } };
      } else {
        retryPrompt = messages.at(-1).content;
        yield { type: "text", delta: JSON.stringify({ goal: "修错", constraints: [], confirmed: [{ sourceId: "m-src", quote: '"exitCode": 1' }], progress: [{ text: "运行", status: "error", sourceId: "m-src" }], pending: [] }) };
        yield { type: "done", finishReason: "stop", usage: { inputTokens: 150, outputTokens: 30 } };
      }
    },
  };
  const retried = await summarize(retryingProvider, plan);
  assert.equal(attempts, 2);
  assert.match(retryPrompt, /摘要进展和工具执行状态不一致/);
  assert.equal(retried.usage.inputTokens, 250);
  assert.equal(retried.usage.outputTokens, 50);
  assert.equal(JSON.parse(retried.summary).progress[0].status, "error");
});

test("大型委派结果落库提取分支字段，read_tool_result 支持按关键词精准定位", async () => {
  const session = store.createSession("u");
  const delegationText = `汇总说明\n\n\`\`\`json\n${JSON.stringify({
    objective: "调研三家竞品",
    batchStatus: "partial",
    results: [
      { taskId: "sub-1", name: "查价格", status: "completed", facts: [{ key: "price", value: "99元", quote: "基础版99元".repeat(400) }], missingFactKeys: [] },
      { taskId: "sub-2", name: "查合规", status: "partial", facts: [], missingFactKeys: ["iso27001"] },
    ],
  }, null, 2)}\n\`\`\``;
  const ref = describeToolResult("delegate_tasks", delegationText);
  assert.ok(ref);
  assert.equal(ref.fields.batchStatus, "partial");
  assert.equal(ref.fields.branchCount, 2);
  assert.ok(ref.fields.branches.some((line) => line.includes("查合规(partial,facts=0,missing=1)")));

  const msg = { id: "m-del-big", role: "tool", toolCallId: "del-1", status: "ok", content: delegationText, toolResult: ref, createdAt: 1 };
  store.addMessage(session, { id: "u-del", role: "user", content: "对比竞品", createdAt: 1 });
  store.addMessage(session, { id: "a-del", role: "assistant", content: "", toolCalls: [{ id: "del-1", name: "delegate_tasks", arguments: "{}" }], createdAt: 1 });
  store.addMessage(session, msg);

  const built = buildContext(session.messages, "system", { inputId: "u-del" });
  const pointer = built.messages.find((m) => m.toolCallId === "del-1").content;
  assert.match(pointer, /delegate_tasks/);
  assert.match(pointer, /"batchStatus":"partial"/);

  const filtered = JSON.parse((await readSavedToolResult.run({ resultId: msg.id, query: "iso27001", limit: 500 }, { userId: "u", sessionId: session.id })).content);
  assert.equal(filtered.totalMatches, 1);
  assert.match(filtered.content, /iso27001/);
});

test("软硬预算水位、上轮真实 usage 校准、maxOutputTokens 收紧与发送前硬预算护栏", async () => {
  // 1M 大窗口封顶 64k；小窗口扣除输出预留后按 75% 计算软水位
  assert.equal(outputReserve(1_000_000), 16_000);
  assert.equal(hardInputBudget(1_000_000), 984_000);
  assert.equal(compactThreshold(1_000_000), 64_000);
  assert.equal(outputReserve(4_096), 1_024);
  assert.equal(hardInputBudget(4_096), 3_072);
  assert.equal(compactThreshold(4_096), 2_304);
  assert.ok(calibrationFactor(1000, 1600, 1) >= 1.6);
  assert.equal(calibrationFactor(1000, 500, 1), 1);

  // 第 0 步单条超长用户输入超过 4096 窗口：硬预算护栏必须将其裁至 hardInputBudget 以内并收紧 maxOutputTokens
  const session = store.createSession("u");
  store.addMessage(session, { id: "u-giant", role: "user", content: "超长输入内容".repeat(1_500), createdAt: 1 });
  const seen = [];
  const provider = {
    id: "mock",
    requestOptions: () => ({ protocol: "anthropic", model: "claude-test", maxOutputTokens: 64_000 }),
    async *stream({ messages, tools, maxOutputTokens }) {
      seen.push({ tokens: estimateRequest(messages, tools), maxOutputTokens, count: messages.length });
      yield { type: "text", delta: "已处理" };
      yield { type: "done", finishReason: "stop", usage: { inputTokens: 2_800, outputTokens: 20 } };
    },
  };
  await run(session, provider, { contextWindow: 4_096, maxSteps: 2 });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].tokens <= hardInputBudget(4_096), `期望护栏裁剪后 <= ${hardInputBudget(4_096)}，实际 ${seen[0].tokens}`);
  assert.ok(seen[0].maxOutputTokens !== undefined && seen[0].tokens + seen[0].maxOutputTokens <= 4_096);

  // 上轮真实 usage.inputTokens 远高于本地估算时，校准系数生效并在下一轮触发收紧与输出上限保护
  const s2 = store.createSession("u");
  store.addMessage(s2, { id: "u-cal", role: "user", content: "开始核对", createdAt: 1 });
  const stepTool = {
    spec: { name: "small_read", description: "读一小段", parameters: { type: "object", properties: {} } },
    parallelSafe: true,
    run: async () => ({ content: "数据行".repeat(350) }),
  };
  const customTools = {
    deferredCatalog: () => "",
    toolSpecs: () => [stepTool.spec],
    toolsFor: () => [stepTool.spec],
    findTool: () => stepTool,
  };
  const reqs = [];
  let step = 0;
  const calProvider = {
    id: "mock",
    requestOptions: () => ({ protocol: "anthropic", model: "claude-test", maxOutputTokens: 64_000 }),
    async *stream({ messages, tools, maxOutputTokens }) {
      step++;
      const est = estimateRequest(messages, tools);
      reqs.push({ est, maxOutputTokens });
      if (step === 1) {
        yield { type: "tool_call", call: { id: "r1", name: "small_read", arguments: "{}" } };
        // 上报真实 inputTokens 是本地估算的 2 倍，触发校准系数上升
        yield { type: "done", finishReason: "tool_calls", usage: { inputTokens: est * 2, outputTokens: 30 } };
      } else {
        yield { type: "text", delta: "完成" };
        yield { type: "done", finishReason: "stop", usage: { inputTokens: est * 2, outputTokens: 20 } };
      }
    },
  };
  await run(s2, calProvider, { tools: customTools, contextWindow: 4_096, maxSteps: 3 });
  assert.equal(reqs.length, 2);
  // 第 2 步按 2x 校准估算后，剩余窗口空间减少，maxOutputTokens 应明显低于第 1 步且满足护栏
  assert.ok(reqs[1].maxOutputTokens < reqs[0].maxOutputTokens);
  assert.ok(calibratedRequestTokens([{ role: "user", content: "a".repeat(400) }], undefined, 2) >= 200);
  const shrunk = fitHardBudget([
    { role: "system", content: "sys" },
    { role: "user", content: "问" },
    { role: "assistant", content: "", toolCalls: [{ id: "1", name: "x", arguments: "{}" }] },
    { role: "tool", toolCallId: "1", content: "长输出".repeat(2_000) },
  ], undefined, 600, 1);
  assert.ok(estimateRequest(shrunk) <= 600);
  assert.equal(shrunk.find((m) => m.role === "tool").toolCallId, "1");
});
