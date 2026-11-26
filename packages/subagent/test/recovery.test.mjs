import { test } from "node:test";
import assert from "node:assert/strict";
import { db, agents, data as workspace, load, store, tool, routeFixture, routeState, readRun } from "../../../tests/fixtures/agent-runtime.mjs";

const { SubagentOrchestrator, runSubagentTool } = load("packages/subagent/src/subagent.ts");
const { ParentDelegation } = load("packages/subagent/src/delegation-policy.ts");
const { checkpointTask, getSubagentTask, listSubagentTasks, registerTask, settleTask } = load("packages/subagent/src/ownership-claim.ts");
const { emptyProgress } = load("packages/subagent/src/progress-blockers.ts");
const { budgetLimits } = load("packages/subagent/src/role-budget.ts");
const { agentSessions } = load("packages/session/src/agent-session.ts");

const done = { type: "done", finishReason: "stop" };
const call = (name, args, id = name) => ({ type: "tool_call", call: { id, name, arguments: JSON.stringify(args) } });
const json = (content) => JSON.parse(content.match(/```json\n([\s\S]+?)\n```/)[1]);
const fact = (key, ref, quote) => ({ key, value: quote, quote, evidenceIds: [ref] });
const candidate = (facts) => JSON.stringify({ summary: "可核对结果", checks: [{ index: 1, met: true, evidenceIds: facts[0].evidenceIds }], facts, unresolved: [] });
const answer = (...facts) => ({ type: "text", delta: candidate(facts) });

