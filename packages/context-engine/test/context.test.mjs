import assert from "node:assert/strict";
import { test } from "node:test";
import { data, db, load, runAgent, store } from "../../../tests/fixtures/agent-runtime.mjs";

const { readSavedToolResult } = load("packages/tools/src/read-tool-result.ts");
const { readToolResult } = load("packages/storage/src/tool-results.ts");
const { buildContext } = load("packages/context-engine/src/context.ts");
const { NOTE_TAG } = load("packages/protocol/src/lib/message-tags.ts");

async function run(session, provider, options = {}) {
  for await (const event of runAgent({ session, provider, userId: "u", workspace: data, multiAgent: false, ...options })) {
    assert.notEqual(event.type, "error", event.message);
  }
}

test("同一用户轮分阶段保存工作态，继续串行调错并保留原始调用与补充", async () => {
  const savedThreshold = process.env.A_COMPACT_TOKENS;
  process.env.A_COMPACT_TOKENS = "4000";
  const session = store.createSession("u");
  const input = { id: "serial-debug", role: "user", content: "反复验证同一个脚本，保留现有输入格式", createdAt: 1 };
  const note = { id: "serial-note", role: "user", content: `${NOTE_TAG} 保留测试夹具`, feedback: { kind: "note", summary: "用户补充" }, createdAt: 2 };
  store.beginTurn(session, input, undefined, "serial-debug-run");
  const probe = { spec: { name: "probe_script", parameters: { type: "object", properties: {} } }, parallelSafe: true,
    run: async ({ step }) => ({ content: step === 1 ? "实际报错：字段名缺失" : `第 ${step} 次已通过验证`, status: step === 1 ? "error" : "ok" }) };
  const registry = { deferredCatalog: () => "", toolSpecs: () => [probe.spec], toolsFor: () => [probe.spec], findTool: () => probe };
  const rawPayload = "同文件调试记录".repeat(430);
  let main = 0, compacted = 0;
  const provider = { id: "working-state", async *stream({ messages }) {
    if (messages[0].content.startsWith("[A.ai:compact]")) {
      compacted++;
      assert.match(messages[0].content, /仍在运行的同一用户轮/);
      const [, status, sourceId] = /\[工具凭据 status=(\w+) sourceId=([^\]]+)\]/.exec(messages[1].content) ?? [];
      assert.ok(sourceId);
      const state = { goal: input.content, constraints: ["保留现有输入格式"], confirmed: [],
        progress: [{ sourceId, status, text: "收到本轮脚本的实际执行结果" }], pending: ["继续验证同一个脚本"] };
      yield { type: "text", delta: JSON.stringify(state) };
    } else if (++main <= 5) {
      assert.ok(messages.some(({ content }) => content.includes(input.content)));
      if (compacted) {
        assert.match(messages[0].content, /当前轮工作态/);
        assert.ok(messages.some(({ content }) => content.includes("保留测试夹具")));
        assert.ok(!messages.some(({ toolCalls }) => toolCalls?.some(({ id }) => id === "probe-1")));
        const calls = new Set(messages.flatMap(({ toolCalls }) => toolCalls?.map(({ id }) => id) ?? []));
        assert.ok(messages.filter(({ role }) => role === "tool").every(({ toolCallId }) => calls.has(toolCallId)));
      }
      yield { type: "tool_call", call: { id: `probe-${main}`, name: "probe_script", arguments: JSON.stringify({ step: main, payload: rawPayload }) } };
    } else yield { type: "text", delta: "同一个脚本已通过最终验证" };
    yield { type: "done" };
  } };
  try {
    const events = [];
    for await (const event of runAgent({ session, provider, userId: "u", workspace: data, tools: registry,
      execution: { runId: "serial-debug-run", inputId: input.id }, disabledTools: { run_python: "fixture", run_command: "fixture" }, maxSteps: 8 })) {
      assert.notEqual(event.type, "error", event.message);
      events.push(event);
      if (event.message?.toolCallId === "probe-2") store.addMessage(session, note);
    }
    assert.ok(events.some(({ message }) => message?.content === "同一个脚本已通过最终验证"));
    assert.ok(compacted >= 2);
    const saved = store.getSession(session.id, "u");
    assert.equal(saved.messages.filter(({ compact }) => compact?.inputId === input.id).length, compacted);
    assert.ok(saved.messages.some(({ toolCallId, content }) => toolCallId === "probe-1" && content.includes("字段名缺失")));
    assert.match(buildContext(saved.messages, "系统", { inputId: input.id }).messages[0].content, /当前轮工作态/);
    assert.doesNotMatch(buildContext(saved.messages, "系统", { inputId: "下一轮" }).messages[0].content, /当前轮工作态/);
  } finally {
    if (savedThreshold === undefined) delete process.env.A_COMPACT_TOKENS;
    else process.env.A_COMPACT_TOKENS = savedThreshold;
  }
});

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
      assert.ok(pointer.length < 120);
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
