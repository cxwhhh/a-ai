import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import childProcess from "node:child_process";
import ts from "typescript";

// 真实 SQLite、策略模块和路由；只替换登录身份和 Docker 进程，不访问实际用户库或 Docker。
const data = mkdtempSync(path.join(tmpdir(), "aai-network-test-"));
const savedEnv = { data: process.env.A_DATA_DIR, mode: process.env.A_SANDBOX, network: process.env.A_SANDBOX_NETWORK };
process.env.A_DATA_DIR = data;
process.env.A_SANDBOX = "docker";
process.env.A_SANDBOX_NETWORK = "0";
const require = createRequire(import.meta.url);
const root = path.resolve("src");
const cache = new Map();
const commands = [];
let actor = { id: "owner" };
const overrides = {
  "lib/server/auth.ts": { currentUser: async () => actor, unauthorized: () => Response.json({}, { status: 401 }) },
  "node:child_process": { ...childProcess,
    execFile: (bin, args, opts, callback) => { commands.push(args); callback(null, "", ""); },
    spawn: () => ({}),
  },
};
function load(name) {
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
const { db } = load("lib/server/db.ts");
const policy = load("lib/server/sandbox-network.ts");
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
  const route = load("app/api/sandbox/route.ts");
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
  const sandbox = load("lib/server/sandbox.ts");
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
