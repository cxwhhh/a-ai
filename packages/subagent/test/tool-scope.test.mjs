import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { access, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { data, load, overrides } from "../../../tests/fixtures/agent-runtime.mjs";

const { archive } = load("packages/tools/src/archive.ts");
const { downloadFile, fileOp } = load("packages/tools/src/file-ops.ts");
const { httpRequest } = load("packages/tools/src/http-request.ts");
const { queryData } = load("packages/tools/src/query-data.ts");
const { capabilityScope } = load("packages/subagent/src/capability-scope.ts");
const { ROLES } = load("packages/subagent/src/role-budget.ts");
const tools = [archive, downloadFile, fileOp, httpRequest, queryData];

test("请求和下载检查首个网址与重定向，拒绝后不请求目标或写文件", async (t) => {
  const workspace = await mkdtemp(path.join(data, "network-scope-"));
  const lookedUp = [];
  const requested = [];
  t.mock.method(dns, "lookup", async (host) => {
    lookedUp.push(host);
    return [{ address: "93.184.215.14", family: 4 }];
  });
  t.mock.method(globalThis, "fetch", async (url) => {
    requested.push(url.href);
    if (url.pathname === "/redirect") return Response.redirect("https://other.example/file");
    return new Response("sample", { headers: { "content-type": "text/plain" } });
  });
  const ctx = { workspace, checkWebUrl(url) {
    if (url.hostname !== "allowed.example") throw new Error("不在主机范围");
  } };
  for (const tool of [httpRequest, downloadFile]) {
    await assert.rejects(tool.run({ url: "https://other.example/file", path: "denied.txt" }, ctx), /不在主机范围/);
    await assert.rejects(tool.run({ url: "https://allowed.example/redirect", path: "denied.txt" }, ctx), /不在主机范围/);
  }
  assert.deepEqual(lookedUp, ["allowed.example", "allowed.example"]);
  assert.deepEqual(requested, ["https://allowed.example/redirect", "https://allowed.example/redirect"]);
  await assert.rejects(access(path.join(workspace, "denied.txt")), { code: "ENOENT" });

  const url = "https://allowed.example/file";
  assert.equal(JSON.parse((await httpRequest.run({ url }, ctx)).content).body, "sample");
  await downloadFile.run({ url, path: "allowed.txt" }, ctx);
  assert.equal(await readFile(path.join(workspace, "allowed.txt"), "utf8"), "sample");
});

test("文件工具对每个读取入口应用路径权限，正常查询、压缩和复制仍可使用", async () => {
  const workspace = await mkdtemp(path.join(data, "file-scope-"));
  await mkdir(path.join(workspace, "input"));
  await writeFile(path.join(workspace, "input", "sales.csv"), "day,total\nMonday,10\n");
  await writeFile(path.join(workspace, "other.csv"), "day,total\nMonday,200\n");
  const unlisted = path.join(workspace, "unlisted");
  await mkdir(unlisted);
  await writeFile(path.join(unlisted, "private.csv"), "day,total\nMonday,200\n");
  await symlink(unlisted, path.join(workspace, "input", "link"), process.platform === "win32" ? "junction" : "dir");
  const builtins = overrides["packages/tool-runtime/src/index.ts"];
  const originalSpecs = builtins.toolSpecs;
  let scope;
  try {
    builtins.toolSpecs = () => tools.map(({ spec }) => spec);
    scope = capabilityScope({ task: "读已授权输入", paths: ["input", "result.zip"] }, tools.map(({ spec }) => spec.name), { workspace, disabled: {} });
    assert.equal(scope.specs.length, tools.length);
    const empty = capabilityScope({ task: "不读取资源", hosts: [], paths: [] }, tools.map(({ spec }) => spec.name), { workspace, disabled: {} });
    assert.deepEqual(empty.specs, []);
    assert.ok(Object.values(ROLES).every(({ tools: names }) => names.every((name) => !tools.some(({ spec }) => name === spec.name))));
  } finally { builtins.toolSpecs = originalSpecs; }

  const seen = [];
  const ctx = { workspace, readPath(file) { seen.push(file); return scope.readPath(file); } };
  const error = /文件路径超出此子任务的读取范围/;
  // 第一项允许但不存在，第二项明确越权。先检查范围能在开始读任何一项前发现越权。
  await assert.rejects(queryData.run({ files: ["input/missing.csv", "other.csv"], sql: "SELECT 1" }, ctx), error);
  assert.deepEqual(seen.splice(0), ["input/missing.csv", "other.csv"]);
  const queried = await queryData.run({ files: ["input/sales.csv"], sql: "SELECT SUM(total) AS total FROM sales" }, ctx);
  assert.deepEqual(JSON.parse(queried.content).rows, [[10]]);

  for (const action of ["list", "zip", "unzip"]) {
    await assert.rejects(archive.run({ action, path: "unlisted.zip", to: "blocked.zip" }, ctx), error);
  }
  await assert.rejects(fileOp.run({ action: "copy", path: "other.csv", to: "blocked.csv" }, ctx), error);
  await assert.rejects(access(path.join(workspace, "blocked.zip")), { code: "ENOENT" });
  await assert.rejects(access(path.join(workspace, "blocked.csv")), { code: "ENOENT" });

  await archive.run({ action: "zip", path: "input", to: "result.zip" }, ctx);
  assert.ok(seen.includes(path.join(workspace, "input", "sales.csv")));
  const listing = await archive.run({ action: "list", path: "result.zip" }, ctx);
  assert.deepEqual(JSON.parse(listing.content).files, ["input/sales.csv"]);
  seen.length = 0;
  await fileOp.run({ action: "copy", path: "input", to: "copy" }, ctx);
  assert.ok(seen.includes(path.join(workspace, "input", "sales.csv")));
  await assert.rejects(lstat(path.join(workspace, "copy", "link")), { code: "ENOENT" });
  assert.match(await readFile(path.join(workspace, "copy", "sales.csv"), "utf8"), /Monday,10/);
});
