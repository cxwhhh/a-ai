import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { load, db, store, data, agents, AgentRegistry, runAgent, signal, tool, overrides,
  routeState, fixtureSettings, routeFixture, readRun, jsonRequest } from "../../../tests/fixtures/agent-runtime.mjs";

test("SQLite 按事件类型拒绝缺失或错误的作用域和字段", () => {
  const { recordAgentLog, readAgentEvents } = load("packages/session/src/log.ts");
  const { id } = store.createSession("u");
  const detail = { step: 1, callId: "call-1", status: "ok", durationMs: null, errorKind: null, artifactId: null };
  const event = { kind: "tool-result", runId: "run-1", inputId: "input-1", detail };
  for (const invalid of [
    { ...event, runId: undefined },
    { ...event, inputId: undefined },
    { ...event, detail: { ...detail, callId: null } },
    { ...event, detail: { ...detail, status: "anything" } },
    { ...event, detail: { ...detail, durationMs: undefined } },
    { ...event, detail: { ...detail, step: 0 } },
    { ...event, detail: { ...detail, extra: "unexpected" } },
    { ...event, kind: "unknown-kind" },
    { kind: "archived", runId: "run-1", detail: { target: "session", targetId: id } },
  ]) assert.throws(() => recordAgentLog(id, invalid), /agent_event_contract_v1/);
  const insert = db().prepare("INSERT INTO agent_events(session_id,at,kind,run_id,input_id,detail) VALUES(?,?,?,?,?,?)");
  assert.throws(() => insert.run(id, 1, "tool-result", "run-1", "input-1", "{broken"), /agent_event_contract_v1/);
  assert.throws(() => insert.run(id, 1, "model-request", "run-1", "input-1", '{"step":1}'), /agent_event_contract_v1/);
  assert.deepEqual(readAgentEvents("u", id), []);
  recordAgentLog(id, event);
  recordAgentLog(id, { kind: "stop-requested", runId: "run-1", detail: { reason: "两轮之间停止" } });
  recordAgentLog(id, { kind: "cancelled", inputId: "queued-1", detail: { reason: "空闲时取消排队" } });
  recordAgentLog(id, { kind: "archived", detail: { target: "session", targetId: id } });
  const rows = readAgentEvents("u", id);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0].detail, detail);
  assert.equal(rows[0].runId, event.runId);
  assert.equal(rows[0].inputId, event.inputId);
});

test("投影读取完整日志并校验用户，旧会话查看不会创建实例", async () => {
  const { inspect } = routeFixture();
  const { recordAgentLog } = load("packages/session/src/log.ts");
  const s = store.createSession("u");
  store.addMessage(s, { id: "projection-legacy", role: "user", content: "无执行日志的旧问题", createdAt: 1 });
  store.addMessage(s, { id: "projection-a", role: "user", content: "已执行", createdAt: 2 });
  const scope = { runId: "r", inputId: "projection-a" };
  const selection = { model: "mock", effort: "default" };
  const step = { ...selection, step: 1 };
  recordAgentLog(s.id, { ...scope, kind: "turn-start", detail: {} });
  recordAgentLog(s.id, { ...scope, kind: "step-start", detail: step });
  recordAgentLog(s.id, { ...scope, kind: "model-request", detail: { ...step, guidanceIds: "", messageCount: 1, toolCount: 0 } });
  recordAgentLog(s.id, { ...scope, kind: "model-result", detail: { ...step, guidanceIds: "", outcome: "completed", messageId: "answer", durationMs: 2 } });
  recordAgentLog(s.id, { ...scope, kind: "step-end", detail: step });
  recordAgentLog(s.id, { ...scope, kind: "turn-end", detail: { outcome: "completed" } });
  for (let i = 0; i < 120; i++) recordAgentLog(s.id, { kind: "model-selected", detail: selection });
  const state = await (await inspect(s.id)).json();
  assert.equal(state.counts.completed, 1);
  assert.equal(state.counts.unknown, 1);
  assert.equal(state.lifecycle, "offline");
  assert.equal(agents.get(s.id, "u"), undefined);
  assert.equal(state.projection.turns[0].steps[0].explicitBoundary, true);
  assert.ok(state.projection.turns[0].steps[0].endEventId !== null);
  routeState.caller = "other";
  try {
    assert.equal((await inspect(s.id)).status, 404);
    routeState.caller = null;
    assert.equal((await inspect(s.id)).status, 401);
  } finally { routeState.caller = "u"; }
});

test("领取输入后首步前取消有轮次结果，重复收尾只记录一次", () => {
  const { session, handle } = agents.create({ userId: "u" });
  const abort = new AbortController();
  const run = handle.agent.openRun(abort.signal);
  run.begin(session, { id: "before-step", role: "user", content: "任务", createdAt: 1 });
  assert.equal(agents.inspect(session.id, "u").inputs[0].status, "accepted");
  abort.abort();
  run.finish();
  run.finish();
  run.endTurn("completed");
  const state = agents.inspect(session.id, "u");
  assert.equal(state.inputs[0].status, "cancelled");
  assert.equal(state.inputs[0].consumed, false);
  assert.equal(state.inputs[0].droppedUnrun, false);
  assert.equal(state.projection.turns[0].steps.length, 0);
  assert.equal(load("packages/session/src/log.ts").readAgentEvents("u", session.id).filter((event) => event.kind === "turn-end").length, 1);
});

