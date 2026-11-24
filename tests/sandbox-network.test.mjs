import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import clientPaths from "../apps/desktop/src/client-paths.cjs";
import { createRequire } from "node:module";
import childProcess from "node:child_process";
import ts from "typescript";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// 真实 SQLite、策略模块和路由；只替换登录身份和 Docker 进程，不访问实际用户库或 Docker。
const data = mkdtempSync(path.join(clientPaths.temporaryDirectory("tests"), "aai-network-test-"));
const savedEnv = { data: process.env.A_DATA_DIR, mode: process.env.A_SANDBOX, network: process.env.A_SANDBOX_NETWORK };
process.env.A_DATA_DIR = data;
process.env.A_SANDBOX = "docker";
process.env.A_SANDBOX_NETWORK = "0";
const require = createRequire(import.meta.url);
const root = path.resolve(".");
const cache = new Map();
const commands = [];
const children = [];
const execs = [];
let actor = { id: "owner" };
const overrides = {
  "packages/application/users/src/auth.ts": { currentUser: async () => actor, unauthorized: () => Response.json({}, { status: 401 }) },
  "node:child_process": { ...childProcess,
    execFile: (bin, args, opts, callback) => { commands.push(args); callback(null, "", ""); },
    spawn: (_bin, args) => {
      execs.push(args);
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      children.push(child);
      return child;
    },
  },
};
function load(name) {
  name = name.split(path.sep).join("/");
  if (overrides[name]) return overrides[name];
  if (cache.has(name)) return cache.get(name).exports;
  const module = { exports: {} }; cache.set(name, module);
  const js = ts.transpileModule(readFileSync(path.join(root, name), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  new Function("require", "module", "exports", js)((id) => {
    if (id === "server-only") return {};
    if (overrides[id]) return overrides[id];
    if (id.startsWith("@/")) return load(id.slice(2) + ".ts");
    if (id.startsWith(".")) return load(path.relative(root, path.resolve(root, path.dirname(name), id)) + ".ts");
    return require(id);
  }, module, module.exports);
  return module.exports;
}
const { db } = load("packages/storage/src/db.ts");
const policy = load("packages/sandbox/src/sandbox-network.ts");
db().exec("INSERT INTO users VALUES('owner','owner','x',1); INSERT INTO users VALUES('other','other','x',2)");
after(() => {
  db().close(); delete globalThis.__aDb;
  for (const [key, value] of [["A_DATA_DIR", savedEnv.data], ["A_SANDBOX", savedEnv.mode], ["A_SANDBOX_NETWORK", savedEnv.network]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(data, { recursive: true, force: true });
});

test("默认沿用部署配置；全局修改需管理账号，关闭也持久保存，重开数据库不丢失", () => {
  assert.deepEqual(policy.networkPolicy(), { enabled: false, revision: 0 });
  process.env.A_SANDBOX_NETWORK = "1";
  assert.equal(policy.networkPolicy().enabled, true);
  assert.throws(() => policy.saveNetworkPolicy("other", false));
  policy.saveNetworkPolicy("owner", false);
  assert.equal(policy.networkPolicy().enabled, false);
  db().close(); delete globalThis.__aDb;
  assert.deepEqual(policy.networkPolicy(), { enabled: false, revision: 1 });
});

test("路由拒绝未登录、普通账号及错误参数；保存后查询返回新状态", async () => {
  const route = load("apps/server/src/routes/api/sandbox/route.ts");
  const request = (network) => new Request("http://test/api/sandbox", { method: "PUT", body: JSON.stringify({ network }) });
  actor = null; assert.equal((await route.PUT(request(true))).status, 401);
  actor = { id: "other" }; assert.equal((await route.PUT(request(true))).status, 403);
  actor = { id: "owner" }; assert.equal((await route.PUT(request("true"))).status, 400);
  assert.equal((await route.PUT(request(true))).status, 200);
  const response = await (await route.GET()).json();
  assert.equal(response.info.network, true);
  assert.equal(response.canManageNetwork, true);
});

test("同会话按策略版本创建 bridge/none 容器，重复执行复用，不强制终止旧容器", async () => {
  const sandbox = load("packages/sandbox/src/sandbox.ts");
  const opts = { sessionId: "session", workspace: data, cwd: "/workspace", script: "true", env: {} };
  await sandbox.sandboxExec(opts);
  await sandbox.sandboxExec(opts);
  policy.saveNetworkPolicy("owner", false);
  assert.equal(sandbox.sandboxInfo().network, false);
  await sandbox.sandboxExec(opts);
  policy.saveNetworkPolicy("owner", true);
  await sandbox.sandboxExec(opts);
  const starts = commands.filter((args) => args[0] === "run" && args.includes("-d"));
  assert.deepEqual(starts.map((args) => args[args.indexOf("--network") + 1]), ["bridge", "none", "bridge"]);
  const names = starts.map((args) => args[args.indexOf("--name") + 1]);
  assert.equal(new Set(names).size, 3);
  // 创建前只清理目标新容器，没有因切换设置而删除上一个容器。
  for (const name of names) assert.equal(commands.filter((args) => args[0] === "rm" && args.includes(name)).length, 1);
});

test("Docker 执行并发达上限时拒绝分配，命令退出后可以继续执行", async () => {
  const saved = process.env.A_SANDBOX_MAX_CONCURRENT;
  process.env.A_SANDBOX_MAX_CONCURRENT = "1";
  try {
    const { runInSandbox } = load("packages/sandbox/src/sandbox.ts");
    const opts = { sessionId: "quota", workspace: data, cwd: "/workspace", script: "true", env: {}, timeoutMs: 5000, onData() {} };
    const first = runInSandbox(opts);
    await assert.rejects(runInSandbox({ ...opts, sessionId: "other-quota" }), /并发上限/);
    await new Promise(setImmediate);
    children.at(-1).emit("close", 0, null);
    assert.equal((await first).code, 0);
    const second = runInSandbox(opts);
    await new Promise(setImmediate);
    children.at(-1).emit("close", 0, null);
    assert.equal((await second).code, 0);
  } finally {
    if (saved === undefined) delete process.env.A_SANDBOX_MAX_CONCURRENT;
    else process.env.A_SANDBOX_MAX_CONCURRENT = saved;
  }
});

test("聊天与应用按账号工作区复用容器，应用数据只通过标准输入", async () => {
  const { sandboxExec, runInSandbox } = load("packages/sandbox/src/sandbox.ts");
  const start = commands.length;
  const workspace = path.join(data, "account-one");
  const opts = { sessionId: "chat-one", workspace, cwd: "/workspace", script: "true", env: {} };
  await sandboxExec(opts);
  await sandboxExec({ ...opts, sessionId: "chat-two" });
  await sandboxExec({ ...opts, workspace: path.join(data, "account-two") });
  const input = JSON.stringify({ data: "私有测试记录" });
  const app = runInSandbox({ ...opts, sessionId: "workspace-app", input, timeoutMs: 5000, onData() {} });
  await new Promise(setImmediate);
  let received = "";
  for await (const chunk of children.at(-1).stdin) received += chunk.toString();
  children.at(-1).emit("close", 0, null);
  assert.equal((await app).code, 0);
  assert.equal(received, input);
  assert.ok(execs.at(-1).includes("-i"));
  assert.ok(!execs.at(-1).join(" ").includes("私有测试记录"));
  const created = commands.slice(start).filter((args) => args[0] === "run" && args.includes("-d"));
  assert.equal(created.length, 2);
  assert.notEqual(created[0][created[0].indexOf("--name") + 1], created[1][created[1].indexOf("--name") + 1]);
});
