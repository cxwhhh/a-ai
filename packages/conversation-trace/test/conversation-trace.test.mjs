import { test } from "node:test";
import assert from "node:assert/strict";
import { load, db, store, data, runAgent, tool, routeState, fixtureSettings, routeFixture, readRun } from "../../../tests/fixtures/agent-runtime.mjs";

test("轨迹包含历史版本并按轮次关联同名调用，拒绝读取他人对话", async () => {
  routeFixture();
  const { GET } = load("apps/server/src/routes/api/sessions/[id]/agent/trace/route.ts");
  const s = store.createSession("u");
  const { recordAgentLog } = load("packages/session/src/log.ts");
  const run = (suffix, from) => {
    const inputId = `trace-input-${suffix}`;
    const runId = `trace-run-${suffix}`;
    const at = Date.now();
    store.beginTurn(s, { id: inputId, role: "user", content: `读取 ${suffix}`, createdAt: at }, from, runId);
    const messageId = `trace-model-${suffix}`;
    store.addMessage(s, { id: messageId, role: "assistant", content: "读取文件", createdAt: at + 1, raw: { fixture: "provider-internal" },
      toolCalls: [{ id: "reused", name: "read_file", arguments: JSON.stringify({ path: `${suffix}.txt` }) }] });
    const modelStep = { step: 1, model: "mock", effort: "default", guidanceIds: "" };
    recordAgentLog(s.id, { kind: "model-request", runId, inputId, detail: { ...modelStep, messageCount: 1, toolCount: 1 } });
    recordAgentLog(s.id, { kind: "model-result", runId, inputId, detail: { ...modelStep, messageId, outcome: "completed", durationMs: 1 } });
    store.addMessage(s, { id: `trace-tool-${suffix}`, role: "tool", toolCallId: "reused", content: `内容 ${suffix}`, createdAt: at + 2, durationMs: 3 });
    recordAgentLog(s.id, { kind: "turn-end", runId, inputId, detail: { outcome: "completed" } });
    return inputId;
  };
  const oldId = run("old");
  run("new", oldId);
  const get = () => GET(new Request("http://localhost/"), { params: Promise.resolve({ id: s.id }) });
  const body = await (await get()).json();
  assert.deepEqual(body.rows.filter((row) => row.kind === "tool").map((row) => [row.result, row.historical, row.paths, row.turn]),
    [["内容 old", true, ["old.txt"], 1], ["内容 new", false, ["new.txt"], 2]]);
  assert.ok(body.schemas.read_file);
  assert.doesNotMatch(JSON.stringify(body), /provider-internal/);
  assert.ok(body.rows.some((row) => row.title.includes("退出当前历史")));
  routeState.caller = "other";
  try {
    assert.equal((await get()).status, 404);
    routeState.caller = null;
    assert.equal((await get()).status, 401);
  } finally { routeState.caller = "u"; }
});