test("模型返回后工具仍运行时步骤不关闭，停止不抹去已成功的工具结果", async () => {
  const { request, queue, inspect } = routeFixture();
  const { getCurrentPosition } = load("packages/session-projection/src/projection.ts");
  const { readSessionTrace } = load("packages/conversation-trace/src/projection.ts");
  const toolEntered = Promise.withResolvers(), release = Promise.withResolvers();
  const original = tool.run;
  tool.run = async () => { toolEntered.resolve(); await release.promise; return { content: "完成读取" }; };
  const abort = new AbortController();
  routeState.provider = { async *stream() {
    yield { type: "tool_call", call: { id: "projection-read", name: "read_file", arguments: "{}" } };
    yield { type: "done" };
  } };
  let stream;
  try {
    stream = await readRun(await request({ message: "读取" }, abort.signal));
    await toolEntered.promise;
    const active = await (await inspect(stream.sessionId)).json();
    assert.equal(active.inputs[0].status, "running");
    assert.equal(Object.hasOwn(active.projection, "currentTurn"), false);
    assert.equal(Object.hasOwn(active.projection, "currentStep"), false);
    const position = getCurrentPosition(active.projection);
    assert.equal(position.turn, active.projection.turns.at(-1));
    assert.equal(position.step, position.turn.steps.at(-1));
    assert.equal(position.step.modelOutcome, "completed");
    assert.equal(position.step.endEventId, null);
    assert.equal(position.step.tools[0].status, "unknown");
    assert.equal(readSessionTrace(stream.sessionId, "u", false, agents.get(stream.sessionId, "u")).rows.find((row) => row.callId === "projection-read")?.toolState, "running");
    await queue({ sessionId: stream.sessionId, runId: stream.runId, action: "enqueue", message: "未执行任务" });
    const item = agents.queueSnapshot(stream.sessionId, "u").items[0];
    await queue({ sessionId: stream.sessionId, runId: stream.runId, action: "remove", id: item.id });
    abort.abort();
    release.resolve();
    await stream.rest();
    const stopped = agents.inspect(stream.sessionId, "u");
    assert.equal(stopped.projection.turns[0].steps[0].tools[0].status, "ok");
    assert.ok(stopped.projection.turns[0].steps[0].endEventId);
    assert.deepEqual(getCurrentPosition(stopped.projection), { turn: null, step: null });
    assert.equal(stopped.inputs.find((input) => input.inputId === item.id).droppedUnrun, true);
    assert.equal(stopped.inputs.find((input) => input.kind === "turn").status, "cancelled");
  } finally { release.resolve(); tool.run = original; }
});

test("重启只重建实例：无收尾轮次是中断，遗失排队项未知，不自动补跑", () => {
  const { recordAgentLog } = load("packages/session/src/log.ts");
  const { getCurrentPosition } = load("packages/session-projection/src/projection.ts");
  const { readSessionTrace } = load("packages/conversation-trace/src/projection.ts");
  const s = store.createSession("u");
  store.addMessage(s, { id: "restart-input", role: "user", content: "未完成", createdAt: 1 });
  const scope = { runId: "old-process", inputId: "restart-input" };
  recordAgentLog(s.id, { ...scope, kind: "accepted", detail: { preview: "未完成" } });
  recordAgentLog(s.id, { ...scope, kind: "model-request", detail: {
    step: 1, model: "mock", effort: "default", guidanceIds: "", messageCount: 1, toolCount: 0,
  } });
  recordAgentLog(s.id, { kind: "queued", runId: scope.runId, inputId: "lost-queue", detail: { target: "next-turn", preview: "未领取" } });
  const registry = new AgentRegistry();
  const before = registry.inspect(s.id, "u");
  registry.resume(s.id, "u");
  const after = registry.inspect(s.id, "u");
  assert.equal(before.lifecycle, "offline");
  assert.equal(after.lifecycle, "idle");
  assert.deepEqual(after.inputs.map((input) => input.status), ["interrupted", "unknown"]);
  assert.equal(after.activeRunId, null);
  assert.deepEqual(after.projection, before.projection);
  assert.equal(getCurrentPosition(after.projection).turn.runId, scope.runId);
  assert.equal(getCurrentPosition(after.projection).step.step, 1);
  const trace = readSessionTrace(s.id, "u");
  assert.equal(trace.running, false);
  assert.equal(trace.rows.find((row) => row.kind === "model")?.status, "未记录结果");
});

