import { promises as fs } from "node:fs";
import path from "node:path";
import { safePath, workspaceOf } from "@/lib/agent/tools/files";
import { MAX_UPLOAD } from "@/lib/attachments";
import { currentUser, unauthorized } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/upload（multipart/form-data，字段名 file，可以多个）
 * 把用户上传的文件存到自己工作区的 uploads/ 目录，返回工作区里的相对路径。
 * agent 的工具都以工作区为根，所以拿到这个路径就能直接 read_document / read_file。
 * 同名文件不覆盖，自动加 (1)、(2)：用户先后传两个“截图.png”，两个都要留着。
 * 可选字段 dir：放进 uploads/<dir>/ 子目录（自动测评每道题一个目录，互相看不到对方的附件）。
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const form = await req.formData().catch(() => null);
  const files = form?.getAll("file").filter((f): f is File => f instanceof File) ?? [];
  if (!files.length) return Response.json({ error: "没有收到文件" }, { status: 400 });

  const sub = cleanDir(String(form?.get("dir") ?? ""));
  const dir = safePath(workspaceOf(user.id), sub ? `uploads/${sub}` : "uploads");
  await fs.mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
  const out: { name: string; path: string; size: number }[] = [];
  for (const f of files) {
    if (f.size > MAX_UPLOAD) return Response.json({ error: `${f.name} 超过 50 MB` }, { status: 413 });
    const name = await freeName(dir, cleanName(f.name));
    await fs.writeFile(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ dir, name), Buffer.from(await f.arrayBuffer()));
    out.push({ name, path: `uploads/${sub ? sub + "/" : ""}${name}`, size: f.size });
  }
  return Response.json({ files: out });
}

/** 子目录名只允许一层、常见字符，防止用 ../ 跳出 uploads */
function cleanDir(d: string) {
  return d.replace(/[^\w.\-\u4e00-\u9fff]+/g, "_").replace(/^\.+/, "").slice(0, 80);
}

/** 去掉路径和系统不允许的字符；换行也去掉，因为附件路径在消息里一行一个 */
function cleanName(n: string) {
  const base = path.basename(n.replace(/\\/g, "/")).replace(/[\r\n\t<>:"|?*\x00-\x1f]+/g, "_").trim();
  return base && base !== "." && base !== ".." ? base.slice(-120) : "file";
}

async function freeName(dir: string, name: string) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const n = i ? `${stem} (${i})${ext}` : name;
    const ok = await fs.access(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ dir, n)).then(() => false, () => true);
    if (ok) return n;
  }
}
