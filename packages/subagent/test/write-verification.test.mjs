import assert from "node:assert/strict";
import { rm, writeFile as saveFixture } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { load, store } from "../../../tests/fixtures/agent-runtime.mjs";

const { openSessionWorkspace } = load("packages/workspace/src/session-workspace.ts");
const { hashFileBytes } = load("packages/workspace/src/file-fingerprint.ts");
const { verifyTaskWrites, canSafelyRecoverWrites } = load("packages/subagent/src/write-verification.ts");

function makeTask(overrides = {}) {
  return {
    id: "task-1",
    sessionId: "s-1",
    runId: "r-1",
    inputId: "i-1",
    role: "implementation",
    status: "interrupted",
    chatActive: true,
    contract: { task: "测试写入核验", role: "implementation" },
    limits: { steps: 24, tokens: 128_000, timeoutMs: 600_000, idleTimeoutMs: 30_000, toolCalls: 36 },
    progress: { steps: 1, toolCalls: 1, inputTokens: 0, outputTokens: 0, estimated: false, blockers: [] },
    evidence: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

test("verifyTaskWrites 准确区分 matches-expected、matches-before、changed 与 unreadable", async () => {
  const session = store.createSession("u");
  const { workspace } = openSessionWorkspace("u", session.id);

  const expectedA = Buffer.from("文件 A 预期内容\n");
  const beforeB = Buffer.from("文件 B 写入前内容\n");
  const expectedB = Buffer.from("文件 B 预期新内容\n");
  const externalC = Buffer.from("文件 C 已被用户手动改动\n");

  await saveFixture(path.join(workspace, "a.txt"), expectedA);
  await saveFixture(path.join(workspace, "b.txt"), beforeB);
  await saveFixture(path.join(workspace, "c.txt"), externalC);
  await rm(path.join(workspace, "not-created.txt"), { force: true });

  const writes = [
    // 新建文件已落盘 -> matches-expected
    { path: "a.txt", beforeHash: null, expectedHash: hashFileBytes(expectedA) },
    // 已有文件停留在写入前 -> matches-before
    { path: "b.txt", beforeHash: hashFileBytes(beforeB), expectedHash: hashFileBytes(expectedB) },
    // 新建文件尚未落盘（磁盘不存在，readFileHash 返回 null）-> matches-before
    { path: "not-created.txt", beforeHash: null, expectedHash: hashFileBytes(Buffer.from("尚未写出")) },
    // 磁盘字节既不等于写入前也不等于预期 -> changed
    { path: "c.txt", beforeHash: hashFileBytes(Buffer.from("旧内容")), expectedHash: hashFileBytes(Buffer.from("预期内容")) },
    // 越界路径 -> unreadable
    { path: "../outside.txt", beforeHash: null, expectedHash: "deadbeef" },
  ];

  const results = await verifyTaskWrites(workspace, makeTask({ status: "interrupted" }), writes);
  assert.deepEqual(results, [
    { path: "a.txt", status: "matches-expected" },
    { path: "b.txt", status: "matches-before" },
    { path: "not-created.txt", status: "matches-before" },
    { path: "c.txt", status: "changed" },
    { path: "../outside.txt", status: "unreadable" },
  ]);
});

test("verifyTaskWrites 对非中断终态返回空列表，并兼容单文件微调与旧记录回退状态", async () => {
  const session = store.createSession("u");
  const { workspace } = openSessionWorkspace("u", session.id);
  const sampleWrite = [{ path: "a.txt", beforeHash: null, expectedHash: "abc" }];

  // 已完成或运行中任务不做中断核验
  assert.deepEqual(await verifyTaskWrites(workspace, makeTask({ status: "completed" }), sampleWrite), []);
  assert.deepEqual(await verifyTaskWrites(workspace, makeTask({ status: "running" }), sampleWrite), []);

  // 单文件微调尚未产生写入检查点 -> not-started
  const revisionNoCheckpoint = makeTask({
    status: "interrupted",
    assignment: { mode: "revision", revisionPath: "draft.md" },
  });
  assert.deepEqual(await verifyTaskWrites(workspace, revisionNoCheckpoint, []), [
    { path: "draft.md", status: "not-started" },
  ]);

  // 旧记录无 mode，但消息里调用过 edit_file 且带有 revisionPath -> unknown
  const legacyEdit = makeTask({
    status: "cancelled",
    assignment: { revisionPath: "legacy.md" },
    messages: [{ id: "m1", role: "assistant", content: "", toolCalls: [{ id: "c1", name: "edit_file", arguments: "{}" }], createdAt: 1 }],
  });
  assert.deepEqual(await verifyTaskWrites(workspace, legacyEdit, []), [
    { path: "legacy.md", status: "unknown" },
  ]);

  // 普通执行分支无写入检查点 -> 空数组
  assert.deepEqual(await verifyTaskWrites(workspace, makeTask({ status: "failed" }), []), []);
});

test("canSafelyRecoverWrites 仅当全部写入为确定安全状态时返回 true", () => {
  assert.equal(canSafelyRecoverWrites([]), false);
  assert.equal(canSafelyRecoverWrites([{ path: "a.txt", status: "matches-expected" }]), true);
  assert.equal(canSafelyRecoverWrites([
    { path: "a.txt", status: "matches-expected" },
    { path: "b.txt", status: "matches-before" },
  ]), true);

  for (const unsafe of ["changed", "unreadable", "not-started", "unknown"]) {
    assert.equal(
      canSafelyRecoverWrites([
        { path: "a.txt", status: "matches-expected" },
        { path: "b.txt", status: unsafe },
      ]),
      false,
      `包含 ${unsafe} 时不能判定为安全恢复`,
    );
  }
});
