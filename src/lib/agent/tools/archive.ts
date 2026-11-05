import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { resolvePath } from "../../server/access";
import { isSensitivePath, within } from "../../server/sandbox";
import type { Tool } from "./types";

/**
 * 压缩和解压 zip。以前只能 run_command 里 unzip / zip：要 Docker，还要等用户确认。
 * 用户最常上传的就是一个 zip，“先解压”是很多任务的第一步，所以做成不依赖沙箱的工具。
 *
 * 解压是有风险的操作，这里挡住三种常见的坏 zip：
 *   - zip slip：条目名是 ../../etc/passwd 这种，解压时跳出目标目录 → 每个条目解压前检查最终路径
 *   - zip 炸弹：几 KB 的 zip 解出几十 GB → 限制条目数和解压后的总大小（边解边数，不信 zip 里写的大小）
 *   - 覆盖已有文件 → 目标目录里已存在的文件不覆盖，计入 skipped
 */
const MAX_ENTRIES = 10_000;
const MAX_TOTAL = 500 * 1024 * 1024;

type Args = { action: "zip" | "unzip" | "list"; path: string; to?: string };

export const archive: Tool<Args> = {
  spec: {
    name: "archive",
    description:
      "解压或打包 zip 文件，不依赖 Docker 沙箱。action：unzip 把 path 这个 zip 解压到 to 目录（不填 = 和 zip 同名的目录，已存在的文件不覆盖）；" +
      "zip 把 path（文件或目录）打包成 to（.zip）；list 只列出 zip 里有哪些文件，不解压。" +
      "适合：用户上传了 zip 要先解压、把结果打包给用户下载。不要用于：.tar.gz、.7z、.rar（用 run_command）；移动、复制文件（用 file_op）。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["unzip", "zip", "list"], description: "unzip 解压，zip 打包，list 查看内容" },
        path: { type: "string", description: "unzip/list：zip 文件路径；zip：要打包的文件或目录" },
        to: { type: "string", description: "unzip：解压到哪个目录；zip：生成的 zip 路径。都可以不填" },
      },
      required: ["action", "path"],
    },
  },
  async run({ action, path: p, to }, ctx) {
    if (action === "zip") return { content: JSON.stringify(await pack(ctx.workspace, p, to)) };
    if (action !== "unzip" && action !== "list") throw new Error(`action 只能是 unzip、zip、list，收到：${action}`);

    const src = resolvePath(ctx.workspace, p, "read");
    const st = await fs.stat(/*turbopackIgnore: true*/ src.full).catch(() => null);
    if (!st) throw new Error(`文件不存在：${src.shown}。用 glob 找一下（例：*.zip），用户上传的文件在 uploads/ 下`);
    if (!/\.zip$/i.test(src.full)) throw new Error(`${src.shown} 不是 .zip。tar.gz、7z、rar 用 run_command 解压`);
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(await fs.readFile(/*turbopackIgnore: true*/ src.full), { decodeFileName });
    } catch {
      throw new Error(`${src.shown} 打不开：文件损坏，或者不是真正的 zip（也可能是加了密码的 zip，这种需要用户先解压）`);
    }
    const entries = Object.values(zip.files).filter((e) => !e.dir && !/(^|\/)(__MACOSX|\.DS_Store)(\/|$)/.test(e.name));
    if (entries.length > MAX_ENTRIES) throw new Error(`zip 里有 ${entries.length} 个文件，超过 ${MAX_ENTRIES} 个上限`);
    if (action === "list")
      return { content: JSON.stringify({ path: src.shown, files: entries.slice(0, 300).map((e) => e.name), total: entries.length, truncated: entries.length > 300 }) };

    const dest = resolvePath(ctx.workspace, to || src.shown.replace(/\.zip$/i, ""), "write");
    let total = 0;
    const written: string[] = [];
    const skipped: string[] = [];
    for (const e of entries) {
      const name = fixName(e);
      const out = path.resolve(/*turbopackIgnore: true*/ dest.full, name);
      // zip slip：解出来的路径必须还在目标目录里
      if (!within(out, [dest.full]) || out === dest.full) throw new Error(`zip 里有不安全的路径「${e.name}」（试图写到目标目录外面），已停止解压`);
      if (isSensitivePath(out) || (await fs.lstat(/*turbopackIgnore: true*/ out).catch(() => null))) {
        skipped.push(name);
        continue;
      }
      const data = await e.async("nodebuffer");
      total += data.length;
      if (total > MAX_TOTAL) throw new Error(`解压后超过 ${MAX_TOTAL / 1048576} MB，已停止（已写出 ${written.length} 个文件）。可能是压缩炸弹，或文件确实太大`);
      await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(out), { recursive: true });
      await fs.writeFile(/*turbopackIgnore: true*/ out, data);
      written.push(name);
    }
    const shownDir = dest.shown;
    return {
      content: JSON.stringify({
        to: shownDir,
        files: written.slice(0, 100).map((n) => (shownDir === "." ? n : `${shownDir}/${n}`)),
        extracted: written.length,
        bytes: total,
        ...(skipped.length ? { skipped: skipped.slice(0, 50), note: "skipped 是目标位置已经存在（没有覆盖）或属于密钥类的文件" } : {}),
      }),
    };
  },
};