test("编辑重发只标记旧视图，已完成的工作不变成取消", async () => {
  const { request } = routeFixture();
  routeState.provider = { async *stream() { yield { type: "text", delta: "完成" }; yield { type: "done" }; } };
  const first = await readRun(await request({ message: "旧任务" }));
  await first.rest();
  const original = store.getSession(first.sessionId, "u").messages[0];
  await (await request({ sessionId: first.sessionId, message: "新任务", truncateFrom: original.id })).text();
  const state = agents.inspect(first.sessionId, "u");
  assert.equal(state.counts.completed, 2);
  assert.deepEqual(state.projection.turns.map((turn) => turn.inCurrentHistory), [false, true]);
  const previous = state.inputs.find((input) => input.inputId === original.id);
  assert.equal(previous.status, "completed");
  assert.equal(previous.truncated, true);
  assert.equal(previous.inCurrentHistory, false);
});

test("投影隔离会话，空轮与未进入模型的引导不能算完成", () => {
  const { projectSession } = load("packages/session-projection/src/projection.ts");
  const { foldConsumedWork } = load("packages/session-projection/src/consumed-work.ts");
  let seq = 0;
  const event = (kind, inputId, detail, sessionId = "a") => ({ id: ++seq, sessionId, sessionTitle: "", at: 1, runId: "r", inputId, kind, detail });
  const step = { model: "mock", effort: "default", step: 1, guidanceIds: "" };
  const events = [event("accepted", "empty", { preview: "" }), event("turn-end", "empty", { outcome: "completed" }),
    event("accepted", "main", { preview: "" }), event("model-request", "main", { ...step, messageCount: 1, toolCount: 0 }),
    event("model-result", "main", { ...step, outcome: "output-truncated", messageId: "answer", durationMs: 0 }),
    event("guidance", "note", { turnInputId: "main", preview: "" }), event("turn-end", "main", { outcome: "output-truncated" }),
    event("accepted", "other", { preview: "" }, "b")];
  const input = { id: "a", messages: ["empty", "main", "note"].map((id) => ({ id, role: "user" })) };
  const state = projectSession(input, [...events].reverse().concat(events[0]));
  assert.equal(state.turns.length, 2);
  const work = foldConsumedWork(state, events, { activeRunId: null, queue: null });
  assert.equal(work.find((input) => input.inputId === "empty").status, "unknown");
  assert.equal(work.find((input) => input.inputId === "main").status, "output-truncated");
  assert.equal(work.find((input) => input.inputId === "note").status, "unknown");
  assert.equal(work.some((input) => input.inputId === "other"), false);
});

test("当前轮和步骤从末尾实时推导，结束后不回退到更早的开放边界", () => {
  const { projectSession, getCurrentPosition } = load("packages/session-projection/src/projection.ts");
  const session = { id: "position", messages: [] };
  const event = (id, inputId, kind, detail) => ({ id, sessionId: session.id, runId: "r", inputId, kind, detail });
  const model = { model: "mock", effort: "default" };
  assert.deepEqual(getCurrentPosition(projectSession(session, [])), { turn: null, step: null });
  const projection = projectSession(session, [
    event(1, "older", "turn-start", {}),
    event(2, "latest", "turn-start", {}),
    event(3, "latest", "step-start", { ...model, step: 1 }),
    event(4, "latest", "step-start", { ...model, step: 2 }),
  ]);
  const latest = projection.turns.at(-1);
  const lastStep = latest.steps.at(-1);
  assert.deepEqual(getCurrentPosition(projection), { turn: latest, step: lastStep });
  lastStep.endEventId = 5;
  assert.deepEqual(getCurrentPosition(projection), { turn: latest, step: null });
  latest.endEventId = 6;
  assert.deepEqual(getCurrentPosition(projection), { turn: null, step: null });
});

test("运行占用不能重复取得，旧运行的收尾不能释放新运行", async () => {
  const { handle } = agents.create({ userId: "u" });
  const { agent } = handle;
  const first = agent.openRun(signal);
  assert.ok(first);
  assert.equal(agent.openRun(signal), null);
  first.finish();
  const second = agent.openRun(signal);
  assert.ok(second);
  first.finish();
  assert.equal(await agent.waitIdle({ waitMs: 0 }), false);
  second.finish();
  assert.equal(await agent.waitIdle({ waitMs: 0 }), true);
  await handle.dispose();
});

test("引导只接纳当前运行所有者的输入，按序提交一次", () => {
  const { session, handle } = agents.create({ userId: "u" });
  const run = handle.agent.openRun(signal);
  const add = (user, runId, text) => agents.get(session.id, user)?.enqueueInput(runId, text, "next-step") ?? false;
  try {
    assert.equal(add("other", run.id, "越权"), false);
    assert.equal(add("u", "旧运行", "迟到请求"), false);
    assert.equal(add("u", run.id, "第一条"), true);
    assert.equal(add("u", run.id, "第二条"), true);
    const pending = run.steering.pending();
    assert.deepEqual(pending.map((item) => item.message), ["第一条", "第二条"]);
    for (const item of pending) run.steering.committed(item.id);
    assert.deepEqual(run.steering.pending(), []);
  } finally {
    run.finish();
  }
  assert.equal(add("u", run.id, "已结束"), false);
});