test("轨迹保存真实请求顺序与调用时工具定义，子请求和子工具各自可追溯", async () => {
  const { request } = routeFixture();
  const { GET: traceList } = load("apps/server/src/routes/api/sessions/[id]/agent/trace/route.ts");
  const { GET: traceDetail } = load("apps/server/src/routes/api/sessions/[id]/agent/trace/[recordId]/route.ts");
  const oldPrompt = fixtureSettings.systemPrompt;
  const oldDescription = tool.spec.description;
  const oldRun = tool.run;
  const session = store.createSession("u", "轨迹测试", undefined, true);
  store.addMessage(session, { id: "earlier-input", role: "user", content: "前一轮的专用文字", createdAt: Date.now() });
  store.addMessage(session, { id: "earlier-output", role: "assistant", content: "前一轮的回复", createdAt: Date.now() });
  fixtureSettings.systemPrompt = "调用时的自定义提示词";
  tool.spec.description = "调用时的读取定义";
  tool.run = async () => ({ content: "受控工具结果", status: "timeout", errorKind: "network" });
  let calls = 0;
  routeState.provider = { id: "mock", async *stream({ messages }) {
    calls++;
    const research = messages.some((m) => m.role === "user" && m.content === "检查目录");
    yield { type: "reasoning", delta: research ? "调研思考" : "主流程思考" };
    if (calls === 1) {
      yield { type: "raw", raw: { fixture: "provider-internal" } };
      yield { type: "tool_call", call: { id: "reused", name: "research", arguments: '{"task":"检查目录"}' } };
    } else if (calls === 2) {
      yield { type: "tool_call", call: { id: "reused", name: "read_file", arguments: '{"path":"src/index.ts"}' } };
    } else {
      assert.ok(messages.some((m) => m.role === "tool" && m.content.includes("受控工具结果")) || calls === 4);
      yield { type: "text", delta: research ? "调研完成" : "主任务完成" };
    }
    yield { type: "done", finishReason: calls <= 2 ? "tool_calls" : "stop", usage: {
      inputTokens: 10, outputTokens: 5, cacheHitTokens: 2, reasoningTokens: 1, estimated: calls === 2,
    } };
  } };
  try {
    const stream = await readRun(await request({ sessionId: session.id, message: "检查程序" }));
    const events = await stream.rest();
    assert.equal(events.some((event) => event.type === "error"), false, JSON.stringify(events));
    assert.equal(calls, 4);
    const req = new Request("http://localhost/");
    const list = await (await traceList(req, { params: Promise.resolve({ id: stream.sessionId }) })).json();
    const top = list.rows.filter((row) => row.kind === "model" && row.traceId && !row.parentId);
    const research = list.rows.find((row) => row.tool === "research");
    const nested = list.rows.filter((row) => row.kind === "model" && row.parentId === research.id);
    const child = list.rows.find((row) => row.kind === "tool" && row.parentId === nested[0].id);
    assert.deepEqual(top.map((row) => row.step), [1, 2]);
    assert.deepEqual(nested.map((row) => row.childStep), [1, 2]);
    assert.equal(child.tool, "read_file");
    assert.equal(child.toolState, "timeout");
    assert.equal(research.requestId, top[0].id);
    assert.doesNotMatch(JSON.stringify(list), /调用时的自定义提示词/);
    assert.equal(list.analysis, undefined);
    const statsRequest = new Request("http://localhost/?stats=1");
    const stats = () => traceList(statsRequest, { params: Promise.resolve({ id: stream.sessionId }) });
    const statsResponse = await stats();
    assert.equal(statsResponse.headers.get("cache-control"), "private, no-store");
    const { analysis } = await statsResponse.json();
    assert.equal(analysis.requests.count, 4);
    assert.deepEqual(analysis.requests.phases, { chat: 2, compact: 0, research: 2 });
    assert.equal(analysis.requests.reported.input, 30);
    assert.equal(analysis.requests.reported.cacheRead, 6);
    assert.equal(analysis.requests.reported.cacheReadInput, 30);
    assert.equal(analysis.requests.estimated.input, 10);
    assert.equal(analysis.legacyModelRows, 1);
    assert.deepEqual(analysis.tools.find(({ name }) => name === "read_file").states, { timeout: 1 });
    assert.deepEqual(analysis.turns.filter((turn) => turn.requests).map(({ closedSteps, requests, tools, consumed }) => [closedSteps, requests, tools, consumed]), [[2, 4, 2, true]]);
    const read = (recordId, id = stream.sessionId) =>
      traceDetail(new Request("http://localhost/?compare=1"), { params: Promise.resolve({ id, recordId }) });
    tool.spec.description = "后来修改的定义";
    const initial = await (await read(top[0].id)).json();
    assert.match(initial.prompts[0], /调用时的自定义提示词/);
    assert.deepEqual(initial.request.messages.map((message) => message.role), ["user"]);
    assert.match(initial.request.messages[0].content, /^检查程序/);
    assert.equal(initial.context.messages.user, 2);
    const nextMain = await (await read(top[1].id)).json();
    assert.deepEqual(nextMain.request.messages.map((message) => message.role), ["user", "assistant", "tool"]);
    assert.doesNotMatch(JSON.stringify([initial.request.messages, nextMain.request.messages]), /前一轮/);
    assert.deepEqual(initial.response.blocks.map((block) => block.kind), ["reasoning", "tool-call"]);
    assert.doesNotMatch(JSON.stringify(initial), /provider-internal/);
    const childRequest = await (await read(nested[0].id)).json();
    assert.equal(childRequest.request.tools.find((spec) => spec.name === "read_file").description, "调用时的读取定义");
    const childResult = await (await read(child.id)).json();
    assert.equal(childResult.result.content, "受控工具结果");
    assert.equal(childResult.result.status, "timeout");
    assert.equal(childResult.result.errorKind, "network");
    const followup = await (await read(nested[1].id)).json();
    assert.ok(followup.request.messages.some((message) => message.role === "tool" && message.content === childResult.result.content));
    assert.deepEqual(followup.context.messages, { system: 1, user: 1, assistant: 1, tool: 1 });
    assert.equal(followup.context.previous.id, nested[0].id);
    assert.equal(followup.context.previous.firstChanged, 3);
    assert.equal(followup.context.previous.added, 2);
    assert.equal((await read(child.id, store.createSession("u").id)).status, 404);
    routeState.caller = "other";
    assert.equal((await read(child.id)).status, 404);
    assert.equal((await stats()).status, 404);
    routeState.caller = null;
    assert.equal((await stats()).status, 401);
    routeState.caller = "u";
    assert.equal(store.deleteSession(stream.sessionId, "u"), true);
    assert.equal(db().prepare("SELECT COUNT(*) AS count FROM conversation_trace_entries WHERE session_id=?").get(stream.sessionId).count, 0);
  } finally {
    routeState.caller = "u";
    fixtureSettings.systemPrompt = oldPrompt;
    tool.spec.description = oldDescription;
    tool.run = oldRun;
  }
});

