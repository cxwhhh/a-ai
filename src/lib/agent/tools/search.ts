import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolvePath } from "../../server/access";
import { isSensitivePath } from "../../server/sandbox";
import type { Tool } from "./types";

/**
 * 搜索工具：glob 按文件名找文件，grep 按内容找行（对应 Claude Code 的 Glob / Grep）。
 *
 * 为什么需要它们：没有搜索时，模型只能 list_files 一层层翻、再把整个文件 read_file 进来，
 * 项目稍大一点就会把步数和上下文都耗光。有了 glob/grep，“找到 → 只读那一段 → edit_file 改”三步就够了。
 *
 * 全部用 Node 自己实现（不依赖系统里装没装 rg / find），只在工作区里搜，
 * 并跳过 node_modules、.git、虚拟环境这类又大又没用的目录（想搜它们里面时，把 path 直接指过去）。
 */

/** 这些目录不进去：体积大、几乎不会是要找的东西（以 . 开头的 .git、.venv、.local 等本来就跳过） */
const SKIP_DIRS = new Set(["node_modules", "__pycache__", "venv", "site-packages"]);
/** 最多看多少个文件，防止工作区特别大时一次搜索卡很久 */
const MAX_FILES = 20000;
/** 超过这个大小的文件 grep 跳过（多半是数据或日志） */
const MAX_GREP_SIZE = 2 * 1024 * 1024;

interface Entry {
  rel: string; // 相对工作区，用 / 分隔
  full: string;
  mtimeMs: number;
  size: number;
}

/** 深度优先遍历目录，逐个产出文件。隐藏文件和 SKIP_DIRS 跳过 */
async function* walk(root: string, dir: string, signal?: AbortSignal, budget = { n: MAX_FILES }): AsyncGenerator<Entry> {
  let entries;
  try {
    entries = await fs.readdir(/*turbopackIgnore: true*/ dir, { withFileTypes: true });
  } catch {
    return; // 没权限或刚被删：跳过
  }
  for (const e of entries) {
    if (signal?.aborted || budget.n <= 0) return;
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    const full = path.join(/*turbopackIgnore: true*/ dir, e.name);
    if (isSensitivePath(full)) continue; // 私钥、.env 这类文件不列出、不搜索（授权目录里也一样）
    if (e.isDirectory()) yield* walk(root, full, signal, budget);
    else if (e.isFile()) {
      budget.n--;
      const st = await fs.stat(/*turbopackIgnore: true*/ full).catch(() => null);
      if (st) yield { rel: path.relative(root, full).split(path.sep).join("/"), full, mtimeMs: st.mtimeMs, size: st.size };
    }
  }
}

/**
 * glob 模式 → 正则。支持 *、**、?、{a,b}、[abc]。
 *   *.py         → 任意目录下的 .py（不含 / 的模式按文件名匹配，和 rg --glob 一样，更符合直觉）
 *   src/**\/*.ts  → src 下任意深度的 .ts
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // **/ = 零层或多层目录；结尾的 ** = 任意内容
        if (glob[i + 2] === "/") (re += "(?:.*/)?"), (i += 2);
        else (re += ".*"), i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) re += "\\{";
      else {
        re += "(?:" + glob.slice(i + 1, end).split(",").map(escape).join("|") + ")";
        i = end;
      }
    } else if (c === "[") {
      const end = glob.indexOf("]", i);
      if (end === -1) re += "\\[";
      else {
        re += "[" + glob.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\") + "]";
        i = end;
      }
    } else re += escape(c);
  }
  return new RegExp(`^${re}$`, "i");
}
const escape = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/** 不含 / 的模式只比文件名，含 / 的比完整相对路径 */
function matcher(glob: string) {
  const g = glob.replace(/^\.\//, "");
  const re = globToRegExp(g);
  return g.includes("/") ? (rel: string) => re.test(rel) : (rel: string) => re.test(rel.slice(rel.lastIndexOf("/") + 1));
}

export const glob: Tool<{ pattern: string; path?: string }> = {
  parallelSafe: true,
  spec: {
    name: "glob",
    description:
      "按文件名模式在目录树里递归找文件，返回 {files: [{path, size}], total, truncated}，最近修改的排在前面，最多 200 个。" +
      "适合：找某一类文件（*.csv）、知道文件名但不知道在哪个目录。" +
      "模式不含 / 时匹配任意目录下的文件名（*.py = 所有 Python 文件）；含 / 时匹配相对路径（src/**/*.ts）。支持 * ** ? {a,b}。自动跳过隐藏目录、node_modules、虚拟环境。" +
      "不要用于：按内容找（用 grep）；只看一个目录有什么（用 list_files）。不要用 run_command 的 find 代替它。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "文件名模式。例：*.csv、**/test_*.py、src/**/*.{ts,tsx}" },
        path: { type: "string", description: "在哪个目录下找：相对工作区的路径，或授权目录的绝对路径。不填 = 整个工作区" },
      },
      required: ["pattern"],
    },
  },
  async run({ pattern, path: p }, ctx) {
    if (!String(pattern ?? "").trim()) throw new Error("pattern 不能为空。例：*.csv、**/*.py；想看一个目录有什么用 list_files");
    await fs.mkdir(ctx.workspace, { recursive: true });
    const { full: base, shown, inWorkspace } = resolvePath(ctx.workspace, p, "read");
    const match = matcher(String(pattern));
    const hits: Entry[] = [];
    for await (const e of walk(base, base, ctx.signal)) if (match(e.rel)) hits.push(e);
    hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
    // 工作区里返回相对路径；授权目录里返回绝对路径，拿去 read_file 能直接用
    const prefix = inWorkspace ? (shown === "." ? "" : shown) : base;
    return {
      content: JSON.stringify({
        files: hits.slice(0, 200).map((e) => ({ path: prefix ? `${prefix}/${e.rel}` : e.rel, size: e.size })),
        total: hits.length,
        truncated: hits.length > 200,
      }),
    };
  },
};

