import assert from "node:assert/strict";
import { readFile, stat, writeFile as saveFixture } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { agents, data, fixtureSettings, load, overrides, readRun, routeFixture, routeState, runAgent, store, tool } from "../../../tests/fixtures/agent-runtime.mjs";

const { SubagentOrchestrator, runSubagentTool } = load("packages/subagent/src/subagent.ts");
const { ParentDelegation } = load("packages/subagent/src/delegation-policy.ts");
const { listSubagentTasks } = load("packages/subagent/src/ownership-claim.ts");
const { openSessionWorkspace } = load("packages/workspace/src/session-workspace.ts");
const { agentSessions } = load("packages/session/src/agent-session.ts");
const { estimateTokens } = load("packages/protocol/src/lib/tokens.ts");
const { collectOutputs } = load("packages/protocol/src/lib/outputs.ts");
const { readToolResult } = load("packages/storage/src/tool-results.ts");
const { boundedContext } = load("packages/subagent/src/context-boundary.ts");
const { buildContext } = load("packages/context-engine/src/context.ts");
const { readSavedToolResult } = load("packages/tools/src/read-tool-result.ts");
const { readFile: readText, writeFile, editFile } = load("packages/tools/src/files.ts");
const { writeDocument } = load("packages/tools/src/write-document.ts");
const { readDocument } = load("packages/tools/src/documents.ts");
const { runPython } = load("packages/tools/src/run-python.ts");
const { runCommand } = load("packages/tools/src/run-command.ts");
const sandbox = load("packages/sandbox/src/sandbox.ts");
const { answerApproval } = load("packages/permissions/src/approvals.ts");

const done = { type: "done", finishReason: "stop" };
const toolsDone = { type: "done", finishReason: "tool_calls" };
const call = (name, args, id = name) => ({ type: "tool_call", call: { id, name, arguments: JSON.stringify(args) } });
const reply = (content) => ({ type: "text", delta: content });
const delegation = (assignments) => call("delegate_tasks", { objective: "交付已核对的分工", reason: "各分支可以独立完成",
  synthesis: "汇总写入文件、结果和缺项", assignments }, "batch");
const jsonReport = (facts, refs, summary = "已核对") => JSON.stringify({ summary,
  checks: refs.map((id, index) => ({ index: index + 1, met: true, evidenceIds: [id] })), facts, unresolved: [] });
const fact = (key, quote, id) => ({ key, value: `值-${key}`, quote, evidenceIds: [id] });

function useTools(extra) {
  const registry = overrides["packages/tool-runtime/src/index.ts"];
  const saved = { ...registry };
  const byName = new Map(extra.map((tool) => [tool.spec.name, tool]));
  registry.findTool = (name) => byName.get(name) ?? saved.findTool(name);
  registry.toolSpecs = () => [...saved.toolSpecs().filter(({ name }) => !byName.has(name)), ...extra.map(({ spec }) => spec)];
  registry.toolsFor = () => registry.toolSpecs();
  return () => Object.assign(registry, saved);
}