test("下一次模型请求包含原始任务、工具结果和运行中补充的消息", async () => {
  const { session, handle } = agents.create({ userId: "u" });
  const { agent } = handle;
  store.addMessage(session, { id: "original", role: "user", content: "分析销售", createdAt: 1 });
  const requests = [];
  const note = "只统计已付款订单";
  const run = agent.openRun(signal);
  const provider = {
    async *stream(request) {
      requests.push(structuredClone(request.messages));
      if (requests.length === 1) {
        assert.equal(agent.enqueueInput(run.id, note, "next-step"), true);
        yield { type: "tool_call", call: { id: "read1", name: "read_file", arguments: "{}" } };
      } else {
        yield { type: "text", delta: "分析完成" };
      }
      yield { type: "done" };
    },
  };
  try {
    for await (const _ of runAgent({
      session, provider, userId: "u", workspace: data, maxSteps: 5, maxFixRounds: 0,
      steering: run.steering,
    })) { /* 消费完整的事件流，断言实际发出的请求。 */ }
  } finally {
    run.finish();
  }
  assert.equal(requests.length, 2);
  assert.equal(requests[0].some(m => m.content.includes(note)), false);
  const next = requests[1];
  assert.ok(next.some(m => m.role === "user" && m.content.includes("分析销售")));
  assert.ok(next.some(m => m.role === "tool" && m.content === "受控工具结果"));
  assert.equal(next.filter(m => m.role === "user" && m.content.includes(note)).length, 1);
});

test("在线实例跨运行复用，释放等待收尾，重建后旧句柄不能撤销新实例", async () => {
  const registry = new AgentRegistry();
  const { session, handle } = registry.create({ userId: "u", title: "注册测试" });
  const { agent } = handle;
  assert.equal(agent.status, "idle");
  assert.equal(registry.get(session.id, "u"), agent);
  assert.deepEqual(registry.list("u"), [agent]);
  assert.deepEqual(registry.list("other"), []);
  assert.equal(registry.get(session.id, "other"), undefined);
  assert.equal(registry.resume(session.id, "other"), null);
  assert.equal(registry.resume("missing-session", "u"), null);

  const first = agent.openRun(signal);
  first.begin(session, { id: "registered-agent-message", role: "user", content: "保持会话", createdAt: Date.now() });
  first.finish();
  const reopened = registry.resume(session.id, "u");
  assert.equal(reopened.handle.agent, agent);
  assert.equal(reopened.session.messages[0].content, "保持会话");
  const run = reopened.handle.agent.openRun(signal);
  assert.notEqual(run.id, first.id);
  assert.equal(agent.status, "running");
  assert.equal(agent.enqueueInput(run.id, "待清理", "next-turn"), true);

  const disposal = handle.dispose();
  assert.equal(run.signal.aborted, true);
  assert.equal(agent.status, "closing");
  assert.equal(registry.get(session.id, "u"), agent);
  assert.equal(agent.openRun(signal), null);
  assert.equal(agent.enqueueInput(run.id, "已关闭", "next-turn"), false);
  run.finish();
  await disposal;
  assert.equal(agent.status, "disposed");
  assert.deepEqual(registry.queueSnapshot(session.id, "u").items, []);
  assert.equal(registry.get(session.id, "u"), undefined);

  const resumed = registry.resume(session.id, "u");
  assert.notEqual(resumed.handle.agent, agent);
  assert.equal(resumed.session.messages[0].content, "保持会话");
  await handle.dispose();
  assert.equal(registry.get(session.id, "u"), resumed.handle.agent);
  await resumed.handle.dispose();
});

test("创建工厂失败时回收刚创建的空会话，不发布实例", () => {
  const registry = new AgentRegistry(() => { throw new Error("受控创建失败"); });
  const before = store.listSessions("u").map(({ id }) => id);
  assert.throws(() => registry.create({ userId: "u" }), /受控创建失败/);
  assert.deepEqual(registry.list("u"), []);
  assert.deepEqual(store.listSessions("u").map(({ id }) => id), before);
});

