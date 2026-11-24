import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { data, db, load, runAgent, store } from "../../../tests/fixtures/agent-runtime.mjs";

const { searchHistory, readHistoryExecution } = load("packages/storage/src/history.ts");
const { migrateHistoryIndex } = load("packages/storage/src/history-index.ts");
const { searchSavedHistory, readSavedHistoryExecution } = load("packages/tools/src/history.ts");
const { readToolResult } = load("packages/storage/src/tool-results.ts");

const append = (s, role, content, more = {}) => {
  const m = { id: store.newId("m"), role, content, createdAt: 1, ...more };
  store.addMessage(s, m);
  return m;
};
const call = (id, path) => ({ id, name: "read_file", arguments: JSON.stringify({ path, purpose: "定位登记表" }) });

test("历史索引回填所有会话的有效轮次，保留原文并跳过已替代分支和摘要", () => {
  const legacy = new DatabaseSync(":memory:");
  try {
    legacy.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY); CREATE TABLE messages(id TEXT PRIMARY KEY,session_id,seq,role,data,superseded_by)");
    const insert = legacy.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?)");
    for (const id of ["one", "two"]) {
      legacy.prepare("INSERT INTO sessions VALUES (?)").run(id);
      const save = (suffix, seq, role, more, superseded = null) => {
        const message = { id: id + suffix, role, content: "大阪清单", ...more };
        insert.run(message.id, id, seq, role, JSON.stringify(message), superseded);
      };
      save("-old", 0, "user", {}, "revision");
      save("-real", 1, "user", {});
      save("-assistant", 2, "assistant", { toolCalls: [call("c", "register.csv")] });
      save("-tool", 3, "tool", { toolCallId: "c", content: "长结果".repeat(5000) });
      save("-digest", 4, "user", { feedback: { kind: "compact" } });
    }
    migrateHistoryIndex(legacy);
    migrateHistoryIndex(legacy);
    assert.deepEqual(legacy.prepare("SELECT input_id,tool_calls,end_seq FROM history_segments ORDER BY input_id").all()
      .map((row) => [row.input_id, row.tool_calls, row.end_seq]), [["one-real", 1, 3], ["two-real", 1, 3]]);
    assert.equal(legacy.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 10);
    assert.equal(legacy.prepare("SELECT COUNT(*) AS n FROM history_segment_terms WHERE term='大阪'").get().n, 2);
  } finally {
    legacy.close();
  }
});

test("调用清单独立分页并按 assistant 分组，识别乱序结果、重复调用 ID 和旧状态", () => {
  const s = store.createSession("u");
  const other = store.createSession("u");
  const input = append(s, "user", "东京盘点：检查 REGISTER_V2 和 inventory.csv");
  append(s, "assistant", "", { toolCalls: [call("same", "inventory.csv"), call("parallel", "parallel.txt")] });
  const parallel = append(s, "tool", "读取结束", { toolCallId: "parallel", status: "ok" });
  const prior = append(s, "tool", "旧工具结果", { toolCallId: "same", status: "ok" });
  append(s, "assistant", "", { toolCalls: [call("same", "revised.csv"), call("missing", "missing.csv")] });
  const revised = append(s, "tool", JSON.stringify({ stdout: "x".repeat(1500), exitCode: 1 }), { toolCallId: "same" });
  const hit = searchHistory("u", s.id, "东京 REGISTER_V2 inventory.csv", 2)[0];
  assert.equal(hit.segmentId, input.id);
  assert.ok(hit.entities.includes("inventory.csv"));
  assert.equal(hit.toolCalls, 4);
  const first = readHistoryExecution("u", s.id, input.id, 0, 2);
  const second = readHistoryExecution("u", s.id, input.id, first.nextOffset, 2);
  assert.deepEqual(first.calls.map(({ resultId }) => resultId), [prior.id, parallel.id]);
  assert.ok(first.calls[0].resultSeq > first.calls[1].resultSeq);
  assert.deepEqual(second.calls.map(({ status, resultId }) => [status, resultId]), [["error", revised.id], ["unknown", null]]);
  assert.equal(second.nextOffset, null);
  assert.equal(readHistoryExecution("u", other.id, input.id, 0, 2), null);
  assert.equal(readHistoryExecution("another", s.id, input.id, 0, 2), null);
  assert.deepEqual(searchHistory("u", other.id, "东京", 2), []);
  assert.deepEqual(searchHistory("another", s.id, "东京", 2), []);
  assert.equal(store.truncateFrom(s, input.id), true);
  assert.equal(readHistoryExecution("u", s.id, input.id, 0, 2), null);
  assert.deepEqual(searchHistory("u", s.id, "东京", 2), []);
  assert.equal(readToolResult("u", s.id, prior.id, 0, 30), null);
  assert.ok(db().prepare("SELECT id FROM messages WHERE id=?").get(prior.id));
});

test("自动召回只发送被摘要覆盖的相关卡片，手动检索排除当前轮", async () => {
  const s = store.createSession("u");
  const old = append(s, "user", "东京库存 ledger.csv\n原始背景 " + "待压缩正文".repeat(100));
  append(s, "assistant", "", { toolCalls: [call("old", "ledger.csv")] });
  append(s, "tool", "原始证据 ONLY_IN_TOOL", { toolCallId: "old", status: "ok" });
  const keep = append(s, "user", "东京近期问题 ledger.csv");
  append(s, "user", "已保存的结构化摘要", { feedback: { kind: "compact", summary: "整理完成" },
    compact: { keepFrom: keep.id, messages: 3, tokensBefore: 5000, tokensAfter: 1000 } });
  const current = append(s, "user", "请回查东京库存 ledger.csv");
  const known = [searchSavedHistory, readSavedHistoryExecution];
  const scopes = { userId: "u", sessionId: s.id, inputId: current.id };
  const matches = JSON.parse((await searchSavedHistory.run({ query: "ledger.csv" }, scopes)).content).matches;
  assert.deepEqual(new Set(matches.map((row) => row.segmentId)), new Set([old.id, keep.id]));
  let count = 0;
  const provider = { id: "test", async *stream({ messages }) {
    const user = messages.find((m) => m.content.startsWith(current.content));
    assert.ok(user.content.includes(old.id));
    assert.ok(!user.content.includes(keep.id));
    assert.ok(!messages.some((m) => /ONLY_IN_TOOL|待压缩正文/.test(m.content)));
    count++;
    yield { type: "text", delta: "已找到历史索引" };
    yield { type: "done" };
  } };
  const specs = () => known.map((t) => t.spec);
  for await (const event of runAgent({ session: s, provider, userId: "u", workspace: data, multiAgent: false, maxSteps: 3,
    tools: { toolsFor: specs, toolSpecs: specs, deferredCatalog: () => "", findTool: (name) => known.find((t) => t.spec.name === name) } })) {
    assert.notEqual(event.type, "error", event.message);
  }
  assert.equal(count, 1);
  assert.equal(store.getSession(s.id, "u").messages.find((m) => m.id === current.id).content, current.content);
});
