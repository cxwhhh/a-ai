import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../../server/db";
import { resolvePath } from "../../server/access";
import type { Tool } from "./types";

/**
 * 文件工具：只能在当前用户自己的“工作区”目录里读写（.data/users/<用户id>/workspace）。
 * 这是 agent 安全的基本功 —— 沙箱（sandbox）：
 * （代码里的 turbopackIgnore 注释只是告诉打包器：这些路径是运行时才确定的，不要去追踪）
 * 模型给出的路径一律先 resolve，再检查是否还在工作区内，防止 ../../ 逃逸到系统文件或别的用户的目录。
 */
const MAX_READ = 20000;

export function workspaceOf(userId: string) {
  if (!/^[a-z0-9_-]+$/i.test(userId)) throw new Error("非法用户 id");
  return path.join(/*turbopackIgnore: true*/ DATA_DIR, "users", userId, "workspace");
}

export function safePath(root: string, p = ".") {
  const full = path.resolve(root, p);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error("路径超出工作区");
  return full;
}

export const listFiles: Tool<{ path?: string }> = {
  parallelSafe: true,
  spec: {
    name: "list_files",
    description:
      "列出一个目录下的文件和子文件夹（只看这一层），返回 {path, items: [{name, size}]}，文件夹名以 / 结尾。" +
      "适合：不知道有哪些文件时先看一眼，或确认某个文件夹里有什么。" +
      "不要用于：在多层目录里找某类文件（用 glob）；找包含某段文字的文件（用 grep）。同一个目录看过就不要再列，除非刚刚改动过。" +
      "路径：相对路径 = 工作区，授权目录用绝对路径。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "目录：相对工作区的路径，或授权目录里的绝对路径。例：.、data、/Users/me/Documents。不填 = 工作区根目录" } },
    },
  },
  async run({ path: p }, ctx) {
    await fs.mkdir(ctx.workspace, { recursive: true });
    const { full: dir, shown } = resolvePath(ctx.workspace, p, "read");
    const entries = await fs.readdir(/*turbopackIgnore: true*/ dir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
      throw new Error(e.code === "ENOENT" ? `目录不存在：${shown}。用 list_files 看上一级目录，或用 glob 按名字找` : e.code === "ENOTDIR" ? `${shown} 是文件不是目录，用 read_file 读它` : e.message);
    });
    const items = await Promise.all(
      entries
        .filter((e) => !e.name.startsWith("."))
        .map(async (e) => {
          const st = await fs.stat(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ dir, e.name));
          return { name: e.name + (e.isDirectory() ? "/" : ""), size: e.isDirectory() ? undefined : st.size };
        }),
    );
    return { content: JSON.stringify({ path: shown, items }) };
  },
};

/** read_file 一次最多返回多少行 / 多少字；单行太长（压缩过的 js、csv 大单元格）只留前面一段 */
const READ_LINES = 400;
const MAX_LINE = 2000;