test("旧请求按当前输入校验展示边界，子任务隐藏继承资料", async () => {
  const { SUBAGENT_REFERENCE_TAG } = load("packages/protocol/src/lib/message-tags.ts");
  const { insertTraceEntry, readTraceRecordView } = load("packages/conversation-trace/src/store.ts");
  const session = store.createSession("u");
  const inputId = "legacy-current";
  store.addMessage(session, { id: inputId, role: "user", content: "重复的输入", createdAt: Date.now() });
  function read(phase, messages, metadata = {}, scopeInput = inputId) {
    const id = `trace:${crypto.randomUUID()}`;
    insertTraceEntry(session.id, { id, at: Date.now(), meta: {
      kind: "request", phase, step: 1, runId: "legacy", inputId: scopeInput, model: "mock", effort: "default",
    } }, { messages, tools: [], ...metadata });
    return readTraceRecordView(session.id, "u", id, true);
  }
  const history = [{ role: "system", content: "系统" }, { role: "user", content: "重复的输入" }, { role: "assistant", content: "旧回复" }];
  const current = [{ role: "user", content: "重复的输入\n\n<环境>\n测试环境\n</环境>" }, { role: "user", content: "【用户补充】本轮补充" }];
  assert.deepEqual(read("chat", [...history, ...current]).request.messages, current);
  assert.deepEqual(read("chat", history, {}, "missing").request.messages, []);
  assert.deepEqual(read("chat", [...history, ...current], { turnStart: null }).request.messages, []);
  const task = { role: "user", content: "子任务输入" };
  const reference = { role: "user", content: SUBAGENT_REFERENCE_TAG + "从母对话带入的材料" };
  const childMessages = [history[0], task, reference, { role: "assistant", content: "子任务回复" }];
  const expected = [task, childMessages[3]];
  assert.deepEqual(read("research", childMessages).request.messages, expected);
  assert.deepEqual(read("research", childMessages, { referenceIndex: 2 }).request.messages, expected);
});

test("停止模型流后，持久轨迹保留已收到的部分思考", async () => {
  const { createConversationTrace } = load("packages/conversation-trace/src/recorder.ts");
  const { readTraceEntry } = load("packages/conversation-trace/src/store.ts");
  const s = store.createSession("u");
  const recorder = createConversationTrace({ sessionId: s.id, runId: "stopped", inputId: "input", model: "mock", effort: "high" });
  const abort = new AbortController();
  const provider = { id: "mock", async *stream() {
    yield { type: "reasoning", delta: "已经收到的思考" };
    abort.signal.throwIfAborted();
  } };
  const { id, stream } = recorder.request(provider, { messages: [], signal: abort.signal }, { phase: "chat", step: 1 });
  await assert.rejects(async () => {
    for await (const _ of stream) abort.abort();
  }, { name: "AbortError" });
  const record = readTraceEntry(s.id, "u", id);
  assert.equal(record.outcome, "cancelled");
  assert.deepEqual(record.response.blocks, [{ kind: "reasoning", text: "已经收到的思考" }]);
  assert.equal(record.response.firstOutputMs, record.response.firstReasoningMs);
  assert.equal(record.response.firstTextMs, undefined);
  assert.equal(record.response.error, undefined);
  assert.ok(record.meta.metrics.streamMs >= record.response.firstOutputMs);
  const { analysis } = load("packages/conversation-trace/src/projection.ts").readSessionTrace(s.id, "u", true);
  assert.equal(analysis.requests.states.cancelled, 1);
  assert.equal(analysis.requests.reported.count + analysis.requests.estimated.count, 0);
});

