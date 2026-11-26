import assert from "node:assert/strict";
import { test } from "node:test";
import { data, load, store } from "../../../tests/fixtures/agent-runtime.mjs";

const { SubagentOrchestrator, runSubagentTool } = load("packages/subagent/src/subagent.ts");
const { ParentDelegation } = load("packages/subagent/src/delegation-policy.ts");
const { getSubagentTask, listSubagentTasks } = load("packages/subagent/src/ownership-claim.ts");

const assignment = (taskKey, dependsOn = []) => ({
  taskKey, dependsOn, task: `核对 ${taskKey}`, name: taskKey, role: "analysis", plan: ["检查资料，交付引文"],
  acceptance: ["有可回读的引文"], factKeys: [`sheet:${taskKey}`], tools: [],
  ...(dependsOn.length ? {} : { contextMessages: ["source"], budget: { idleTimeoutMs: 90_000 } }),
});
const call = (assignments) => ({ name: "delegate_tasks", id: "plan", arguments: JSON.stringify({
  objective: "准备可回读的表格资料", reason: "需求与数据可以并行", synthesis: "父轮核对并输出表格", assignments,
}) });

function fixture(stream, timeout) {
  const service = new SubagentOrchestrator();
  const parent = new ParentDelegation(timeout);
  const session = store.createSession("u");
  session.messages = [{ id: "source", role: "user", content: "需求列为地区。数据列为销售额。", createdAt: 1 }];
  const ctx = { session, sessionId: session.id, userId: "u", workspace: data, disabled: {},
    provider: { id: "dependency-mock", stream }, parent, orchestrator: service,
    origin: { runId: "run", inputId: "input", parentCallId: "plan" } };
  return { ctx, service, parent, rows: () => listSubagentTasks(ctx), async close() { await parent.close(); await service.close(); } };
}

function verified(key, ref, quote) {
  return { type: "text", delta: JSON.stringify({ summary: quote,
    checks: [{ index: 1, met: true, evidenceIds: [ref] }],
    facts: [{ key: `sheet:${key}`, value: quote, quote, evidenceIds: [ref] }], unresolved: [],
  }) };
}

const done = { type: "done", finishReason: "stop" };

test("依赖等待超过默认空闲时限时无模型调用，每个上游仍可先行交付", { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const slow = Promise.withResolvers();
  const first = Promise.withResolvers();
  const calls = [];
  const notices = [];
  const inputs = [];
  const f = fixture(async function* ({ messages }) {
    const key = messages[1].content.split(" ").at(-1);
    calls.push(key);
    if (key === "data") await slow.promise;
    if (key === "analysis") {
      inputs.push(...messages.slice(2).map(({ content }) => content));
      yield verified(key, "D2.1", "数据列为销售额");
    } else yield verified(key, "C1", key === "data" ? "数据列为销售额" : "需求列为地区");
    yield done;
  });
  const result = runSubagentTool(call([assignment("analysis", ["requirements", "data"]), assignment("requirements"), assignment("data")]),
    { ...f.ctx, onSettlement: ({ record }) => { notices.push(record.contract.name); first.resolve(); } });
  try {
    await first.promise;
    t.mock.timers.tick(30_001);
    const pending = f.rows().find(({ contract }) => contract.name === "analysis");
    assert.equal(pending.status, "queued");
    assert.equal(pending.progress.inputTokens, 0);
    assert.equal(pending.progress.steps, 0);
    assert.deepEqual(notices, ["requirements"]);
    assert.deepEqual(calls, ["requirements", "data"]);
    slow.resolve();
    const reply = await result;
    assert.equal(reply.status, "ok");
    assert.deepEqual(notices, ["requirements", "data", "analysis"]);
    assert.deepEqual(calls, ["requirements", "data", "analysis"]);
    assert.match(inputs.join("\n"), /上游已核验资料.*\n.*需求列为地区.*数据列为销售额/s);
    const finished = getSubagentTask(f.ctx, pending.id);
    assert.equal(finished.status, "completed");
    assert.equal(finished.result.facts[0].evidenceIds[0], "D2.1");
    assert.equal(finished.dependencyIds.length, 2);
    const duplicate = await runSubagentTool(call([assignment("analysis", ["data", "requirements"]), assignment("requirements"), assignment("data")]), f.ctx);
    assert.equal(duplicate.status, "ok");
    assert.equal(calls.length, 3);
    const retry = f.service.start({}, f.ctx, { ...f.ctx.origin, parentCallId: undefined, retryOf: finished.id });
    assert.equal((await retry.finished).status, "completed");
    assert.equal(calls.filter((key) => key === "analysis").length, 2);
  } finally { slow.resolve(); await f.close(); }
});