export const readFile: Tool<{ path: string; offset?: number; limit?: number }> = {
  parallelSafe: true,
  spec: {
    name: "read_file",
    description:
      "读取一个文本文件（代码、txt、md、csv、json、日志），返回 {path, totalLines, startLine, endLine, content, nextOffset}。" +
      "content 每行前面带行号和制表符（例：\"  12\\tprint(x)\"），行号只是显示用，不属于文件内容，edit_file 时不要带上。" +
      "默认从第 1 行读 400 行；文件更长时 nextOffset 是下一段的起始行，用 offset 继续读。大文件先用 grep 找到行号，再用 offset/limit 只读那一段。" +
      "不要用于：PDF、Word、Excel、PPT（用 read_document）；图片等二进制文件（用 run_python）；对 csv 做统计（用 run_python + pandas，不要整份读进来心算）。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对工作区的文件路径，或授权目录里的绝对路径。例：notes.md、/Users/me/Documents/a.txt" },
        offset: { type: "integer", description: "从第几行开始读（从 1 开始）。不填 = 1" },
        limit: { type: "integer", description: "最多读几行，默认 400，最大 2000" },
      },
      required: ["path"],
    },
  },
  async run({ path: p, offset, limit }, ctx) {
    const { full, shown } = resolvePath(ctx.workspace, p, "read");
    const st = await fs.stat(/*turbopackIgnore: true*/ full).catch(() => null);
    if (!st) throw new Error(`文件不存在：${shown}。先用 glob 或 list_files 确认文件名和路径`);
    if (st.isDirectory()) throw new Error(`${shown} 是目录不是文件，用 list_files 看里面有什么`);
    const text = await fs.readFile(/*turbopackIgnore: true*/ full, "utf8");
    if (text.slice(0, 8000).includes("\0")) throw new Error("这是二进制文件，不能按文本读取。PDF、Word、Excel、PPT 用 read_document；其他格式用 run_python 处理");
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop(); // 文件以换行结尾时，最后那个空串不算一行
    const start = Math.max(1, Math.floor(Number(offset) || 1));
    const max = Math.min(Math.max(1, Math.floor(Number(limit) || READ_LINES)), 2000);
    // 行数和总字数两个上限，先到哪个停在哪
    const out: string[] = [];
    let chars = 0;
    let i = start - 1;
    for (; i < lines.length && out.length < max; i++) {
      const line = lines[i].length > MAX_LINE ? lines[i].slice(0, MAX_LINE) + "…（本行过长，已截断）" : lines[i];
      if (chars + line.length > MAX_READ && out.length) break;
      chars += line.length + 1;
      out.push(`${String(i + 1).padStart(6)}\t${line}`);
    }
    return {
      content: JSON.stringify({
        path: shown,
        totalLines: lines.length,
        startLine: start,
        endLine: i,
        content: out.join("\n"),
        ...(i < lines.length ? { nextOffset: i + 1 } : {}),
        ...(start > lines.length && lines.length ? { note: `文件只有 ${lines.length} 行` } : {}),
      }),
    };
  },
};

/**
 * 精确替换：把文件里的 old_string 换成 new_string（和 Claude Code 的 Edit 工具同一个思路）。
 * 为什么不用 write_file 整体覆盖：改 1 行也要把整个文件重新生成一遍，又慢又费 token，
 * 还容易把没打算改的地方“顺手”改坏。只发要改的那一段，模型出错的面积小得多。
 * 要求 old_string 在文件里唯一：不唯一时报错并告诉模型出现在哪几行，让它多带几行上下文。
 */
