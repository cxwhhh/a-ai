import { isUtf8 } from "node:buffer";
import { createReadStream, promises as fs, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { safePath, workspaceOf } from "../../../../../../packages/tools/src/files";
import { currentUser, unauthorized } from "../../../../../../packages/application/users/src/auth";
import { readDocument } from "../../../../../../packages/tools/src/documents";
import { resolvePath } from "../../../../../../packages/workspace/src/access";
import { hashFileBytes } from "../../../../../../packages/workspace/src/file-fingerprint";
import { replaceWorkspaceFile } from "../../../../../../packages/workspace/src/file-write";
import { registerWorkspaceFile, workspaceFilePath } from "../../../../../../packages/storage/src/workspace-files";
import { markdownTaskMarker } from "../../../../../../packages/protocol/src/markdown-task";


const MAX = 200_000;
const isMarkdown = (name: string) => /\.(md|markdown)$/i.test(name);
/** raw 预览只放行这几种：图片和 PDF。svg/html 这类能带脚本的不在这里，避免上传的文件在本站域名下执行代码 */
const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", avif: "image/avif",
  pdf: "application/pdf",
};

/**
 * GET /api/files?path=demo/result.txt
 * 给右侧文件弹窗用：读取工作区内的文件或目录。
 * 兼容原相对路径，也支持按文件 ID 查询。解析后的真实路径必须在当前用户工作区内。
 */
export async function GET(req: Request) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const q = new URL(req.url).searchParams;
  const id = q.get("id");
  const p = id ? workspaceFilePath(user.id, id) : q.get("path") || ".";
  if (!p) return Response.json({ error: "文件不存在" }, { status: 404 });
  try {
    const { full, shown } = ownedPath(user.id, p);
    const st = await fs.stat(/*turbopackIgnore: true*/ full);
    if (st.isDirectory()) {
      const entries = await fs.readdir(/*turbopackIgnore: true*/ full, { withFileTypes: true });
      const items = entries
        .filter((e) => !e.name.startsWith("."))
        .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
      return Response.json({ path: p, type: "dir", items });
    }
    if (!st.isFile()) return Response.json({ path: p, error: "只能读取普通文件" }, { status: 404 });
    const streamFile = () => Readable.toWeb(createReadStream(full)) as ReadableStream<Uint8Array>;
    // ?raw=1：直接返回文件本身，给图片 <img> 和 PDF <iframe> 预览用（上传的附件点开能看到原样）
    if (q.get("raw")) {
      const type = MIME[path.extname(full).slice(1).toLowerCase()];
      if (!type) return new Response("不支持预览这种文件", { status: 415 });
      return new Response(streamFile(), { headers: { "Content-Type": type, "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff" } });
    }
    // ?download=1：原样下载（Word / Excel / PPT 这类不能直接显示的文件用）。
    // 强制 attachment + octet-stream，浏览器只会存成文件，不会在本站打开执行
    if (q.get("download")) {
      const name = encodeURIComponent(path.basename(full));
      return new Response(streamFile(), {
        headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${name}`, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-cache" },
      });
    }
    const file = await fs.open(full, "r");
    let buf: Buffer;
    try {
      const prefix = Buffer.alloc(Math.min(st.size, MAX + 1));
      const { bytesRead } = await file.read(prefix);
      buf = prefix.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
    const binary = buf.subarray(0, 8000).includes(0);
    const ext = path.extname(full).slice(1).toLowerCase();
    // Office 文件：借用 read_document 的解析，取出文字给右侧预览（以前只显示“二进制文件，无法预览”）
    let preview: string | undefined;
    if (["docx", "xlsx", "pptx"].includes(ext)) {
      try {
        const r = await readDocument.run({ path: p }, { workspace: workspaceOf(user.id) } as Parameters<typeof readDocument.run>[1]);
        preview = String(JSON.parse(r.content).content ?? "");
      } catch {
        /* 解析失败就只给下载 */
      }
    }
    return Response.json({
      path: p,
      id: registerWorkspaceFile(user.id, shown),
      ...(isMarkdown(full) && !binary && buf.length <= MAX && isUtf8(buf) ? { revision: hashFileBytes(buf) } : {}),
      type: "file",
      size: st.size,
      mtime: st.mtimeMs,
      binary,
      content: binary ? "" : buf.toString("utf8", 0, Math.min(buf.length, MAX)),
      truncated: st.size > MAX,
      ext,
      preview,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ path: p, error: msg.includes("ENOENT") ? "文件不存在" : msg }, { status: 404 });
  }
}

/** 保存看板上的一次勾选。用户与 Agent 都以当前工作区文件为准。 */
export async function PATCH(req: Request) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  if (!/^application\/json(?:;|$)/i.test(req.headers.get("content-type") ?? "")) {
    return Response.json({ error: "需要 JSON 请求" }, { status: 415 });
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body.id !== "string" || !/^[a-f\d]{64}$/.test(body.revision ?? "") ||
      !Number.isSafeInteger(body.itemStart) || typeof body.checked !== "boolean") {
    return Response.json({ error: "无效的任务修改" }, { status: 400 });
  }
  const p = workspaceFilePath(user.id, body.id);
  if (!p) return Response.json({ error: "文件不存在" }, { status: 404 });
  const conflict = () => Response.json({ error: "文件已更新，已重新载入，请核对后再勾选" }, { status: 409 });
  try {
    const { full } = ownedPath(user.id, p);
    const st = statSync(full);
    if (!isMarkdown(full) || !st.isFile() || st.size > MAX) {
      return Response.json({ error: "只能修改完整的 Markdown 文件" }, { status: 400 });
    }
    const before = readFileSync(full);
    if (hashFileBytes(before) !== body.revision) return conflict();
    const text = before.toString("utf8");
    const marker = markdownTaskMarker(text, body.itemStart);
    if (!isUtf8(before) || before.includes(0) || marker === undefined) {
      return Response.json({ error: "找不到对应的任务项" }, { status: 400 });
    }
    const content = text.slice(0, marker) + (body.checked ? "x" : " ") + text.slice(marker + 1);
    const next = Buffer.from(content, "utf8");
    if (!replaceWorkspaceFile(full, before, next)) return conflict();
    return Response.json({ content, revision: hashFileBytes(next), mtime: statSync(full).mtimeMs, size: next.length });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Response.json({ error: "文件不存在" }, { status: 404 });
    return Response.json({ error: "工作区文件保存失败" }, { status: 500 });
  }
}

function ownedPath(userId: string, name: string) {
  const workspace = workspaceOf(userId);
  const target = resolvePath(workspace, safePath(workspace, name), "read");
  if (!target.inWorkspace) throw new Error("路径超出工作区");
  return target;
}