test("请求对比只使用同轮同阶段同父调用的上一快照，并保留提示词和工具变化", async () => {
  const { createConversationTrace } = load("packages/conversation-trace/src/recorder.ts");
  const { readTraceEntry } = load("packages/conversation-trace/src/store.ts");
  const s = store.createSession("u");
  const provider = { id: "mock", async *stream() { yield { type: "done", finishReason: "stop" }; } };
  async function record(inputId, phase, step, parentId, system, names) {
    const recorder = createConversationTrace({ sessionId: s.id, runId: "shared", inputId, model: "mock", effort: "default" });
    const { id, stream } = recorder.request(provider, {
      messages: [{ role: "system", content: system }, { role: "user", content: inputId }],
      tools: names.map((name) => ({ name, description: name === "retained" ? system : name, parameters: { type: "object" } })),
    }, { phase, step, parentId });
    for await (const _ of stream) { /* 收尾后再读取。 */ }
    return id;
  }
  const first = await record("turn-a", "research", 1, "parent-a", "旧提示", ["retained", "old", "common"]);
  await record("turn-a", "research", 1, "parent-b", "其他子 Agent", []);
  await record("turn-a", "compact", 1, undefined, "压缩", []);
  const queued = await record("turn-b", "research", 1, "parent-a", "另一个排队输入", []);
  const next = await record("turn-a", "research", 2, "parent-a", "新提示", ["common", "retained", "new"]);
  assert.equal(readTraceEntry(s.id, "u", queued, true).context.previous, undefined);
  const previous = readTraceEntry(s.id, "u", next, true).context.previous;
  assert.deepEqual(previous, {
    id: first, step: 1, childStep: undefined, firstChanged: 1, added: 1, removed: 1, systemChanged: true,
    toolsAdded: ["new"], toolsRemoved: ["old"], toolsChanged: ["retained"], toolOrderChanged: true,
  });
});

test("轨迹列表直接读取请求上下文、已有分析和子工具摘要，兼容旧快照", async () => {
  const { createConversationTrace } = load("packages/conversation-trace/src/recorder.ts");
  const { readSessionTrace } = load("packages/conversation-trace/src/projection.ts");
  const s = store.createSession("u");
  const recorder = createConversationTrace({ sessionId: s.id, runId: "r", inputId: "i", model: "fixture", effort: "default" });
  const recorded = recorder.request({ id: "fixture", async *stream() {
    yield { type: "reasoning", delta: "已记录的分析" };
    yield { type: "text", delta: "已记录的回复" };
    yield { type: "done", finishReason: "stop" };
  } }, { messages: [{ role: "system", content: "设置" }, { role: "user", content: "查文件" }] }, { phase: "research", step: 1 });
  for await (const _ of recorded.stream) { /* 等待快照收尾。 */ }
  await recorder.tool({ id: "child", name: "read_file", arguments: '{"path":"notes.txt"}' },
    { step: 1, parentId: recorded.id }, undefined, async () => ({ content: "文件摘要", status: "ok" }));
  const check = () => {
    const rows = readSessionTrace(s.id, "u").rows;
    assert.deepEqual(rows.find((row) => row.id === recorded.id).preview, {
      context: { messages: { system: 1, user: 1, assistant: 0, tool: 0 }, tools: 0 },
      reasoning: "已记录的分析", text: "已记录的回复",
    });
    const tool = rows.find((row) => row.callId === "child");
    assert.equal(tool.args, '{"path":"notes.txt"}');
    assert.equal(tool.result, "文件摘要");
  };
  check();
  const { db } = load("packages/storage/src/db.ts");
  db().prepare("UPDATE conversation_trace_entries SET meta=json_remove(meta,'$.preview') WHERE session_id=?").run(s.id);
  check();
  assert.equal(readSessionTrace(s.id, "other"), null);
});

