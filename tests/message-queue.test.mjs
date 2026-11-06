import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

// 使用实际队列、存储和 Agent 循环。仅环境探测与工具目录使用受控夹具，模型只返回预设响应。
// 所有数据写入临时目录；不连接模型服务，不启动真实命令，也不访问用户数据库。
const root = path.resolve("src/lib");
const data = mkdtempSync(path.join(tmpdir(), "aai-queue-test-"));
process.env.A_DATA_DIR = data;
const require = createRequire(import.meta.url);
const cache = new Map();
const tool = { parallelSafe: true, spec: {name:"read_file",parameters:{type:"object",properties:{}}}, run: async () => ({content:"受控工具结果"}) };
const overrides = {
  "agent/tools/index.ts": { deferredCatalog:()=>"", toolsFor:()=>[tool.spec], findTool:n=>n==="read_file"?tool:undefined, toolSpecs:()=>[tool.spec] },
  "agent/env.ts": { envPrompt:async()=>"",turnEnv:async()=>"" },
  "agent/subagent.ts": {RESEARCH_SPEC:{name:"research"},runResearch:()=>{throw Error("unexpected research");}},
};
function load(name) {
  // Windows 的相对路径使用反斜杠，统一后才能命中受控工具与环境夹具。
  name = name.split(path.sep).join("/");
  if (overrides[name]) return overrides[name];
  if (cache.has(name)) return cache.get(name).exports;
  const module={exports:{}};cache.set(name,module);
  const source=readFileSync(path.join(root,name),"utf8");
  const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  const localRequire = id => {
    if (id==="server-only") return {};
    if (id === "@/lib/llm") return load("llm/index.ts");
    if (id.startsWith("@/lib/")) return load(id.slice(6)+".ts");
    if (id.startsWith(".")) return load(path.relative(root,path.resolve(root,path.dirname(name),id))+".ts");
    return require(id);
  };
  new Function("require","module","exports",js)(localRequire,module,module.exports);
  return module.exports;
}
const {db}=load("server/db.ts");
const store=load("server/store.ts");
const runtime = load("server/notes.ts");
const { runAgent } = load("agent/run.ts");

after(() => {
  db().close();
  delete globalThis.__aDb;
  rmSync(data, { recursive: true, force: true });
});

test("补充消息只由会话所有者写入，按序取走一次，运行结束后释放", () => {
  runtime.openRun("session-A", "u");
  try {
    assert.equal(runtime.addNote("session-A", "other", "越权"), false);
    assert.equal(runtime.addNote("session-A", "u", "第一条"), true);
    assert.equal(runtime.addNote("session-A", "u", "第二条"), true);
    assert.deepEqual(runtime.takeNotes("session-A"), ["第一条", "第二条"]);
    assert.deepEqual(runtime.takeNotes("session-A"), []);
  } finally {
    runtime.closeRun("session-A");
  }
  assert.equal(runtime.addNote("session-A", "u", "已结束"), false);
});

test("下一次模型请求包含原始任务、工具结果和运行中补充的消息", async () => {
  db().prepare("INSERT INTO users(id, username, password_hash, created_at) VALUES(?, ?, ?, ?)").run("u", "u", "x", 0);
  const session = store.createSession("u");
  store.addMessage(session, { id: "original", role: "user", content: "分析销售", createdAt: 1 });
  const requests = [];
  const note = "只统计已付款订单";
  const provider = {
    async *stream(request) {
      requests.push(structuredClone(request.messages));
      if (requests.length === 1) {
        assert.equal(runtime.addNote(session.id, "u", note), true);
        yield { type: "tool_call", call: { id: "read1", name: "read_file", arguments: "{}" } };
      } else {
        yield { type: "text", delta: "分析完成" };
      }
      yield { type: "done" };
    },
  };
  runtime.openRun(session.id, "u");
  try {
    for await (const _ of runAgent({
      session, provider, userId: "u", workspace: data, maxSteps: 5, maxFixRounds: 0,
      notes: () => runtime.takeNotes(session.id),
    })) { /* 消费完整的事件流，断言实际发出的请求。 */ }
  } finally {
    runtime.closeRun(session.id);
  }
  assert.equal(requests.length, 2);
  assert.equal(requests[0].some(m => m.content.includes(note)), false);
  const next = requests[1];
  assert.ok(next.some(m => m.role === "user" && m.content.includes("分析销售")));
  assert.ok(next.some(m => m.role === "tool" && m.content === "受控工具结果"));
  assert.equal(next.filter(m => m.role === "user" && m.content.includes(note)).length, 1);
});
