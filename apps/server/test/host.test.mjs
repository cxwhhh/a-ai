import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createTestDirectory } from "../../../packages/storage-manager/src/index.ts";
import path from "node:path";
import clientPaths from "../../desktop/src/client-paths.cjs";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { build } from "esbuild";

// 使用构建后的生产入口。所有写入在测试专用目录，模型用内置 Mock。
const data = createTestDirectory(clientPaths.temporaryDirectory("tests"), "aai-host");
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

async function start(text, sessionId) {
  const response = await request("/api/chat", owner, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text, sessionId }),
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

test("存储管理按账号显示用量，管理操作受权限和 Docker 模式限制", async () => {
  assert.equal((await fetch(`${origin}/api/storage`)).status, 401);
  const admin = await (await request("/api/storage", owner)).json();
  const regular = await (await request("/api/storage", visitor)).json();
  assert.equal(admin.admin, true);
  assert.equal(regular.admin, false);
  assert.equal(admin.limitMiB, 512);
  const change = (cookie, action, mib) => request("/api/storage", cookie, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, mib }),
  });
  assert.equal((await change(visitor, "clear-tests")).status, 403);
  assert.equal((await change(owner, "set-quota", 1024)).status, 400);
  assert.equal((await change(owner, "set-quota", 128)).status, 409);
  assert.equal((await change(visitor, "clear-cache")).status, 200);
});

test("旧版本编辑返回可识别的冲突，回读会话后可在同一对话重发", async () => {
  const send = (body) => request("/api/chat", owner, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const first = await send({ message: "原问题" });
  assert.equal(first.status, 200);
  const firstEvent = /^data: (.+)$/m.exec(await first.text());
  assert.ok(firstEvent);
  const { session } = JSON.parse(firstEvent[1]);
  assert.ok(session.id);
  const read = async () => (await request(`/api/sessions/${session.id}`)).json();
  const initial = await read();
  const originalId = initial.messages[0].id;

  const second = await send({ sessionId: session.id, revision: initial.revision, message: "另一页面追加的问题" });
  assert.equal(second.status, 200);
  await second.text();
  const edit = { sessionId: session.id, truncateFrom: originalId, message: "编辑后的问题" };
  const stale = await send({ ...edit, revision: initial.revision });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "history_conflict");
  const latest = await read();
  assert.deepEqual(latest.messages.filter((m) => m.role === "user").map((m) => m.content), ["原问题", "另一页面追加的问题"]);

  const confirmed = await send({ ...edit, revision: latest.revision });
  assert.equal(confirmed.status, 200);
  await confirmed.text();
  const saved = await read();
  assert.deepEqual(saved.messages.filter((m) => m.role === "user").map((m) => m.content), ["编辑后的问题"]);
  assert.ok(saved.messages.some((m) => m.role === "assistant" && m.content.includes("编辑后的问题")));
});

test("桌面更新文件名只解码一次，支持带空格的文件名和断点下载", async () => {
  writeFileSync(path.join(data, "A.ai Setup.exe"), "12345");
  const partial = await fetch(`${origin}/updates/A.ai%20Setup.exe`, { headers: { range: "bytes=1-2" } });
  assert.equal(partial.status, 206);
  assert.equal(await partial.text(), "23");
  assert.equal((await fetch(`${origin}/updates/A.ai%2520Setup.exe`)).status, 404);
  writeFileSync(path.join(data, "empty.exe"), "");
  const empty = await fetch(`${origin}/updates/empty.exe`);
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get("content-length"), "0");
  assert.equal(await empty.text(), "");
  assert.equal((await fetch(`${origin}/updates/empty.exe`, { method: "HEAD" })).status, 200);
  const range = await fetch(`${origin}/updates/empty.exe`, { headers: { range: "bytes=0-" } });
  assert.equal(range.status, 416);
  assert.equal(range.headers.get("content-range"), "bytes */0");
});

