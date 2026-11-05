import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /updates/<文件名>：桌面版的更新源，由 A.ai 服务器自己提供，不用另外配 nginx。
 *
 * 服务器上把打包出来的文件放进 updates 目录（docker-compose.yml 把 ./updates 挂到容器的 /app/updates）：
 *   A.ai-Setup-0.2.0.exe、A.ai-Setup-0.2.0.exe.blockmap、latest.yml
 * 桌面版启动时请求 /updates/latest.yml，看到比自己新的版本号，就下载 yml 里写的 exe。
 *
 * - 不需要登录：桌面版检查更新时还没登录。只认这几种扩展名的文件，文件名不能带路径（防止 ../ 读到别的文件）
 * - yml 不缓存：不然客户端一直看到旧版本号
 * - 支持 Range（只给一段）：下载断了可以接着下；差量更新会一次要多段，这里不支持，electron-updater 会自动改成整个下载
 */
const DIR = () => path.resolve(process.env.A_UPDATES_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), "updates"));
const NAME = /^[\w.\- ]+\.(yml|exe|blockmap|dmg|zip)$/;
const TYPES: Record<string, string> = { yml: "text/yaml; charset=utf-8", exe: "application/octet-stream", blockmap: "application/octet-stream", dmg: "application/x-apple-diskimage", zip: "application/zip" };

export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
  const name = decodeURIComponent((await params).file);
  if (!NAME.test(name)) return new Response("not found", { status: 404 });
  const full = path.join(DIR(), name);
  const st = await fs.stat(/*turbopackIgnore: true*/ full).catch(() => null);
  if (!st?.isFile()) return new Response("not found", { status: 404 });

  const ext = name.split(".").pop()!;
  const headers: Record<string, string> = {
    "Content-Type": TYPES[ext],
    "Accept-Ranges": "bytes",
    "Cache-Control": ext === "yml" ? "no-cache" : "public, max-age=3600",
    "Last-Modified": st.mtime.toUTCString(),
  };
  const send = (start: number, end: number, status: number) => {
    const body = Readable.toWeb(createReadStream(/*turbopackIgnore: true*/ full, { start, end })) as ReadableStream;
    return new Response(body, { status, headers: { ...headers, "Content-Length": String(end - start + 1) } });
  };

  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${st.size}` } });
    headers["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
    return send(start, end, 206);
  }
  return send(0, st.size - 1, 200);
}

export async function HEAD(req: Request, ctx: { params: Promise<{ file: string }> }) {
  const r = await GET(req, ctx);
  await r.body?.cancel();
  return new Response(null, { status: r.status, headers: r.headers });
}