test("统计补读旧响应的用量，区分截断、中断和 HTTP 错误且不保存凭据", async () => {
  const { createConversationTrace } = load("packages/conversation-trace/src/recorder.ts");
  const { insertTraceEntry, finishTraceEntry, listTraceEntries, readTraceEntry } = load("packages/conversation-trace/src/store.ts");
  const { readSessionTrace } = load("packages/conversation-trace/src/projection.ts");
  const s = store.createSession("u");
  const scope = { sessionId: s.id, runId: "diagnostic-run", inputId: "diagnostic-input", model: "fixture/actual-model", effort: "max" };
  const legacy = { id: "trace:legacy-stat", at: Date.now() - 90, meta: { kind: "request", phase: "chat", step: 1,
    runId: scope.runId, inputId: scope.inputId, model: scope.model, effort: scope.effort } };
  assert.equal(insertTraceEntry(s.id, legacy, { messages: [], tools: [] }), true);
  finishTraceEntry(s.id, legacy.id, "completed", { blocks: [], firstOutputMs: 12, usage: { inputTokens: 100, outputTokens: 20 } });
  assert.equal(listTraceEntries(s.id, "u")[0].meta.metrics, undefined);
  assert.equal(listTraceEntries(s.id, "u", true)[0].meta.metrics.usage.inputTokens, 100);
  const recorder = createConversationTrace(scope);
  const provider = {
    id: "测试连接",
    requestOptions: () => ({ protocol: "openai-compatible", model: "actual-model", reasoningEffort: "max", apiKey: "fixture-secret" }),
    async *stream() { throw Object.assign(new Error("Bearer fixture-secret"), { status: 429 }); },
  };
  const failed = recorder.request(provider, { messages: [] }, { phase: "chat", step: 2 });
  await assert.rejects(async () => { for await (const _ of failed.stream) { /* 等待失败。 */ } }, /fixture-secret/);
  const failedRecord = readTraceEntry(s.id, "u", failed.id);
  assert.equal(failedRecord.request.provider.options.model, "actual-model");
  assert.deepEqual(failedRecord.response.error, { kind: "rate-limit", status: 429 });
  assert.doesNotMatch(JSON.stringify(failedRecord), /fixture-secret|apiKey/);

  const truncated = recorder.request({ id: "fixture", async *stream() {
    yield { type: "text", delta: "部分正文" };
    yield { type: "done", finishReason: "length" };
  } }, { messages: [] }, { phase: "chat", step: 3 });
  for await (const _ of truncated.stream) { /* 消费截断输出。 */ }
  const interrupted = recorder.request(provider, { messages: [] }, { phase: "chat", step: 4 });

  const stats = readSessionTrace(s.id, "u", true).analysis;
  assert.deepEqual(stats.requests.states, { completed: 1, failed: 1, "output-truncated": 1, interrupted: 1 });
  assert.equal(stats.requests.reported.count, 1);
  assert.equal(stats.requests.reported.output, 20);
  assert.equal(stats.requests.elapsed.count, 3);
  assert.equal(stats.requests.firstOutput.count, 2);
  assert.deepEqual(stats.issues.map(({ rowId, state }) => [rowId, state]), [
    [failed.id, "failed"], [truncated.id, "output-truncated"], [interrupted.id, "interrupted"],
  ]);
});

test("模型选项匹配实际请求，缺失提供方用量时读取该步骤已有的估算", async () => {
  const { request } = routeFixture();
  const { OpenAICompatibleProvider } = load("packages/llm/src/providers/openai-compatible.ts");
  const { listTraceEntries, readTraceEntry } = load("packages/conversation-trace/src/store.ts");
  const { readSessionTrace } = load("packages/conversation-trace/src/projection.ts");
  const originalFetch = globalThis.fetch;
  const originalProvider = routeState.provider;
  const allowed = process.env.A_PRIVATE_MODEL_ORIGINS;
  process.env.A_PRIVATE_MODEL_ORIGINS = "http://localhost:1";
  routeState.provider = new OpenAICompatibleProvider({
    model: "fixture-model", baseUrl: "http://localhost:1", apiKey: "fixture-key", thinking: "enabled", effort: "max",
  });
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response('data: {"choices":[{"delta":{"content":"请求完成"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3}}\n\ndata: [DONE]\n\n');
  };
  try {
    const stream = await readRun(await request({ message: "用量核对" }));
    const events = await stream.rest();
    assert.equal(events.some(({ type }) => type === "error"), false);
    const [entry] = listTraceEntries(stream.sessionId, "u");
    assert.equal(entry.meta.metrics.usage, undefined);
    const record = readTraceEntry(stream.sessionId, "u", entry.id, true);
    const options = record.request.provider.options;
    assert.equal(options.model, body.model);
    assert.equal(options.thinking, body.thinking.type);
    assert.equal(options.reasoningEffort, body.reasoning_effort);
    assert.equal(options.includeUsage, body.stream_options.include_usage);
    assert.doesNotMatch(JSON.stringify(options), /fixture-key|localhost/);
    assert.equal(record.response.usage.estimated, true);
    const { requests } = readSessionTrace(stream.sessionId, "u", true).analysis;
    assert.equal(requests.reported.count, 0);
    assert.equal(requests.estimated.count, 1);
    assert.equal(requests.estimated.input, record.response.usage.inputTokens);
  } finally {
    globalThis.fetch = originalFetch;
    routeState.provider = originalProvider;
    if (allowed === undefined) delete process.env.A_PRIVATE_MODEL_ORIGINS;
    else process.env.A_PRIVATE_MODEL_ORIGINS = allowed;
  }
});

