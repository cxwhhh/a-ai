import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { data, load } from "../../../tests/fixtures/agent-runtime.mjs";

const { executeWorkspaceApp } = load("packages/workspace/src/app-runtime.ts");
const { workspaceAppRequest } = load("packages/workspace/src/apps.ts");

test("旧应用库迁出工作区后，账号隔离、页面版本和原记录继续生效", async () => {
  const owner = mkdtempSync(path.join(data, "app-owner-"));
  const visitor = mkdtempSync(path.join(data, "app-visitor-"));
  const old = path.join(owner, ".aai-apps", "apps.sqlite");
  const { app } = executeWorkspaceApp(old, { type: "deploy-app", title: "饮食记录", html: "<p>第一版</p>" });
  const cmd = { type: "records", appId: app.id };
  const { record } = executeWorkspaceApp(old, { ...cmd, command: { action: "create", data: { food: "米饭" } } });
  assert.equal((await workspaceAppRequest(visitor, { type: "read-app", appId: app.id })).status, 404);
  assert.equal((await workspaceAppRequest(visitor, { ...cmd, command: { action: "create", data: {} } })).status, 404);
  assert.deepEqual((await workspaceAppRequest(owner, { ...cmd, command: { action: "list" } })).records, [record]);
  assert.equal(existsSync(path.dirname(old)), false);

  // 后续工作区里出现同名库，应用接口仍然使用迁移后的数据库。
  executeWorkspaceApp(old, { type: "deploy-app", title: "另一应用", html: "<p>示例</p>" });
  const { app: updated } = await workspaceAppRequest(owner, { type: "deploy-app", appId: app.id, title: "饮食记录", html: "<p>第二版</p>" });
  assert.equal(updated.revision, 2);
  assert.equal(updated.id, app.id);
  assert.equal((await workspaceAppRequest(owner, { type: "read-app", appId: app.id })).app.html, "<p>第二版</p>");
  assert.deepEqual((await workspaceAppRequest(owner, { ...cmd, command: { action: "list" } })).records, [record]);
});
