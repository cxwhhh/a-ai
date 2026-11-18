import { test } from "node:test";
import assert from "node:assert/strict";
import { load, store, agents, routeState, routeFixture, readRun } from "../../../tests/fixtures/agent-runtime.mjs";

const sse = (data) => `data: ${JSON.stringify(data)}\n\n`;
const textFrame = (content, finish_reason) => sse({ choices: [{ delta: { content }, finish_reason }] });
const toolFrame = sse({ choices: [{ delta: { tool_calls: [{
  index: 0, id: "test-call", function: { name: "read_file", arguments: "{}" },
}] } }] });

/** 在真实聊天路由中使用兼容适配器，只有 HTTP 响应由测试接管。 */
function mockSse(t, respond) {
  const originalFetch = globalThis.fetch;
  const originalProvider = routeState.provider;
  const { OpenAICompatibleProvider } = load("packages/llm/src/providers/openai-compatible.ts");
  routeState.provider = new OpenAICompatibleProvider({ model: "fixture", baseUrl: "http://localhost:1", apiKey: "fixture" });
  globalThis.fetch = respond;
  t.after(() => {
    globalThis.fetch = originalFetch;
    routeState.provider = originalProvider;
  });
}

test("兼容接口无结束信号即关闭时保留半截文字，拒绝派发工具并暂停队列", async (t) => {
  const { request, queue } = routeFixture();
  const gate = Promise.withResolvers();
  let requests = 0;
  mockSse(t, async () => {
    requests++;
    await gate.promise;
    return new Response(textFrame("已收到的文字") + toolFrame);
  });
  const flow = await readRun(await request({ message: "先检查文件" }));
  try {
    const response = await queue({ action: "enqueue", sessionId: flow.sessionId, runId: flow.runId, message: "待处理的下一轮" });
    assert.equal(response.status, 200);
  } finally {
    gate.resolve();
  }
  const events = await flow.rest();
  assert.equal(requests, 1);
  assert.ok(events.some(e => e.type === "error" && e.message.includes("提前中断")));
  assert.ok(events.some(e => e.type === "done" && e.interrupted));
  assert.equal(events.some(e => e.type === "tool_start"), false);

  const saved = store.getSession(flow.sessionId, "u");
  assert.deepEqual(saved.messages.map(m => [m.role, m.content]), [["user", "先检查文件"], ["assistant", "已收到的文字"]]);
  assert.equal(saved.messages[1].toolCalls, undefined);
  const work = agents.inspect(flow.sessionId, "u");
  assert.equal(work.counts.interrupted, 1);
  assert.equal(work.counts.completed, 0);
  assert.equal(work.counts.queued, 1);
  assert.equal(work.activeRunId, null);

  const { listTraceEntries, readTraceEntry } = load("packages/conversation-trace/src/store.ts");
  const [entry] = listTraceEntries(flow.sessionId, "u");
  assert.equal(entry.outcome, "interrupted");
  const record = readTraceEntry(flow.sessionId, "u", entry.id, true);
  assert.ok(record.response.blocks.some(block => block.kind === "tool-draft"));
  assert.equal(record.response.blocks.some(block => block.kind === "tool-call"), false);
});

test("兼容接口仅提供 finish_reason 或仅提供 DONE 时仍能正常结束", async (t) => {
  const { request } = routeFixture();
  const responses = [textFrame("有结束原因", "stop"), textFrame("有结束标记") + "data: [DONE]\n\n"];
  mockSse(t, async () => new Response(responses.shift()));
  for (const text of ["有结束原因", "有结束标记"]) {
    const flow = await readRun(await request({ message: "正常结束" }));
    const events = await flow.rest();
    assert.equal(events.some(e => e.type === "error"), false);
    assert.equal(store.getSession(flow.sessionId, "u").messages.at(-1).content, text);
    assert.equal(agents.inspect(flow.sessionId, "u").counts.completed, 1);
  }
});

test("正常完成的工具请求可以执行，长度截断的工具请求停止在本轮", async (t) => {
  const { request } = routeFixture();
  const responses = [toolFrame + textFrame("", "tool_calls"), textFrame("工具执行完成", "stop"), toolFrame + textFrame("部分回答", "length")];
  mockSse(t, async () => new Response(responses.shift()));
  const successful = await readRun(await request({ message: "调用工具" }));
  assert.ok((await successful.rest()).some(e => e.type === "tool_start" && e.callId === "test-call"));
  assert.equal(agents.inspect(successful.sessionId, "u").counts.completed, 1);

  const truncated = await readRun(await request({ message: "触发输出上限" }));
  assert.equal((await truncated.rest()).some(e => e.type === "tool_start"), false);
  assert.equal(agents.inspect(truncated.sessionId, "u").counts["output-truncated"], 1);
  assert.equal(responses.length, 0);
});

test("适配器交出工具调用后直接结束迭代，主循环仍要求 done", async (t) => {
  const { request } = routeFixture();
  const originalProvider = routeState.provider;
  routeState.provider = { async *stream() {
    yield { type: "tool_call", call: { id: "unconfirmed", name: "read_file", arguments: "{}" } };
  } };
  t.after(() => { routeState.provider = originalProvider; });
  const flow = await readRun(await request({ message: "检查适配器契约" }));
  const events = await flow.rest();
  assert.equal(events.some(e => e.type === "tool_start"), false);
  assert.equal(agents.inspect(flow.sessionId, "u").counts.interrupted, 1);
});