export const editFile: Tool<{ path: string; old_string: string; new_string: string; replace_all?: boolean; purpose?: string }> = {
  spec: {
    name: "edit_file",
    description:
      "修改已有的文本文件：把 old_string 精确替换成 new_string，返回 {path, replacements, line, preview}（preview 是改完后的那一段，不用再 read_file 确认）。" +
      "适合：改已有文件里的一处或几处。使用前先用 read_file 看过要改的那一段。" +
      "old_string 必须和文件内容逐字一致（包括缩进和空格，不要带 read_file 显示的行号），并且在文件中唯一；不唯一时多带几行上下文，确实要全部替换时设 replace_all=true。new_string 为空字符串 = 删除这段。" +
      "不要用于：新建文件或几乎整个重写（用 write_file）；改名、移动（用 file_op）。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对工作区的文件路径，或可读写授权目录里的绝对路径。例：src/main.py" },
        old_string: { type: "string", description: "要被替换的原文（逐字一致，含缩进）" },
        new_string: { type: "string", description: "替换后的新内容" },
        replace_all: { type: "boolean", description: "替换所有出现的地方（例如改变量名）。默认 false" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  async run({ path: p, old_string, new_string, replace_all }, ctx) {
    const { full, shown } = resolvePath(ctx.workspace, p, "write");
    let text: string;
    try {
      text = await fs.readFile(/*turbopackIgnore: true*/ full, "utf8");
    } catch {
      throw new Error(`文件不存在：${shown}。新建文件请用 write_file`);
    }
    let oldS = String(old_string ?? "");
    let newS = String(new_string ?? "");
    if (!oldS) throw new Error("old_string 不能为空。新建或整体重写文件请用 write_file");
    if (oldS === newS) throw new Error("old_string 和 new_string 相同，没有需要修改的内容。如果文件已经是想要的样子，这一步可以跳过");
    // Windows 换行（\r\n）的文件：模型给的一般是 \n，统一成文件自己的换行再找
    if (!text.includes(oldS) && text.includes("\r\n")) {
      oldS = oldS.replace(/\r?\n/g, "\r\n");
      newS = newS.replace(/\r?\n/g, "\r\n");
    }

    const positions = findAll(text, oldS);
    if (!positions.length) throw new Error(notFoundHint(text, oldS));
    if (positions.length > 1 && !replace_all)
      throw new Error(
        `old_string 在文件中出现了 ${positions.length} 次（第 ${positions.map((i) => lineAt(text, i)).slice(0, 10).join("、")} 行），无法确定改哪一处。` +
          "请多带几行上下文让它唯一，或者设 replace_all=true 全部替换。",
      );

    // 用 split/join 而不是 String.replace：replace 会把 new_string 里的 $& $1 当成特殊符号
    const next = replace_all ? text.split(oldS).join(newS) : text.slice(0, positions[0]) + newS + text.slice(positions[0] + oldS.length);
    await fs.writeFile(/*turbopackIgnore: true*/ full, next, "utf8");

    // 返回修改后那一段（前后各带 2 行），模型不用再 read_file 就能确认改对了
    const line = lineAt(next, positions[0]);
    const all = next.split(/\r?\n/);
    const span = newS.split(/\r?\n/).length;
    const from = Math.max(1, line - 2);
    const to = Math.min(all.length, line + span + 1);
    const preview = all
      .slice(from - 1, to)
      .map((l, k) => `${String(from + k).padStart(6)}\t${l}`)
      .join("\n");
    return { content: JSON.stringify({ path: shown, replacements: replace_all ? positions.length : 1, line, preview: preview.slice(0, 4000) }) };
  },
};

function findAll(text: string, s: string) {
  const out: number[] = [];
  for (let i = text.indexOf(s); i !== -1; i = text.indexOf(s, i + s.length)) out.push(i);
  return out;
}

const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;

/**
 * 找不到时给模型一个线索：最常见的原因是缩进 / 空格不一致，或者带上了 read_file 的行号。
 * 用 old_string 的第一行（去掉首尾空白）在文件里找，找到就告诉它在第几行、原文长什么样。
 */
function notFoundHint(text: string, oldS: string) {
  let msg = "在文件中找不到 old_string。";
  if (/^\s*\d+\t/.test(oldS)) return msg + "看起来带上了 read_file 显示的行号，请去掉每行开头的行号和制表符再试。";
  const first = oldS.split("\n").find((l) => l.trim())?.trim();
  if (first) {
    const lines = text.split(/\r?\n/);
    const hit = lines.findIndex((l) => l.includes(first));
    if (hit !== -1) return msg + `第一行在文件第 ${hit + 1} 行能找到，但后面的内容或缩进不一致。文件原文：\n${lines.slice(hit, hit + 6).join("\n")}\n请先用 read_file 读这一段，照原文复制 old_string。`;
  }
  return msg + "请先用 read_file（或 grep）找到要改的原文，逐字复制（包括缩进）后再试。";
}

export const writeFile: Tool<{ path: string; content: string; purpose?: string }> = {
  spec: {
    name: "write_file",
    description:
      "创建一个文本文件，或整体覆盖已有文件（自动创建上级目录），返回 {path, bytes}。" +
      "适合：新建代码、脚本、配置、数据文件，或者要把文件彻底重写。用户指定了保存路径，或后面的脚本要读这个文件时，用它。" +
      "不要用于：只改已有文件的一部分（用 edit_file，更快也不容易改坏）；只是给用户看的成品，不需要留在工作区（用 create_artifact）；二进制文件、图片（用 run_python 生成）。" +
      "同名文件会被直接覆盖，覆盖用户的文件之前先确认。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对工作区的文件路径，或可读写授权目录里的绝对路径。例：output/report.md" },
        content: { type: "string", description: "文件的完整内容（不是增量修改）" },
      },
      required: ["path", "content"],
    },
  },
  async run({ path: p, content }, ctx) {
    const { full, shown } = resolvePath(ctx.workspace, p, "write");
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, String(content ?? ""), "utf8");
    return { content: JSON.stringify({ path: shown, bytes: Buffer.byteLength(String(content ?? "")) }) };
  },
};