test("五个分支结算经主上下文回传短回执，完整引文可分页回读，旧记录采用同一投影", async () => {
  const service = new SubagentOrchestrator();
  const { request } = routeFixture({ agents, agentSessions, subagents: service });
  const restore = useTools([readSavedToolResult]);
  const assign = Array.from({ length: 5 }, (_, n) => ({ role: "analysis", name: `分项${n}`, task: `核对分项${n}`,
    plan: ["读取资料"], acceptance: ["事实有原文"], factKeys: [`item:${n}`], paths: ["."] }));
  const original = tool.run;
  tool.run = async ({ path }) => ({ content: `原文${path}：` + "甲乙丙丁戊己庚辛".repeat(46) });
  let parentStep = 0;
  let preview;
  let id;
  routeState.provider = { id: "receipt-mock", async *stream({ messages }) {
    const results = messages.filter(({ role }) => role === "tool");
    if (messages[0].content.startsWith("你是 A.ai 的只读子 Agent")) {
      const n = Number(messages[1].content.at(-1));
      if (results.length) {
        yield reply(jsonReport([fact(`item:${n}`, results[0].content.split("\n")[1], "E1.1")], ["E1.1"]));
        yield done;
      } else {
        yield call("read_file", { path: `source${n}.txt`, factKey: `item:${n}` });
        yield toolsDone;
      }
      return;
    }
    if (++parentStep === 1) { yield delegation(assign); yield toolsDone; }
    else if (parentStep === 2) {
      preview = results.at(-1).content;
      id = /结果存储在 (\S+)（/.exec(preview)?.[1];
      assert.ok(id);
      assert.ok(estimateTokens(preview) < 1_000);
      for (const [index, entry] of assign.entries()) {
        assert.ok(preview.includes(entry.name));
        assert.ok(preview.includes(`item:${index}=值-item:${index}`));
      }
      assert.doesNotMatch(preview, /"quote"|"acceptance"/);
      yield call("read_tool_result", { resultId: id, limit: 650 }, "read-back");
      yield toolsDone;
    } else {
      assert.match(results.at(-1).content, /原文source\d\.txt|nextOffset/);
      yield reply("分工结果已汇总");
      yield done;
    }
  } };
  try {
    const run = await readRun(await request({ message: "核对五份材料" }));
    const events = await run.rest();
    assert.ok(events.some(({ message }) => message?.content === "分工结果已汇总"), events.find(({ type }) => type === "error")?.message);
    const session = store.getSession(run.sessionId, "u");
    const saved = session.messages.find((message) => message.id === id);
    assert.ok(saved.toolResult.preview);
    assert.ok(estimateTokens(saved.content) > estimateTokens(preview) * 2);
    let text = "", next = 0;
    while (next !== null) {
      const page = readToolResult("u", run.sessionId, id, next, 400);
      text += page.content;
      next = page.nextOffset;
    }
    assert.equal(text, saved.content);
    assert.ok(assign.every((_, n) => text.includes(`原文source${n}.txt`)));
    const legacy = session.messages.map((message) => message.id === id ? { ...message, toolResult: undefined } : message);
    assert.ok(buildContext(legacy, "测试").messages.some(({ content }) => content === preview));
  } finally { tool.run = original; restore(); await service.close(); }
});

test("紧窗口的子分支按编号回读压缩前的原文，并用中段引文通过验收", async () => {
  const service = new SubagentOrchestrator();
  const session = store.createSession("u");
  const clue = "MID-CITE 数据口径为本年累计";
  const raw = [...Array.from({ length: 105 }, () => "模板内容仅供归档".repeat(18)), clue,
    ...Array.from({ length: 15 }, () => "归档说明".repeat(20))].join("\n");
  const original = tool.run;
  tool.run = async () => ({ content: raw });
  let step = 0;
  const provider = { id: "evidence-mock", async *stream({ messages, tools }) {
    ++step;
    if (step === 1) {
      yield call("read_file", { path: "archive.txt", factKey: "archive:scope" });
      yield toolsDone;
    } else if (step === 2) {
      const toolReply = messages.find(({ role }) => role === "tool");
      assert.match(toolReply.content, /\[E1\.1\] 证据节选/);
      assert.ok(toolReply.content.length < raw.length);
      assert.ok(tools.some(({ name }) => name === "read_evidence"));
      yield call("read_evidence", { evidenceId: "E1.1", query: "MID-CITE" });
      yield toolsDone;
    } else {
      assert.ok(messages.some(({ content }) => content.includes(clue)));
      yield reply(jsonReport([fact("archive:scope", clue, "E1.1")], ["E1.1"]));
      yield done;
    }
  } };
  try {
    const { finished } = service.start({ task: "检查历史资料", acceptance: ["有确切原文"], factKeys: ["archive:scope"] },
      { ...session, sessionId: session.id, userId: "u", workspace: data, disabled: {}, contextWindow: 8_000, provider },
      { runId: "bounded", inputId: "bounded" });
    const result = await finished;
    assert.equal(result.status, "completed");
    assert.equal(step, 3);
    assert.equal(result.result.facts[0].quote, clue);
    assert.ok(result.messages.some(({ content }) => content.includes(raw)));
    const packed = boundedContext([{ role: "tool", content: `[E1.1]\n${raw}` }], undefined, 250,
      { terms: [], quotes: new Map([["E1.1", [clue]]]) });
    assert.ok(packed.tokens <= 250);
    assert.ok(packed.messages[0].content.includes(clue));
  } finally { tool.run = original; await service.close(); }
});

