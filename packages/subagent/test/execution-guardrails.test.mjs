import assert from "node:assert/strict";
import { readFile, writeFile as saveFixture } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { load, overrides, store } from "../../../tests/fixtures/agent-runtime.mjs";

const { SubagentOrchestrator, runSubagentTool } = load("packages/subagent/src/subagent.ts");
const { ParentDelegation } = load("packages/subagent/src/delegation-policy.ts");
const { openSessionWorkspace } = load("packages/workspace/src/session-workspace.ts");
const { createConversationTrace } = load("packages/conversation-trace/src/recorder.ts");
const { readSessionTrace } = load("packages/conversation-trace/src/projection.ts");
const { readFile: readText, writeFile, editFile } = load("packages/tools/src/files.ts");
const { runCommand } = load("packages/tools/src/run-command.ts");
const sandbox = load("packages/sandbox/src/sandbox.ts");

const done = { type: "done", finishReason: "stop" };
const toolsDone = { type: "done", finishReason: "tool_calls" };
const call = (name, args, id = name) => ({ type: "tool_call", call: { id, name, arguments: JSON.stringify(args) } });
const reply = (content) => ({ type: "text", delta: content });
const report = (refs, summary, unresolved = []) => JSON.stringify({
  summary,
  checks: refs.map((id, i) => ({ index: i + 1, met: true, evidenceIds: [id] })),
  facts: [],
  unresolved,
});

function useTools(extra) {
  const registry = overrides["packages/tool-runtime/src/index.ts"];
  const saved = { ...registry };
  const byName = new Map(extra.map((t) => [t.spec.name, t]));
  registry.findTool = (name) => byName.get(name) ?? saved.findTool(name);
  registry.toolSpecs = () => [...saved.toolSpecs().filter(({ name }) => !byName.has(name)), ...extra.map(({ spec }) => spec)];
  return () => Object.assign(registry, saved);
}

test("执行分支改完文件未验证或验证后再改动时触发步内提醒，持续失败有界退出为 partial", async () => {
  const service = new SubagentOrchestrator();
  const session = store.createSession("u");
  const owner = { sessionId: session.id, userId: "u" };
  const { workspace } = openSessionWorkspace("u", session.id);
  const realMode = sandbox.sandboxInfo;
  sandbox.sandboxInfo = () => ({ ...realMode(), mode: "docker" });
  let failAlways = false;
  let runs = 0;
  const terminal = { ...runCommand, async run() {
    runs++;
    return { content: JSON.stringify({ exitCode: failAlways ? 1 : 0, timedOut: false, output: failAlways ? "持续失败" : "通过" }) };
  } };
  const restore = useTools([writeFile, editFile, terminal]);

  try {
    // 场景 1：写文件后从未跑测试 -> 提醒运行验证；通过后再改文件 -> 再次提醒复测；复测通过后 completed
    let step = 0;
    const reminders = [];
    const p1 = { id: "verify-all-branches", async *stream({ messages }) {
      const tail = messages.at(-1);
      if (tail?.role === "user" && (tail.content.includes("尚未运行任何测试") || tail.content.includes("上次验证之后又修改了文件"))) reminders.push(tail.content);
      step++;
      if (step === 1) {
        yield call("write_file", { path: "mod.ts", content: "export const a = 1;\n" }, "w1");
        yield toolsDone;
      } else if (step === 2) {
        // 写了文件没测就想收尾 -> 应触发首次提醒
        yield reply(report(["E1.1"], "先交差"));
        yield done;
      } else if (step === 3) {
        yield call("run_command", { command: "npm test" }, "t1");
        yield toolsDone;
      } else if (step === 4) {
        // 测完又改了文件，接着下一轮想收尾 -> 应触发第二次提醒
        yield call("edit_file", { path: "mod.ts", old_string: "a = 1", new_string: "a = 2" }, "e1");
        yield toolsDone;
      } else if (step === 5) {
        yield reply(report(["E3.1"], "改完未复测"));
        yield done;
      } else if (step === 6) {
        yield call("run_command", { command: "npm test" }, "t2");
        yield toolsDone;
      } else {
        yield reply(report(["E6.1"], "复测通过"));
        yield done;
      }
    } };
    const r1 = await service.start(
      { role: "implementation", name: "验证全路径", task: "写并验证 mod.ts", tools: ["write_file", "edit_file", "run_command"], writePaths: ["mod.ts"], acceptance: ["测试通过"] },
      { ...owner, workspace, provider: p1, disabled: {}, commandApproval: "auto" },
      { runId: "v1", inputId: "v1" },
    ).finished;
    assert.equal(r1.status, "completed");
    assert.equal(runs, 2);
    assert.equal(reminders.length, 2);
    assert.match(reminders[0], /尚未运行任何测试/);
    assert.match(reminders[1], /上次验证之后又修改了文件/);

    // 场景 2：持续失败且模型在纠偏后于 unresolved 声明阻塞 -> 不陷入死循环，结算为 partial
    failAlways = true;
    let failTurns = 0;
    const p2 = { id: "bounded-fail", async *stream() {
      failTurns++;
      if (failTurns === 1) {
        yield call("run_command", { command: "npm test" }, "f1");
        yield toolsDone;
      } else if (failTurns === 2) {
        yield reply(report([], "尝试结束"));
        yield done;
      } else {
        // 收到纠偏提醒后在 unresolved 说明阻塞 -> 应立即退出循环并结算为 partial
        yield reply(report([], "环境依赖缺失无法通过", ["缺少外部依赖"]));
        yield done;
      }
    } };
    const r2 = await service.start(
      { role: "implementation", name: "有界失败", task: "跑测试", tools: ["run_command"], writePaths: ["mod.ts"], acceptance: ["测试通过"] },
      { ...owner, workspace, provider: p2, disabled: {}, commandApproval: "auto" },
      { runId: "v2", inputId: "v2" },
    ).finished;
    assert.equal(r2.status, "partial");
    assert.equal(failTurns, 3);
    assert.deepEqual(r2.result.unresolved, ["缺少外部依赖"]);
    assert.equal(r2.result.verification[0].exitCode, 1);
    assert.equal(r2.progress.blockers[0].code, "acceptance");
  } finally {
    sandbox.sandboxInfo = realMode;
    restore();
    await service.close();
  }
});

