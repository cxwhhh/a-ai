import { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTestDirectory } from "../../packages/storage-manager/src/index.ts";
import path from "node:path";
import clientPaths from "../../apps/desktop/src/client-paths.cjs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import ts from "typescript";

// 使用实际队列、存储和 Agent 循环。仅环境探测与工具目录使用受控夹具，模型只返回预设响应。
// 所有数据写入临时目录；不连接模型服务，不启动真实命令，也不访问用户数据库。
const root = fileURLToPath(new URL("../../", import.meta.url));
const data = createTestDirectory(clientPaths.temporaryDirectory("tests"), "aai-queue");
process.env.A_DATA_DIR = data;
const require = createRequire(import.meta.url);
const cache = new Map();
const tool = { parallelSafe: true, spec: {name:"read_file",parameters:{type:"object",properties:{}}}, run: async () => ({content:"受控工具结果"}) };
const askTool = () => load("packages/tools/src/ask-user.ts").askUser;
const overrides = {
  "packages/tool-runtime/src/index.ts": { deferredCatalog:()=>"", toolsFor:()=>[tool.spec, askTool().spec], findTool:n=>n==="read_file"?tool:n==="ask_user"?askTool():undefined, toolSpecs:()=>[tool.spec, askTool().spec] },
  "packages/agent-loop/src/env.ts": { envPrompt:async()=>"",turnEnv:async()=>"" },
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
    if (id === "@A-ai/cordis") return load("vendor/cordis/src/index.ts");
    if (id === "@a-ai/cosmokit") return load("vendor/cosmokit/src/index.ts");

    if (id.startsWith("@/lib/")) return load(id.slice(6)+".ts");
    if (id.startsWith(".")) {
      const file = path.relative(root, path.resolve(root, path.dirname(name), id));
      return load(id.endsWith(".ts") ? file : file + ".ts");
    }
    return require(id);
  };
  new Function("require","module","exports",js)(localRequire,module,module.exports);
  return module.exports;
}
const {db}=load("packages/storage/src/db.ts");
const store=load("packages/storage/src/store.ts");
const { AgentRegistry } = load("packages/agent-registry/src/index.ts");
const { createAgentInstance } = load("packages/agent-core/agent/src/factory.ts");
const { createQueueClock } = load("packages/agent-core/inbox/src/clock.ts");
const { emptyQueueSnapshot } = load("packages/agent-core/inbox/src/index.ts");
const { inspectAgentWork } = load("packages/session-projection/src/inspect.ts");
const { Context } = load("vendor/cordis/src/index.ts");
const { builtinAgentPlugins } = load("packages/runtime/src/agent-plugins.ts");
const { agentSessions } = load("packages/session/src/agent-session.ts");
const { openChatAgent: openSession } = load("packages/application/chat/src/agent-session.ts");
const openChatAgent = (...args) => openSession(agentSessions, ...args);
function createRegistry(clock = createQueueClock(), catalog = builtinAgentPlugins) {
  const ctx = new Context();
  ctx.provide("queueClock", clock);
  ctx.provide("agentPlugins", catalog);
  ctx.provide("agentSessions", agentSessions);
  ctx.provide("models", (settings) => {
    routeState.selectedProvider = { model: settings.currentModel, effort: settings.reasoningEffort };
    return routeState.provider;
  });
  ctx.provide("hostTools", overrides["packages/tool-runtime/src/index.ts"]);
  return new AgentRegistry((sessionId, userId, plugins) => createAgentInstance(ctx, ctx, sessionId, userId, plugins));
}
const queueClock = createQueueClock();
const agents = createRegistry(queueClock);
const defaultRuntime = {
  agents,
  agentSessions,
  queueClock
};
function inspectWork(sessionId, userId, registry = agents) {
  const agent = registry.get(sessionId, userId);
  return inspectAgentWork(sessionId, userId, agent);
}
const queueSnapshot = (sessionId, userId) =>
  agents.get(sessionId, userId)?.queueSnapshot() ?? emptyQueueSnapshot(sessionId, queueClock);
const { runAgent } = load("packages/agent-loop/src/run.ts");
const signal = new AbortController().signal;