test("执行分支能写文件、局部编辑、生成 Office 文件并回读，主对话登记真实产出", async () => {
  const service = new SubagentOrchestrator();
  const { request } = routeFixture({ agents, agentSessions, subagents: service });
  const realMode = sandbox.sandboxInfo;
  const approvalMode = fixtureSettings.commandApproval;
  fixtureSettings.commandApproval = "auto";
  sandbox.sandboxInfo = () => ({ ...realMode(), mode: "docker" });
  const python = { ...runPython, async run({ code }, ctx) {
    assert.match(code, /check\.xlsx/);
    assert.deepEqual(ctx.isolatedPython, { inputs: ["requirements.txt"], optionalOutputs: ["output/notes.md", "output/check.xlsx"] });
    assert.equal((await readFile(ctx.readPath("output/notes.md").full, "utf8")).trim(), "# 复核版");
    return { content: '{"exitCode":0,"stdout":"文件检查通过"}' };
  } };
  const restore = useTools([readText, writeFile, editFile, writeDocument, readDocument, python]);
  const assignment = { role: "implementation", name: "制作报告和表格", task: "写入并验证两份文件",
    tools: ["write_file", "edit_file", "write_document", "read_file", "read_document", "run_python"], writePaths: ["output/notes.md", "output/check.xlsx"],
    paths: ["requirements.txt"], contextFiles: ["requirements.txt"],
    plan: ["创建文件并修改标题", "核对源文件和表格"], acceptance: ["核对标题", "核对工作表", "运行 Python 验证"] };
  routeState.provider = { id: "implementation-mock", async *stream({ messages, tools }) {
    const results = messages.filter(({ role }) => role === "tool");
    if (messages[0].content.startsWith("你是 A.ai 的执行子 Agent")) {
      assert.ok(tools.some(({ name }) => name === "write_file"));
      if (results.length === 0) {
        yield call("write_file", { path: "output/notes.md", content: "# 初版\n" });
        yield call("edit_file", { path: "output/notes.md", old_string: "初版", new_string: "复核版" });
        yield call("write_document", { path: "output/check.xlsx", sheets: [{ name: "验收", rows: [["合计"], [12]] }] });
        yield call("write_file", { path: "output/unassigned.md", content: "不应写入" }, "denied-file");
        yield toolsDone;
      } else if (results.length === 4) {
        assert.match(results[3].content, /不在此子任务的 writePaths/);
        yield call("read_file", { path: "output/notes.md" });
        yield call("read_document", { path: "output/check.xlsx" });
        assert.deepEqual(Object.keys(tools.find(({ name }) => name === "run_python").parameters.properties), ["code", "purpose"]);
        yield call("run_python", { code: "import zipfile\nassert zipfile.is_zipfile('output/check.xlsx')" });
        yield toolsDone;
      } else {
        assert.match(results[4].content, /复核版/);
        assert.match(results[5].content, /合计/);
        assert.match(results[6].content, /文件检查通过/);
        yield reply(jsonReport([], ["E2.1", "E2.2", "E2.3"], "已写入并回读两份文件"));
        yield done;
      }
    } else if (!results.length) { yield delegation([assignment]); yield toolsDone; }
    else { yield reply("两份文件均已核对"); yield done; }
  } };
  try {
    const seeded = store.createSession("u");
    const { workspace } = openSessionWorkspace("u", seeded.id);
    await saveFixture(path.join(workspace, "requirements.txt"), "生成文档与检查表");
    const run = await readRun(await request({ sessionId: seeded.id, message: "制作并核对报告和表格" }));
    const events = await run.rest();
    assert.ok(events.some(({ message }) => message?.content === "两份文件均已核对"), events.find(({ type }) => type === "error")?.message);
    const owner = { sessionId: run.sessionId, userId: "u" };
    const [task] = listSubagentTasks(owner);
    assert.equal(task.status, "completed");
    assert.deepEqual(task.result.writtenPaths, assignment.writePaths);
    assert.equal(await readFile(path.join(workspace, "output/notes.md"), "utf8"), "# 复核版\n");
    await assert.rejects(stat(path.join(workspace, "output/unassigned.md")), { code: "ENOENT" });
    const session = store.getSession(run.sessionId, "u");
    assert.deepEqual(new Set(collectOutputs(session.messages, session.artifacts).outputs.map(({ name }) => name)), new Set(assignment.writePaths));
    assert.throws(() => service.start({}, { ...owner, workspace }, { runId: "retry", inputId: "retry", retryOf: task.id }), /核对实际内容/);

    const parent = new ParentDelegation();
    try {
      const origin = { runId: "scope", inputId: "scope", parentCallId: "scope" };
      const ctx = { ...owner, workspace, provider: routeState.provider, disabled: {}, origin, parent, orchestrator: service };
      const collision = await runSubagentTool(delegation([assignment, { ...assignment, task: "重复写报告", writePaths: ["./output/notes.md"] }]).call, ctx);
      assert.match(collision.content, /已分配给另一子任务/);
      const directory = await runSubagentTool(delegation([{ ...assignment, writePaths: ["output"] }]).call, ctx);
      assert.match(directory.content, /目标必须是普通文件/);
      assert.equal(listSubagentTasks(owner).length, 1);
    } finally { await parent.close(); }

    const revisionModel = { id: "revision-mock", async *stream({ messages }) {
      if (!messages.some(({ role }) => role === "tool")) {
        assert.match(messages[0].content, /唯一可读写的文件是 "output\/notes.md"/);
        yield call("edit_file", { path: "output/notes.md", old_string: "复核版", new_string: "定稿" });
        yield toolsDone;
      } else { yield reply("标题已定稿"); yield done; }
    } };
    const revision = service.continueTask("把标题改为定稿", "output/notes.md",
      { ...owner, workspace, provider: revisionModel, disabled: {}, session, commandApproval: "auto" }, { runId: "revision", inputId: "revision", retryOf: task.id });
    assert.equal((await revision.finished).status, "completed");
    assert.equal(await readFile(path.join(workspace, "output/notes.md"), "utf8"), "# 定稿\n");
  } finally { fixtureSettings.commandApproval = approvalMode; sandbox.sandboxInfo = realMode; restore(); await service.close(); }
});

