import "server-only";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { resolvePath } from "../../server/access";
import { httpHint, safeFetch, UA } from "./web-fetch";
import type { Tool } from "./types";

/**
 * 整理文件：建目录、移动 / 改名、复制、删除。
 * 以前只能靠 run_command 的 mkdir / mv / rm：要等沙箱、要确认，Docker 不可用时就整个做不了。
 * 这些操作本身很简单，直接在 Node 里做，路径规则和其他文件工具一样（工作区 + 可读写的授权目录）。
 * 删除不可撤销，每次都先请用户确认。
 */
type OpArgs = { action: "mkdir" | "move" | "copy" | "delete"; path: string; to?: string; purpose?: string };

export const fileOp: Tool<OpArgs> = {
  spec: {
    name: "file_op",
    description:
      "整理文件和文件夹，返回 {action, path, to?}。action：mkdir 新建目录（自动建上级目录）；move 移动或改名；copy 复制（目录会整个复制）；delete 删除（会先请用户确认，不可撤销）。" +
      "适合：建目录、改名、归档、复制一份再改、删除不要的文件。能操作工作区和可读写的授权目录；从只读授权目录复制到工作区也可以。" +
      "不要用于：改文件内容（用 edit_file / write_file）；批量按规则处理很多文件（用 run_python 或 run_command）。不要用 run_command 的 mkdir、mv、cp、rm 代替它。" +
      "目标已存在时不覆盖，会报错。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["mkdir", "move", "copy", "delete"], description: "要做的操作" },
        path: { type: "string", description: "操作对象（move/copy 的来源）。相对工作区，或授权目录里的绝对路径" },
        to: { type: "string", description: "move/copy 的目标路径（含新文件名）。例：archive/2026/report.pdf" },
      },
      required: ["action", "path"],
    },
  },
  async run({ action, path: p, to, purpose }, ctx) {
    await fs.mkdir(ctx.workspace, { recursive: true });
    if (action === "mkdir") {
      const d = resolvePath(ctx.workspace, p, "write");
      await fs.mkdir(/*turbopackIgnore: true*/ d.full, { recursive: true });
      return { content: JSON.stringify({ action, path: d.shown }) };
    }
    if (action === "delete") {
      const d = resolvePath(ctx.workspace, p, "write");
      if (d.shown === ".") throw new Error("不能删除整个工作区");
      const st = await fs.stat(/*turbopackIgnore: true*/ d.full).catch(() => null);
      if (!st) throw new Error(`不存在：${d.shown}，不需要删除。用 list_files 确认路径`);
      const ok = (await ctx.confirm?.({ command: `删除 ${d.shown}${st.isDirectory() ? "（整个文件夹）" : ""}`, reason: purpose || "删除后无法恢复", readonly: false })) ?? true;
      if (!ok) return { content: JSON.stringify({ action, path: d.shown, denied: true, note: "用户拒绝了删除，不要换个方式再删，先问用户" }) };
      await fs.rm(/*turbopackIgnore: true*/ d.full, { recursive: true });
      return { content: JSON.stringify({ action, path: d.shown }) };
    }
    if (action === "move" || action === "copy") {
      if (!to) throw new Error(`${action} 需要 to（目标路径，含文件名）。例：{"action":"${action}","path":"a.txt","to":"backup/a.txt"}`);
      const src = resolvePath(ctx.workspace, p, action === "move" ? "write" : "read");
      const dst = resolvePath(ctx.workspace, to, "write");
      if (!(await exists(src.full))) throw new Error(`来源不存在：${src.shown}。用 list_files 或 glob 确认路径`);
      if (await exists(dst.full)) throw new Error(`目标已存在：${dst.shown}。换一个名字，或先删除它`);
      await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(dst.full), { recursive: true });
      if (action === "copy") await fs.cp(/*turbopackIgnore: true*/ src.full, dst.full, { recursive: true, errorOnExist: true });
      else
        await fs.rename(/*turbopackIgnore: true*/ src.full, dst.full).catch(async (e: NodeJS.ErrnoException) => {
          // 跨磁盘（例如工作区 → 外接硬盘上的授权目录）不能直接 rename：先复制再删
          if (e.code !== "EXDEV") throw e;
          await fs.cp(/*turbopackIgnore: true*/ src.full, dst.full, { recursive: true, errorOnExist: true });
          await fs.rm(/*turbopackIgnore: true*/ src.full, { recursive: true });
        });
      return { content: JSON.stringify({ action, path: src.shown, to: dst.shown }) };
    }
    throw new Error(`action 只能是 mkdir、move、copy、delete，收到：${action}。改内容用 edit_file / write_file`);
  },
};