/**
 * Windows 上压缩的 zip 里，中文、日文文件名常常是 GBK / Shift_JIS 编码，又没标记 UTF-8，按 UTF-8 读就是乱码。
 * jszip 遇到没有 UTF-8 标记的文件名时调用这个函数：先严格按 UTF-8 解，失败再试 GBK、Shift_JIS。
 */
function decodeFileName(bytes: string[] | Uint8Array | Buffer) {
  const buf = Array.isArray(bytes) ? Uint8Array.from(bytes.map((b) => b.charCodeAt(0))) : bytes;
  for (const enc of ["utf-8", "gbk", "shift_jis"])
    try {
      return new TextDecoder(enc, { fatal: true }).decode(buf);
    } catch {
      /* 换下一种 */
    }
  return new TextDecoder("utf-8").decode(buf);
}

/** jszip 已经去掉了开头的 / 和 ../，这里再统一成 / 分隔；下面解压时还会检查一次最终路径 */
const fixName = (e: JSZip.JSZipObject) => e.name.replace(/\\/g, "/").replace(/^\/+/, "");

async function pack(workspace: string, p: string, to?: string) {
  const src = resolvePath(workspace, p, "read");
  const st = await fs.stat(/*turbopackIgnore: true*/ src.full).catch(() => null);
  if (!st) throw new Error(`不存在：${src.shown}。用 list_files 或 glob 确认路径`);
  const base = path.basename(src.full) || "workspace";
  const dst = resolvePath(workspace, to || `${src.inWorkspace && src.shown !== "." ? path.posix.dirname(src.shown) : "."}/${base}.zip`, "write");
  if (!/\.zip$/i.test(dst.full)) throw new Error(`to 要以 .zip 结尾，收到：${to}`);
  if (await fs.stat(/*turbopackIgnore: true*/ dst.full).catch(() => null)) throw new Error(`${dst.shown} 已存在。换一个名字，或先用 file_op 删除它`);

  const zip = new JSZip();
  let count = 0;
  let total = 0;
  const add = async (full: string, rel: string) => {
    if (full === dst.full || isSensitivePath(full)) return; // 不把自己和密钥打进去
    const s = await fs.lstat(/*turbopackIgnore: true*/ full);
    if (s.isSymbolicLink()) return;
    if (s.isDirectory()) {
      for (const name of await fs.readdir(/*turbopackIgnore: true*/ full)) {
        if (name === "node_modules" || name === ".git" || name === ".runs") continue;
        await add(path.join(/*turbopackIgnore: true*/ full, name), rel ? `${rel}/${name}` : name);
      }
      return;
    }
    if (++count > MAX_ENTRIES) throw new Error(`文件超过 ${MAX_ENTRIES} 个，换一个更小的目录打包`);
    total += s.size;
    if (total > MAX_TOTAL) throw new Error(`要打包的内容超过 ${MAX_TOTAL / 1048576} MB，换一个更小的目录`);
    zip.file(rel, await fs.readFile(/*turbopackIgnore: true*/ full), { date: s.mtime });
  };
  await add(src.full, base);
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(dst.full), { recursive: true });
  await fs.writeFile(/*turbopackIgnore: true*/ dst.full, buf);
  return { path: dst.shown, files: count, bytes: buf.length };
}