test("写入协调支持引用计数与三级传递 DAG 接力，拒绝菱形并行写同一文件", async () => {
  const service = new SubagentOrchestrator();
  const session = store.createSession("u");
  const owner = { sessionId: session.id, userId: "u" };
  const { workspace } = openSessionWorkspace("u", session.id);
  const restore = useTools([readText, writeFile]);

  // 1) 引用计数：同一文件两次占位，释放一次仍锁住，两次全释放后解锁
  const r1 = service.trackParentWrite(owner, "./Shared.txt");
  const r2 = service.trackParentWrite(owner, "Shared.txt");
  const noopProvider = { id: "noop", async *stream() { yield done; } };
  const targetName = process.platform === "linux" ? "Shared.txt" : "shared.txt";
  r1();
  assert.throws(
    () => service.start({ role: "implementation", task: "写", tools: ["write_file"], writePaths: [targetName] },
      { ...owner, workspace, provider: noopProvider, disabled: {} }, { runId: "lock1", inputId: "lock1" }),
    /正由主对话写入/,
  );
  r2();

  // 2) 菱形并行分支（b1 与 b2 均依赖 root 但互相独立）写同一文件 -> 409 拒绝
  const parent = new ParentDelegation();
  const batchArgs = (assignments) => call("delegate_tasks", {
    objective: "测试写协调", reason: "验证依赖接力与冲突拦截", synthesis: "汇总", assignments,
  }, "batch").call;
  try {
    const diamond = await runSubagentTool(batchArgs([
      { role: "implementation", name: "根", task: "步骤0", taskKey: "root", tools: ["write_file"], writePaths: ["d.txt"], plan: ["写"], acceptance: ["已写"] },
      { role: "implementation", name: "左支", task: "步骤左", taskKey: "b1", dependsOn: ["root"], tools: ["write_file"], writePaths: ["d.txt"], plan: ["写"], acceptance: ["已写"] },
      { role: "implementation", name: "右支", task: "步骤右", taskKey: "b2", dependsOn: ["root"], tools: ["write_file"], writePaths: ["d.txt"], plan: ["写"], acceptance: ["已写"] },
    ]), { ...owner, workspace, provider: noopProvider, disabled: {}, orchestrator: service, parent, origin: { runId: "dia", inputId: "dia", parentCallId: "dia:1" } });
    assert.equal(diamond.isError, true);
    assert.match(diamond.content, /已分配给另一子任务/);

    // 3) 三级链式依赖 s1 -> s2 -> s3：s1 与 s3 接力写同一文件允许执行
    const chainProvider = { id: "chain", async *stream({ messages }) {
      const task = messages[1].content;
      if (!messages.some(({ role }) => role === "tool")) {
        if (task.includes("复查写入")) {
          yield call("write_file", { path: "chain-note.txt", content: "v2-checked" });
          yield toolsDone;
        } else {
          yield call("write_file", { path: "chain.txt", content: task.includes("终稿") ? "v3-final" : "v1-init" });
          yield toolsDone;
        }
      } else {
        yield reply(report(["E1.1"], "完成写入"));
        yield done;
      }
    } };
    const chain = await runSubagentTool(batchArgs([
      { role: "implementation", name: "初稿", task: "初稿写入", taskKey: "s1", tools: ["write_file"], writePaths: ["chain.txt"], plan: ["写初稿"], acceptance: ["已写"] },
      { role: "implementation", name: "复查", task: "复查写入", taskKey: "s2", dependsOn: ["s1"], tools: ["write_file"], writePaths: ["chain-note.txt"], plan: ["写说明"], acceptance: ["已写"] },
      { role: "implementation", name: "终稿", task: "终稿定稿", taskKey: "s3", dependsOn: ["s2"], tools: ["write_file"], writePaths: ["chain.txt"], plan: ["写终稿"], acceptance: ["已写"] },
    ]), { ...owner, workspace, provider: chainProvider, disabled: {}, commandApproval: "auto", orchestrator: service, parent, origin: { runId: "ch", inputId: "ch", parentCallId: "ch:1" } });
    assert.equal(chain.status, "ok");
    assert.equal(await readFile(path.join(workspace, "chain.txt"), "utf8"), "v3-final");
  } finally {
    await parent.close();
    restore();
    await service.close();
  }
});