test("同一项目两段对话的同名附件和任务勾选各自独立", async () => {
  const text = "# 同名计划\r\n\r\n- [ ] 上线\r\n  - [ ] 复核\r\n";
  const headers = { "Content-Type": "application/json" };
  const project = await (await request("/api/projects", owner, { method: "POST", headers, body: JSON.stringify({ name: "文件隔离" }) })).json();
  const makeSession = async (cookie, projectId) => (await (await request("/api/sessions", cookie, {
    method: "POST", headers, body: JSON.stringify({ projectId }),
  })).json()).id;
  const sessionA = await makeSession(owner, project.id);
  const sessionB = await makeSession(owner, project.id);
  const sessionC = await makeSession(visitor);
  const files = (sessionId, values = {}) => `/api/files?${new URLSearchParams({ sessionId, ...values })}`;
  async function upload(cookie, sessionId, content, name = "plan.md") {
    const form = new FormData();
    form.append("file", new Blob([content]), name);
    const res = await request(`/api/upload?sessionId=${sessionId}`, cookie, { method: "POST", body: form });
    assert.equal(res.status, 200);
    return (await res.json()).files[0];
  }
  const a = await upload(owner, sessionA, text);
  assert.equal((await request(files(sessionB, { path: a.path }))).status, 404);
  assert.deepEqual((await (await request(files(sessionB))).json()).items, []);
  const b = await upload(owner, sessionB, "另一段对话");
  const c = await upload(visitor, sessionC, text);
  assert.equal(a.path, b.path);
  assert.notEqual(a.id, b.id);
  const endpoint = files(sessionA, { id: a.id });
  const original = await (await request(endpoint)).json();
  const toggle = (cookie, revision, itemStart, sessionId = sessionA) => request(files(sessionId), cookie, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: a.id, revision, itemStart, checked: true }),
  });
  const offset = text.indexOf("- [ ] 上线");
  assert.equal((await request(endpoint, visitor)).status, 404);
  assert.equal((await toggle(visitor, original.revision, offset)).status, 404);
  assert.equal((await request(files(sessionB, { id: a.id }))).status, 404);
  assert.equal((await toggle(owner, original.revision, offset, sessionB)).status, 404);
  assert.equal((await request(`/api/files?id=${a.id}`)).status, 404);
  const updated = await toggle(owner, original.revision, offset);
  assert.equal(updated.status, 200);
  const changed = (await updated.json()).content;
  assert.equal(changed, text.replace("- [ ] 上线", "- [x] 上线"));
  assert.equal((await toggle(owner, original.revision, text.indexOf("- [ ] 复核"))).status, 409);
  assert.equal(await (await request(`${endpoint}&download=1`)).text(), changed);
  const large = "%PDF-1.4\n" + "fixture".repeat(80_000);
  const pdf = await upload(owner, sessionA, large, "large.pdf");
  const raw = await request(files(sessionA, { id: pdf.id, raw: "1" }));
  assert.equal(raw.headers.get("content-type"), "application/pdf");
  assert.equal(await raw.text(), large);
  const download = await request(files(sessionA, { id: pdf.id, download: "1" }));
  assert.match(download.headers.get("content-disposition"), /attachment.*large\.pdf/);
  assert.equal(await download.text(), large);
  const preview = await (await request(files(sessionA, { id: pdf.id }))).json();
  assert.equal(preview.truncated, true);
  assert.equal(preview.content.length, 200_000);
  assert.equal((await (await request(files(sessionB, { path: b.path }))).json()).content, "另一段对话");
  assert.equal((await (await request(files(sessionC, { id: c.id }), visitor)).json()).content, text);
  const db = new DatabaseSync(path.join(data, "a.db"));
  const { user_id: userId } = db.prepare("SELECT user_id FROM sessions WHERE id=?").get(sessionA);
  db.close();
  const root = path.join(data, "users", userId, "session-workspaces");
  symlinkSync(path.join(root, sessionA, "uploads"), path.join(root, sessionB, "linked-uploads"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await request(files(sessionB, { path: "linked-uploads/plan.md" }))).status, 404);
  assert.ok(!(await (await request(files(sessionB))).json()).items.some(({ name }) => name === "linked-uploads"));
  const move = await request(`/api/sessions/${sessionA}`, owner, { method: "PATCH", headers, body: JSON.stringify({ projectId: null }) });
  assert.equal(move.status, 200);
  assert.equal((await (await request(endpoint)).json()).content, changed);
});

