import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { agents, createRegistry, data, db, load, overrides, readRun, routeFixture, routeState, runAgent, store, tool } from "../../../tests/fixtures/agent-runtime.mjs";

const { runSubagentTool, SubagentOrchestrator } = load("packages/subagent/src/subagent.ts");
const { ParentDelegation } = load("packages/subagent/src/delegation-policy.ts");
const { collectSettlements } = load("packages/subagent/src/delegation-inbox.ts");
const { budgetLimits, ROLES, TokenBudget } = load("packages/subagent/src/role-budget.ts");
const { assessResult } = load("packages/subagent/src/result-contract.ts");
const { capabilityScope } = load("packages/subagent/src/capability-scope.ts");
const { getSubagentTask, listSubagentTasks, registerTask } = load("packages/subagent/src/ownership-claim.ts");
const { agentSessions } = load("packages/session/src/agent-session.ts");

const toolCall = (name, args, id = name) => ({ type: "tool_call", call: { id, name, arguments: JSON.stringify(args) } });
const model = (stream) => ({ id: "mock", stream });
const stop = { type: "done", finishReason: "stop" };
const toolEnd = { type: "done", finishReason: "tool_calls" };
const weather = "weather:tokyo:2026-11-20:temp:c";
const costs = "project:operating-cost";

// 生产 Host 的监听会让进程保持运行。测试中的模型和工具故意悬停时，也要让 unref 的期限有机会触发。
let hostTimer;
beforeEach(() => { hostTimer = setInterval(() => {}, 30_000); });
afterEach(() => { clearInterval(hostTimer); });

function makeOrigin(parentCallId) {
  return { runId: crypto.randomUUID(), inputId: crypto.randomUUID(), parentCallId };
}

function setup(provider, extras = {}) {
  const session = store.createSession("u");
  return { session, sessionId: session.id, userId: "u", workspace: data, disabled: {}, provider, ...extras };
}

function assignment(task, role, key, file) {
  return { task, role, plan: ["确认路径和口径", "读取并回报原文"], acceptance: ["有明确来源"], factKeys: [key], paths: [file] };
}

function plan(a, b) {
  return { objective: "完成项目事实核对", reason: "两份资料检查可以独立推进", synthesis: "合并已核对的事实，列出未完成项", assignments: [a, b] };
}

function response(facts, summary = "调研结果") {
  return { type: "text", delta: JSON.stringify({ summary, checks: [{ index: 1, met: true, evidenceIds: ["E1.1"] }], facts, unresolved: [] }) };
}

function published(result) {
  return JSON.parse(result.match(/```json\n([\s\S]*?)\n```/)[1]);
}

test("简单天气任务由父轮直接查询并简短回应，不登记子任务", async () => {
  const fixture = routeFixture();
  let calls = 0;
  routeState.provider = model(async function* ({ messages }) {
    if (++calls === 1) {
      assert.match(messages[0].content, /查天气、一次网页查询.*由你直接处理/);
      yield toolCall("read_file", { path: "tokyo-weather.txt" });
      yield toolEnd;
    } else {
      yield { type: "text", delta: "东京今天 29°C。" };
      yield stop;
    }
  });
  const run = await readRun(await fixture.request({ message: "今天东京天气怎么样？", multiAgent: true }));
  const events = await run.rest();
  assert.equal(calls, 2);
  assert.ok(events.some(({ message }) => message?.content === "东京今天 29°C。"));
  assert.deepEqual(listSubagentTasks({ sessionId: run.sessionId, userId: "u" }), []);
});

test("普通对话默认禁用委派，开启后保留设置，项目自动使用多 Agent", async () => {
  const service = new SubagentOrchestrator();
  const fixture = routeFixture({ agents, agentSessions, subagents: service });
  const { createProject } = load("packages/application/projects/src/projects.ts");
  const available = [];
  routeState.provider = model(async function* ({ messages, tools }) {
    if (messages[0].content.startsWith("你是 A.ai 的只读子 Agent")) {
      yield { type: "text", delta: "子分支完成" };
      yield stop;
    } else if (messages.at(-1)?.role !== "tool") {
      available.push(tools.some(({ name }) => name === "research"));
      yield toolCall("research", { name: "搜索日期", task: "核对活动日期" });
      yield toolEnd;
    } else {
      yield { type: "text", delta: "父轮结束" };
      yield stop;
    }
  });
  try {
    const plain = await readRun(await fixture.request({ message: "普通对话" }));
    const ordinary = await plain.rest();
    assert.ok(ordinary.some(({ message }) => message?.role === "tool" && message.status === "denied"));
    assert.equal(listSubagentTasks({ sessionId: plain.sessionId, userId: "u" }).length, 0);
    assert.equal((await fixture.patch("sessions", plain.sessionId, { multiAgent: true })).status, 200);
    const enabled = await readRun(await fixture.request({ sessionId: plain.sessionId, message: "继续协作" }));
    await enabled.rest();
    assert.equal(store.getSession(plain.sessionId, "u").multiAgent, true);
    assert.equal(listSubagentTasks({ sessionId: plain.sessionId, userId: "u" })[0].contract.name, "搜索日期");

    const project = createProject("u", { name: "测试项目", description: "", memory: "off", share: false });
    const auto = await readRun(await fixture.request({ projectId: project.id, message: "项目任务" }));
    await auto.rest();
    assert.equal((await fixture.patch("sessions", auto.sessionId, { multiAgent: false })).status, 409);
    assert.equal(listSubagentTasks({ sessionId: auto.sessionId, userId: "u" }).length, 1);
    assert.deepEqual(available, [false, true, true]);
  } finally { await service.close(); }
});

test("用户只和指定的在途子 Agent 对话，消息与答复进入父轮的批量结果", { timeout: 5000 }, async () => {
  const service = new SubagentOrchestrator();
  const runtime = { agents, agentSessions, subagents: service };
  const fixture = routeFixture(runtime);
  const { GET, POST } = load("apps/server/src/routes/api/sessions/[id]/agent/subagents/route.ts");
  const hold = gate();
  const a = { ...assignment("验证日期", "review", "event-date", "date.txt"), name: "搜索日期" };
  const b = { ...assignment("验证地点", "review", "event-place", "place.txt"), name: "搜索地点" };
  let merged;
  let sawGuidance = false;
  const oldTool = tool.run;
  tool.run = async ({ path: file }) => ({ content: `记录 ${file}` });
  routeState.provider = model(async function* ({ messages }) {
    const child = [a, b].find(({ task }) => task === messages[1]?.content);
    if (!child) {
      const result = messages.find(({ role }) => role === "tool");
      if (result) {
        merged = published(result.content);
        yield { type: "text", delta: "已合并两个分支和用户补充" };
        yield stop;
      } else { yield toolCall("delegate_tasks", plan(a, b)); yield toolEnd; }
      return;
    }
    const guidance = messages.some(({ content }) => content.includes("请用日本时间"));
    if (!messages.some(({ role }) => role === "tool")) {
      await hold.wait;
      yield toolCall("read_file", { path: child.paths[0], factKey: child.factKeys[0] });
      yield toolEnd;
      return;
    }
    assert.equal(guidance, child === a);
    sawGuidance ||= guidance;
    const result = JSON.parse(response([{ key: child.factKeys[0], value: child.paths[0], quote: `记录 ${child.paths[0]}`, evidenceIds: ["E1.1"] }]).delta);
    if (guidance) result.reply = "收到，按日本时间核对。";
    yield { type: "text", delta: JSON.stringify(result) };
    yield stop;
  });
  try {
    const run = await readRun(await fixture.request({ message: "核对活动资料", multiAgent: true }));
    const owner = { sessionId: run.sessionId, userId: "u" };
    const context = { params: Promise.resolve({ id: run.sessionId }), runtime };
    await waitFor(() => listSubagentTasks(owner).length === 2);
    const list = await (await GET(new Request(`http://localhost/?runId=${run.runId}`), context)).json();
    assert.deepEqual(list.tasks.map(({ name }) => name).sort(), ["搜索地点", "搜索日期"]);
    const selected = list.tasks.find(({ name }) => name === a.name);
    const request = () => new Request(`http://localhost/?taskId=${selected.id}`, { method: "POST", body: JSON.stringify({ message: "请用日本时间" }) });
    routeState.caller = "other";
    assert.equal((await POST(request(), context)).status, 404);
    routeState.caller = "u";
    assert.equal((await POST(request(), context)).status, 202);
    assert.equal(getSubagentTask(owner, selected.id).pendingMessages[0].content, "请用日本时间");
    hold.open();
    await run.rest();
    assert.equal(sawGuidance, true);
    assert.equal(merged.results[0].dialogue.unanswered, 0);
    assert.deepEqual(merged.results[0].dialogue.messages, ["请用日本时间"]);
    assert.match(merged.results[0].dialogue.reply, /按日本时间核对/);
    assert.equal(merged.results[1].dialogue, undefined);
    const finished = getSubagentTask(owner, selected.id);
    assert.equal(finished.messages.filter(({ role }) => role === "tool").length, 1);
    assert.ok(finished.messages.some(({ role, content }) => role === "assistant" && content.includes("按日本时间核对")));
    assert.deepEqual((await (await GET(new Request(`http://localhost/?runId=${run.runId}`), context)).json()).tasks, []);
    assert.equal((await POST(request(), context)).status, 409);
  } finally { hold.open(); routeState.caller = "u"; tool.run = oldTool; await service.close(); }
});