test("轨迹按 review、review-check、followup、revision 区分 subagentKind 与标题", async () => {
  const service = new SubagentOrchestrator();
  const session = store.createSession("u");
  const owner = { sessionId: session.id, userId: "u" };
  const { workspace } = openSessionWorkspace("u", session.id);
  await saveFixture(path.join(workspace, "doc.md"), "# 标题\n数值：100\n");
  const restore = useTools([readText, editFile]);
  const trace = createConversationTrace({ sessionId: session.id, runId: "kind-run", inputId: "kind-input", model: "mock", effort: "low" });

  try {
    // 1) review 角色并触发收尾复核（review-check）
    const reviewProvider = { id: "review-check-mock", async *stream({ messages }) {
      if (messages[0].content.includes("收尾复核")) {
        yield reply(JSON.stringify({ action: "accept", reason: "引文无歧义" }));
        yield done;
        return;
      }
      if (!messages.some(({ role }) => role === "tool")) {
        yield call("read_file", { path: "doc.md", factKey: "doc:val" });
        yield toolsDone;
      } else {
        yield reply(JSON.stringify({
          summary: "已读到数值 100",
          checks: [{ index: 1, met: true, evidenceIds: ["E1.1"] }],
          facts: [{ key: "doc:val", value: "100", quote: "数值：100", evidenceIds: ["E1.1"] }],
          review: { reason: "确认口径", evidenceIds: ["E1.1"] },
          unresolved: [],
        }));
        yield done;
      }
    } };
    const first = await service.start(
      { role: "review", task: "审阅 doc.md", paths: ["doc.md"], acceptance: ["有引文"], factKeys: ["doc:val"] },
      { ...owner, workspace, provider: reviewProvider, disabled: {}, trace: { recorder: trace, step: 1 } },
      { runId: "kind-run", inputId: "kind-input" },
    ).finished;
    assert.equal(first.status, "completed");

    // 2) 普通续聊（followup）
    const followup = await service.continueTask(
      "再概括一下",
      undefined,
      { ...owner, workspace, provider: { id: "f-mock", async *stream() { yield reply("数值为 100"); yield done; } }, disabled: {}, trace: { recorder: trace, step: 2 } },
      { runId: "kind-run", inputId: "kind-input", retryOf: first.id },
    ).finished;
    assert.equal(followup.status, "completed");

    // 3) 文件微调（revision）
    const revisionProvider = { id: "rev-mock", async *stream({ messages }) {
      if (!messages.some(({ role }) => role === "tool")) {
        yield call("edit_file", { path: "doc.md", old_string: "100", new_string: "200" });
        yield toolsDone;
      } else { yield reply("已改为 200"); yield done; }
    } };
    const revision = await service.continueTask(
      "把 100 改成 200",
      "doc.md",
      { ...owner, workspace, provider: revisionProvider, disabled: {}, commandApproval: "auto", trace: { recorder: trace, step: 3 } },
      { runId: "kind-run", inputId: "kind-input", retryOf: followup.id },
    ).finished;
    assert.equal(revision.status, "completed");

    const projected = readSessionTrace(session.id, "u", true);
    const kinds = projected.analysis.requests.subagentKinds;
    assert.ok((kinds?.review ?? 0) >= 2);
    assert.equal(kinds?.["review-check"], 1);
    assert.equal(kinds?.followup, 1);
    assert.ok((kinds?.revision ?? 0) >= 2);
    assert.ok(projected.rows.some((r) => r.subagentKind === "review-check" && r.title.includes("收尾复核")));
    assert.ok(projected.rows.some((r) => r.subagentKind === "followup" && r.title.includes("线程续聊")));
    assert.ok(projected.rows.some((r) => r.subagentKind === "revision" && r.title.includes("文件微调")));
  } finally {
    restore();
    await service.close();
  }
});