test("旧对话只自动恢复有明确来源的产出，其余文件需显式导入", async () => {
  const makeSession = async () => (await (await request("/api/sessions", owner, { method: "POST" })).json()).id;
  const a = await makeSession();
  const b = await makeSession();
  const artifact = { id: "legacy-saved-artifact", title: "旧产出", kind: "markdown", content: "旧产出", file: `output/${a}/saved.md`, createdAt: 1 };
  const db = new DatabaseSync(path.join(data, "a.db"));
  let legacy;
  try {
    const { user_id: userId } = db.prepare("SELECT user_id FROM sessions WHERE id=?").get(a);
    legacy = path.join(data, "users", userId, "workspace");
    mkdirSync(path.join(legacy, "output", a), { recursive: true });
    writeFileSync(path.join(legacy, artifact.file), artifact.content);
    writeFileSync(path.join(legacy, "legacy-plan.md"), "用户旧文件");
    db.prepare("UPDATE sessions SET workspace_ready_at=NULL WHERE id IN (?, ?)").run(a, b);
    db.prepare("INSERT INTO artifacts(id, session_id, created_at, data) VALUES (?, ?, ?, ?)")
      .run(artifact.id, a, artifact.createdAt, JSON.stringify(artifact));
  } finally { db.close(); }
  const files = (sessionId, params) => `/api/files?${new URLSearchParams({ sessionId, ...params })}`;
  assert.equal((await (await request(files(a, { path: artifact.file }))).json()).content, artifact.content);
  assert.equal((await request(files(b, { path: artifact.file }))).status, 404);
  assert.equal((await request(files(a, { path: "legacy-plan.md" }))).status, 404);
  assert.equal((await request(files(a, { legacy: "1", path: "legacy-plan.md" }))).status, 404);
  const listing = await (await request(files(a, { legacy: "1" }))).json();
  assert.ok(listing.items.some(({ name }) => name === "legacy-plan.md"));
  const copy = (name, cookie = owner) => {
    const body = new FormData();
    body.append("legacyPath", name);
    return request(`/api/upload?sessionId=${a}`, cookie, { method: "POST", body });
  };
  assert.equal((await copy("legacy-plan.md", visitor)).status, 404);
  assert.equal((await copy("../legacy-plan.md")).status, 404);
  assert.equal((await copy("legacy-plan.md")).status, 200);
  assert.equal((await copy("legacy-plan.md")).status, 409);
  assert.equal((await (await request(files(a, { path: "legacy-plan.md" }))).json()).content, "用户旧文件");
  assert.equal((await request(files(b, { path: "legacy-plan.md" }))).status, 404);
  assert.equal(readFileSync(path.join(legacy, "legacy-plan.md"), "utf8"), "用户旧文件");
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
  const oversized = await command({ action: "create", data: { food: "x".repeat(18_000) } });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.headers.get("connection"), "close");
  await oversized.text();
  const deployed = await request(endpoint);
  assert.match(deployed.headers.get("content-type"), /application\/json/);
  assert.match((await deployed.json()).app.html, /aai\.records\.create/);
  const thumbnail = await request(`${endpoint}&thumbnail=1`);
  assert.equal(thumbnail.status, 200);
  assert.match(thumbnail.headers.get("content-type"), /^text\/html/);
  assert.match(thumbnail.headers.get("content-security-policy"), /^sandbox; default-src 'none';/);
  assert.match(thumbnail.headers.get("content-security-policy"), /frame-ancestors 'self'/);
  assert.match(await thumbnail.text(), /aai\.records\.create/);
  assert.equal((await request(`${endpoint}&thumbnail=1`, visitor)).status, 404);
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

test("产出源码只比较本账号本会话的有效版本", async () => {
  const makeSession = async () => (await (await request("/api/sessions", owner, { method: "POST" })).json()).id;
  const sessionId = await makeSession();
  const otherSession = await makeSession();
  const oldSource = "<h1>旧标题</h1>";
  const newSource = "<h1>新标题</h1>";
  const artifactId = "fixture-source-comparison";
  const legacyId = "fixture-source-legacy";
  const db = new DatabaseSync(path.join(data, "a.db"));
  const addArtifact = db.prepare("INSERT INTO artifacts(id, session_id, created_at, data) VALUES (?, ?, ?, ?)");
  const addVersion = db.prepare("INSERT INTO artifact_versions(id, artifact_id, session_id, version, data) VALUES (?, ?, ?, ?, ?)");
  const artifact = (id, content) => JSON.stringify({ id, title: id, kind: "html", content, createdAt: 1 });
  const url = (id = artifactId, scope = sessionId) => `/api/artifacts?${new URLSearchParams({ sessionId: scope, artifactId: id })}`;
  try {
    addArtifact.run(artifactId, sessionId, 1, artifact(artifactId, oldSource));
    addVersion.run("fixture-source-first", artifactId, sessionId, 1, artifact(artifactId, oldSource));
    assert.deepEqual(await (await request(url())).json(), { before: "", after: oldSource });
    db.prepare("UPDATE artifacts SET data=? WHERE id=?").run(artifact(artifactId, newSource), artifactId);
    addVersion.run("fixture-source-next", artifactId, sessionId, 2, artifact(artifactId, newSource));
    const response = await request(url());
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.deepEqual(await response.json(), { before: oldSource, after: newSource });

    addArtifact.run(legacyId, sessionId, 1, artifact(legacyId, newSource));
    addVersion.run(`legacy_${legacyId}`, legacyId, sessionId, 1, artifact(legacyId, newSource));
    assert.deepEqual(await (await request(url(legacyId))).json(), { before: null, after: newSource });
    assert.equal((await request(url(artifactId, otherSession))).status, 404);
    assert.equal((await request(url(), visitor)).status, 404);
    assert.equal((await fetch(origin + url())).status, 401);
  } finally { db.close(); }
});

test("同轮网页只列一次，磁盘文件缺失时保留快照入口和独立生成的文件", async () => {
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
  const plainFile = `output/${sessionId}/plain.html`;
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
    { role: "assistant", content: "", toolCalls: [action("plain-html", "write_file", { path: plainFile, content: "<p>文件网页</p>" })] },
    { role: "tool", toolCallId: "plain-html", content: JSON.stringify({ path: plainFile }) },
  ];
  const db = new DatabaseSync(path.join(data, "a.db"));
  let independentPath;
  try {
    const { user_id: userId } = db.prepare("SELECT user_id FROM sessions WHERE id = ?").get(sessionId);
    const workspace = path.join(data, "users", userId, "session-workspaces", sessionId);
    independentPath = path.join(workspace, drafts[1].file);
    mkdirSync(path.dirname(independentPath), { recursive: true });
    writeFileSync(independentPath, drafts[1].content);
    writeFileSync(path.join(workspace, sourceFile), html);
    writeFileSync(path.join(workspace, plainFile), "<p>文件网页</p>");
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
    [`a:${deployed.id}`, `a:${drafts[1].id}`, `f:${plainFile}`].sort());
  const visible = async () => (await (await request("/api/artifacts")).json()).filter((a) => a.sessionId === sessionId);
  const expected = [drafts[1].id, `f:${sessionId}:${plainFile}`].sort();
  assert.deepEqual((await visible()).map((a) => a.id).sort(), expected);
  assert.deepEqual(reopened.unavailableOutputKeys, []);
  unlinkSync(independentPath);
  assert.equal((await visible()).find((a) => a.id === drafts[1].id).snapshotOnly, true);
  const afterDeletion = await (await request(endpoint)).json();
  assert.deepEqual(afterDeletion.unavailableOutputKeys, []);
  assert.ok(afterDeletion.artifacts.some((a) => a.id === drafts[1].id));
  assert.equal((await request(endpoint, visitor)).status, 404);
  writeFileSync(independentPath, drafts[1].content);
  assert.deepEqual((await (await request(endpoint)).json()).unavailableOutputKeys, []);
  assert.equal((await visible()).find((a) => a.id === drafts[1].id).snapshotOnly, undefined);
  const dbAfter = new DatabaseSync(path.join(data, "a.db"));
  const user = dbAfter.prepare("SELECT user_id FROM sessions WHERE id=?").get(sessionId).user_id;
  dbAfter.close();
  unlinkSync(path.join(data, "users", user, "session-workspaces", sessionId, plainFile));
  assert.deepEqual((await visible()).map((a) => a.id), [drafts[1].id]);
  assert.deepEqual((await (await request(endpoint)).json()).unavailableOutputKeys, [`f:${plainFile}`]);
});