test("聊天 HTTP 入口拒绝非法锚点、旧版本和他人会话，成功重发刷新后只见有效记录", async () => {
  const { request, logs } = routeFixture();
  routeState.provider = { async *stream() { yield { type: "text", delta: "新回答" }; yield { type: "done" }; } };
  const s = store.createSession("u");
  const original = { id: "route-question", role: "user", content: "旧问题", createdAt: 1 };
  store.addMessage(s, original);
  const body = { sessionId: s.id, revision: s.revision, message: "新问题" };
  assert.equal((await request({ ...body, truncateFrom: "missing" })).status, 409);
  assert.equal(await agents.waitIdle(s.id, "u", { waitMs: 0 }), true);
  assert.deepEqual(store.getSession(s.id, "u").messages, [original]);
  assert.equal((await request({ ...body, revision: s.revision - 1 })).status, 409);
  db().prepare("INSERT INTO users(id, username, password_hash, created_at) VALUES(?, ?, ?, ?)").run("other", "other", "x", 0);
  const foreign = store.createSession("other");
  assert.equal((await request({ sessionId: foreign.id, message: "越权" })).status, 404);
  const response = await request({ ...body, truncateFrom: original.id });
  assert.equal(response.status, 200);
  const events = await response.text();
  assert.equal(events.includes('"type":"error"'), false, events);
  const saved = store.getSession(s.id, "u");
  assert.deepEqual(saved.messages.map(m => m.content), ["新问题", "新回答"]);
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id=?").get(s.id).n, 3);
  const revision = db().prepare("SELECT id,reason FROM session_revisions WHERE session_id=?").get(s.id);
  assert.equal(revision.reason, "edit");
  const tagged = db().prepare("SELECT id,superseded_by FROM messages WHERE session_id=?").all(s.id);
  assert.equal(tagged.find(m => m.id === original.id).superseded_by, revision.id);
  assert.ok(tagged.filter(m => m.id !== original.id).every(m => m.superseded_by === null));

  // 编辑框原文直接确认也会发起新回答，旧问题和回答归到同一个修订标记。
  const regenerated = await request({ sessionId: s.id, revision: saved.revision,
    truncateFrom: saved.messages[0].id, message: saved.messages[0].content });
  assert.equal(regenerated.status, 200);
  const regeneratedEvents = await regenerated.text();
  assert.equal(regeneratedEvents.includes('"type":"error"'), false, regeneratedEvents);
  const latest = store.getSession(s.id, "u");
  assert.deepEqual(latest.messages.map(m => m.content), ["新问题", "新回答"]);
  assert.notEqual(latest.messages[0].id, saved.messages[0].id);
  const oldTags = saved.messages.map(m => db().prepare("SELECT superseded_by FROM messages WHERE id=?").get(m.id).superseded_by);
  assert.ok(oldTags[0]);
  assert.equal(oldTags[0], oldTags[1]);
  assert.equal(db().prepare("SELECT reason FROM session_revisions WHERE id=?").get(oldTags[0]).reason, "regenerate");
  const trace = await (await logs({ sessionId: s.id, inputId: saved.messages[0].id })).json();
  assert.equal(trace.find((event) => event.kind === "truncated").detail.revision, oldTags[0]);
  assert.equal(trace.find((event) => event.kind === "turn-end").detail.outcome, "completed");
  assert.equal(await agents.waitIdle(s.id, "u", { waitMs: 0 }), true);
});

test("真实聊天流中引导移入下一步，其余排队消息依次开启独立轮次", async () => {
  const { request, queue, logs } = routeFixture();
  const gate = Promise.withResolvers();
  const requests = [];
  routeState.provider = { async *stream(options) {
    requests.push(structuredClone(options.messages));
    if (requests.length === 1) {
      await gate.promise;
      yield { type: "tool_call", call: { id: "read-queue", name: "read_file", arguments: "{}" } };
    } else yield { type: "text", delta: "完成" };
    yield { type: "done" };
  } };
  const stream = await readRun(await request({ message: "查日志" }));
  const { sessionId } = stream;
  const online = agents.get(sessionId, "u");
  let guidanceId;
  assert.equal(online?.status, "running");
  const command = (input) => queue({ sessionId, runId: stream.runId, ...input });
  try {
    for (const message of ["写清单", "只查今天", "列风险"]) assert.equal((await command({ action: "enqueue", message })).status, 200);
    const before = agents.queueSnapshot(sessionId, "u").items;
    assert.deepEqual(before.map((item) => item.target), ["next-turn", "next-turn", "next-turn"]);
    const id = guidanceId = before[1].id;
    routeState.caller = "other";
    assert.equal((await command({ action: "steer", id })).status, 409);
    routeState.caller = "u";
    assert.equal((await command({ action: "steer", id, runId: "stale" })).status, 409);
    assert.equal((await command({ action: "steer", id })).status, 200);
    assert.equal((await command({ action: "steer", id })).status, 409);
    assert.deepEqual(store.getSession(sessionId, "u").messages.map((m) => m.content), ["查日志"]);
  } finally {
    routeState.caller = "u";
    gate.resolve();
  }
  const events = await stream.rest();
  assert.ok(events.every((event) => event.scope.sessionId === sessionId && event.scope.runId === stream.runId));
  assert.equal(events.some((event) => event.type === "error"), false, JSON.stringify(events));
  assert.equal(events.filter((event) => event.type === "done").length, 3);
  assert.equal(requests.length, 4);
  const contains = (i, text) => requests[i].some((message) => message.content.includes(text));
  assert.equal(contains(0, "只查今天"), false);
  assert.ok(contains(1, "只查今天") && contains(1, "受控工具结果"));
  assert.equal(contains(1, "写清单"), false);
  assert.ok(contains(2, "写清单"));
  assert.equal(contains(2, "列风险"), false);
  assert.ok(contains(3, "列风险"));
  const userMessages = store.getSession(sessionId, "u").messages.filter((m) => m.role === "user");
  assert.deepEqual(userMessages.map((m) => m.content), ["查日志", "【用户补充】只查今天", "写清单", "列风险"]);
  assert.deepEqual(agents.queueSnapshot(sessionId, "u").items, []);
  assert.equal(agents.get(sessionId, "u"), online);
  assert.equal(online.status, "idle");
  const trace = await (await logs({ sessionId, inputId: guidanceId })).json();
  assert.deepEqual(trace.map((event) => event.kind), ["model-result", "model-request", "guidance", "steered", "queued"]);
  const state = agents.inspect(sessionId, "u");
  assert.equal(state.projection.turns.length, 3);
  assert.deepEqual(state.projection.turns.map((turn) => turn.steps.length), [2, 1, 1]);
  assert.ok(state.projection.turns.every((turn) => turn.endEventId && turn.steps.every((step) => step.explicitBoundary && step.endEventId)));
  assert.equal(state.inputs.find((input) => input.inputId === guidanceId).consumed, true);
  assert.equal(state.counts.completed, 4);
  assert.equal(load("packages/session-projection/src/projection.ts").getCurrentPosition(state.projection).turn, null);
});

