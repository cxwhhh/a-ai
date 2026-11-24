import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { currentUser } from "../../../packages/application/users/src/auth";

const mime: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".ico": "image/x-icon",
};

/** 服务器沿用旧地址与登录重定向。页面参数来自已验证的 Cookie，浏览器只负责渲染。 */
export async function servePage(request: Request, webRoot: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("not found", { status: 404 });
  const pathname = new URL(request.url).pathname.replace(/\/$/, "") || "/";
  if (pathname === "/") return redirect("/A.ai");
  if (pathname.startsWith("/assets/") || pathname === "/icon.svg") return await asset(webRoot, pathname);
  if (pathname !== "/login" && pathname !== "/A.ai" && !/^\/A\.ai\/chat(?:\/[^/]+)*$/.test(pathname)) return new Response("not found", { status: 404 });

  const me = await currentUser(request);
  if (pathname === "/login" && me) return redirect("/A.ai/chat");
  let page: "intro" | "login" | "chat" = pathname === "/login" ? "login" : "intro";
  let initialId: string | undefined;
  if (pathname.startsWith("/A.ai/chat")) {
    if (!me) return redirect("/login");
    const [, , , user, id] = pathname.split("/");
    const canonical = `/A.ai/chat/${encodeURIComponent(me.username)}`;
    try {
      if (!user || decodeURIComponent(user) !== me.username) return redirect(canonical);
      initialId = id && decodeURIComponent(id);
    } catch { return redirect(canonical); }
    page = "chat";
  }
  const html = await readFile(path.join(webRoot, "index.html"), "utf8");
  const state = JSON.stringify({ page, user: me?.username ?? null, initialId }).replace(/</g, "\\u003c");
  const title = page === "intro" ? "A.ai — 极简、高效的 AI agent" : "A.ai";
  const description = page === "intro" ? "说出任务，直接拿结果。A.ai 会自己规划、调用工具、写代码并运行，把成果直接交给你。" : "极简、高效的 AI agent";
  return new Response(html.replace("<!-- a-ai-bootstrap -->", () => `<script type="application/json" id="bootstrap">${state}</script>`)
    .replace("<title>A.ai</title>", () => `<title>${title}</title>`)
    .replace('name="description" content="极简、高效的 AI agent"', () => `name="description" content="${description}"`), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // 内嵌的应用可以在自己的文档里执行脚本，子窗口只能加载本站资源或隔离的 srcdoc。
      ...(page === "chat" ? { "Content-Security-Policy": "frame-src 'self' blob: data:" } : {}),
    },
  });
}

function redirect(location: string) {
  return new Response(location, { status: 307, headers: { Location: location, "Cache-Control": "no-store" } });
}

async function asset(root: string, pathname: string): Promise<Response> {
  const name = pathname.slice(1);
  if (/[^\w./-]/.test(name) || name.split("/").some((part) => part === "..")) return new Response("not found", { status: 404 });
  const file = path.join(root, name);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return new Response("not found", { status: 404 });
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers: {
    "Content-Type": mime[path.extname(file)] ?? "application/octet-stream",
    "Content-Length": String(info.size),
    "Cache-Control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  } });
}