test("生成 HTML 时只有写盘成功才登记文件，磁盘目录冲突时仍保存快照", async () => {
  for (const blocked of [false, true]) {
    const { id } = await (await request("/api/sessions", owner, { method: "POST" })).json();
    await request(`/api/files?sessionId=${id}`);
    if (blocked) {
      const db = new DatabaseSync(path.join(data, "a.db"));
      const user = db.prepare("SELECT user_id FROM sessions WHERE id=?").get(id).user_id;
      db.close();
      writeFileSync(path.join(data, "users", user, "session-workspaces", id, "output"), "普通文件占用目录名");
    }
    const { reader, sessionId } = await start("做一个网页：A.ai 介绍", id);
    assert.equal(sessionId, id);
    while (!(await reader.read()).done) { /* 等待产出写回 */ }
    const session = await (await request(`/api/sessions/${id}`)).json();
    const artifact = session.artifacts.find((item) => item.kind === "html");
    assert.ok(artifact?.content.includes("<html"));
    const library = await (await request("/api/artifacts")).json();
    const entry = library.find((item) => item.id === artifact.id);
    assert.ok(entry);
    if (blocked) {
      assert.equal(artifact.file, undefined);
      assert.equal(entry.snapshotOnly, true);
    } else {
      assert.equal(artifact.fileCreated, true);
      const file = await request(`/api/files?${new URLSearchParams({ sessionId: id, path: artifact.file })}`);
      assert.equal(file.status, 200);
      assert.equal((await file.json()).content, artifact.content);
      assert.equal(entry.snapshotOnly, undefined);
    }
  }
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