const editAssignment = (name) => ({ role: "implementation", name, task: name, tools: ["write_file"],
  writePaths: [`${name}.txt`], plan: ["完成本分工的文件"], acceptance: ["有写入回执"] });

test("同一执行分支修改、运行失败后自行修复并复测，父轮只做集成验证", async () => {
  const service = new SubagentOrchestrator();
  const session = store.createSession("u");
  const { workspace } = openSessionWorkspace("u", session.id);
  await saveFixture(path.join(workspace, "math.cjs"), "exports.add = (a, b) => a - b;\n");
  const original = sandbox.sandboxInfo;
  sandbox.sandboxInfo = () => ({ ...original(), mode: "docker" });
  const checks = [];
  const terminal = { ...runCommand, async run({ command }, ctx) {
    if (ctx.isolatedCommand) assert.deepEqual(ctx.isolatedCommand, { inputs: ["math.cjs"], ownedFiles: ["math.cjs"] });
    const code = await readFile(path.join(ctx.workspace, "math.cjs"), "utf8");
    const fixed = code.includes("a + b");
    checks.push({ command, delegated: !!ctx.isolatedCommand, fixed });
    return { content: JSON.stringify({ exitCode: fixed ? 0 : 1, timedOut: false, output: fixed ? "测试通过" : "预期 5，得到 -1" }) };
  } };
  const restore = useTools([editFile, terminal]);
  const assignment = { ...editAssignment("修复加法"), tools: ["run_command", "edit_file"], paths: ["math.cjs"], writePaths: ["math.cjs"],
    plan: ["重现普通算术测试失败", "修正加法并重跑"], acceptance: ["加法测试通过"], budget: { steps: 16 } };
  const source = { id: "fix-input", role: "user", content: "修好加法，合并后复查", createdAt: 1 };
  store.beginTurn(session, source, undefined, "fix-run");
  const command = "node --test math.test.cjs";
  const provider = { id: "developer-mock", async *stream({ messages }) {
    const results = messages.filter(({ role }) => role === "tool");
    if (messages[0].content.startsWith("你是 A.ai 的执行子 Agent")) {
      if (!results.length || results.length === 2) yield call("run_command", { command }, `test-${results.length}`);
      else if (results.length === 1) {
        assert.match(results[0].content, /预期 5，得到 -1/);
        yield call("edit_file", { path: "math.cjs", old_string: "a - b", new_string: "a + b" });
      } else {
        assert.match(results[2].content, /测试通过/);
        yield reply(jsonReport([], ["E3.1"], "已在分支修复并复测"));
        yield done;
        return;
      }
    } else if (!results.length) yield delegation([assignment]);
    else if (results.length === 1) {
      const batch = JSON.parse(results[0].content.match(/```json\n([\s\S]+?)\n```/)[1]);
      assert.equal(batch.batchStatus, "completed");
      assert.deepEqual(batch.results[0].writtenPaths, ["math.cjs"]);
      assert.deepEqual(batch.results[0].verification, [1, 0].map((exitCode) => ({ command, exitCode, timedOut: false })));
      yield call("run_command", { command }, "integration");
    } else {
      yield reply("集成验证通过");
      yield done;
      return;
    }
    yield toolsDone;
  } };
  try {
    const events = [];
    for await (const event of runAgent({ session, workspace, userId: "u", provider, subagents: service, commandApproval: "auto",
      execution: { inputId: source.id, runId: "fix-run" }, maxSteps: 4 })) events.push(event);
    assert.ok(events.some(({ message }) => message?.content === "集成验证通过"), events.find(({ type }) => type === "error")?.message);
    assert.deepEqual(checks, [
      { command, delegated: true, fixed: false }, { command, delegated: true, fixed: true }, { command, delegated: false, fixed: true },
    ]);
    assert.equal((await readFile(path.join(workspace, "math.cjs"), "utf8")), "exports.add = (a, b) => a + b;\n");
    assert.equal(listSubagentTasks({ sessionId: session.id, userId: "u" })[0].limits.steps, 16);
  } finally { sandbox.sandboxInfo = original; restore(); await service.close(); }
});

