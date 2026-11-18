import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** 把 Node 的字节流转成标准 Request/Response。连接终止只取消此请求的读写。 */
export function httpServer(handler: (request: Request) => Promise<Response>) {
  return createServer(async (incoming, outgoing) => {
    const disconnected = new AbortController();
    outgoing.once("close", () => { if (!outgoing.writableFinished) disconnected.abort(); });
    try {
      const request = requestOf(incoming, disconnected.signal);
      await send(outgoing, request.method, await handler(request), disconnected.signal);
    } catch (error) {
      if (disconnected.signal.aborted) return;
      if (outgoing.headersSent) { outgoing.destroy(); return; }
      console.error("[http] 请求处理失败", error);
      await send(outgoing, incoming.method ?? "GET", Response.json({ error: "服务暂时无法处理该请求" }, { status: 500 }), disconnected.signal);
    }
  });
}

function requestOf(incoming: IncomingMessage, signal: AbortSignal): Request {
  const target = incoming.url ?? "/";
  if (!target.startsWith("/") || target.startsWith("//")) throw new Error("无效的请求地址");
  const host = incoming.headers.host ?? "localhost";
  const headers = new Headers();
  for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
  const method = incoming.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
  const init: RequestInit & { duplex?: "half" } = { method, headers, body, signal };
  if (body) init.duplex = "half";
  return new Request(`http://${host}${target}`, init);
}

async function send(outgoing: ServerResponse, method: string, response: Response, signal: AbortSignal) {
  if (signal.aborted) { await response.body?.cancel(); return; }
  outgoing.statusCode = response.status;
  for (const [name, value] of response.headers) if (name !== "set-cookie" && name !== "connection") outgoing.setHeader(name, value);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) outgoing.setHeader("set-cookie", cookies);
  if (!response.body || method === "HEAD") {
    await response.body?.cancel();
    outgoing.end();
    return;
  }
  outgoing.flushHeaders();
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), outgoing, { signal });
}
