import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// 使用构建后的生产入口。所有写入在测试专用目录，模型用内置 Mock。
const data = mkdtempSync(path.join(tmpdir(), "aai-host-test-"));
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
