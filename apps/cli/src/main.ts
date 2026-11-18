import { parseArgs } from "node:util";
import type { AgentEvent } from "../../../packages/protocol/src/lib/shared";

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  server: { type: "string", default: "http://127.0.0.1:3000" },
  session: { type: "string" },
  after: { type: "string", default: "0" },
  json: { type: "boolean" },
} });
const [command, ...args] = positionals;
if (!command || command === "help") {
  console.log("A.ai CLI: send <消息> | sessions | follow <运行 ID> | stop <运行 ID>\n参数: --server <URL> --session <ID> --after <事件 ID> --json\n认证使用 A_AI_USERNAME 与 A_AI_PASSWORD，或已有的 A_AI_SESSION。");
} else {
  try { await execute(); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}

async function execute() {
  const server = new URL(values.server!);
  if (!/^https?:$/.test(server.protocol)) throw new Error("服务地址需使用 HTTP 或 HTTPS");
  const signal = new AbortController();
  process.once("SIGINT", () => signal.abort());
  let cookie = process.env.A_AI_SESSION ? `a_session=${process.env.A_AI_SESSION}` : "";
  if (!cookie && process.env.A_AI_USERNAME && process.env.A_AI_PASSWORD) {
    const login = await fetch(new URL("/api/auth/login", server), { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: process.env.A_AI_USERNAME, password: process.env.A_AI_PASSWORD }), redirect: "error", signal: signal.signal });
    if (!login.ok) throw new Error(`登录失败 (${login.status})`);
    cookie = login.headers.getSetCookie()[0]?.split(";")[0] ?? "";
  }
  if (!cookie) throw new Error("缺少 CLI 登录凭据");
  const request = async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Cookie", cookie);
    const response = await fetch(new URL(path, server), { ...init, headers, redirect: "error", signal: signal.signal });
    if (!response.ok) throw new Error(`请求失败 (${response.status}) ${await response.text()}`);
    return response;
  };
  const id = args[0] && encodeURIComponent(args[0]);
  switch (command) {
    case "sessions":
      console.log(JSON.stringify(await (await request("/api/sessions")).json(), null, 2));
      break;
    case "send":
      if (!args.join(" ").trim()) throw new Error("send 需要消息正文");
      await consume(await request("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: values.session, message: args.join(" ") }) }));
      break;
    case "follow":
      if (!id) throw new Error("follow 需要运行 ID");
      await consume(await request(`/api/runs/${id}?after=${encodeURIComponent(values.after!)}`));
      break;
    case "stop":
      if (!id) throw new Error("stop 需要运行 ID");
      await request(`/api/runs/${id}`, { method: "DELETE" });
      break;
    default: throw new Error(`未知命令 ${command}`);
  }
}

async function consume(response: Response) {
  if (!response.body) throw new Error("服务器没有返回事件流");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).join("\n");
        if (!data) continue;
        const event: AgentEvent = JSON.parse(data);
        if (values.json) console.log(JSON.stringify(event));
        else if (event.type === "session") console.error(`会话 ${event.session.id}，运行 ${event.runId}`);
        else if (event.type === "text") process.stdout.write(event.delta);
        else if (event.type === "error") { console.error(event.message); process.exitCode = 1; }
      }
    }
  } finally { reader.releaseLock(); }
  if (!values.json) process.stdout.write("\n");
}
