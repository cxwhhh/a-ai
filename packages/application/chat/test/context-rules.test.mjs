import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { data, db, load, readRun, routeFixture, routeState, store } from "../../../../tests/fixtures/agent-runtime.mjs";

test("项目规则逐轮刷新并传给委派，其他项目不加载，绑定失效时不调用模型", async () => {
  const { request, patch } = routeFixture();
  const { createProject } = load("packages/application/projects/src/projects.ts");
  const settings = { name: "规则项目", description: "项目说明内容", memory: "off", share: false };
  const project = createProject("u", { ...settings, rulesFile: "rules/AGENTS.md" });
  const rules = path.join(data, "rules", "AGENTS.md");
  await mkdir(path.dirname(rules));
  await writeFile(rules, "项目规则版本一");
  const calls = [];
  routeState.provider = { id: "mock", async *stream({ messages }) {
    calls.push(messages[0].content);
    if (calls.length === 1) {
      yield { type: "tool_call", call: { id: "delegate", name: "research", arguments: '{"task":"查看公开资料"}' } };
      yield { type: "done", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text", delta: "资料已核对。" };
    yield { type: "done", finishReason: "stop" };
  } };

  const first = await readRun(await request({ projectId: project.id, message: "进行测试" }));
  await first.rest();
  assert.ok(calls.length >= 3);
  assert.ok(calls.every((system) => system.includes("项目规则版本一")));
  assert.match(calls[0], /项目说明内容/);

  // 更新项目图标的旧客户端不传文件路径，已设置的绑定仍有效。
  const saved = await patch("projects", project.id, { ...settings, icon: "code" });
  assert.equal((await saved.json()).rulesFile, "rules/AGENTS.md");
  await writeFile(rules, "项目规则版本二");
  await (await readRun(await request({ sessionId: first.sessionId, message: "继续" }))).rest();
  assert.match(calls.at(-1), /项目规则版本二/);
  assert.doesNotMatch(calls.at(-1), /项目规则版本一/);

  const otherProject = createProject("u", { ...settings, name: "独立项目" });
  await (await readRun(await request({ projectId: otherProject.id, message: "新项目的问题" }))).rest();
  assert.doesNotMatch(calls.at(-1), /项目规则版本/);

  await rm(rules);
  const count = calls.length;
  const failed = await (await readRun(await request({ sessionId: first.sessionId, message: "读取不到规则时开始" }))).rest();
  assert.equal(calls.length, count);
  assert.ok(failed.some(({ type, message }) => type === "error" && /无法读取项目规则/.test(message)));
});

test("显式任务要求通过 SQLite 保存，压缩后仍生效，替换、清除和编辑按活动分支处理", async () => {
  const { request } = routeFixture();
  const { buildContext, planCompact } = load("packages/context-engine/src/context.ts");
  const calls = [];
  routeState.provider = { id: "mock", async *stream({ messages }) {
    calls.push(messages);
    yield { type: "text", delta: "收到。" };
    yield { type: "done", finishReason: "stop" };
  } };
  const first = await readRun(await request({ message: "/任务要求 只检查文件" }));
  assert.ok((await first.rest()).some(({ message }) => message?.content === "已更新本次任务要求。"));
  assert.equal(calls.length, 0);
  const sessionId = first.sessionId;
  const second = await readRun(await request({ sessionId, message: "现在看一下说明" }));
  await second.rest();
  const session = store.getSession(sessionId, "u");
  const { id: firstId } = session.messages[0];
  const { id: secondId } = session.messages.find((message) => message.content === "现在看一下说明");
  const row = db().prepare("SELECT data FROM messages WHERE id=?").get(firstId);
  assert.equal(JSON.parse(row.data).taskRequirements, "只检查文件");
  assert.match(calls.at(-1)[0].content, /当前任务要求[\s\S]*只检查文件/);
  assert.ok(calls.at(-1).slice(1).every((message) => !message.content.includes("只检查文件")));

  store.addMessage(session, { id: "requirements-compact", role: "user", content: "较早讨论摘要", createdAt: Date.now(),
    feedback: { kind: "compact", summary: "压缩" }, compact: { keepFrom: secondId, messages: 2, tokensBefore: 100, tokensAfter: 50 } });
  const compressed = buildContext(store.getSession(sessionId, "u").messages, "固定提示词");
  assert.match(compressed.messages[0].content, /较早讨论摘要[\s\S]*只检查文件/);
  assert.ok(compressed.messages.slice(1).every((message) => !message.content.includes("当前任务要求")));

  const replacement = await readRun(await request({ sessionId, message: "/任务要求 输出日文" }));
  await replacement.rest();
  assert.equal(calls.length, 1);
  await (await readRun(await request({ sessionId, message: "按新要求回答" }))).rest();
  assert.match(calls.at(-1)[0].content, /输出日文/);
  assert.doesNotMatch(calls.at(-1)[0].content, /只检查文件/);
  const cleared = await readRun(await request({ sessionId, message: "/清除任务要求" }));
  await cleared.rest();
  assert.equal(calls.length, 2);
  await (await readRun(await request({ sessionId, message: "继续回答" }))).rest();
  assert.match(calls.at(-1)[0].content, /已清除显式任务要求/);
  assert.doesNotMatch(calls.at(-1)[0].content, /输出日文/);

  const edited = await readRun(await request({ sessionId, truncateFrom: firstId, message: "普通问题" }));
  await edited.rest();
  assert.doesNotMatch(calls.at(-1)[0].content, /当前任务要求|只检查文件|输出日文/);
  const invalid = await request({ sessionId, message: `/任务要求 ${"字".repeat(4001)}` });
  assert.equal(invalid.status, 400);

  const message = (id, content, taskRequirements) => ({ id, role: "user", content, createdAt: 0, taskRequirements });
  const plan = planCompact([
    message("old", "更早的资料".repeat(1_000)),
    message("keep", "上一轮实际问题"),
    message("current", "本轮实际问题"),
    message("command", "/清除任务要求", ""),
  ]);
  assert.equal(plan.keepFrom, "keep");
});

test("运行中引导在下次模型请求应用任务要求", async () => {
  const { request, queue } = routeFixture();
  const calls = [];
  let resume;
  const held = new Promise((resolve) => { resume = resolve; });
  routeState.provider = { id: "mock", async *stream({ messages }) {
    calls.push(messages[0].content);
    if (calls.length === 1) {
      await held;
      yield { type: "tool_call", call: { id: "read", name: "read_file", arguments: '{"path":"report.txt"}' } };
      yield { type: "done", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text", delta: "收到补充要求。" };
    yield { type: "done", finishReason: "stop" };
  } };
  const run = await readRun(await request({ message: "检查报告" }));
  const { sessionId, runId } = run;
  try {
    const queued = await queue({ sessionId, runId, action: "enqueue", message: "/任务要求 只核对标题" });
    assert.equal(queued.status, 200);
    const { items } = await queued.json();
    assert.equal((await queue({ sessionId, runId, action: "steer", id: items[0].id })).status, 200);
  } finally { resume(); }
  await run.rest();
  assert.doesNotMatch(calls[0], /只核对标题/);
  assert.match(calls[1], /当前任务要求[\s\S]*只核对标题/);
  assert.equal(store.getSession(sessionId, "u").messages.find((message) => message.feedback?.kind === "note").taskRequirements, "只核对标题");
});