test("两项写入审批经父轮推流，重复的子模型调用 ID 各自等待用户决定", { timeout: 5000 }, async () => {
  const service = new SubagentOrchestrator();
  const session = store.createSession("u");
  const { workspace } = openSessionWorkspace("u", session.id);
  const restore = useTools([writeFile]);
  const names = ["第一分支", "第二分支"];
  store.addMessage(session, { id: "approved-parent", role: "user", content: "独立创建两份文本", createdAt: 1 });
  const provider = { id: "approval-parent", async *stream({ messages }) {
    const results = messages.filter(({ role }) => role === "tool");
    if (messages[0].content.startsWith("你是 A.ai 的执行子 Agent")) {
      if (!results.length) {
        yield call("write_file", { path: `${messages[1].content}.txt`, content: messages[1].content }, "same-child-id");
        yield toolsDone;
      } else {
        yield reply(jsonReport([], results[0].content.includes("未获批准") ? [] : ["E1.1"]));
        yield done;
      }
    } else if (!results.length) { yield delegation(names.map(editAssignment)); yield toolsDone; }
    else { yield reply("已处理两个分支"); yield done; }
  } };
  const approvals = [];
  const closed = [];
  const controller = new AbortController();
  try {
    for await (const event of runAgent({ session, workspace, provider, userId: "u", subagents: service,
      signal: controller.signal, maxSteps: 4, commandApproval: "ask" })) {
      if (event.type === "approval") {
        approvals.push(event);
        assert.match(event.reason, /子任务/);
        assert.equal(answerApproval("other", event.approvalId, "allow"), false);
        if (approvals.length === 2) {
          for (const name of names) await assert.rejects(stat(path.join(workspace, `${name}.txt`)), { code: "ENOENT" });
          for (const pending of approvals) assert.ok(answerApproval("u", pending.approvalId, pending.command.includes(names[0]) ? "allow" : "deny"));
        }
      } else if (event.type === "approval_end") closed.push(event);
      else assert.notEqual(event.type, "error", event.message);
    }
    assert.equal(new Set(approvals.map(({ callId }) => callId)).size, 2);
    assert.equal(new Set(approvals.map(({ approvalId }) => approvalId)).size, 2);
    assert.equal(closed.filter(({ allowed }) => allowed).length, 1);
    assert.equal(closed.filter(({ allowed }) => !allowed).length, 1);
    assert.equal(await readFile(path.join(workspace, `${names[0]}.txt`), "utf8"), names[0]);
    await assert.rejects(stat(path.join(workspace, `${names[1]}.txt`)), { code: "ENOENT" });
  } finally { controller.abort(); await service.close(); restore(); }
});

