// 执行层“停止 / 并发”测试：需要 A.ai 正在运行、当前模型是 Mock。用法：node evals/stop-test.mjs [地址] [账号] [密码]
const B = process.argv[2] || "http://localhost:3000";
const x = await fetch(B + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: process.argv[3] || "eval", password: process.argv[4] || "eval12345" }) });
const cookie = x.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const H = { Cookie: cookie, "Content-Type": "application/json" };
await fetch(B + "/api/settings", { method: "PUT", headers: H, body: JSON.stringify({ commandApproval: "auto", memory: false }) });
const script = (steps) => "[A.ai:script]" + JSON.stringify({ steps, final: "完成" });
const c = (name, args) => ({ name, args: { purpose: "测试", ...args } });

async function send(sessionId, message, abortAfter) {
  const ac = new AbortController();
  if (abortAfter) setTimeout(() => ac.abort(), abortAfter);
  let sid = sessionId, status;
  try {
    const res = await fetch(B + "/api/chat", { method: "POST", headers: H, body: JSON.stringify({ sessionId, message }), signal: ac.signal });
    status = res.status;
    if (!res.ok) return { sid, status, error: await res.text() };
    const dec = new TextDecoder();
    let buf = "";
    for await (const ch of res.body) {
      buf += dec.decode(ch, { stream: true });
      const m = /"type":"session","session":\{"id":"([^"]+)"/.exec(buf);
      if (m) sid = m[1];
    }
  } catch (e) { /* aborted */ }
  return { sid, status };
}
const session = async (id) => (await fetch(B + "/api/sessions/" + id, { headers: H })).json();
const summary = (s) => s.messages.filter((m) => m.role === "tool").map((m) => `${m.status}${m.errorKind ? "/" + m.errorKind : ""}`);
const paired = (s) => {
  const ids = new Set(s.messages.filter((m) => m.role === "tool").map((m) => m.toolCallId));
  return s.messages.flatMap((m) => m.toolCalls ?? []).every((c) => ids.has(c.id));
};

// 1. 停止：写文件（成功）→ sleep 命令（被停止）→ 读文件（还没开始）
const r1 = await send(undefined, script([[c("write_file", { path: "stop/a.txt", content: "a" }), c("run_command", { command: "sleep 4; echo late > stop/late.txt" }), c("read_file", { path: "stop/a.txt" })]]), 2500);
await new Promise((r) => setTimeout(r, 1500));
let s = await session(r1.sid);
console.log("停止后状态:", summary(s), "调用都有结果:", paired(s));
// 停止后再发一条，历史要合法
const r2 = await send(r1.sid, "你好");
s = await session(r1.sid);
console.log("再发一条:", r2.status, "最后一条:", s.messages.at(-1).role, JSON.stringify(s.messages.at(-1).content.slice(0, 30)));

// 2. 同一会话并发：第一条要跑 8 秒，马上发第二条
const p1 = send(r1.sid, script([[c("run_command", { command: "sleep 8" })]]));
await new Promise((r) => setTimeout(r, 800));
const t0 = Date.now();
const p2 = await send(r1.sid, "第二条");
console.log("并发第二条:", p2.status, p2.error, `等了 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await p1;