test("主对话续跑复用已验收分支，只接续缺项，并在上游齐备后启动下游", async () => {
  const service = new SubagentOrchestrator();
  const { request } = routeFixture({ agents, agentSessions, subagents: service });
  const session = store.createSession("u", undefined, undefined, true);
  const owner = { sessionId: session.id, userId: "u" };
  const origin = { runId: "old-run", inputId: "old-input", parentCallId: "old-assistant:batch" };
  store.beginTurn(session, { id: origin.inputId, role: "user", content: "先核对需求和数据，再核验表格口径。", createdAt: 1 }, undefined, origin.runId);
  const budget = budgetLimits("analysis", {}, 128_000);
  const seed = (key, keys, dependencies, tools = []) => registerTask(owner, origin,
    { name: key, task: `核对${key}`, role: "analysis", plan: ["按原契约核对"], acceptance: ["有原文"], factKeys: keys, tools },
    "analysis", budget, key, key, dependencies, { key, objective: "按口径交付表格", tools }).record;

  const requirement = seed("需求", ["sheet:region"]);
  const requirementsFact = fact("sheet:region", "C1", "地区");
  const evidence = [{ id: "C1", kind: "message", source: origin.inputId }];
  assert.ok(settleTask(owner, requirement.id, { status: "completed", summary: "需求已验收", progress: emptyProgress(), evidence,
    facts: [requirementsFact], acceptance: [{ criterion: "有原文", met: true, evidenceIds: ["C1"] }], unresolved: [] }));
  const data = seed("数据", ["sheet:amount", "sheet:currency"], undefined, ["read_file"]);
  const analysis = seed("口径", ["sheet:format"], { ids: [requirement.id, data.id], queued: true });
  const proof = { id: "E1.1", kind: "tool", source: "amount.txt", tool: "read_file", factKey: "sheet:amount" };
  const amount = fact("sheet:amount", proof.id, "销售额");
  const inFlight = { id: "in-flight-note", role: "user", content: "使用本期口径", createdAt: 3 };
  assert.ok(checkpointTask(owner, data.id, {
    progress: { ...emptyProgress(), steps: 2, toolCalls: 1 }, evidence: [proof], candidate: candidate([amount]),
    messages: [{ id: data.id, role: "user", content: data.contract.task, createdAt: 1 },
      { id: "old-response", role: "tool", toolCallId: "amount", content: "[E1.1]\n销售额", status: "ok", createdAt: 2 }, inFlight],
    unansweredMessages: [inFlight], pendingMessages: [{ id: "old-note", role: "user", content: "请继续核对准确币种", createdAt: 4 }],
  }));
  db().prepare("UPDATE subagent_tasks SET executor='dead-worker' WHERE id IN (?,?)").run(data.id, analysis.id);

  const calls = [];
  let phase = 0;
  routeState.provider = { id: "recovery-mock", async *stream({ messages, tools }) {
    const task = messages[1]?.content;
    const replies = messages.filter(({ role }) => role === "tool");
    if (messages[0].content.startsWith("你是 A.ai 的只读子 Agent")) {
      calls.push(task);
      assert.ok(tools?.every(({ name }) => name !== "recover_subagent_tasks"));
      if (task === "核对数据") {
        assert.ok(messages.some(({ content }) => content.includes("按口径交付表格")));
        assert.ok(messages.some(({ content }) => content.includes("E1.1") && content.includes("销售额")));
        assert.ok(messages.some(({ content }) => content.includes("请继续核对准确币种")));
        assert.equal(messages.filter(({ content }) => content.includes("使用本期口径")).length, 1);
        if (!replies.length) {
          yield call("read_file", { path: "currency.txt", factKey: "sheet:currency" }, "currency");
          yield { type: "done", finishReason: "tool_calls" };
          return;
        }
        assert.match(replies[0].content, /\[E2\.1\]/);
        yield { type: "text", delta: candidate([fact("sheet:currency", "E2.1", "受控工具结果")]).replace(/}$/, ',"reply":"已核对"}') };
      } else {
        assert.equal(task, "核对口径");
        assert.ok(messages.some(({ content }) => /D1\.1.*地区.*D2\.1.*销售额.*D2\.2.*受控工具结果/.test(content)));
        yield answer(fact("sheet:format", "D1.1", "地区"));
      }
      yield done;
      return;
    }
    if (++phase === 1) {
      assert.ok(tools?.some(({ name }) => name === "recover_subagent_tasks"));
      assert.match(messages[0].content, /上一轮运行已中断/);
      yield call("recover_subagent_tasks", {}, "inspect");
      yield { type: "done", finishReason: "tool_calls" };
    } else if (phase === 2) {
      assert.ok(tools?.some(({ name }) => name === "recover_subagent_tasks"));
      const { results } = json(replies.at(-1).content);
      assert.equal(results.find(({ taskId }) => taskId === requirement.id).status, "completed");
      const partial = results.find(({ taskId }) => taskId === data.id);
      assert.deepEqual(partial.facts, [amount]);
      assert.deepEqual(partial.missingFactKeys, ["sheet:currency"]);
      assert.equal(partial.interruptedFrom, "running");
      assert.equal(results.find(({ taskId }) => taskId === analysis.id).interruptedFrom, "queued");
      yield call("recover_subagent_tasks", { taskIds: [analysis.id] }, "recover");
      yield { type: "done", finishReason: "tool_calls" };
    } else {
      assert.deepEqual(json(replies.at(-1).content).results.map(({ status }) => status), ["completed", "completed", "completed"]);
      yield { type: "text", delta: "已沿原分工核对需求、数据和口径。" };
      yield done;
    }
  } };
  try {
    const run = await readRun(await request({ sessionId: session.id, message: "继续原任务" }));
    const events = await run.rest();
    assert.ok(events.some(({ message }) => message?.content === "已沿原分工核对需求、数据和口径。"), JSON.stringify({ phase, calls,
      error: events.find(({ type }) => type === "error")?.message }));
    assert.deepEqual(calls, ["核对数据", "核对数据", "核对口径"]);
    const rows = listSubagentTasks(owner);
    assert.equal(rows.length, 5);
    const recovered = rows.find(({ retryOf }) => retryOf === data.id);
    assert.equal(recovered.status, "completed");
    assert.deepEqual(recovered.result.facts.map(({ key }) => key), ["sheet:amount", "sheet:currency"]);
    assert.deepEqual(rows.find(({ retryOf }) => retryOf === analysis.id).dependencyIds, [requirement.id, recovered.id]);
    assert.equal(getSubagentTask(owner, analysis.id).progress.steps, 0);
    assert.equal(getSubagentTask(owner, data.id).status, "interrupted");

    const parent = new ParentDelegation();
    try {
      const ctx = { ...owner, disabled: {}, provider: routeState.provider, orchestrator: service, parent,
        interruptedInputId: origin.inputId, origin: { ...origin, inputId: recovered.inputId } };
      assert.equal((await runSubagentTool(call("recover_subagent_tasks", { taskIds: [analysis.id] }).call, ctx)).status, "ok");
      assert.equal(listSubagentTasks(owner).length, 5);
      assert.equal((await runSubagentTool(call("recover_subagent_tasks", { taskIds: ["foreign-task"] }).call, ctx)).status, "error");
      assert.equal((await runSubagentTool(call("recover_subagent_tasks", {}).call, { ...ctx, interruptedInputId: undefined })).status, "denied");
    } finally { await parent.close(); }
  } finally { await service.close(); }
});