export const grep: Tool<{
  pattern: string;
  path?: string;
  glob?: string;
  ignore_case?: boolean;
  output_mode?: "content" | "files" | "count";
  context?: number;
  max_results?: number;
}> = {
  parallelSafe: true,
  spec: {
    name: "grep",
    description:
      "按正则表达式搜索文本文件的内容，返回匹配的行（“路径:行号: 内容”）、包含匹配的文件列表（output_mode=files）或每个文件的匹配数（count）。" +
      "适合：找函数定义、变量在哪里用到、报错信息出自哪里、某个配置项。找到后用 read_file 的 offset 只读附近几十行，再用 edit_file 修改。" +
      "不要用于：按文件名找（用 glob）；搜 PDF、Word、Excel 里的文字（先用 read_document 读出来）。不要用 run_command 的 grep / rg 代替它。" +
      "正则是 JavaScript 语法。跳过二进制文件、超过 2MB 的文件和隐藏目录。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "正则表达式。例：def\\s+load_data、TODO|FIXME、import pandas" },
        path: { type: "string", description: "搜索的目录或单个文件：相对工作区的路径，或授权目录的绝对路径。不填 = 整个工作区" },
        glob: { type: "string", description: "只搜文件名符合这个模式的文件。例：*.py、*.{ts,tsx}" },
        ignore_case: { type: "boolean", description: "忽略大小写，默认 false" },
        output_mode: { type: "string", enum: ["content", "files", "count"], description: "返回内容，默认 content" },
        context: { type: "integer", description: "content 模式下每个匹配前后多显示几行，默认 0，最大 5" },
        max_results: { type: "integer", description: "最多返回多少条（行 / 文件），默认 100，最大 500" },
      },
      required: ["pattern"],
    },
  },
  async run(args, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(String(args.pattern ?? ""), args.ignore_case ? "i" : "");
    } catch (e) {
      throw new Error(`正则表达式有误：${e instanceof Error ? e.message : e}。( ) [ ] . * + ? 这些字符要匹配原文时前面加 \\，例：foo\\(1\\)`);
    }
    if (!args.pattern) throw new Error("pattern 不能为空。例：def load_data、TODO|FIXME");
    await fs.mkdir(ctx.workspace, { recursive: true });
    const mode = args.output_mode === "files" || args.output_mode === "count" ? args.output_mode : "content";
    const ctxLines = Math.min(Math.max(0, Math.floor(Number(args.context) || 0)), 5);
    const max = Math.min(Math.max(1, Math.floor(Number(args.max_results) || 100)), 500);
    const only = args.glob ? matcher(String(args.glob)) : null;

    // path 可以是单个文件
    const { full: target, inWorkspace } = resolvePath(ctx.workspace, args.path, "read");
    const ws = resolvePath(ctx.workspace, ".", "read").full;
    const st = await fs.stat(/*turbopackIgnore: true*/ target).catch(() => null);
    if (!st) throw new Error(`路径不存在：${args.path}。先用 list_files 或 glob 确认；不填 path 会搜整个工作区`);
    const files: AsyncIterable<Entry> | Entry[] = st.isFile()
      ? [{ rel: path.basename(target), full: target, mtimeMs: st.mtimeMs, size: st.size }]
      : walk(target, target, ctx.signal);
    const toRel = (full: string) => (inWorkspace ? path.relative(ws, full).split(path.sep).join("/") : full);

    const out: string[] = [];
    const counts: { path: string; count: number }[] = [];
    let total = 0;
    let truncated = false;
    let skipped = 0;
    for await (const f of files) {
      if (only && !only(f.rel)) continue;
      if (f.size > MAX_GREP_SIZE) {
        skipped++;
        continue;
      }
      const buf = await fs.readFile(/*turbopackIgnore: true*/ f.full).catch(() => null);
      if (!buf || buf.subarray(0, 8000).includes(0)) continue; // 有 \0 = 二进制文件
      const lines = buf.toString("utf8").split(/\r?\n/);
      const rel = toRel(f.full);
      let n = 0;
      let lastPrinted = -1; // 上下文行不要重复打印
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        n++;
        total++;
        if (mode !== "content") continue;
        if (out.length >= max) {
          truncated = true;
          continue;
        }
        const from = Math.max(i - ctxLines, lastPrinted + 1);
        if (ctxLines && lastPrinted >= 0 && from > lastPrinted + 1) out.push("--");
        for (let k = from; k <= Math.min(i + ctxLines, lines.length - 1); k++) {
          // 匹配行用“:”，上下文行用“-”，和 grep -n 的习惯一样
          out.push(`${rel}:${k + 1}${k === i ? ":" : "-"} ${clip(lines[k])}`);
          lastPrinted = k;
        }
      }
      if (n) counts.push({ path: rel, count: n });
      if (mode !== "content" && counts.length >= max) {
        truncated = true;
        break;
      }
    }

    const base = { pattern: String(args.pattern), totalMatches: total, files: counts.length, truncated, ...(skipped ? { skippedLargeFiles: skipped } : {}) };
    if (mode === "files") return { content: JSON.stringify({ ...base, paths: counts.map((c) => c.path) }) };
    if (mode === "count") return { content: JSON.stringify({ ...base, counts }) };
    return { content: JSON.stringify({ ...base, output: out.join("\n") || "（没有匹配）" }) };
  },
};

const clip = (s: string) => (s.length > 300 ? s.slice(0, 300) + "…" : s);