test("上游验收失败会结算下游，等待中的无关分支仍可继续交付", { timeout: 5000 }, async () => {
  const hold = Promise.withResolvers();
  const blocked = Promise.withResolvers();
  const calls = [];
  const f = fixture(async function* ({ messages }) {
    const key = messages[1].content.split(" ").at(-1);
    calls.push(key);
    if (key === "requirements") yield { type: "text", delta: '{"checks":[],"facts":[],"unresolved":["资料缺失"]}' };
    else { await hold.promise; yield verified(key, "C1", "数据列为销售额"); }
    yield done;
  });
  const result = runSubagentTool(call([assignment("requirements"), assignment("data"), assignment("analysis", ["requirements", "data"])]),
    { ...f.ctx, onSettlement: ({ record }) => { if (record.contract.name === "analysis") blocked.resolve(record); } });
  try {
    const failed = await blocked.promise;
    assert.equal(failed.status, "blocked");
    assert.deepEqual([...new Set(calls)], ["requirements", "data"]);
    assert.equal(failed.progress.blockers[0].code, "dependency");
    assert.match(failed.progress.blockers[0].detail, /requirements.*sheet:requirements/);
    assert.equal(f.rows().find(({ contract }) => contract.name === "data").status, "running");
    assert.throws(() => f.service.start({}, f.ctx, { ...f.ctx.origin, retryOf: failed.id }), /补齐上游/);
    hold.resolve();
    const reply = await result;
    assert.match(reply.content, /"key":"sheet:data"/);
    assert.match(reply.content, /"dependencyTaskIds"/);
  } finally { hold.resolve(); await f.close(); }
});

test("未知依赖、自依赖、重复标识和循环依赖在登记与模型调用前拒绝", async () => {
  let calls = 0;
  const f = fixture(async function* () { calls++; yield done; });
  try {
    const a = assignment("a");
    const b = assignment("b");
    for (const [assignments, issue] of [
      [[a, { ...b, dependsOn: ["missing"] }], /不存在/],
      [[a, { ...b, dependsOn: ["b"] }], /依赖自身/],
      [[a, { ...b, taskKey: "a" }], /标识.*重复/],
      [[{ ...a, dependsOn: ["b"] }, { ...b, dependsOn: ["a"] }], /循环依赖/],
    ]) {
      const result = await runSubagentTool(call(assignments), f.ctx);
      assert.equal(result.status, "error");
      assert.match(result.content, issue);
      assert.deepEqual(f.rows(), []);
    }
    assert.equal(calls, 0);
  } finally { await f.close(); }
});

test("等待中的任务可单独取消，父轮截止也会结算等待项", { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const hold = Promise.withResolvers();
  const started = Promise.withResolvers();
  const calls = [];
  const f = fixture(async function* ({ messages }) {
    calls.push(messages[1].content);
    started.resolve();
    await hold.promise;
    yield done;
  }, 100);
  try {
    const args = JSON.parse(call([assignment("data"), assignment("cancelled", ["data"]), assignment("analysis", ["data"])]).arguments);
    const { assignments } = f.service.startPlan(args, f.ctx, f.ctx.origin, f.parent);
    await started.promise;
    assert.equal(f.service.cancel(f.ctx, assignments[1].record.id), true);
    assert.equal((await assignments[1].finished).status, "cancelled");
    t.mock.timers.tick(101);
    const overdue = await assignments[2].finished;
    assert.equal(overdue.status, "timed-out");
    assert.equal(overdue.progress.blockers[0].code, "timeout");
    assert.equal(overdue.progress.steps, 0);
    hold.resolve();
    await assignments[0].finished;
    assert.deepEqual(calls, ["核对 data"]);
  } finally { hold.resolve(); await f.close(); }
});