test("压缩提示词和压缩后的主请求分别保存，且关联同一个步骤", async () => {
  const { createConversationTrace } = load("packages/conversation-trace/src/recorder.ts");
  const { listTraceEntries, readTraceEntry, readTraceRecordView } = load("packages/conversation-trace/src/store.ts");
  const s = store.createSession("u");
  for (const [id, content] of [["old", "早期对话材料".repeat(1000)], ["near", "最近一轮"], ["new", "继续处理"]]) {
    store.addMessage(s, { id: `compact-${id}`, role: "user", content, createdAt: Date.now() });
  }
  const provider = { id: "mock", async *stream({ messages }) {
    const compact = messages[0].content.startsWith("[A.ai:compact]");
    yield { type: "text", delta: compact
      ? JSON.stringify({ goal: "测试压缩摘要", constraints: [], confirmed: [], progress: [], pending: [] })
      : "最终答复" };
    yield { type: "done", finishReason: "stop" };
  } };
  for await (const _ of runAgent({ session: s, provider, userId: "u", workspace: data, contextWindow: 4096, maxSteps: 3,
    execution: { runId: "compact", inputId: "compact-new" },
    conversationTrace: createConversationTrace({ sessionId: s.id, runId: "compact", inputId: "compact-new", model: "mock", effort: "default" }),
  })) { /* 消费完整模型流。 */ }
  const entries = listTraceEntries(s.id, "u");
  assert.deepEqual(entries.map(({ meta }) => [meta.phase, meta.step]), [["compact", 1], ["chat", 1]]);
  assert.match(readTraceEntry(s.id, "u", entries[0].id).request.messages[0].content, /\[A\.ai:compact\]/);
  assert.ok(readTraceEntry(s.id, "u", entries[1].id).request.messages.some((message) => message.content.includes("测试压缩摘要")));
  assert.deepEqual(readTraceRecordView(s.id, "u", entries[0].id).request.messages, []);
  const view = readTraceRecordView(s.id, "u", entries[1].id);
  assert.equal(view.request.messages.length, 1);
  assert.match(view.request.messages[0].content, /^继续处理/);
});

test("被重复失败保护拦下的工具不启动，也不产生执行中的轨迹事件", async () => {
  const s = store.createSession("u");
  store.addMessage(s, { id: "guard-trace", role: "user", content: "读取文件", createdAt: Date.now() });
  const original = tool.run;
  let executed = 0;
  tool.run = async () => { executed++; throw new Error("文件不存在"); };
  let step = 0;
  const provider = { id: "mock", async *stream() {
    if (step < 3) yield { type: "tool_call", call: { id: `guard-${++step}`, name: "read_file", arguments: "{}" } };
    else yield { type: "text", delta: "读取失败" };
    yield { type: "done" };
  } };
  try {
    const started = [];
    for await (const event of runAgent({ session: s, provider, userId: "u", workspace: data, maxSteps: 4, maxFixRounds: 0 })) {
      if (event.type === "tool_start") started.push(event.callId);
    }
    assert.deepEqual(started, ["guard-1", "guard-2"]);
    assert.equal(executed, 2);
    assert.equal(s.messages.find((message) => message.toolCallId === "guard-3").errorKind, "blocked");
  } finally { tool.run = original; }
});