test("独立写入的审批可按权限轮询，文件变更或停止后旧审批无法提交", { timeout: 5000 }, async () => {
  const service = new SubagentOrchestrator();
  const restore = useTools([writeFile]);
  const session = store.createSession("u");
  const { workspace } = openSessionWorkspace("u", session.id);
  const provider = { id: "approval-direct", async *stream({ messages }) {
    if (!messages.some(({ role }) => role === "tool")) {
      yield call("write_file", { path: `${messages[1].content}.txt`, content: "模型版本" });
      yield toolsDone;
    } else { yield reply("已检查执行回执"); yield done; }
  } };
  const runtime = { agents, agentSessions, subagents: service, models: () => provider };
  routeFixture(runtime);
  const { GET, POST, DELETE } = load("apps/server/src/routes/api/sessions/[id]/agent/subagents/route.ts");
  const approve = load("apps/server/src/routes/api/approve/route.ts").POST;
  const context = { runtime, params: Promise.resolve({ id: session.id }) };
  const request = (method, taskId, body) => new Request(`http://localhost/subagents${taskId ? `?taskId=${taskId}` : ""}`,
    { method, body: body ? JSON.stringify(body) : undefined });
  const getTask = async (id) => (await (await GET(request("GET", id), context)).json()).task;
  const set = (approvalId, decision) => approve(new Request("http://localhost/api/approve", { method: "POST", body: JSON.stringify({ approvalId, decision }) }));
  async function wait(id, check) {
    for (let i = 0; i < 120; i++) {
      const item = await getTask(id);
      if (check(item)) return item;
      await delay(5);
    }
    assert.fail("子任务未达到预期的审批或任务状态");
  }
  try {
    for (const name of ["审批时发生修改", "审批时停止"]) {
      const file = path.join(workspace, `${name}.txt`);
      await saveFixture(file, "用户原文");
      const response = await POST(request("POST", null, editAssignment(name)), context);
      assert.equal(response.status, 202);
      const { task } = await response.json();
      const pending = (await wait(task.id, ({ pendingApproval }) => !!pendingApproval)).pendingApproval;
      assert.match(pending.command, /替换文件/);
      assert.equal(await readFile(file, "utf8"), "用户原文");
      routeState.caller = "other";
      assert.equal((await GET(request("GET", task.id), context)).status, 404);
      assert.equal((await set(pending.approvalId, "allow")).status, 404);
      routeState.caller = "u";
      const conflict = await POST(request("POST", null, { ...editAssignment(name), name: "同文件的另一分支" }), context);
      assert.equal(conflict.status, 409);
      assert.match((await conflict.json()).error, /已分配给另一子任务/);
      if (name === "审批时发生修改") {
        await saveFixture(file, "用户新版本");
        assert.equal((await set(pending.approvalId, "allow")).status, 200);
        const after = await wait(task.id, ({ status }) => status !== "running");
        assert.ok(after.messages.some(({ content }) => content.includes("文件在审批后发生变化")));
        assert.equal(await readFile(file, "utf8"), "用户新版本");
      } else {
        assert.equal((await DELETE(request("DELETE", task.id), context)).status, 204);
        assert.equal((await wait(task.id, ({ status }) => status !== "running")).status, "cancelled");
        assert.equal((await set(pending.approvalId, "allow")).status, 404);
        assert.equal(await readFile(file, "utf8"), "用户原文");
      }
    }
  } finally { routeState.caller = "u"; await service.close(); restore(); }
});
