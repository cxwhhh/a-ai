import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as storage from "../packages/storage-manager/src/index.ts";
import path from "node:path";
import clientPaths from "../apps/desktop/src/client-paths.cjs";
import { createRequire } from "node:module";
import childProcess from "node:child_process";
import ts from "typescript";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";

// 真实 SQLite、策略模块和路由；只替换登录身份和 Docker 进程，不访问实际用户库或 Docker。
const data = storage.createTestDirectory(clientPaths.temporaryDirectory("tests"), "aai-network");
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
const spawns = new EventEmitter();
let actor = { id: "owner" };
const overrides = {
  "packages/storage-manager/src/index.ts": storage,
  "packages/application/users/src/auth.ts": { currentUser: async () => actor, unauthorized: () => Response.json({}, { status: 401 }) },
  "node:child_process": { ...childProcess,
    execFile: (bin, args, opts, callback) => {
      commands.push(args);
      if (args[0] === "cp") writeFileSync(args.at(-1), "已交付");
      callback(null, "", "");
    },
    spawn: (_bin, args) => {
      execs.push(args);
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      children.push(child);
      spawns.emit("spawn");
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

test("同账号的两段对话使用各自挂载，容器不会挂载主服务的应用库", async () => {
  const { sandboxExec } = load("packages/sandbox/src/sandbox.ts");
  const start = commands.length;
  const account = path.join(data, "users", "account-one");
  const workspace = path.join(account, "session-workspaces", "chat-one");
  const otherWorkspace = path.join(account, "session-workspaces", "chat-two");
  const opts = { sessionId: "chat-one", workspace, cwd: "/workspace", script: "true", env: {} };
  await sandboxExec(opts);
  await sandboxExec(opts);
  await sandboxExec({ ...opts, sessionId: "chat-two", workspace: otherWorkspace });
  const created = commands.slice(start).filter((args) => args[0] === "run" && args.includes("-d"));
  assert.equal(created.length, 2);
  assert.equal(new Set(created.map((args) => args[args.indexOf("--name") + 1])).size, 2);
  for (const [args, dir] of created.map((args, index) => [args, [workspace, otherWorkspace][index]])) {
    assert.equal(args[args.indexOf("--mount") + 1], `type=bind,src=${dir},dst=/workspace`);
    assert.ok(!args.some((arg) => arg.includes("workspace-apps")));
  }
});

test("Docker 临时验证与账号工作区分开，Python 源码通过标准输入，调用结束后分别回收", async () => {
  const { runPython } = load("packages/tools/src/run-python.ts");
  const { runCommand } = load("packages/tools/src/run-command.ts");
  const workspace = path.join(data, "temporary-tools");
  const context = { sessionId: "temporary-tools", userId: "owner", workspace };
  const start = commands.length;
  const code = "print('temporary source')";

  const pythonSpawned = once(spawns, "spawn");
  const python = runPython.run({ code, temporary: true }, context);
  await Promise.race([pythonSpawned, python.then(() => assert.fail("Python 应启动 Docker 子进程"))]);
  const pythonArgs = execs.at(-1);
  assert.ok(pythonArgs.at(-1).includes('exec python3 "$TMPDIR/run.py"'));
  const pythonChild = children.at(-1);
  let received = "";
  for await (const chunk of pythonChild.stdin) received += chunk.toString();
  assert.equal(received, code);
  assert.ok(!pythonArgs.join(" ").includes(code));
  assert.equal(existsSync(path.join(workspace, ".runs")), false);
  pythonChild.emit("close", 0, null);
  assert.equal(JSON.parse((await python).content).exitCode, 0);

  const terminalSpawned = once(spawns, "spawn");
  const terminal = runCommand.run({ command: "pwd", temporary: true }, context);
  await Promise.race([terminalSpawned, terminal.then(() => assert.fail("终端应启动 Docker 子进程"))]);
  const terminalScript = execs.at(-1).at(-1);
  const temporaryPath = /export TMPDIR=(\S+)/.exec(terminalScript)?.[1];
  assert.ok(temporaryPath?.startsWith("/tmp/aai-run-"));
  assert.match(terminalScript, /cd -- \/tmp\/aai-run-/);
  assert.ok(execs.at(-1).includes("XDG_CACHE_HOME=/tmp/aai-cache"));
  assert.ok(execs.at(-1).includes("HOME=/workspace"));
  children.at(-1).emit("close", 3, null);
  const result = JSON.parse((await terminal).content);
  assert.equal(result.exitCode, 3);
  assert.match(result.cwd, /临时目录/);

  const cleanup = commands.slice(start).filter((args) => args.at(-1)?.includes("rm -rf -- /tmp/aai-run-"));
  assert.equal(cleanup.length, 2);
  assert.ok(cleanup[1].at(-1).includes(temporaryPath));
  assert.ok(!cleanup[0].at(-1).includes(temporaryPath));
  assert.ok(commands.slice(start).some((args) => args.includes("/tmp:rw,exec,size=512m")));
});

test("Docker 取消先通知进程组，收尾只回收对应调用的临时文件", async () => {
  const { runInSandbox } = load("packages/sandbox/src/sandbox.ts");
  const abort = new AbortController();
  const start = commands.length;
  const run = runInSandbox({ sessionId: "cancel", workspace: data, cwd: "/workspace", script: "true", env: {},
    temporary: true, timeoutMs: 5000, signal: abort.signal, onData() {} });
  await new Promise(setImmediate);
  const temporaryPath = /export TMPDIR=(\S+)/.exec(execs.at(-1).at(-1))?.[1];
  assert.ok(temporaryPath);
  abort.abort();
  children.at(-1).emit("close", 130, null);
  assert.equal((await run).code, 130);
  const actions = commands.slice(start).map((args) => args.at(-1)).filter((script) => script?.includes(temporaryPath));
  assert.equal(actions.length, 2);
  assert.match(actions[0], /\.cancelled[\s\S]*kill -KILL/);
  assert.match(actions[1], /kill -KILL[\s\S]*rm -rf/);
  assert.ok(!actions[1].includes("/workspace"));
});

test("同轮临时命令复用只读工作区容器，配额来自服务，正式产出经服务交付", async () => {
  const { runCommand } = load("packages/tools/src/run-command.ts");
  const workspace = path.join(data, "scoped-account");
  mkdirSync(workspace);
  const manager = new storage.StorageManager(path.join(data, "scoped-manager"));
  manager.setRunLimit(128);
  const context = { sessionId: "scoped", userId: "owner", workspace };
  const start = commands.length;
  let files;
  await manager.withRun("owner", async () => {
    for (const args of [{ command: "pwd", temporary: false }, { command: "pwd", outputs: ["ok.txt"] }]) {
      const spawned = once(spawns, "spawn");
      const running = runCommand.run(args, context);
      await Promise.race([spawned, running.then(() => assert.fail("必须通过 Docker 执行"))]);
      assert.match(execs.at(-1).at(-1), /cd -- \/tmp\/aai-scratch/);
      children.at(-1).emit("close", 0, null);
      files = JSON.parse((await running).content).outputs;
    }
  });
  const creates = commands.slice(start).filter((args) => args[0] === "run");
  assert.equal(creates.length, 1);
  assert.ok(creates[0].some((value) => value.includes("dst=/workspace,readonly")));
  assert.ok(creates[0].includes("/tmp:rw,exec,mode=1777,size=128m"));
  assert.match(files[0], /^output\/.+\/ok\.txt$/);
  assert.equal(readFileSync(path.join(workspace, files[0]), "utf8"), "已交付");
  const name = creates[0][creates[0].indexOf("--name") + 1];
  assert.ok(commands.slice(start).at(-1).includes(name));
  assert.equal(commands.slice(start).at(-1)[0], "rm");
});
