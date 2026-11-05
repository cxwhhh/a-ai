import { promises as fs } from "node:fs";
import path from "node:path";
import { safePath, workspaceOf } from "@/lib/agent/tools/files";
import { currentUser, unauthorized } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX = 200_000;
/** raw 预览只放行这几种：图片和 PDF。svg/html 这类能带脚本的不在这里，避免上传的文件在本站域名下执行代码 */
const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", avif: "image/avif",
  pdf: "application/pdf",
};

/**
 * GET /api/files?path=demo/result.txt
 * 给右侧文件弹窗用：读取工作区内的文件或目录。
 * 和工具共用 safePath()，而且根目录是当前用户自己的工作区，所以读不到别人的文件。
 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const q = new URL(req.url).searchParams;
  const p = q.get("path") || ".";
  try {
    const full = safePath(workspaceOf(user.id), p);
    const st = await fs.stat(/*turbopackIgnore: true*/ full);
    if (st.isDirectory()) {
      const entries = await fs.readdir(/*turbopackIgnore: true*/ full, { withFileTypes: true });
      const items = entries
        .filter((e) => !e.name.startsWith("."))
        .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
      return Response.json({ path: p, type: "dir", items });
    }
    const buf = await fs.readFile(/*turbopackIgnore: true*/ full);
    // ?raw=1：直接返回文件本身，给图片 <img> 和 PDF <iframe> 预览用（上传的附件点开能看到原样）
    if (q.get("raw")) {
      const type = MIME[path.extname(full).slice(1).toLowerCase()];
      if (!type) return new Response("不支持预览这种文件", { status: 415 });
      return new Response(new Uint8Array(buf), { headers: { "Content-Type": type, "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff" } });
    }
    const binary = buf.subarray(0, 8000).includes(0);
    return Response.json({
      path: p,
      type: "file",
      size: st.size,
      mtime: st.mtimeMs,
      binary,
      content: binary ? "" : buf.toString("utf8", 0, Math.min(buf.length, MAX)),
      truncated: buf.length > MAX,
      ext: path.extname(full).slice(1).toLowerCase(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ path: p, error: msg.includes("ENOENT") ? "文件不存在" : msg }, { status: 404 });
  }
}
