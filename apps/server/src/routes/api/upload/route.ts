import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { MAX_UPLOAD } from "../../../../../../packages/protocol/src/lib/attachments";
import { currentUser, notFound, unauthorized } from "../../../../../../packages/application/users/src/auth";
import { registerWorkspaceFile } from "../../../../../../packages/storage/src/workspace-files";
import { isSessionArchived } from "../../../../../../packages/session/src/archive-admission";
import { ensureWorkspaceDirectory, legacyFilePath, openSessionWorkspace } from "../../../../../../packages/workspace/src/session-workspace";


/**
 * POST /api/upload（multipart/form-data，字段名 file，可以多个）
 * 把用户上传的文件存到当前对话的 uploads/，返回对话工作区里的相对路径。
 * agent 的工具都以工作区为根，所以拿到这个路径就能直接 read_document / read_file。
 * 同名文件不覆盖，自动加 (1)、(2)：用户先后传两个“截图.png”，两个都要留着。
 * 可选字段 dir：放进 uploads/<dir>/ 子目录。
 */
export async function POST(req: Request) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const sessionId = new URL(req.url).searchParams.get("sessionId") ?? "";
  const scope = openSessionWorkspace(user.id, sessionId);
  if (!scope) return notFound();
  if (isSessionArchived(sessionId, user.id)) return Response.json({ error: "对话或项目已归档，请先恢复" }, { status: 409 });
  const { workspace } = scope;
  const form = await req.formData().catch(() => null);
  const legacy = form?.get("legacyPath");
  if (typeof legacy === "string") {
    try {
      const source = legacyFilePath(user.id, legacy);
      if (!(await fs.lstat(source)).isFile()) return notFound();
      const parent = ensureWorkspaceDirectory(workspace, path.dirname(legacy));
      await fs.copyFile(source, path.join(parent, path.basename(legacy)), constants.COPYFILE_EXCL);
      return Response.json({ path: legacy });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return Response.json({ error: "对话中已有同名文件" }, { status: 409 });
      return Response.json({ error: "无法导入旧工作区文件" }, { status: 404 });
    }
  }
  const files = form?.getAll("file").filter((f): f is File => f instanceof File) ?? [];
  if (!files.length) return Response.json({ error: "没有收到文件" }, { status: 400 });
  const oversized = files.find((f) => f.size > MAX_UPLOAD);
  if (oversized) return Response.json({ error: `${oversized.name} 超过 50 MB` }, { status: 413 });

  const sub = cleanDir(String(form?.get("dir") ?? ""));
  const relativeDir = sub ? `uploads/${sub}` : "uploads";
  const dir = ensureWorkspaceDirectory(workspace, relativeDir);
  const out: { id: string; name: string; path: string; size: number }[] = [];
  for (const f of files) {
    const name = await writeUpload(dir, cleanName(f.name), Buffer.from(await f.arrayBuffer()));
    const relativePath = `${relativeDir}/${name}`;
    out.push({ id: registerWorkspaceFile(sessionId, relativePath), name, path: relativePath, size: f.size });
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

async function writeUpload(dir: string, name: string, bytes: Buffer) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const n = i ? `${stem} (${i})${ext}` : name;
    try {
      await fs.writeFile(path.join(dir, n), bytes, { flag: "wx" });
      return n;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}