test("停止后保留未执行和未消费的引导，继续队列只领取当前队首", async () => {
  const { request, queue, logs } = routeFixture();
  const gate = Promise.withResolvers();
  routeState.provider = { async *stream() { await gate.promise; yield { type: "done" }; } };
  const s = store.createSession("u");
  const abort = new AbortController();
  const stream = await readRun(await request({ sessionId: s.id, message: "正在工作" }, abort.signal));
  const command = (input) => queue({ sessionId: s.id, runId: stream.runId, ...input });
  let pending;
  try {
    assert.equal((await command({ action: "enqueue", message: "保留排队" })).status, 200);
    assert.equal((await command({ action: "enqueue", message: "保留引导" })).status, 200);
    pending = agents.queueSnapshot(s.id, "u").items;
    assert.equal((await command({ action: "steer", id: pending[1].id })).status, 200);
  } finally {
    abort.abort();
    gate.resolve();
  }
  await stream.rest();
  assert.deepEqual(agents.queueSnapshot(s.id, "u").items, pending);
  assert.equal((await request({ sessionId: s.id, queuedId: pending[1].id })).status, 409);
  assert.equal(await agents.waitIdle(s.id, "u", { waitMs: 0 }), true);
  routeState.provider = { async *stream() { yield { type: "text", delta: "完成" }; yield { type: "done" }; } };
  const resumed = await request({ sessionId: s.id, queuedId: pending[0].id });
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.text()).includes('"type":"error"'), false);
  const users = store.getSession(s.id, "u").messages.filter((m) => m.role === "user");
  assert.deepEqual(users.map((m) => m.content), ["正在工作", "保留排队", "保留引导"]);
  assert.deepEqual(users.slice(1).map((m) => m.id), pending.map((item) => item.id));
  const trace = await (await logs({ sessionId: s.id, inputId: users[0].id })).json();
  assert.equal(trace.find((event) => event.kind === "turn-end").detail.outcome, "cancelled");
  assert.ok(trace.some((event) => event.kind === "stop-requested"));
});

for (const reason of ["等待用户回答", "模型失败"]) {
  test(`${reason}时暂停队列，待处理消息不会当成当前轮输入`, async () => {
    const { request, queue } = routeFixture();
    const gate = Promise.withResolvers();
    routeState.provider = { async *stream() {
      await gate.promise;
      if (reason === "模型失败") throw new Error("受控模型异常");
      yield { type: "tool_call", call: { id: "ask-queue", name: "ask_user", arguments: '{"question":"选哪一种？"}' } };
      yield { type: "done" };
    } };
    const s = store.createSession("u");
    const stream = await readRun(await request({ sessionId: s.id, message: "开始任务" }));
    try {
      assert.equal((await queue({ sessionId: s.id, runId: stream.runId, action: "enqueue", message: "另一个任务" })).status, 200);
    } finally {
      gate.resolve();
    }
    const events = await stream.rest();
    assert.ok(events.some((event) => reason === "模型失败" ? event.type === "error" : event.type === "done" && event.awaitingUser));
    assert.deepEqual(store.getSession(s.id, "u").messages.filter((m) => m.role === "user").map((m) => m.content), ["开始任务"]);
    assert.deepEqual(agents.queueSnapshot(s.id, "u").items.map((item) => item.message), ["另一个任务"]);
    assert.equal(await agents.waitIdle(s.id, "u", { waitMs: 0 }), true);
    const state = agents.inspect(s.id, "u");
    assert.equal(state.inputs.find((input) => input.kind === "turn").status, reason === "模型失败" ? "failed" : "waiting-for-answer");
    assert.equal(state.counts.queued, 1);
    assert.ok(state.projection.turns[0].steps[0].endEventId);
  });
}