const exists = (p: string) => fs.stat(/*turbopackIgnore: true*/ p).then(() => true, () => false);

/**
 * 下载文件到工作区：PDF、Excel、图片、压缩包这类 web_fetch 读不了的东西，先下载，再用 read_document / run_python 处理。
 * 沙箱默认断网，run_python 里 urllib 下载会失败；这个工具在 A.ai 服务端下载，和 web_fetch 一样防 SSRF。
 */
const MAX_DOWNLOAD = 50 * 1024 * 1024;

export const downloadFile: Tool<{ url: string; path?: string; purpose?: string }> = {
  spec: {
    name: "download_file",
    description:
      "把一个公开网址的文件下载到工作区（最大 50 MB），返回 {path, bytes, contentType}。" +
      "适合：PDF、Excel、图片、数据集、压缩包这类不是网页的文件；下载后用 read_document、read_file 或 run_python 处理。沙箱默认断网，要下载东西一律用它，不要在 run_python / run_command 里用 requests、curl、wget。" +
      "不要用于：读网页正文（用 web_fetch）。不能访问本机和内网地址。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "完整的 http(s) 网址，必须来自用户或之前的工具结果" },
        path: { type: "string", description: "保存位置（相对工作区，含文件名）。不填 = downloads/ 下，用网址里的文件名" },
      },
      required: ["url"],
    },
  },
  async run({ url, path: p }, ctx) {
    const timeout = AbortSignal.timeout(60_000);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
    const res = await safeFetch(url, { signal, headers: { "User-Agent": UA } });
    if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}${httpHint(res.status)}`);
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_DOWNLOAD) throw new Error(`文件太大（${(len / 1048576).toFixed(1)} MB），超过 50 MB 上限。告诉用户文件太大，或者找一个更小的版本`);

    const name = p || path.posix.join("downloads", fileNameOf(res, url));
    const dst = resolvePath(ctx.workspace, name, "write");
    await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(dst.full), { recursive: true });
    // 边下边数字节：content-length 可能没有或不准，超过上限就中断并删掉半个文件
    let bytes = 0;
    const counter = async function* (src: AsyncIterable<Uint8Array>) {
      for await (const chunk of src) {
        bytes += chunk.length;
        if (bytes > MAX_DOWNLOAD) throw new Error("文件超过 50 MB 上限，已停止下载");
        yield chunk;
      }
    };
    try {
      await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), counter, createWriteStream(/*turbopackIgnore: true*/ dst.full));
    } catch (e) {
      await fs.rm(/*turbopackIgnore: true*/ dst.full, { force: true });
      throw e;
    }
    return { content: JSON.stringify({ path: dst.shown, bytes, contentType: (res.headers.get("content-type") || "").split(";")[0] }) };
  },
};

/** 文件名：优先 Content-Disposition，其次网址最后一段，都没有就叫 download */
function fileNameOf(res: Response, url: string) {
  const cd = res.headers.get("content-disposition") || "";
  const m = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(cd);
  const dec = (x: string) => {
    try {
      return decodeURIComponent(x);
    } catch {
      return x;
    }
  };
  let name = m ? dec(m[1] || m[2]) : dec(new URL(res.url || url).pathname.split("/").pop() || "");
  name = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim();
  return name && name !== "." && name !== ".." ? name : "download";
}
