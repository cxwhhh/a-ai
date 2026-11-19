import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inspectWork, data, db, load, overrides, readRun, routeFixture, routeState, signal, store } from "../../../../tests/fixtures/agent-runtime.mjs";

const { editFile, writeFile } = load("packages/tools/src/files.ts");
const { hashFileBytes } = load("packages/workspace/src/file-fingerprint.ts");
const { recordFileWrite, readFileRecoveries, recoverInterruptedTurn } = load("packages/session/session-recovery/src/file-recovery.ts");
const { recordAgentLog, readAgentEvents } = load("packages/session/src/log.ts");
const { readSessionTrace } = load("packages/conversation-trace/src/projection.ts");
const hash = (text) => hashFileBytes(Buffer.from(text));
const original = "timeout: 30\n";
const expected = "timeout: 60\n";
const step = { step: 1, model: "mock", effort: "default" };

/** 按真实落库顺序保存调用和检查点，停在文件操作和结果事务之间的指定位置。 */
function interruptedFile(label, content, { result = false } = {}) {
  const session = store.createSession("u");
  const file = `${label}.txt`;
  const scope = {
    sessionId: session.id, inputId: `${label}-input`, runId: `${label}-run`,
    assistantId: `${label}-assistant`, callId: "shared-call-id", step: 1
  };
  const { runId, inputId, assistantId, callId } = scope;
  store.beginTurn(session, { id: inputId, role: "user", content: "把超时改成 60", createdAt: 1 }, undefined, runId);
  recordAgentLog(session.id, { kind: "step-start", runId, inputId, detail: step });
  store.addMessage(session, {
    id: assistantId, role: "assistant", content: "", createdAt: 2, toolCalls: [{
      id: callId, name: "edit_file", arguments: JSON.stringify({ path: file, old_string: original, new_string: expected })
    }]
  });
  recordAgentLog(session.id, { kind: "tool-start", runId, inputId, detail: { step: 1, callId, name: "edit_file" } });
  recordFileWrite(scope, file, hash(original), hash(expected));
  writeFileSync(path.join(data, file), content);
  if (result) store.addMessage(session, { id: `${label}-result`, role: "tool", toolCallId: callId, content: "实际工具结果", status: "ok", createdAt: 3 });
  return { session, file, scope };
}

test("文件工具提交检查点后才写入，提交失败时保留原文件", async () => {
  const file = "before-write.txt";
  const full = path.join(data, file);
  writeFileSync(full, original);
  const base = { sessionId: "file-test", workspace: data, signal };
  const checkpointFileWrite = (name, before, after) => {
    assert.equal(name, file);
    assert.equal(before, hash(original));
    assert.equal(after, hash(expected));
    assert.equal(readFileSync(full, "utf8"), original);
    throw new Error("检查点不可写");
  };
  await assert.rejects(editFile.run({ path: file, old_string: original, new_string: expected }, { ...base, checkpointFileWrite }), /检查点不可写/);
  await assert.rejects(writeFile.run({ path: file, content: expected }, { ...base, checkpointFileWrite }), /检查点不可写/);
  assert.equal(readFileSync(full, "utf8"), original);
});

test("真实聊天入口将新建文件的检查点与助手、运行和步骤关联", async () => {
  const { request } = routeFixture();
  const tools = overrides["packages/tool-runtime/src/index.ts"];
  const originalFind = tools.findTool;
  try {
    tools.findTool = (name) => name === "write_file" ? writeFile : originalFind(name);
    routeState.provider = { async *stream({ messages }) {
      if (messages.some((message) => message.role === "tool")) yield { type: "text", delta: "文件已写入" };
      else yield { type: "tool_call", call: { id: "create-file", name: "write_file", arguments: JSON.stringify({ path: "created.txt", content: expected }) } };
      yield { type: "done" };
    } };
    const run = await readRun(await request({ message: "写文件" }));
    await run.rest();
    const saved = store.getSession(run.sessionId, "u");
    const call = saved.messages.find((message) => message.toolCalls?.length);
    const row = db().prepare(`SELECT assistant_id, run_id, step, before_hash, expected_hash, verification
      FROM agent_file_writes WHERE session_id=? AND call_id=?`).get(run.sessionId, "create-file");
    assert.equal(row.assistant_id, call.id);
    assert.equal(row.run_id, run.runId);
    assert.equal(row.step, 1);
    assert.equal(row.before_hash, null);
    assert.equal(row.expected_hash, hash(expected));
    assert.equal(row.verification, null);
    assert.equal(readFileSync(path.join(data, "created.txt"), "utf8"), expected);
  } finally {
    tools.findTool = originalFind;
  }
});