test("复杂任务经实际聊天入口分工，分别执行计划，再将独占事实、证据和验收交回父轮", async () => {
  const service = new SubagentOrchestrator();
  const fixture = routeFixture({ agents, agentSessions, subagents: service });
  const byTask = new Map();
  const a = assignment("核对东京指定时刻温度", "research", weather, "weather.txt");
  const b = assignment("核对项目运行成本", "analysis", costs, "costs.txt");
  const original = tool.run;
  tool.run = async ({ path: file }) => ({ content: file === "weather.txt" ? "东京温度 29°C" : "项目运行成本 3" });
  let batch;
  routeState.provider = model(async function* ({ messages, tools }) {
    const child = messages[0].content.startsWith("你是 A.ai 的只读子 Agent");
    if (!child) {
      const expanded = messages.find((message) => message.role === "tool");
      if (!expanded) {
        assert.ok(tools.some(({ name }) => name === "delegate_tasks"));
        yield toolCall("delegate_tasks", plan(a, b));
        yield toolEnd;
      } else {
        batch = published(expanded.content);
        yield { type: "text", delta: "集中结果：东京 29°C，运行成本 3。两项均有来源。" };
        yield stop;
      }
      return;
    }
    const task = messages[1].content === a.task ? a : b;
    const [key] = task.factKeys;
    assert.match(messages[0].content, /确认路径和口径/);
    assert.match(messages[0].content, /读取并回报原文/);
    assert.doesNotMatch(JSON.stringify(messages), /复杂项目：请综合/);
    assert.deepEqual(tools.find(({ name }) => name === "read_file").parameters.properties.factKey.enum, [key]);
    const attempt = (byTask.get(key) ?? 0) + 1;
    byTask.set(key, attempt);
    if (attempt === 1) {
      yield toolCall("read_file", { path: task.paths[0], factKey: key }, "reused");
      yield toolEnd;
    } else {
      const quote = task === a ? "东京温度 29°C" : "项目运行成本 3";
      yield response([{ key, value: task === a ? "29°C" : "3", quote, evidenceIds: ["E1.1"] }]);
      yield stop;
    }
  });
  try {
    const run = await readRun(await fixture.request({ message: "复杂项目：请综合核对温度和运行成本。", multiAgent: true }));
    const events = await run.rest();
    assert.ok(events.some(({ message }) => message?.content === "集中结果：东京 29°C，运行成本 3。两项均有来源。"));
    assert.deepEqual([...byTask.values()], [2, 2]);
    assert.deepEqual(batch.results.map(({ facts }) => facts[0].value), ["29°C", "3"]);
    assert.ok(batch.results.every((item) => item.status === "completed" && item.acceptance[0].met && item.evidence[0].traceId));
    const records = listSubagentTasks({ sessionId: run.sessionId, userId: "u" });
    assert.equal(records.length, 2);
    assert.equal(new Set(records.map(({ parentCallId }) => parentCallId)).size, 1);
    const readTrace = load("packages/conversation-trace/src/store.ts");
    const entries = readTrace.listTraceEntries(run.sessionId, "u");
    const requests = entries.filter(({ meta }) => meta.phase === "research");
    const parentRequest = entries.find(({ meta }) => meta.phase === "chat");
    const parentWindow = readTrace.readTraceEntry(run.sessionId, "u", parentRequest.id).request.agent.contextWindow;
    assert.equal(parentWindow, 128_000);
    for (const { id } of requests) assert.equal(readTrace.readTraceEntry(run.sessionId, "u", id).request.agent.contextWindow, parentWindow);
    for (const second of requests.filter(({ meta }) => meta.childStep === 2)) {
      const comparison = readTrace.readTraceEntry(run.sessionId, "u", second.id, true);
      const first = requests.find(({ id }) => id === comparison.context.previous.id);
      assert.equal(first.meta.taskId, second.meta.taskId);
    }
  } finally {
    tool.run = original;
    await service.close();
  }
});

test("计划验收前拒绝规范化后的重复事实及不完整分工，登记事务不会留下半份计划", async () => {
  const service = new SubagentOrchestrator();
  const ctx = setup(model(async function* () { assert.fail("无效计划不应开始执行"); }));
  const a = assignment("查温度", "research", weather, "weather.txt");
  const b = assignment("比对统计", "analysis", weather.toUpperCase(), "costs.txt");
  const parent = new ParentDelegation();
  assert.throws(() => service.startPlan(plan(a, b), ctx, makeOrigin("parent"), parent), /重复分工/);
  assert.throws(() => service.startPlan(plan(a, { ...b, plan: [] }), ctx, makeOrigin("parent"), parent), /角色、步骤/);
  assert.throws(() => service.startPlan(plan(a, { ...b, factKeys: [costs], tools: ["write_file"] }), ctx, makeOrigin("parent"), parent), /角色范围/);
  const search = { ...a, task: "搜索公开资料", tools: ["web_search"], hosts: ["example.org"] };
  assert.throws(() => service.startPlan(plan({ ...b, factKeys: [costs] }, search), ctx, makeOrigin("parent"), parent), /搜索公开资料.*web_search.*省略 hosts/);
  assert.throws(() => service.start({ ...a, paths: [], tools: ["read_file"] }, ctx, makeOrigin()), /查温度.*read_file.*材料范围/);
  assert.throws(() => service.start({ ...a, tools: ["read_file"] }, { ...ctx, disabled: { read_file: "停用" } }, makeOrigin()), /查温度.*read_file/);
  assert.deepEqual(listSubagentTasks(ctx), []);
  await service.close();
});

