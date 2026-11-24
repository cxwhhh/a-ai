import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import clientPaths from "../../../apps/desktop/src/client-paths.cjs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const worker = fileURLToPath(new URL("../src/app-worker.ts", import.meta.url));

test("账号应用经独立进程重新打开，发布新版仍可读取原记录", () => {
  const owner = mkdtempSync(path.join(clientPaths.temporaryDirectory("tests"), "aai-app-owner-"));
  const visitor = mkdtempSync(path.join(clientPaths.temporaryDirectory("tests"), "aai-app-visitor-"));
  const call = (cwd, command) => JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", worker], {
    cwd, input: JSON.stringify(command), encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
  }));
  try {
    const { app } = call(owner, { type: "deploy-app", title: "饮食记录", html: "<p>第一版</p>" });
    const cmd = { type: "records", appId: app.id };
    const { record } = call(owner, { ...cmd, command: { action: "create", data: { food: "米饭" } } });
    assert.equal(call(visitor, { type: "read-app", appId: app.id }).status, 404);
    assert.equal(call(visitor, { ...cmd, command: { action: "create", data: { food: "test" } } }).status, 404);
    const { app: updated } = call(owner, { type: "deploy-app", appId: app.id, title: "饮食记录", html: "<p>第二版</p>" });
    assert.equal(updated.revision, 2);
    assert.equal(updated.id, app.id);
    assert.equal(call(owner, { type: "read-app", appId: app.id }).app.html, "<p>第二版</p>");
    assert.deepEqual(call(owner, { ...cmd, command: { action: "list" } }).records, [record]);
  } finally {
    rmSync(owner, { recursive: true, force: true });
    rmSync(visitor, { recursive: true, force: true });
  }
});