before(() => {
  db().prepare("INSERT INTO users(id, username, password_hash, created_at) VALUES(?, ?, ?, ?)").run("u", "u", "x", 0);
});

after(() => {
  db().close();
  delete globalThis.__aDb;
});

const routeState = {
  provider: { async *stream() {
    yield { type: "text", delta: "新回答" };
    yield { type: "done" };
  } },
  caller: "u",
  selectedProvider: undefined,
};
const fixtureSettings = { ...load("packages/protocol/src/lib/settings.ts").DEFAULT_SETTINGS, skills: false, memory: false, maxSteps: 3, maxFixRounds: 0 };
function routeFixture(runtime = defaultRuntime) {
  // 路由、Agent、存储和事务使用实际源码；仅登录、设置、环境和模型使用受控值。
  Object.assign(overrides, {
    "packages/llm/src/index.ts": { getProvider: (settings) => { routeState.selectedProvider = { model: settings.currentModel, effort: settings.reasoningEffort }; return routeState.provider; } },
    "packages/application/users/src/auth.ts": { currentUser: async () => routeState.caller ? { id: routeState.caller } : null, unauthorized: () => new Response(null, { status: 401 }), notFound: () => new Response(null, { status: 404 }) },
    "packages/application/settings/src/settings.ts": { getSettings: () => fixtureSettings },
    "packages/tools/src/files.ts": { workspaceOf: () => data },
    "packages/memory/src/reflect.ts": { reflect: async () => {} },
    "packages/memory/src/memory.ts": { getMemory: () => ({}), memoryPrompt: () => "" },
    "packages/skills/src/skills.ts": { activeSkills: () => [], skillsPrompt: () => "" },
    "packages/skills/src/learn.ts": { learnSkills: async () => {} },
    "packages/sandbox/src/sandbox.ts": { sandboxPrompt: () => "", unavailableTools: async () => ({}) },
  });
  return {
    request: (body, signal) => load("apps/server/src/routes/api/chat/route.ts").POST(jsonRequest("chat", body, signal), { runtime }),
    queue: (body) => load("apps/server/src/routes/api/chat/queue/route.ts").POST(jsonRequest("chat/queue", body), { runtime }),
    getQueue(sessionId) {
      const query = new URLSearchParams({ sessionId });
      const route = load("apps/server/src/routes/api/chat/queue/route.ts");
      return route.GET(new Request(`http://localhost/api/chat/queue?${query}`), { runtime });
    },
    patch: (resource, id, body) => load(`apps/server/src/routes/api/${resource}/[id]/route.ts`).PATCH(jsonRequest(resource, body, undefined, "PATCH"), { params: Promise.resolve({ id }), runtime }),
    logs: (query) => load("apps/server/src/routes/api/chat/log/route.ts").GET(new Request(`http://localhost/api/chat/log?${new URLSearchParams(query)}`)),
    inspect: (id) => load("apps/server/src/routes/api/sessions/[id]/agent/route.ts").GET(new Request(`http://localhost/api/sessions/${id}/agent`), { params: Promise.resolve({ id }), runtime }),
  };
}

function jsonRequest(route, body, signal, method = "POST") {
  return new Request(`http://localhost/api/${route}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
}

/** 第一帧含运行 ID，读取它后保留 reader，用同一条真实流继续观察。 */
async function readRun(response) {
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  const head = JSON.parse(decoder.decode(first.value, { stream: true }).trim().slice(6));
  assert.equal(head.type, "session");
  assert.deepEqual(head.scope, { sessionId: head.session.id, runId: head.runId });
  return {
    sessionId: head.session.id,
    runId: head.runId,
    async rest() {
      let body = "";
      for (let chunk; !(chunk = await reader.read()).done;) body += decoder.decode(chunk.value, { stream: true });
      return body.trim().split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.slice(6)));
    },
  };
}

export { load, db, store, data, agents, AgentRegistry, createRegistry, openChatAgent, inspectWork, queueSnapshot, runAgent, signal, tool, overrides,
  routeState, fixtureSettings, routeFixture, readRun, jsonRequest };
