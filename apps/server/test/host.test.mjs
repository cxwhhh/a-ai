import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import clientPaths from "../../desktop/src/client-paths.cjs";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { build } from "esbuild";

// 使用构建后的生产入口。所有写入在测试专用目录，模型用内置 Mock。
const data = mkdtempSync(path.join(clientPaths.temporaryDirectory("tests"), "aai-host-test-"));
let child;
let origin;
let owner;
let visitor;

before(async () => {
  child = spawn(process.execPath, ["dist/server/server.mjs"], {
    env: { ...process.env, HOSTNAME: "127.0.0.1", PORT: "0", A_DATA_DIR: data, A_UPDATES_DIR: data, A_ALLOW_SIGNUP: "1", A_SANDBOX: "off" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  origin = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("生产服务没有启动")), 10_000);
    let output = "";
    let errors = "";
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const url = /\[a-ai\] (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
      if (url) { clearTimeout(timeout); resolve(url); }
    });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`服务退出 ${code} ${errors}`)); });
  });
  owner = await register("owner");
  visitor = await register("visitor");
});

after(async () => {
  if (child?.exitCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  rmSync(data, { recursive: true, force: true });
});

async function register(username) {
  const response = await fetch(`${origin}/api/auth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: "fixture-1234" }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie()[0];
  assert.match(cookie, /HttpOnly; SameSite=Lax/);
  return cookie.split(";")[0];
}

function request(url, cookie = owner, init = {}) {
  return fetch(`${origin}${url}`, { ...init, headers: { cookie, ...init.headers } });
}

async function start(text) {
  const response = await request("/api/chat", owner, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text }),
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let data = "";
  while (!data.includes("\n\n")) {
    const chunk = await reader.read();
    assert.ok(!chunk.done);
    data += new TextDecoder().decode(chunk.value);
  }
  const first = JSON.parse(data.split("\n")[0].slice(6));
  assert.equal(first.type, "session");
  return { reader, runId: first.runId, sessionId: first.session.id };
}

test("Node 接入保留登录、会话深链接和静态资源", async () => {
  const login = await fetch(`${origin}/login`);
  assert.match(await login.text(), /"page":"login"/);
  assert.equal((await fetch(`${origin}/api/sessions`)).status, 401);
  const redirect = await request("/A.ai/chat/visitor", owner, { redirect: "manual" });
  assert.equal(redirect.headers.get("location"), "/A.ai/chat/owner");
  const session = await request("/A.ai/chat/owner/test-id");
  assert.match(await session.text(), /"initialId":"test-id"/);
  assert.equal((await request("/icon.svg")).headers.get("content-type"), "image/svg+xml");
});

test("桌面更新文件名只解码一次，支持带空格的文件名和断点下载", async () => {
  writeFileSync(path.join(data, "A.ai Setup.exe"), "12345");
  const partial = await fetch(`${origin}/updates/A.ai%20Setup.exe`, { headers: { range: "bytes=1-2" } });
  assert.equal(partial.status, 206);
  assert.equal(await partial.text(), "23");
  assert.equal((await fetch(`${origin}/updates/A.ai%2520Setup.exe`)).status, 404);
});

test("任务勾选保存到账号自己的 Markdown 文件，冲突时保留新版本", async () => {
  const text = "# 同名计划\r\n\r\n- [ ] 上线\r\n  - [ ] 复核\r\n";
  async function upload(cookie) {
    const form = new FormData();
    form.append("file", new Blob([text]), "plan.md");
    const res = await request("/api/upload", cookie, { method: "POST", body: form });
    assert.equal(res.status, 200);
    return (await res.json()).files[0];
  }
  const a = await upload(owner);
  const b = await upload(visitor);
  assert.equal(a.path, b.path);
  assert.notEqual(a.id, b.id);
  const endpoint = `/api/files?id=${a.id}`;
  const original = await (await request(endpoint)).json();
  const toggle = (cookie, revision, itemStart) => request("/api/files", cookie, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: a.id, revision, itemStart, checked: true }),
  });
  const offset = text.indexOf("- [ ] 上线");
  assert.equal((await request(endpoint, visitor)).status, 404);
  assert.equal((await toggle(visitor, original.revision, offset)).status, 404);
  const updated = await toggle(owner, original.revision, offset);
  assert.equal(updated.status, 200);
  const changed = (await updated.json()).content;
  assert.equal(changed, text.replace("- [ ] 上线", "- [x] 上线"));
  assert.equal((await toggle(owner, original.revision, text.indexOf("- [ ] 复核"))).status, 409);
  assert.equal(await (await request(`${endpoint}&download=1`)).text(), changed);
  assert.equal((await (await request(`/api/files?id=${b.id}`, visitor)).json()).content, text);
});

test("聊天部署的饮食应用可跨登录读取，数据和页面按账号授权", async () => {
  const headers = { "Content-Type": "application/json" };
  const project = await (await request("/api/projects", owner, {
    method: "POST", headers, body: JSON.stringify({ name: "饮食记录项目" }),
  })).json();
  const projectQuery = `/api/workspace-apps?projectId=${project.id}`;
  const chat = await request("/api/chat", owner, {
    method: "POST", headers, body: JSON.stringify({ message: "帮我做一个记录我饮食的页面", projectId: project.id }),
  });
  assert.equal(chat.status, 200);
  const stream = await chat.text();
  const events = stream.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
  const artifact = events.find((event) => event.type === "artifact")?.artifact;
  assert.ok(artifact?.workspaceApp?.id, stream.slice(-600));
  const id = artifact.workspaceApp.id;
  const endpoint = `/api/workspace-apps?id=${id}`;
  const command = (body, cookie = owner) => request(endpoint, cookie, { method: "POST", headers, body: JSON.stringify(body) });

  assert.equal((await fetch(origin + endpoint)).status, 401);
  assert.equal((await request(endpoint, visitor)).status, 404);
  assert.equal((await request(projectQuery, visitor)).status, 404);
  assert.equal((await request(`${endpoint}&download=1`, visitor)).status, 404);
  assert.equal((await command({ action: "list" }, visitor)).status, 404);
  assert.deepEqual((await (await request("/api/workspace-apps", visitor)).json()).apps, []);
  assert.equal((await command(null)).status, 400);
  assert.equal((await command({ action: "create", data: { food: "x".repeat(18_000) } })).status, 413);
  const deployed = await request(endpoint);
  assert.match(deployed.headers.get("content-type"), /application\/json/);
  assert.match((await deployed.json()).app.html, /aai\.records\.create/);
  const create = await command({ action: "create", data: { food: "烤鱼", meal: "午餐" } });
  assert.equal(create.status, 200);
  const { record } = await create.json();

  const login = await fetch(origin + "/api/auth/login", {
    method: "POST", headers, body: JSON.stringify({ username: "owner", password: "fixture-1234" }),
  });
  assert.equal(login.status, 200);
  const otherDevice = login.headers.getSetCookie()[0].split(";")[0];
  assert.notEqual(otherDevice, owner);
  const projects = await (await request("/api/projects", otherDevice)).json();
  assert.ok(projects.some((item) => item.id === project.id));
  const list = (await (await request(projectQuery, otherDevice)).json()).apps;
  assert.equal(list[0].id, id);
  assert.equal(list[0].projectId, project.id);
  const download = await request(`${endpoint}&projectId=${project.id}&download=1`, otherDevice);
  assert.match(download.headers.get("content-disposition"), /^attachment;/);
  assert.match(await download.text(), /aai\.records\.create/);
  assert.ok(!(await (await request("/api/artifacts", otherDevice)).json()).some(({ id }) => id === artifact.id));
  assert.deepEqual((await (await command({ action: "list" }, otherDevice)).json()).records, [record]);
  const edit = { action: "update", id: record.id, revision: record.revision, data: { food: "青花鱼", meal: "午餐" } };
  assert.equal((await command(edit, otherDevice)).status, 200);
  assert.equal((await command(edit)).status, 409);
  assert.equal((await command({ action: "remove", id: record.id, revision: record.revision }, visitor)).status, 404);
});

test("同轮网页只列一次，删除文件后退出列表并保留会话快照", async () => {
  const { reader, sessionId } = await start("帮我做一个记录我饮食的页面");
  while (!(await reader.read()).done) { /* 等生产入口完成部署 */ }
  const endpoint = `/api/sessions/${sessionId}`;
  const session = await (await request(endpoint)).json();
  const deployed = session.artifacts.find((a) => a.workspaceApp);
  assert.ok(deployed);
  const { html } = (await (await request(`/api/workspace-apps?id=${deployed.workspaceApp.id}`)).json()).app;

  // 模拟已上线版本遗留的三条交付记录，再在下一轮建一个同名的独立网页。
  const now = Date.now();
  const drafts = [
    { id: "fixture-preview", title: deployed.title, kind: "html", content: html, createdAt: now },
    { id: "fixture-independent", title: deployed.title, kind: "html", content: "<p>另一个网页</p>", createdAt: now + 1,
      file: `output/${sessionId}/independent.html` },
  ];
  const sourceFile = `output/${sessionId}/index.html`;
  const action = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });
  const preview = (a) => action(`call-${a.id}`, "create_artifact", { title: a.title, kind: a.kind, content: a.content });
  const source = action("call-source", "write_file", { path: `/workspace/${sourceFile}`, content: html });
  const messages = [
    { role: "assistant", content: "", toolCalls: [preview(drafts[0]), source] },
    { role: "tool", toolCallId: `call-${drafts[0].id}`, artifactId: drafts[0].id, content: "已展示" },
    { role: "tool", toolCallId: source.id, content: JSON.stringify({ path: sourceFile }) },
    { role: "user", content: "做另一个同名的静态网页" },
    { role: "assistant", content: "", toolCalls: [preview(drafts[1])] },
    { role: "tool", toolCallId: `call-${drafts[1].id}`, artifactId: drafts[1].id, content: "已展示" },
  ];
  const db = new DatabaseSync(path.join(data, "a.db"));
  let independentPath;
  try {
    const { user_id: userId } = db.prepare("SELECT user_id FROM sessions WHERE id = ?").get(sessionId);
    const workspace = path.join(data, "users", userId, "workspace");
    independentPath = path.join(workspace, drafts[1].file);
    mkdirSync(path.dirname(independentPath), { recursive: true });
    writeFileSync(independentPath, drafts[1].content);
    writeFileSync(path.join(workspace, sourceFile), html);
    const addArtifact = db.prepare("INSERT INTO artifacts(id, session_id, created_at, data) VALUES (?, ?, ?, ?)");
    for (const a of drafts) addArtifact.run(a.id, sessionId, a.createdAt, JSON.stringify(a));
    const { seq } = db.prepare("SELECT max(seq) AS seq FROM messages WHERE session_id=?").get(sessionId);
    const addMessage = db.prepare("INSERT INTO messages(id, session_id, seq, role, created_at, data) VALUES (?, ?, ?, ?, ?, ?)");
    for (const [index, m] of messages.entries()) {
      const record = { ...m, id: `fixture-output-message-${index}`, createdAt: now + index };
      addMessage.run(record.id, sessionId, seq + index + 1, record.role, record.createdAt, JSON.stringify(record));
    }
  } finally { db.close(); }

  const { outputFiles: [module] } = await build({ entryPoints: ["packages/protocol/src/lib/outputs.ts"],
    bundle: true, write: false, format: "esm" });
  const { collectOutputs } = await import(`data:text/javascript;base64,${Buffer.from(module.contents).toString("base64")}`);
  const reopened = await (await request(endpoint)).json();
  assert.deepEqual(collectOutputs(reopened.messages, reopened.artifacts).outputs.map((output) => output.key).sort(),
    [`a:${deployed.id}`, `a:${drafts[1].id}`].sort());
  const visible = async () => (await (await request("/api/artifacts")).json()).filter((a) => a.sessionId === sessionId);
  assert.deepEqual((await visible()).map((a) => a.id), [drafts[1].id]);
  assert.deepEqual(reopened.unavailableOutputKeys, []);
  unlinkSync(independentPath);
  assert.deepEqual(await visible(), []);
  const afterDeletion = await (await request(endpoint)).json();
  assert.deepEqual(afterDeletion.unavailableOutputKeys, [`a:${drafts[1].id}`]);
  assert.ok(afterDeletion.artifacts.some((a) => a.id === drafts[1].id));
  assert.equal((await request(endpoint, visitor)).status, 404);
  writeFileSync(independentPath, drafts[1].content);
  assert.deepEqual((await (await request(endpoint)).json()).unavailableOutputKeys, []);
  assert.deepEqual((await visible()).map((a) => a.id), [drafts[1].id]);
});

test("生产 Host 按会话读取和设置插件，拒绝越权和未知 ID", async () => {
  const a = await (await request("/api/sessions", owner, { method: "POST" })).json();
  const b = await (await request("/api/sessions", owner, { method: "POST" })).json();
  const endpoint = (id) => `/api/sessions/${id}/agent/plugins`;
  const configure = (id, enabled, user = owner) => request(endpoint(id), user, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled })
  });
  const initial = await (await request(endpoint(a.id))).json();
  assert.deepEqual(initial.enabled, []);
  assert.ok(initial.available.some(({ id }) => id === "concise-replies"));
  assert.equal((await request(endpoint(a.id), visitor)).status, 404);
  assert.equal((await configure(a.id, [], visitor)).status, 404);
  assert.equal((await configure(a.id, ["unknown"])).status, 400);
  assert.equal((await configure(a.id, ["concise-replies"])).status, 200);
  assert.equal((await configure(b.id, ["structured-replies"])).status, 200);
  assert.deepEqual((await (await request(endpoint(a.id))).json()).enabled, ["concise-replies"]);
  assert.deepEqual((await (await request(endpoint(b.id))).json()).enabled, ["structured-replies"]);
  const chat = await request("/api/chat", owner, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: a.id, message: "验证插件会话" })
  });
  assert.equal(chat.status, 200);
  const stream = await chat.text();
  assert.match(stream, /"type":"done"/);
  assert.doesNotMatch(stream, /"type":"error"/);
});

test("SSE 断开后按原运行和游标继续，停止另一会话不影响本任务", { timeout: 15_000 }, async () => {
  const a = await start("核对运行 A");
  const b = await start("核对运行 B");
  assert.notEqual(a.runId, b.runId);
  await a.reader.cancel();
  const active = await (await request(`/api/runs?sessionId=${a.sessionId}`)).json();
  assert.equal(active.runId, a.runId);
  assert.equal((await request(`/api/runs/${a.runId}`, visitor)).status, 404);
  assert.equal((await request(`/api/runs/${b.runId}`, owner, { method: "DELETE" })).status, 204);
  await b.reader.cancel();
  const replay = await (await request(`/api/runs/${a.runId}?after=1`)).text();
  assert.match(replay, /"type":"done"/);
  assert.ok(!/^id: 1$/m.test(replay));
  const result = await (await request(`/api/sessions/${a.sessionId}`)).json();
  assert.equal(result.messages.filter((message) => message.role === "user" && !message.feedback).length, 1);
  assert.ok(result.messages.some((message) => message.role === "assistant" && message.content));
});