test("归档项目先检查运行状态，恢复项目不会恢复独立归档的对话", async () => {
  const { request, patch, logs } = routeFixture();
  const { createProject, projectPrompt } = load("packages/application/projects/src/projects.ts");
  const project = createProject("u", { name: "项目归档", description: "", share: true, memory: "off" });
  const { session, handle } = agents.create({ userId: "u", projectId: project.id });
  const archived = store.createSession("u", "独立归档", project.id);
  const active = handle.agent.openRun(signal);
  try {
    assert.equal((await patch("projects", project.id, { archived: true })).status, 409);
  } finally { active.finish(); }
  assert.equal((await patch("sessions", archived.id, { archived: true })).status, 200);
  assert.doesNotMatch(projectPrompt(project, "u", session.id), /独立归档/);
  assert.equal((await patch("projects", project.id, { archived: true })).status, 200);
  assert.equal((await request({ sessionId: session.id, message: "继续" })).status, 409);
  assert.equal((await request({ projectId: project.id, message: "新建" })).status, 409);
  assert.equal((await patch("projects", project.id, { archived: false })).status, 200);
  assert.equal((await request({ sessionId: archived.id, message: "仍然已归档" })).status, 409);
  assert.equal((await patch("sessions", archived.id, { archived: false })).status, 200);
  const trace = await (await logs({ sessionId: archived.id })).json();
  assert.deepEqual(trace.map((e) => [e.kind, e.detail.target]), [["restored", "session"], ["restored", "project"], ["archived", "project"], ["archived", "session"]]);
  assert.deepEqual(store.getSession(archived.id, "u").messages, []);
  routeState.caller = "other";
  try {
    assert.equal((await patch("projects", project.id, { archived: true })).status, 404);
    assert.equal((await request({ projectId: project.id, message: "越权" })).status, 404);
    assert.equal((await logs({ sessionId: session.id })).status, 404);
    assert.ok((await (await logs({})).json()).every((e) => e.sessionId !== session.id));
    routeState.caller = null;
    assert.equal((await logs({})).status, 401);
  } finally { routeState.caller = "u"; }
});

test("会话模型和强度独立持久化，默认值变化只影响没有选择的会话", async () => {
  const { request, patch } = routeFixture();
  const { PRESETS } = load("packages/protocol/src/lib/settings.ts");
  const deepseek = { model: "ds/deepseek-flash", effort: "high" };
  const mock = { model: "mock", effort: "default" };
  routeState.provider = { async *stream() { yield { type: "text", delta: "完成" }; yield { type: "done" }; } };
  async function run(body, expected) {
    const stream = await readRun(await request(body));
    const events = await stream.rest();
    assert.equal(events.some((e) => e.type === "error"), false, JSON.stringify(events));
    assert.deepEqual(routeState.selectedProvider, expected);
    assert.deepEqual(store.getSession(stream.sessionId, "u").modelSelection, expected);
    return stream.sessionId;
  }
  fixtureSettings.connections = [{ ...PRESETS.deepseek, id: "ds", apiKey: "fixture" }];
  try {
    const a = await run({ message: "A", modelSelection: deepseek }, deepseek);
    const b = await run({ message: "B" }, mock);
    assert.equal((await patch("sessions", b, { modelSelection: { ...mock, effort: "max" } })).status, 400);
    fixtureSettings.currentModel = deepseek.model;
    fixtureSettings.reasoningEffort = "low";
    await run({ sessionId: b, message: "继续 B" }, mock);
    await agents.dispose(a, "u");
    await run({ sessionId: a, message: "恢复 A" }, deepseek);
    await run({ message: "新默认值" }, { ...deepseek, effort: "low" });
    assert.equal((await patch("sessions", a, { modelSelection: mock })).status, 200);
    await run({ sessionId: a, message: "A 改模型" }, mock);
    assert.equal(fixtureSettings.currentModel, deepseek.model);
  } finally { Object.assign(fixtureSettings, { connections: [], currentModel: "mock", reasoningEffort: "default" }); }
});

test("并行对话复用工具调用 ID 时，审批和停止只影响对应运行", { timeout: 5000 }, async () => {
  const { request } = routeFixture();
  const approve = load("apps/server/src/routes/api/approve/route.ts").POST;
  const original = tool.run;
  const previousApproval = fixtureSettings.commandApproval;
  const completed = new Map();
  const abortA = new AbortController(), abortB = new AbortController();
  const readers = [];
  const a = store.createSession("u"), b = store.createSession("u");
  try {
    fixtureSettings.commandApproval = "ask";
    tool.run = async (_, ctx) => {
      const allowed = await ctx.confirm({ command: ctx.sessionId, reason: "受控确认", readonly: false });
      completed.set(ctx.sessionId, allowed);
      return { content: allowed ? "已确认" : "已拒绝" };
    };
    routeState.provider = { async *stream({ messages }) {
      if (messages.some((m) => m.role === "tool")) yield { type: "text", delta: "完成" };
      else yield { type: "tool_call", call: { id: "same-approval-tool", name: "read_file", arguments: "{}" } };
      yield { type: "done" };
    } };
    async function approvalFor(sessionId, signal) {
      const response = await request({ sessionId, message: "读取" }, signal);
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      readers.push(reader);
      for (let chunk; !(chunk = await reader.read()).done;) {
        const event = JSON.parse(new TextDecoder().decode(chunk.value).trim().slice(6));
        if (event.type === "approval") return { event, reader };
      }
      assert.fail("没有收到确认事件");
    }
    const [first, second] = await Promise.all([approvalFor(a.id, abortA.signal), approvalFor(b.id, abortB.signal)]);
    assert.equal(first.event.callId, second.event.callId);
    assert.notEqual(first.event.approvalId, second.event.approvalId);
    assert.equal(first.event.scope.sessionId, a.id);
    assert.equal(second.event.scope.sessionId, b.id);
    assert.equal((await approve(jsonRequest("approve", { approvalId: first.event.approvalId, decision: "allow" }))).status, 200);
    while (!(await first.reader.read()).done) { /* 等待 A 收尾 */ }
    assert.equal(completed.get(a.id), true);
    assert.equal(completed.has(b.id), false);
    assert.equal(agents.get(b.id, "u").activeRunId, second.event.scope.runId);
    abortB.abort();
    while (!(await second.reader.read()).done) { /* 等待 B 收尾 */ }
    assert.equal(completed.get(b.id), false);
    assert.equal(agents.inspect(a.id, "u").counts.completed, 1);
    assert.equal(agents.inspect(b.id, "u").counts.cancelled, 1);
  } finally {
    abortA.abort();
    abortB.abort();
    await Promise.all(readers.map((reader) => reader.cancel().catch(() => {})));
    tool.run = original;
    fixtureSettings.commandApproval = previousApproval;
  }
});