test("续聊自动核验已写入文件，恢复结论进入原调用的上下文与轨迹", async () => {
  const { request } = routeFixture();
  const { session, file, scope } = interruptedFile("applied", expected);
  const full = path.join(data, file);
  const before = statSync(full).mtimeMs;
  const captured = [];
  routeState.provider = { async *stream({ messages }) {
    captured.push(messages);
    yield { type: "text", delta: "继续处理后续步骤" };
    yield { type: "done" };
  } };
  const previous = readSessionTrace(session.id, "u");
  assert.equal(previous.rows.find((row) => row.callId === scope.callId).toolState, "unknown");
  assert.equal(readFileRecoveries(session.id, "u").length, 0);
  const stream = await readRun(await request({ sessionId: session.id, message: "继续" }));
  await stream.rest();
  assert.notEqual(stream.runId, scope.runId);
  assert.match(captured[0][0].content, /上一轮运行已中断/);
  const assistantAt = captured[0].findIndex((message) => message.toolCalls?.some((call) => call.id === scope.callId));
  assert.ok(assistantAt > 0);
  assert.equal(captured[0][assistantAt + 1].toolCallId, scope.callId);
  assert.match(captured[0][assistantAt + 1].content, /目标状态已满足/);
  assert.equal(statSync(full).mtimeMs, before);
  assert.equal(store.getSession(session.id, "u").messages.filter((message) => message.role === "tool").length, 0);
  const trace = readSessionTrace(session.id, "u");
  const row = trace.rows.find((item) => item.callId === scope.callId);
  assert.equal(row.detail.verification, "matches-expected");
  assert.match(row.status, /目标状态已满足/);
  const work = inspectWork(session.id, "u");
  assert.equal(work.inputs.find((item) => item.inputId === scope.inputId).status, "interrupted");
  assert.equal(readFileRecoveries(session.id, "other").length, 0);
});

test("恢复区分仍是原版、外部更改和已有结果，并且重复核验不重复补记", async () => {
  const already = interruptedFile("logged", expected, { result: true });
  recordAgentLog(already.session.id, {
    runId: already.scope.runId, inputId: already.scope.inputId, kind: "turn-end", detail: { outcome: "interrupted" }
  });
  const before = interruptedFile("unchanged", original);
  const changed = interruptedFile("conflict", "timeout: 90\n");
  for (const item of [already, before, changed]) {
    for (let i = 0; i < 2; i++) await recoverInterruptedTurn(item.session, "u", data, signal);
    assert.equal(readFileSync(path.join(data, item.file), "utf8"), item === already ? expected : item === before ? original : "timeout: 90\n");
  }
  assert.equal(readAgentEvents("u", already.session.id).filter((e) => e.kind === "tool-result").length, 1);
  assert.equal(readFileRecoveries(already.session.id, "u").length, 0);
  assert.deepEqual(readFileRecoveries(before.session.id, "u").map((item) => item.verification), ["matches-before"]);
  assert.deepEqual(readFileRecoveries(changed.session.id, "u").map((item) => item.verification), ["changed"]);
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM agent_file_writes WHERE session_id=? AND checked_at IS NOT NULL").get(changed.session.id).n, 1);
});

test("普通对话中断后继续会带上已保存的半截回复", async () => {
  const { request } = routeFixture();
  const session = store.createSession("u");
  const input = { id: "partial-question", role: "user", content: "说一下方案", createdAt: 1 };
  store.beginTurn(session, input, undefined, "partial-run");
  store.addMessage(session, { id: "partial-answer", role: "assistant", content: "未说完的答复", createdAt: 2 });
  recordAgentLog(session.id, { runId: "partial-run", inputId: input.id, kind: "turn-end", detail: { outcome: "interrupted" } });
  let history;
  routeState.provider = { async *stream({ messages }) {
    history = messages;
    yield { type: "text", delta: "续答" };
    yield { type: "done" };
  } };
  await (await request({ sessionId: session.id, message: "继续" })).text();
  assert.match(history[0].content, /上一轮运行已中断/);
  assert.ok(history.some((message) => message.role === "assistant" && message.content === "未说完的答复"));
  const statuses = inspectWork(session.id, "u").inputs.map((item) => item.status);
  assert.deepEqual(statuses, ["interrupted", "completed"]);
});

test("续聊发现同一文件冲突时，内置写入工具要求先核对", async () => {
  const { request } = routeFixture();
  const { session, file } = interruptedFile("blocked-write", "timeout: 90\n");
  const tools = overrides["packages/tool-runtime/src/index.ts"];
  const originalFind = tools.findTool;
  try {
    tools.findTool = (name) => name === "write_file" ? writeFile : originalFind(name);
    routeState.provider = { async *stream({ messages }) {
      if (messages.some((message) => message.role === "tool" && message.toolCallId === "repeat-write")) {
        yield { type: "text", delta: "等待核对" };
      } else {
        yield { type: "tool_call", call: { id: "repeat-write", name: "write_file", arguments: JSON.stringify({ path: file, content: expected }) } };
      }
      yield { type: "done" };
    } };
    await (await request({ sessionId: session.id, message: "继续" })).text();
    const stored = store.getSession(session.id, "u");
    const tool = stored.messages.find((message) => message.toolCallId === "repeat-write");
    assert.match(tool.content, /恢复核验发现/);
    assert.equal(readFileSync(path.join(data, file), "utf8"), "timeout: 90\n");
  } finally {
    tools.findTool = originalFind;
  }
});