test("同源分工分别核对事实，部分失败时父轮只补缺项", async () => {
  const service = new SubagentOrchestrator();
  const fixture = routeFixture({ agents, agentSessions, subagents: service });
  const catalog = load("packages/tool-runtime/src/index.ts");
  const previous = { ...catalog };
  const reads = [];
  const web = { spec: { name: "web_fetch", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
    async run({ url }) {
      reads.push(url);
      return url.endsWith("/unavailable") ? { content: "示例网页请求超时", status: "timeout" }
        : { content: JSON.stringify({ url, content: "工作组位于东京，核对周期为每月。" }) };
    } };
  catalog.findTool = (name) => name === "web_fetch" ? web : previous.findTool(name);
  catalog.toolSpecs = () => [...previous.toolSpecs(), web.spec];
  const a = { ...assignment("核对工作组地点", "research", "office:city", "."), hosts: ["example.org"] };
  const b = { ...assignment("核对核验周期", "research", "office:review-cycle", "."), hosts: ["example.org"] };
  const c = { ...assignment("核对资金来源", "research", "office:funding", "."), hosts: ["example.org"] };
  const commonUrl = "https://example.org/description";
  const unavailable = "https://example.org/unavailable";
  const originalRead = tool.run;
  let fallbackReads = 0;
  tool.run = async () => { fallbackReads++; return { content: "补充材料：资金来自委托方。" }; };
  routeState.provider = model(async function* ({ messages }) {
    const role = [a, b, c].find(({ task }) => task === messages[1]?.content);
    const toolMessages = messages.filter(({ role }) => role === "tool");
    if (role) {
      if (!toolMessages.length) {
        yield toolCall("web_fetch", { url: role === c ? unavailable : commonUrl, factKey: role.factKeys[0] });
        yield toolEnd;
      } else {
        yield response(role === c ? [] : [{ key: role.factKeys[0], value: role === a ? "东京" : "每月",
          quote: role === a ? "工作组位于东京" : "核对周期为每月", evidenceIds: ["E1.1"] }]);
        yield stop;
      }
      return;
    }
    if (!toolMessages.length) {
      yield toolCall("delegate_tasks", { ...plan(a, b), assignments: [a, b, c] }, "initial-batch");
      yield toolEnd;
    } else if (toolMessages.length === 1) {
      const result = published(toolMessages[0].content);
      assert.equal(result.batchStatus, "partial");
      assert.deepEqual(result.results.map(({ name, facts, status, missingFactKeys }) => ({ name, value: facts[0]?.value, status, missingFactKeys })), [
        { name: a.task, value: "东京", status: "completed", missingFactKeys: [] },
        { name: b.task, value: "每月", status: "completed", missingFactKeys: [] },
        { name: c.task, value: undefined, status: "partial", missingFactKeys: c.factKeys },
      ]);
      yield toolCall("read_file", { path: "backup-funding.txt" }, "missing-only");
      yield toolEnd;
    } else {
      assert.match(toolMessages[1].content, /资金来自委托方/);
      yield { type: "text", delta: "已汇总地点、核对周期与资金来源。" };
      yield stop;
    }
  });
  try {
    const run = await readRun(await fixture.request({ message: "分别核对三个工作组事项并汇总。", multiAgent: true }));
    const events = await run.rest();
    const batch = events.find(({ message }) => message?.toolCallId === "initial-batch").message;
    assert.equal(batch.status, "ok");
    assert.equal(batch.isError, false);
    assert.ok(events.some(({ message }) => message?.content === "已汇总地点、核对周期与资金来源。"));
    assert.equal(listSubagentTasks({ sessionId: run.sessionId, userId: "u" }).length, 3);
    assert.deepEqual(reads.sort(), [commonUrl, commonUrl, unavailable].sort());
    assert.equal(fallbackReads, 1);
  } finally { Object.assign(catalog, previous); tool.run = originalRead; await service.close(); }
});

test("父轮在批次内逐项收到持久结算，全部分支结束后才向模型交付汇总输入", { timeout: 3000 }, async () => {
  const service = new SubagentOrchestrator();
  const slow = gate();
  const a = assignment("慢分支", "review", "first-file", "a.txt");
  const b = assignment("快分支", "review", "second-file", "b.txt");
  const original = tool.run;
  tool.run = async ({ path: file }) => ({ content: `原文 ${file}` });
  let parentReads = 0;
  const ctx = setup(model(async function* ({ messages }) {
    const task = [a, b].find(({ task }) => task === messages[1]?.content);
    if (!task) {
      parentReads++;
      const completed = messages.filter(({ role }) => role === "tool");
      if (!completed.length) {
        yield toolCall("delegate_tasks", plan(a, b), "batch");
        yield toolEnd;
      } else {
        assert.equal(completed.length, 1);
        assert.deepEqual(published(completed[0].content).results.map(({ task }) => task), [a.task, b.task]);
        yield { type: "text", delta: "两项都已汇总" };
        yield stop;
      }
      return;
    }
    if (!messages.some(({ role }) => role === "tool")) {
      if (task === a) await slow.wait;
      yield toolCall("read_file", { path: task.paths[0], factKey: task.factKeys[0] });
      yield toolEnd;
    } else {
      yield response([{ key: task.factKeys[0], value: task.paths[0], quote: `原文 ${task.paths[0]}`, evidenceIds: ["E1.1"] }]);
      yield stop;
    }
  }));
  const turn = runAgent({ ...ctx, subagents: service, maxSteps: 2 });
  const events = [];
  try {
    for (;;) {
      const next = await turn.next();
      assert.equal(next.done, false);
      const event = next.value;
      events.push(event);
      if (event.type !== "tool_output" || !event.delta.includes("已结算")) continue;
      const tasks = listSubagentTasks(ctx);
      const fast = tasks.find(({ contract }) => contract.task === b.task);
      assert.equal(fast.status, "completed");
      assert.ok(event.delta.includes(fast.id));
      assert.equal(tasks.find(({ contract }) => contract.task === a.task).status, "running");
      assert.equal(parentReads, 1);
      assert.ok(events.every(({ type }) => type !== "text" && type !== "done"));
      break;
    }
    slow.open();
    for await (const event of turn) events.push(event);
    assert.equal(parentReads, 2);
    assert.equal(events.filter(({ message }) => message?.role === "tool").length, 1);
    assert.ok(events.some(({ type, delta }) => type === "text" && delta === "两项都已汇总"));
  } finally { slow.open(); await turn.return(); tool.run = original; await service.close(); }
});

test("子任务收件箱按完成顺序通知，重复句柄只唤醒一次，原分工顺序可汇总", async () => {
  const events = [];
  const a = { id: "a" };
  const b = { id: "b" };
  const slow = gate();
  const first = { record: a, finished: slow.wait.then(() => a) };
  const second = { record: b, finished: Promise.resolve(b) };
  const collected = collectSettlements([first, second, second], (event) => events.push(event));
  await waitFor(() => events.length === 1);
  assert.deepEqual(events.map(({ record, sequence }) => [record.id, sequence]), [["b", 1]]);
  slow.open();
  assert.deepEqual((await collected).map(({ record }) => record.id), ["a", "b", "b"]);
  assert.deepEqual(events.map(({ record, sequence }) => [record.id, sequence]), [["b", 1], ["a", 2]]);
});

for (const action of ["revise", "accept"]) {
  test(`收尾复核 ${action} 共用原预算，复核意见须经程序验收`, async () => {
    const service = new SubagentOrchestrator();
    const original = tool.run;
    const read = [];
    tool.run = async ({ path: file }) => {
      read.push(file);
      return { content: file === "a.txt" ? "现场测量 29°C" : "校准记录 30°C" };
    };
    let reviews = 0;
    let childSteps = 0;
    const ctx = setup(model(async function* ({ messages, tools, maxOutputTokens }) {
      if (messages[0].content.startsWith("你只负责子 Agent 收尾复核")) {
        reviews++;
        assert.equal(tools, undefined);
        assert.equal(maxOutputTokens, 256);
        const review = JSON.parse(messages[1].content);
        assert.deepEqual(review.concern.cited, [{ id: "E1.1", excerpt: "现场测量 29°C" }]);
        assert.ok(!JSON.stringify(review).includes("不存在的证据"));
        yield { type: "text", delta: JSON.stringify({ action, reason: "核对校准记录" }) };
        yield stop;
        return;
      }
      childSteps++;
      if (childSteps === 1 || childSteps === 3) {
        if (childSteps === 3) assert.match(messages.at(-1).content, /收尾复核要求补证/);
        yield toolCall("read_file", { path: childSteps === 1 ? "a.txt" : "b.txt", factKey: weather });
        yield toolEnd;
      } else if (childSteps === 2) {
        const answer = JSON.parse(response([{ key: weather, value: "31°C", quote: "现场测量 29°C", evidenceIds: ["E1.1"] }]).delta);
        answer.review = { reason: "现场记录和校准口径可能不同", evidenceIds: ["E1.1", "不存在的证据"] };
        yield { type: "text", delta: JSON.stringify(answer) };
        yield stop;
      } else {
        assert.equal(tools, undefined);
        const answer = JSON.parse(response([{ key: weather, value: "30°C", quote: "校准记录 30°C", evidenceIds: ["E4.1"] }]).delta);
        answer.checks[0].evidenceIds = ["E4.1"];
        yield { type: "text", delta: JSON.stringify(answer) };
        yield stop;
      }
    }));
    ctx.contextWindow = 128_000;
    const origin = makeOrigin();
    const { createConversationTrace } = load("packages/conversation-trace/src/recorder.ts");
    ctx.trace = { recorder: createConversationTrace({ ...ctx, ...origin, model: "mock", effort: "default" }), step: 1 };
    try {
      const task = await service.start({ ...assignment("核对温度口径", "review", weather, "a.txt"), paths: ["a.txt", "b.txt"] }, ctx, origin).finished;
      assert.equal(reviews, 1);
      assert.equal(task.progress.steps, childSteps + reviews);
      const { listTraceEntries, readTraceEntry } = load("packages/conversation-trace/src/store.ts");
      const records = listTraceEntries(ctx.sessionId, ctx.userId).filter(({ meta }) => meta.kind === "request");
      assert.equal(records.length, childSteps + reviews);
      for (const { id } of records) assert.equal(readTraceEntry(ctx.sessionId, ctx.userId, id).request.agent.contextWindow, 128_000);
      if (action === "revise") {
        assert.deepEqual(read, ["a.txt", "b.txt"]);
        assert.equal(task.status, "completed");
        assert.equal(task.result.facts[0].value, "30°C");
      } else {
        assert.deepEqual(read, ["a.txt"]);
        assert.equal(task.status, "partial");
        assert.deepEqual(task.result.facts, []);
      }
    } finally { tool.run = original; await service.close(); }
  });
}

test("父轮到期时即使模型和工具忽略取消也能结算，晚到结果不能改写终态", { timeout: 4500 }, async () => {
  const service = new SubagentOrchestrator();
  const parent = new ParentDelegation(400);
  const stalledModel = gate();
  const stalledTool = gate();
  let modelSignal;
  let toolSignal;
  const original = tool.run;
  tool.run = async (_args, { signal }) => {
    toolSignal = signal;
    await stalledTool.wait;
    return { content: "迟到的工具结果" };
  };
  const ctx = setup(model(async function* ({ messages, signal }) {
    if (messages[1]?.content === "等待模型") {
      modelSignal = signal;
      yield { type: "text", delta: "已有片段" };
      await stalledModel.wait;
      yield { type: "text", delta: "迟到的模型文本" };
      yield stop;
    } else {
      yield toolCall("read_file", { path: "a.txt" });
      yield toolEnd;
    }
  }));
  try {
    const calls = ["等待模型", "等待工具"].map((task) => runSubagentTool(toolCall("research", { task }).call, {
      ...ctx, parent, origin: makeOrigin("parent"), orchestrator: service,
    }));
    const results = await Promise.all(calls);
    assert.ok(results.every(({ status }) => status === "timeout"));
    assert.ok(modelSignal.aborted && toolSignal.aborted);
    assert.equal(service.isBusy(ctx), false);
    const saved = listSubagentTasks(ctx);
    assert.ok(saved.every(({ status, progress }) => status === "timed-out" && progress.blockers[0].detail.includes("父轮等待")));
    assert.equal(saved.find(({ contract }) => contract.task === "等待模型").result.summary, "已有片段");
    stalledModel.open();
    stalledTool.open();
    await delay(30);
    assert.deepEqual(listSubagentTasks(ctx), saved);
  } finally { stalledModel.open(); stalledTool.open(); await parent.close(); await service.close(); tool.run = original; }
});

test("不同分工可以读取同一原文，越权事实仍不进入父轮可引用结果", async () => {
  const service = new SubagentOrchestrator();
  const a = assignment("查东京温度", "research", weather, "weather.txt");
  const b = { ...assignment("查独立资料", "analysis", costs, "costs.txt"), paths: ["costs.txt", "weather.txt"] };
  const original = tool.run;
  const executed = [];
  tool.run = async ({ path: file }) => { executed.push(file); return { content: "东京温度 29°C" }; };
  let ownerStarted;
  const ownerEvidence = new Promise((resolve) => { ownerStarted = resolve; });
  const ctx = setup(model(async function* ({ messages }) {
    const isOwner = messages[1].content === a.task;
    const followup = messages.some(({ role }) => role === "tool");
    if (!followup) {
      if (!isOwner) await ownerEvidence;
      yield toolCall("read_file", { path: "weather.txt", factKey: weather }, "owner");
      if (!isOwner) yield toolCall("read_file", { path: "./weather.txt", factKey: costs }, "duplicate");
      yield toolEnd;
      return;
    }
    if (isOwner) {
      ownerStarted();
      yield response([{ key: weather, value: "29°C", quote: "东京温度 29°C", evidenceIds: ["E1.1"] }]);
    } else {
      const returned = messages.filter(({ role }) => role === "tool");
      assert.match(returned[0].content, /没有分配/);
      assert.match(returned[1].content, /\[E1\.2\].*东京温度/s);
      yield response([{ key: weather, value: "2°C", quote: "东京温度 2°C", evidenceIds: ["E1.1"] }], "自由文本声称东京 2°C");
    }
    yield stop;
  }));
  try {
    const parent = new ParentDelegation();
    const { assignments } = service.startPlan(plan(a, b), ctx, makeOrigin("parent"), parent);
    const [valid, invalid] = await Promise.all(assignments.map(({ finished }) => finished));
    assert.deepEqual(executed, ["weather.txt", "./weather.txt"]);
    assert.equal(valid.result.facts[0].value, "29°C");
    assert.equal(invalid.status, "partial");
    assert.doesNotMatch(JSON.stringify(invalid.result), /2°C/);
    assert.throws(() => service.start({ ...a, task: "另一阶段重新查同一项" }, ctx, makeOrigin("later"), parent), /已分配/);
  } finally { tool.run = original; await service.close(); }
});

test("负责人引文必须支持数值，若其给出互相冲突的数值则都不发布", () => {
  const evidence = [{ id: "E1.1", kind: "tool", source: "天气记录", factKey: weather }];
  const quotes = new Map([["E1.1", "东京温度 29°C"]]);
  const valid = { key: weather, value: "29°C", quote: "东京温度 29°C", evidenceIds: ["E1.1"] };
  const wrong = { ...valid, value: "2°C" };
  assert.equal(assessResult(response([valid]).delta, [], evidence, [weather], quotes).facts[0].value, "29°C");
  assert.deepEqual(assessResult(response([wrong]).delta, [], evidence, [weather], quotes).facts, []);
  const timeAndTemperature = "下午 2 点记录为 29°C";
  const timeQuote = new Map([["E1.1", timeAndTemperature]]);
  assert.deepEqual(assessResult(response([{ ...wrong, quote: timeAndTemperature }]).delta, [], evidence, [weather], timeQuote).facts, []);
  const conflict = assessResult(response([valid, wrong]).delta, [], evidence, [weather], quotes);
  assert.deepEqual(conflict.facts, []);
  assert.match(conflict.unresolved.join(" "), /互相冲突/);
});

test("上下文只继承显式有效引用，文件真实路径、网站和禁用工具均受限", async () => {
  const service = new SubagentOrchestrator();
  const ctx = setup(model(async function* ({ messages, tools }) {
    assert.match(messages[2].content, /允许的上下文/);
    assert.doesNotMatch(JSON.stringify(messages), /不需要的上下文/);
    assert.equal(tools.length, 0);
    yield { type: "text", delta: "已读引用" };
    yield stop;
  }), { disabled: { read_file: "运行限制" } });
  const selected = { id: "allowed-message", role: "user", content: "允许的上下文", createdAt: Date.now() };
  const hidden = { ...selected, id: "omitted-message", content: "不需要的上下文" };
  store.addMessage(ctx.session, selected);
  store.addMessage(ctx.session, hidden);
  const allowed = path.join(data, "scope-allowed");
  const other = path.join(data, "scope-other");
  await mkdir(allowed);
  await mkdir(other);
  // Windows 普通用户可建立目录联接，仍验证真实路径越过许可目录时会被拦住。
  await symlink(other, path.join(allowed, "alias"), process.platform === "win32" ? "junction" : "dir");
  const scope = capabilityScope({ paths: ["scope-allowed"], hosts: ["example.org"] }, ["read_file", "web_fetch"], ctx);
  assert.throws(() => scope.readPath("scope-allowed/alias/file.txt"), /超出/);
  assert.throws(() => scope.checkUrl(new URL("https://different.example/")), /超出/);
  assert.doesNotThrow(() => scope.checkUrl(new URL("https://example.org/")));
  const input = { task: "读取明确引用", contextMessages: [selected.id], paths: ["scope-allowed"], contextFiles: ["scope-allowed/example.txt"] };
  const result = await service.start(input, ctx, makeOrigin()).finished;
  assert.equal(result.status, "completed");
  assert.deepEqual(result.evidence.map(({ id, source }) => [id, source]), [["C1", selected.id]]);
  assert.throws(() => service.start({ ...input, contextMessages: ["foreign"] }, ctx, makeOrigin()), /不在当前会话/);
  assert.throws(() => service.start({ ...input, contextFiles: ["scope-other/file.txt"] }, ctx, makeOrigin()), /超出/);
  await service.close();
});

test("执行入口拒绝没有暴露的子工具和已禁用的父委派", async () => {
  const service = new SubagentOrchestrator();
  const ctx = setup(model(async function* ({ messages, tools }) {
    assert.ok(tools.every(({ name }) => name !== "read_file"));
    if (messages.some(({ role }) => role === "tool")) {
      assert.match(messages.at(-1).content, /未获准/);
      yield { type: "text", delta: "工具不可用" };
      yield stop;
    } else {
      yield toolCall("read_file", { path: "restricted.txt" });
      yield toolEnd;
    }
  }), { disabled: { read_file: "禁用" } });
  const original = tool.run;
  tool.run = async () => assert.fail("禁用的工具不应调用");
  try {
    const result = await service.start({ task: "只能使用授权工具" }, ctx, makeOrigin()).finished;
    assert.equal(result.status, "partial");
    const events = [];
    const root = setup(model(async function* ({ messages, tools }) {
      assert.ok(tools.every(({ name }) => name !== "research" && name !== "delegate_tasks"));
      if (!messages.some(({ role }) => role === "tool")) {
        yield toolCall("research", { task: "不可执行" });
        yield toolEnd;
      } else {
        yield { type: "text", delta: "已直接处理" };
        yield stop;
      }
    }));
    for await (const event of load("packages/agent-loop/src/run.ts").runAgent({ ...root, disabledTools: { research: "禁用" } })) events.push(event);
    assert.ok(events.some(({ message }) => message?.status === "denied"));
    assert.ok(events.every(({ type }) => type !== "tool_start"));
    assert.deepEqual(listSubagentTasks(root), []);
  } finally { tool.run = original; await service.close(); }
});

test("各自结算 token，单子任务工具额用完后拒绝额外执行", async () => {
  const first = new TokenBudget(400);
  const second = new TokenBudget(400);
  const reservation = first.reserve(150);
  assert.equal(reservation.output, 250);
  assert.equal(second.reserve(100).output, 300);
  reservation.settle({ inputTokens: 150, outputTokens: 20 });
  assert.equal(first.reserve(100).output, 130);
  const service = new SubagentOrchestrator();
  const ctx = setup(model(async function* ({ messages, tools, maxOutputTokens }) {
    assert.ok(maxOutputTokens > 0 && maxOutputTokens <= 2048);
    if (!messages.some(({ role }) => role === "tool")) {
      yield toolCall("read_file", { path: "first" }, "first");
      yield toolCall("read_file", { path: "second" }, "second");
      yield toolEnd;
    } else {
      assert.equal(tools, undefined);
      assert.match(messages.find(({ toolCallId }) => toolCallId === "second").content, /没有执行/);
      yield { type: "text", delta: "已使用先到的证据。" };
      yield stop;
    }
  }));
  const result = await service.start({ task: "测试工具额度", budget: { toolCalls: 1 } }, ctx, makeOrigin()).finished;
  assert.equal(result.status, "completed");
  assert.equal(result.progress.toolCalls, 1);
  assert.ok(result.progress.inputTokens > 0);
  assert.equal(result.progress.estimated, true);
  assert.equal(result.evidence.length, 1);
  await service.close();
});

test("子任务截断、超时与父轮取消各自结算，保留模型片段", async (t) => {
  const service = new SubagentOrchestrator();
  const truncated = setup(model(async function* () {
    yield { type: "text", delta: "尚未写完" };
    yield { type: "done", finishReason: "length" };
  }));
  const first = await service.start({ task: "截断" }, truncated, makeOrigin()).finished;
  assert.equal(first.status, "partial");
  assert.equal(first.result.summary, "尚未写完");
  assert.equal(first.progress.blockers[0].code, "truncated");
  const timed = setup(model(async function* ({ signal }) { await untilAborted(signal); }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = service.start({ task: "超时", budget: { idleTimeoutMs: 180_000 } }, timed, makeOrigin());
    t.mock.timers.tick(599_999);
    assert.equal(getSubagentTask(timed, pending.record.id).status, "running");
    t.mock.timers.tick(1);
    const second = await pending.finished;
    assert.equal(second.status, "timed-out");
    assert.equal(second.progress.blockers[0].code, "timeout");
  } finally { t.mock.timers.reset(); }
  const stopParent = new AbortController();
  const cancelled = setup(model(async function* () {
    yield { type: "text", delta: "已经收到的片段" };
    stopParent.abort();
  }), { signal: stopParent.signal });
  const third = await service.start({ task: "停止" }, cancelled, makeOrigin("parent"), new ParentDelegation()).finished;
  assert.equal(third.status, "cancelled");
  assert.equal(third.result.summary, "已经收到的片段");
  assert.equal(getSubagentTask(cancelled, third.id).status, "cancelled");
  await service.close();
});

test("子任务总时限默认 10 分钟，只接受 10 至 30 分钟的配置", async () => {
  const service = new SubagentOrchestrator();
  const ctx = setup(model(async function* () {
    yield { type: "text", delta: "已读取" };
    yield stop;
  }), { contextWindow: 32_000 });
  try {
    for (const timeoutMs of [599_999, 1_800_001]) {
      assert.throws(() => service.start({ task: "检查非法时限", budget: { timeoutMs } }, ctx, makeOrigin()), /600000 至 1800000/);
    }
    const defaultTask = await service.start({ task: "默认预算" }, ctx, makeOrigin()).finished;
    assert.equal(defaultTask.limits.timeoutMs, 600_000);
    assert.equal(defaultTask.limits.idleTimeoutMs, 30_000);
    assert.equal(defaultTask.limits.tokens, 48_000);
    for (const timeoutMs of [600_000, 1_200_000, 1_800_000]) {
      const task = await service.start({ task: "检查有效时限", budget: { timeoutMs } }, ctx, makeOrigin()).finished;
      assert.equal(task.limits.timeoutMs, timeoutMs);
    }
    assert.equal(listSubagentTasks(ctx).length, 4);
  } finally { await service.close(); }
});

test("子任务使用模型配置的大窗口，显式累计预算仍能收紧", async () => {
  const service = new SubagentOrchestrator();
  const { estimateRequest } = load("packages/context-engine/src/context.ts");
  const inputs = [];
  const ctx = setup(model(async function* ({ messages, tools, maxOutputTokens }) {
    inputs.push({ tokens: estimateRequest(messages, tools), maxOutputTokens });
    yield { type: "text", delta: "材料已核对" };
    yield stop;
  }), { contextWindow: 128_000, projectRules: "项目约定".repeat(1_125) });
  ctx.session = { ...ctx.session, messages: Array.from({ length: 8 }, (_, i) => ({
    id: `material-${i}`, role: "user", content: "任务材料".repeat(375), createdAt: i,
  })) };
  const task = { task: "核对八份材料", contextMessages: ctx.session.messages.map(({ id }) => id) };
  try {
    const wide = await service.start(task, ctx, makeOrigin()).finished;
    assert.equal(wide.limits.tokens, 128_000);
    assert.equal(wide.status, "completed");
    assert.ok(inputs[0].tokens > 16_000);
    assert.ok(inputs[0].tokens + inputs[0].maxOutputTokens <= ctx.contextWindow);
    for (const [input, context] of [
      [task, { ...ctx, contextWindow: 12_000 }],
      [{ ...task, budget: { tokens: 12_000 } }, ctx],
    ]) {
      const restricted = await service.start(input, context, makeOrigin()).finished;
      assert.equal(restricted.progress.blockers[0].code, "budget");
    }
    assert.equal(inputs.length, 1);
  } finally { await service.close(); }
});

test("模型截断后用最后一次只读证据收尾，已截断的工具参数不执行", async () => {
  const svc = new SubagentOrchestrator();
  let step = 0;
  const ctx = setup(model(async function* ({ messages, tools, maxOutputTokens }) {
    step++;
    if (step === 1) {
      yield toolCall("read_file", { path: "fixture.txt", factKey: costs });
      yield toolEnd;
    } else if (step === 2) {
      yield toolCall("read_file", { path: "never.txt", factKey: costs });
      yield { type: "done", finishReason: "length" };
    } else {
      assert.equal(tools, undefined);
      assert.ok(maxOutputTokens > 2048);
      assert.match(messages.at(-1).content, /简短 JSON/);
      assert.ok(messages.some(({ content }) => content.includes("[E1.1]")));
      yield response([{ key: costs, value: "已核对", quote: "受控工具结果", evidenceIds: ["E1.1"] }]);
      yield stop;
    }
  }));
  try {
    const result = await svc.start({ ...assignment("验证截断恢复", "review", costs, "fixture.txt"), budget: { steps: 3 } }, ctx, makeOrigin()).finished;
    assert.equal(result.status, "completed");
    assert.equal(result.progress.toolCalls, 1);
    assert.equal(result.result.facts[0].key, costs);
    assert.equal(step, 3);
  } finally { await svc.close(); }
});

test("预算紧张时用收尾预留输出确认已有证据", async () => {
  const svc = new SubagentOrchestrator();
  let step = 0;
  const ctx = setup(model(async function* ({ messages, tools }) {
    step++;
    if (step <= 2) {
      yield toolCall("read_file", { path: `part${step}.txt`, factKey: costs });
      yield { ...toolEnd, usage: { inputTokens: 2500, outputTokens: 1100 } };
      return;
    }
    assert.equal(tools, undefined);
    assert.match(messages.at(-1).content, /交付已有结果/);
    yield response([{ key: costs, value: "已核对", quote: "受控工具结果", evidenceIds: ["E1.1"] }]);
    yield stop;
  }));
  try {
    const result = await svc.start({ ...assignment("验证收尾预留", "review", costs, "."), budget: { tokens: 12_000 } }, ctx, makeOrigin()).finished;
    assert.equal(result.status, "completed");
    assert.equal(result.progress.toolCalls, 2);
    assert.equal(step, 3);
  } finally { await svc.close(); }
});

test("父轮从首项起共用 30 分钟截止时间，后续分工启动时不重置", async (t) => {
  const parent = new ParentDelegation();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    t.mock.timers.tick(1_800_000);
    assert.equal(parent.signal.aborted, false);
    parent.track(Promise.resolve());
    t.mock.timers.tick(600_000);
    parent.track(Promise.resolve());
    t.mock.timers.tick(1_199_999);
    assert.equal(parent.signal.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(parent.signal.reason.name, "TimeoutError");
    assert.throws(() => parent.assertOpen(), /不能再委派/);
  } finally { await parent.close(); t.mock.timers.reset(); }
});

test("升级预算后旧提交保持幂等，旧短时限任务可按新下限创建重试", async () => {
  const service = new SubagentOrchestrator();
  let requests = 0;
  const ctx = setup(model(async function* () {
    requests++;
    yield { type: "text", delta: "读取完成" };
    yield stop;
  }));
  const seedLegacyTask = (contract, dedupeKey) => {
    const scope = capabilityScope(contract, ROLES.research.tools, ctx);
    const limits = { ...budgetLimits("research", {}, 128_000), tokens: 24_000, timeoutMs: contract.budget?.timeoutMs ?? 120_000 };
    const { idleTimeoutMs: _omitted, ...oldLimits } = limits;
    const fingerprint = createHash("sha256").update(JSON.stringify([contract, oldLimits, scope.identity, "", ctx.provider.id])).digest("hex");
    const { record } = registerTask(ctx, makeOrigin(), contract, "research", limits, dedupeKey, fingerprint);
    db().prepare("UPDATE subagent_tasks SET status='timed-out' WHERE id=?").run(record.id);
    return record.id;
  };
  try {
    const payload = { task: "旧请求", idempotencyKey: "legacy-request" };
    const saved = seedLegacyTask(payload, "background:legacy-request");
    const replay = await service.start(payload, ctx, makeOrigin()).finished;
    assert.equal(replay.id, saved);
    assert.equal(replay.limits.timeoutMs, 120_000);
    assert.throws(() => service.start({ ...payload, task: "另一项工作" }, ctx, makeOrigin()), /去重键/);
    assert.equal(requests, 0);

    const short = seedLegacyTask({ task: "旧短时限", budget: { timeoutMs: 90_000 } }, "background:legacy-short");
    const retry = await service.start({}, ctx, { ...makeOrigin(), retryOf: short }).finished;
    assert.equal(retry.retryOf, short);
    assert.equal(retry.contract.budget.timeoutMs, 600_000);
    assert.equal(retry.limits.timeoutMs, 600_000);
    assert.equal(getSubagentTask(ctx, short).limits.timeoutMs, 90_000);
    assert.equal((await service.start({}, ctx, { ...makeOrigin(), retryOf: short }).finished).id, retry.id);
    assert.equal(requests, 1);
  } finally { await service.close(); }
});

for (const count of [4, 7, 40]) {
  test(`父轮的 ${count} 项分工都在首批直接启动`, async () => {
    const service = new SubagentOrchestrator();
    const release = gate();
    const started = [];
    const source = "原始材料：各分项已核对";
    const ctx = setup(model(async function* ({ messages }) {
      const task = messages[1].content;
      started.push(task);
      await release.wait;
      yield { type: "text", delta: JSON.stringify({
        summary: "已核对",
        facts: [{ key: `section:${task.split(" ").at(-1)}`, value: "已核对", quote: source, evidenceIds: ["C1"] }],
        checks: [{ index: 1, met: true, evidenceIds: ["C1"] }],
      }) };
      yield stop;
    }));
    store.addMessage(ctx.session, { id: `evidence-${ctx.sessionId}`, role: "user", content: source, createdAt: Date.now() });
    const assignments = Array.from({ length: count }, (_, index) => ({
      ...assignment(`审阅分项 ${index}`, "review", `section:${index}`, "."),
      contextMessages: [ctx.session.messages[0].id],
    }));
    const input = { ...plan(assignments[0], assignments[1]), assignments };
    const parent = new ParentDelegation();
    try {
      const scheduled = service.startPlan(input, ctx, makeOrigin("parent"), parent).assignments;
      assert.equal(scheduled.length, count);
      await waitFor(() => started.length === count);
      assert.equal(listSubagentTasks(ctx).filter(({ status }) => status === "running").length, count);
      release.open();
      const results = await Promise.all(scheduled.map(({ finished }) => finished));
      assert.ok(results.every(({ status }) => status === "completed"));
      assert.deepEqual(started, assignments.map(({ task }) => task));
    } finally {
      release.open();
      await parent.close();
      await service.close();
    }
  });
}

test("聊天入口在同一步并发启动超过普通工具批次上限的独立委派", { timeout: 3000 }, async () => {
  const service = new SubagentOrchestrator();
  const fixture = routeFixture({ agents, agentSessions, subagents: service });
  const release = gate();
  const started = new Set();
  routeState.provider = model(async function* ({ messages }) {
    if (messages[0].content.startsWith("你是 A.ai 的只读子 Agent")) {
      started.add(messages[1].content);
      await release.wait;
      yield { type: "text", delta: "完成分项" };
      yield stop;
    } else if (!messages.some(({ role }) => role === "tool")) {
      for (let i = 0; i < 9; i++) yield toolCall("research", { task: `分项 ${i}` }, `branch-${i}`);
      yield toolEnd;
    } else {
      yield { type: "text", delta: "已汇总全部分项" };
      yield stop;
    }
  });
  try {
    const chat = await readRun(await fixture.request({ message: "测试同一步委派", multiAgent: true }));
    const response = chat.rest();
    await waitFor(() => started.size === 9);
    release.open();
    assert.ok((await response).some(({ message }) => message?.content === "已汇总全部分项"));
  } finally { release.open(); await service.close(); }
});

test("空白和心跳不会续期，已经收到的正文和超时原因保留", { timeout: 3000 }, async () => {
  const service = new SubagentOrchestrator();
  const ctx = setup(model(async function* ({ signal }) {
    yield { type: "text", delta: "已找到一条资料" };
    while (!signal.aborted) {
      yield { type: "text", delta: " \n " };
      yield { type: "raw", raw: { heartbeat: true } };
      await delay(15, undefined, { signal });
    }
  }));
  try {
    const handle = service.start({ task: "正文之后卡住", budget: { idleTimeoutMs: 100 } }, ctx, makeOrigin());
    const result = await handle.finished;
    assert.equal(result.status, "timed-out");
    assert.equal(result.progress.blockers[0].code, "idle-timeout");
    assert.equal(result.result.summary, "已找到一条资料");
    assert.equal(result.progress.lastProgressAt, result.progress.lastOutputAt);
    assert.equal(result.progress.lastProgressKind, "text");
    assert.equal(service.isBusy(ctx), false);
  } finally { await service.close(); }
});

for (const channel of ["text", "reasoning", "tool_call_delta"]) {
  test(`${channel} 在流片段边界变化时仍能识别复读，只停止对应子任务`, async () => {
    const service = new SubagentOrchestrator();
    const prefix = "此前已确认一条事实。";
    const period = "一直回到同一个地方重复检查，循环进行。";
    let chunks = 0;
    let loopSignal;
    const ctx = setup(model(async function* ({ messages, signal }) {
      if (messages[1].content === "正常子任务") {
        yield { type: "text", delta: "结论如下。金额为 2。结论如下。数量为 9。" };
        yield stop;
        return;
      }
      loopSignal = signal;
      if (channel === "text") yield { type: "text", delta: prefix };
      const stream = period.repeat(80);
      for (let offset = 0; offset < stream.length;) {
        const width = 3 + offset % 7;
        const delta = stream.slice(offset, offset + width);
        chunks++;
        if (channel === "tool_call_delta") yield { type: channel, index: 0, name: "read_file", delta };
        else yield { type: channel, delta };
        offset += width;
      }
      yield toolCall("read_file", { path: "never-launch.txt" });
      yield toolEnd;
    }));
    const parent = new ParentDelegation();
    const origin = makeOrigin("parent");
    try {
      const [loop, normal] = await Promise.all([
        service.start({ task: "复读子任务" }, ctx, origin, parent).finished,
        service.start({ task: "正常子任务" }, ctx, origin, parent).finished,
      ]);
      assert.equal(loopSignal.aborted, true);
      assert.ok(chunks < 50, `复读未提前停止，共消费 ${chunks} 个片段`);
      assert.equal(loop.progress.blockers[0].code, "repeated-output");
      assert.equal(loop.progress.toolCalls, 0);
      assert.equal(loop.status, channel === "text" ? "partial" : "blocked");
      assert.equal(loop.result.summary, channel === "text" ? prefix : "");
      assert.equal(normal.status, "completed");
      assert.equal(parent.signal.aborted, false);
      assert.equal(service.isBusy(ctx), false);
    } finally { await parent.close(); await service.close(); }
  });
}

test("工具在 A、B 之间循环且结果不变时停止，重复结果沿用原证据编号", async () => {
  const service = new SubagentOrchestrator();
  const original = tool.run;
  let requests = 0;
  let executed = 0;
  tool.run = async ({ path: file }) => {
    executed++;
    return { content: `原始证据 ${path.basename(file)}` };
  };
  const ctx = setup(model(async function* ({ messages }) {
    requests++;
    if (requests === 4) {
      const repeated = messages.find(({ toolCallId }) => toolCallId === "tool-3");
      assert.match(repeated.content, /^\[E1\.1\] 与此前查询结果相同/);
    }
    const file = requests % 2 ? "a.txt" : "b.txt";
    yield toolCall("read_file", { purpose: `说明变更 ${requests}`, path: requests < 3 ? file : `./${file}` }, `tool-${requests}`);
    yield toolEnd;
  }));
  try {
    const result = await service.start({ task: "循环读取两份材料" }, ctx, makeOrigin()).finished;
    assert.equal(requests, 4);
    assert.equal(executed, 4);
    assert.equal(result.status, "partial");
    assert.equal(result.progress.blockers[0].code, "tool-loop");
    assert.deepEqual(result.evidence.map(({ id }) => id), ["E1.1", "E2.1"]);
  } finally { tool.run = original; await service.close(); }
});

test("同一个工具更新结果后继续执行，收尾可基于新的证据", async () => {
  const service = new SubagentOrchestrator();
  const original = tool.run;
  let executed = 0;
  tool.run = async () => ({ content: ++executed < 3 ? "项目仍在进行" : "项目已完成" });
  const ctx = setup(model(async function* ({ messages }) {
    const results = messages.filter(({ role }) => role === "tool");
    if (results.length < 3) {
      yield toolCall("read_file", { path: "status.txt" }, `check-${results.length}`);
      yield toolEnd;
      return;
    }
    assert.match(results.at(-1).content, /项目已完成/);
    yield { type: "text", delta: "根据最新记录，项目已完成。" };
    yield stop;
  }));
  try {
    const result = await service.start({ task: "核对更新后的状态" }, ctx, makeOrigin()).finished;
    assert.equal(result.status, "completed");
    assert.equal(result.progress.blockers.length, 0);
    assert.deepEqual(result.evidence.map(({ id }) => id), ["E1.1", "E3.1"]);
  } finally { tool.run = original; await service.close(); }
});

test("工具的流式输出持续复读时停止在途调用", async () => {
  const service = new SubagentOrchestrator();
  const original = tool.run;
  let chunks = 0;
  tool.run = async (_args, { onOutput, signal }) => {
    for (let index = 0; index < 80; index++) {
      chunks++;
      onOutput("一直回到同一个地方重复检查，循环进行。", "out");
      signal.throwIfAborted();
    }
    return { content: "不应完成" };
  };
  const ctx = setup(model(async function* () {
    yield toolCall("read_file", { path: "stream.txt" });
    yield toolEnd;
  }));
  try {
    const result = await service.start({ task: "处理工具复读" }, ctx, makeOrigin()).finished;
    assert.equal(result.status, "blocked");
    assert.match(result.progress.blockers[0].detail, /工具持续重复/);
    assert.ok(chunks < 20);
    assert.equal(result.evidence.length, 0);
  } finally { tool.run = original; await service.close(); }
});

test("推理和工具参数增量能续期，工具卡住时仅停止对应分支", { timeout: 3000 }, async () => {
  const service = new SubagentOrchestrator();
  const original = tool.run;
  let toolAborted = false;
  tool.run = async (_args, { signal }) => {
    try { await delay(2000, undefined, { signal }); }
    finally { toolAborted = signal.aborted; }
    return { content: "已返回" };
  };
  const ctx = setup(model(async function* ({ messages, signal }) {
    if (messages[1].content === "工具卡住") {
      yield toolCall("read_file", { path: "stall.txt" });
      yield toolEnd;
      return;
    }
    yield { type: "reasoning", delta: "准备核对内容" };
    for (let i = 0; i < 5; i++) {
      await delay(40, undefined, { signal });
      yield { type: "tool_call_delta", index: 0, name: "read_file", delta: `"分项${i}"` };
    }
    yield { type: "text", delta: "核对完成" };
    yield stop;
  }));
  try {
    const parent = new ParentDelegation();
    const origin = makeOrigin("parent");
    const budget = { idleTimeoutMs: 135 };
    const blocked = service.start({ task: "工具卡住", budget }, ctx, origin, parent).finished;
    const active = service.start({ task: "持续产生进展", budget }, ctx, origin, parent).finished;
    const [stalled, completed] = await Promise.all([blocked, active]);
    assert.equal(stalled.status, "timed-out");
    assert.equal(stalled.progress.blockers[0].code, "idle-timeout");
    assert.equal(stalled.progress.lastOutputAt, undefined);
    assert.equal(stalled.progress.lastProgressKind, "tool-call");
    assert.equal(toolAborted, true);
    assert.equal(completed.status, "completed");
    assert.equal(completed.result.summary, "核对完成");
    assert.equal(parent.signal.aborted, false);
    await parent.close();
  } finally { tool.run = original; await service.close(); }
});

test("父轮提前退出时取消和等待子模型、子工具的实际清理，同会话独立任务继续运行", { timeout: 3000 }, async () => {
  const service = new SubagentOrchestrator();
  const modelCleanup = gate();
  const toolCleanup = gate();
  const completeIndependent = gate();
  let modelSignal;
  let toolSignal;
  let independentSignal;
  const original = tool.run;
  tool.run = async (_args, { signal }) => {
    toolSignal = signal;
    await untilAborted(signal);
    await toolCleanup.wait;
    return { content: "工具已关闭" };
  };
  const ctx = setup(model(async function* ({ messages, signal }) {
    if (messages[1]?.content === "模型子任务") {
      modelSignal = signal;
      try { await untilAborted(signal); }
      finally { await modelCleanup.wait; }
    } else if (messages[1]?.content === "工具子任务") {
      yield toolCall("read_file", { path: "report.txt" });
      yield toolEnd;
    } else if (messages[1]?.content === "独立后台任务") {
      independentSignal = signal;
      await completeIndependent.wait;
      yield { type: "text", delta: "独立结果" };
      yield stop;
    } else {
      yield toolCall("research", { task: "模型子任务" }, "child-model");
      yield toolCall("research", { task: "工具子任务" }, "child-tool");
      yield toolEnd;
    }
  }));
  const independent = service.start({ task: "独立后台任务" }, ctx, makeOrigin());
  const turn = runAgent({ ...ctx, subagents: service, maxSteps: 2 });
  try {
    for (;;) {
      const next = await turn.next();
      assert.equal(next.done, false);
      if (modelSignal && toolSignal) break;
    }
    let returned = false;
    const closing = turn.return().then(() => { returned = true; });
    await waitFor(() => modelSignal.aborted && toolSignal.aborted);
    assert.equal(returned, false);
    assert.equal(independentSignal.aborted, false);

    modelCleanup.open();
    await waitFor(() => listSubagentTasks(ctx).some(({ contract, status }) => contract.task === "模型子任务" && status === "cancelled"));
    assert.equal(returned, false);
    toolCleanup.open();
    await closing;
    const tasks = listSubagentTasks(ctx);
    assert.deepEqual(tasks.filter(({ parentCallId }) => parentCallId).map(({ status }) => status), ["cancelled", "cancelled"]);
    assert.equal(tasks.find(({ id }) => id === independent.record.id).status, "running");

    completeIndependent.open();
    assert.equal((await independent.finished).status, "completed");
    assert.equal(service.isBusy(ctx), false);
  } finally {
    modelCleanup.open();
    toolCleanup.open();
    completeIndependent.open();
    await turn.return();
    await service.close();
    tool.run = original;
  }
});

test("Registry 释放父实例时等待委派模型关闭，再撤销父实例登记", { timeout: 3000 }, async () => {
  const registry = createRegistry();
  const service = new SubagentOrchestrator();
  const fixture = routeFixture({ agents: registry, agentSessions, subagents: service });
  const cleanup = gate();
  let childSignal;
  routeState.provider = model(async function* ({ messages, signal }) {
    if (messages[1]?.content === "释放模型测试") {
      childSignal = signal;
      try { await untilAborted(signal); }
      finally { await cleanup.wait; }
    } else {
      yield toolCall("research", { task: "释放模型测试" });
      yield toolEnd;
    }
  });
  try {
    const run = await readRun(await fixture.request({ message: "发起委派并保持会话占用", multiAgent: true }));
    await waitFor(() => childSignal);
    const disposing = registry.dispose(run.sessionId, "u");
    await waitFor(() => childSignal.aborted);
    assert.equal(registry.get(run.sessionId, "u").status, "closing");
    const owner = { sessionId: run.sessionId, userId: "u" };
    assert.equal(listSubagentTasks(owner)[0].status, "running");

    cleanup.open();
    await disposing;
    await run.rest();
    assert.equal(listSubagentTasks(owner)[0].status, "cancelled");
    assert.equal(service.isBusy(owner), false);
    assert.equal(registry.get(run.sessionId, "u"), undefined);
  } finally {
    cleanup.open();
    await registry.disposeAll();
    await service.close();
  }
});

test("独立任务 API 支持隔离、去重、取消、读取和重试，旧进程的活动状态安全结算", async () => {
  const service = new SubagentOrchestrator();
  routeFixture();
  const sessions = store.createSession("u", undefined, undefined, true);
  const params = Promise.resolve({ id: sessions.id });
  let modelInvocations = 0;
  let lastInput;
  let hold = true;
  let released;
  const provider = model(async function* ({ signal, messages }) {
    modelInvocations++;
    lastInput = messages[1].content;
    if (hold) await new Promise((resolve) => { released = resolve; signal.addEventListener("abort", resolve, { once: true }); });
    yield { type: "text", delta: "独立任务结果" };
    yield stop;
  });
  const runtime = { agents, agentSessions, subagents: service, models: () => provider };
  const { GET, POST, PATCH, DELETE } = load("apps/server/src/routes/api/sessions/[id]/agent/subagents/route.ts");
  const sessionRoute = load("apps/server/src/routes/api/sessions/[id]/route.ts");
  const req = (method = "GET", query = "", body, signal) => new Request(`http://localhost/${query}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body), signal,
  });
  const context = { params, runtime };
  const owner = { sessionId: sessions.id, userId: "u" };
  const payload = { task: "单独读取项目材料", role: "review", idempotencyKey: "test-request" };
  try {
    const request = new AbortController();
    const first = await POST(req("POST", "", payload, request.signal), context);
    assert.equal(first.status, 202);
    const { task } = await first.json();
    request.abort();
    const again = await POST(req("POST", "", payload), context);
    assert.equal((await again.json()).task.id, task.id);
    assert.equal((await POST(req("POST", "", { ...payload, task: "不同目标" }), context)).status, 409);
    assert.equal(modelInvocations, 1);
    assert.equal(getSubagentTask(owner, task.id).status, "running");
    const archive = await sessionRoute.PATCH(req("PATCH", "", { archived: true }), context);
    assert.equal(archive.status, 409);
    routeState.caller = "other";
    assert.equal((await GET(req(), context)).status, 404);
    assert.equal((await GET(req("GET", "?threads=1"), context)).status, 404);
    assert.equal((await DELETE(req("DELETE", `?taskId=${task.id}`), context)).status, 404);
    routeState.caller = "u";
    const activeThreads = await (await GET(req("GET", "?threads=active"), context)).json();
    assert.deepEqual(activeThreads.tasks.map(({ id }) => id), [task.id]);
    assert.equal(activeThreads.tasks[0].metrics, undefined);
    assert.equal((await POST(req("POST", `?taskId=${task.id}`, { message: "请核对附件原文" }), context)).status, 202);
    assert.equal((await DELETE(req("DELETE", `?taskId=${task.id}`), context)).status, 204);
    await waitFor(() => getSubagentTask(owner, task.id).status === "cancelled");
    const paused = getSubagentTask(owner, task.id);
    assert.equal(paused.chatActive, false);
    assert.equal((await POST(req("POST", "", { continueTaskId: task.id, message: "自定义消息" }), context)).status, 409);
    routeState.caller = "other";
    assert.equal((await PATCH(req("PATCH", `?taskId=${task.id}`, { active: true }), context)).status, 404);
    routeState.caller = "u";
    const activation = await PATCH(req("PATCH", `?taskId=${task.id}`, { active: true }), context);
    assert.equal(activation.status, 200);
    const { task: activated } = await activation.json();
    assert.deepEqual(activated, JSON.parse(JSON.stringify({ ...paused, chatActive: true })));
    assert.deepEqual(listSubagentTasks(owner).map(({ id }) => id), [task.id]);
    assert.equal(getSubagentTask(owner, task.id).chatActive, true);
    assert.equal(modelInvocations, 1);
    hold = false;
    const retry = await POST(req("POST", "", { retryTaskId: task.id }), context);
    const { task: retried } = await retry.json();
    assert.equal(retried.retryOf, task.id);
    assert.notEqual(retried.id, task.id);
    await waitFor(() => getSubagentTask(owner, retried.id).status === "completed");
    const threads = await (await GET(req("GET", "?threads=1"), context)).json();
    assert.deepEqual(threads.tasks.map(({ id, status }) => ({ id, status })), [{ id: retried.id, status: "completed" }]);
    assert.equal(threads.tasks[0].metrics.attempts, 2);
    assert.equal(threads.tasks[0].metrics.modelCalls, 2);
    assert.deepEqual(threads.tasks[0].metrics.dialogue, { user: 1, agent: 1 });
    assert.deepEqual((await (await GET(req("GET", "?threads=active"), context)).json()).tasks, []);
    const transcript = getSubagentTask(owner, retried.id).messages;
    assert.ok(transcript.some(({ content }) => content === payload.task));
    assert.ok(transcript.every(({ content }) => content !== "恢复任务"));
    assert.ok(transcript.some(({ content }) => content === "独立任务结果"));
    const continued = await POST(req("POST", "", { retryTaskId: retried.id }), context);
    assert.equal(continued.status, 202);
    const { task: continuedTask } = await continued.json();
    await waitFor(() => getSubagentTask(owner, continuedTask.id).status === "completed");
    assert.equal(continuedTask.retryOf, retried.id);
    const latestThread = (await (await GET(req("GET", "?threads=1"), context)).json()).tasks[0];
    assert.equal(latestThread.metrics.attempts, 3);
    assert.deepEqual(latestThread.metrics.dialogue, { user: 1, agent: 2 });
    const message = "请直接说明结论";
    const followupResponse = await POST(req("POST", "", { continueTaskId: continuedTask.id, message }), context);
    assert.equal(followupResponse.status, 202);
    const { task: followup } = await followupResponse.json();
    await waitFor(() => getSubagentTask(owner, followup.id).status === "completed");
    const savedFollowup = getSubagentTask(owner, followup.id);
    assert.equal(lastInput, message);
    assert.equal(savedFollowup.chatActive, true);
    assert.equal(savedFollowup.messages.at(-2).content, message);
    assert.equal((await PATCH(req("PATCH", `?taskId=${continuedTask.id}`, { active: true }), context)).status, 409);
    assert.equal((await GET(req("GET", `?taskId=${retried.id}`), context)).headers.get("cache-control"), "private, no-store");
    assert.equal(store.getSession(sessions.id, "u").messages.length, 0);
    db().prepare("UPDATE subagent_tasks SET executor='previous-process', status='running' WHERE id=?").run(task.id);
    const recovered = getSubagentTask(owner, task.id);
    assert.equal(recovered.status, "interrupted");
    assert.ok(recovered.progress.blockers.some(({ code }) => code === "interrupted"));
  } finally { released?.(); routeState.caller = "u"; await service.close(); }
});

async function waitFor(condition) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail("子任务没有在限定时间结算");
}

test("子线程单文件微调沿用历史，对其它文件和父对话没有写入权限", async () => {
  routeFixture();
  const session = store.createSession("u", undefined, undefined, true);
  const owner = { sessionId: session.id, userId: "u" };
  const { workspace } = load("packages/workspace/src/session-workspace.ts").openSessionWorkspace("u", session.id);
  await writeFile(path.join(workspace, "report.md"), "# Original\n");
  await writeFile(path.join(workspace, "other.md"), "# Other\n");
  const service = new SubagentOrchestrator();
  const fixtureFiles = overrides["packages/tools/src/files.ts"];
  delete overrides["packages/tools/src/files.ts"];
  const { readFile: readTool, editFile: editTool } = load("packages/tools/src/files.ts");
  overrides["packages/tools/src/files.ts"] = fixtureFiles;
  const catalog = load("packages/tool-runtime/src/index.ts");
  const old = { ...catalog };
  catalog.findTool = (name) => name === "edit_file" ? editTool : name === "read_file" ? readTool : old.findTool(name);
  catalog.toolSpecs = () => [readTool.spec, editTool.spec];
  const input = "把标题改为 Revised";
  const provider = model(async function* ({ messages, tools }) {
    const revised = messages[1].content === input;
    const results = messages.filter(({ role }) => role === "tool");
    if (!revised) {
      assert.ok(!tools?.some(({ name }) => name === "edit_file"));
      if (!results.length) { yield toolCall("read_file", { path: "report.md" }, "initial-read"); yield toolEnd; return; }
      yield { type: "text", delta: "报告原始标题是 Original" };
      yield stop;
      return;
    }
    assert.match(messages[0].content, /唯一可读写的文件是 "report.md"/);
    assert.deepEqual(tools.map(({ name }) => name).sort(), ["edit_file", "read_file"]);
    if (!results.length) {
      assert.ok(messages.some(({ content }) => content.includes("报告原始标题是 Original")));
      yield toolCall("read_file", { path: "report.md" }, "revision-read");
      yield toolEnd;
    } else if (results.length === 1) {
      yield toolCall("edit_file", { path: "other.md", old_string: "Other", new_string: "Wrong" }, "wrong-edit");
      yield toolCall("edit_file", { path: "report.md", old_string: "Original", new_string: "Revised" }, "revision-edit");
      yield toolEnd;
    } else {
      assert.match(results[1].content, /只能读取所选微调文件/);
      assert.match(results[2].content, /Revised/);
      yield { type: "text", delta: "已更新报告标题" };
      yield stop;
    }
  });
  const runtime = { agents, agentSessions, subagents: service, models: () => provider };
  const { GET, POST } = load("apps/server/src/routes/api/sessions/[id]/agent/subagents/route.ts");
  const context = { params: Promise.resolve({ id: session.id }), runtime };
  const post = (body) => POST(new Request("http://localhost/subagents", { method: "POST", body: JSON.stringify(body) }), context);
  try {
    const initial = await post({ task: "读取报告", name: "报告核对", paths: ["report.md"] });
    assert.equal(initial.status, 202);
    const { task } = await initial.json();
    await waitFor(() => getSubagentTask(owner, task.id).status === "completed");
    const previous = getSubagentTask(owner, task.id);
    const payload = { continueTaskId: task.id, message: input, path: "other.md" };
    assert.equal((await post(payload)).status, 403);
    const next = await post({ ...payload, path: "report.md" });
    assert.equal(next.status, 202);
    const { task: revision } = await next.json();
    await waitFor(() => getSubagentTask(owner, revision.id).status !== "running");
    const revised = getSubagentTask(owner, revision.id);
    assert.equal(revised.retryOf, task.id);
    assert.equal(revised.parentCallId, undefined);
    assert.equal(revised.status, "partial"); // 越界调用被拒绝，允许的修改仍然结算并保留。
    assert.equal(revised.result.summary, "已更新报告标题");
    assert.ok(revised.messages.some(({ content }) => content === input));
    assert.deepEqual(revised.messages.slice(0, previous.messages.length), previous.messages);
    assert.equal(await readFile(path.join(workspace, "report.md"), "utf8"), "# Revised\n");
    assert.equal(await readFile(path.join(workspace, "other.md"), "utf8"), "# Other\n");
    assert.deepEqual(store.getSession(session.id, "u").messages, []);
    const refreshed = await (await GET(new Request("http://localhost/subagents?threads=1"), context)).json();
    assert.deepEqual(refreshed.tasks.map(({ id, name }) => ({ id, name })), [{ id: revision.id, name: "报告核对" }]);
    assert.equal(refreshed.tasks[0].metrics.dialogue.user, 1);
  } finally { Object.assign(catalog, old); await service.close(); }
});

function gate() {
  let open;
  const wait = new Promise((resolve) => { open = resolve; });
  return { wait, open };
}

function untilAborted(signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
}