test("并行对话的同名产出、SSE、日志各归原会话，投错作用域的事件被丢弃", async () => {
  const { request, logs, queue } = routeFixture();
  const { bindAgentDispatch } = load("packages/protocol/src/dispatch.ts");
  const a = store.createSession("u"), b = store.createSession("u");
  const gate = Promise.withResolvers();
  const fileTool = { spec: { name: "scoped_artifact" }, async run(args, ctx) {
    const art = ctx.emitArtifact({ kind: "markdown", title: "同名产出", content: args.content });
    return { content: "已写入", artifactId: art.id };
  } };
  const tools = overrides["packages/tool-runtime/src/index.ts"];
  const findTool = tools.findTool;
  tools.findTool = (name) => name === fileTool.spec.name ? fileTool : findTool(name);
  routeState.provider = { async *stream({ messages }) {
    if (!messages.some((m) => m.role === "tool")) {
      const content = messages.find((m) => m.role === "user" && /^会话[AB]$/.test(m.content))?.content;
      assert.ok(content);
      await gate.promise;
      yield { type: "tool_call", call: { id: "same-call-id", name: fileTool.spec.name, arguments: JSON.stringify({ content }) } };
    } else {
      yield { type: "text", delta: "截断的输出" };
    }
    yield { type: "done", finishReason: messages.some((m) => m.role === "tool") ? "length" : "tool_calls" };
  } };
  try {
    const sa = await readRun(await request({ sessionId: a.id, message: "会话A" }));
    const sb = await readRun(await request({ sessionId: b.id, message: "会话B" }));
    assert.equal((await queue({ sessionId: b.id, runId: sa.runId, action: "enqueue", message: "错误归属" })).status, 409);
    assert.equal((await queue({ sessionId: a.id, runId: sa.runId, action: "enqueue", message: "待取消" })).status, 200);
    const pending = agents.queueSnapshot(a.id, "u").items[0];
    assert.equal((await queue({ sessionId: a.id, runId: sa.runId, action: "remove", id: pending.id })).status, 200);
    gate.resolve();
    const [ea, eb] = await Promise.all([sa.rest(), sb.rest()]);
    const scopeA = { sessionId: a.id, runId: sa.runId };
    const scopeB = { sessionId: b.id, runId: sb.runId };
    for (const [events, scope, content] of [[ea, scopeA, "会话A"], [eb, scopeB, "会话B"]]) {
      assert.ok(events.every((e) => e.scope.sessionId === scope.sessionId && e.scope.runId === scope.runId));
      const art = events.find((e) => e.type === "artifact").artifact;
      assert.ok(art.file.startsWith(`output/${scope.sessionId}/`));
      assert.equal(readFileSync(path.join(data, art.file), "utf8"), content);
      const trace = await (await logs({ sessionId: scope.sessionId })).json();
      assert.ok(trace.every((e) => e.sessionId === scope.sessionId));
      assert.ok(trace.some((e) => e.kind === "model-result" && e.detail.outcome === "output-truncated"));
      const state = agents.inspect(scope.sessionId, "u");
      assert.equal(state.inputs.find((input) => input.kind === "turn").status, "output-truncated");
      assert.equal(state.projection.turns[0].steps[0].tools[0].status, "ok");
    }
    const sent = [];
    const dispatch = bindAgentDispatch(scopeA, (event) => sent.push(event));
    dispatch(eb.find((e) => e.type === "artifact"));
    dispatch({ type: "queue", queue: agents.queueSnapshot(b.id, "u") });
    dispatch({ type: "done", scope: { ...scopeA, runId: scopeB.runId } });
    dispatch({ type: "done" });
    assert.deepEqual(sent, [{ type: "done", scope: scopeA }]);
    const trace = await (await logs({ sessionId: a.id, inputId: pending.id })).json();
    assert.deepEqual(trace.map((e) => e.kind), ["cancelled", "queued"]);
  } finally {
    gate.resolve();
    tools.findTool = findTool;
  }
});