test("并行读取先保存已返回的正文，重试只接收仍获准的历史证据", async () => {
  const session = store.createSession("u");
  const owner = { sessionId: session.id, userId: "u" };
  const service = new SubagentOrchestrator();
  const slow = Promise.withResolvers();
  const returned = Promise.withResolvers();
  const original = tool.run;
  tool.run = async ({ path }) => {
    if (path === "slow.txt") await slow.promise;
    return { content: path === "fast.txt" ? "快分支证据" : "慢分支证据" };
  };
  const ctx = { ...owner, workspace, disabled: {}, onOutput: (text) => {
    if (text.startsWith("✓")) queueMicrotask(returned.resolve);
  }, provider: { id: "test", async *stream() {
    yield call("read_file", { path: "fast.txt", factKey: "fast" }, "fast");
    yield call("read_file", { path: "slow.txt", factKey: "slow" }, "slow");
    yield { type: "done", finishReason: "tool_calls" };
  } } };
  const origin = () => ({ runId: crypto.randomUUID(), inputId: crypto.randomUUID() });
  try {
    const old = service.start({ task: "读取两项材料", factKeys: ["fast", "slow"] }, ctx, origin());
    await returned.promise;
    const wait = getSubagentTask(owner, old.record.id);
    assert.equal(wait.status, "running");
    assert.ok(wait.messages.some(({ content }) => content === "[E1.1]\n快分支证据"));
    assert.ok(!wait.messages.some(({ content }) => content.includes("慢分支证据")));

    // 模拟进程退出，原任务仍留下可读快照。随后失效的工具权限不能被快照绕过。
    db().prepare("UPDATE subagent_tasks SET executor='dead-worker' WHERE id=?").run(wait.id);
    const interrupted = getSubagentTask(owner, wait.id);
    assert.equal(interrupted.status, "interrupted");
    const result = service.start({}, { ...ctx, disabled: { read_file: "已取消读取权限" }, provider: { id: "test", async *stream({ messages, tools }) {
      assert.ok(!messages.some(({ content }) => content.includes("快分支证据")));
      assert.ok(!tools?.some(({ name }) => name === "read_file"));
      yield answer(fact("fast", "E1.1", "快分支证据"));
      yield done;
    } } }, { ...origin(), retryOf: wait.id });
    assert.deepEqual((await result.finished).result.facts, []);
    slow.resolve();
    await assert.rejects(old.finished);
    assert.equal(getSubagentTask(owner, wait.id).status, "interrupted");
  } finally { slow.resolve(); tool.run = original; await service.close(); }
});
