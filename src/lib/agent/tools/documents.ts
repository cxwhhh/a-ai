import "server-only";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { resolvePath } from "../../server/access";
import type { Tool } from "./types";

/**
 * read_document：把 PDF、Word、Excel、PPT 变成文字给模型看。
 *
 * 为什么单独做一个工具：以前这类文件只能让模型写 Python（pypdf、openpyxl…）去读，
 * 一要沙箱能跑 Python，二要装对库，三要模型把代码写对，任何一步出错就是一串报错。
 * 这里直接在 Node 里解析，不依赖 Docker 和 Python：
 *   PDF   pdfjs-dist（Firefox 用的 pdf.js）按页取文字，带 cmaps 才能读中文、日文
 *   docx  mammoth 取正文
 *   xlsx / pptx 本质是 zip 包里的 XML，用 jszip 解开后自己取单元格 / 文本框里的文字
 * 输出有上限（每次 20000 字），太长时用 offset 接着读，和 read_file 的分页是一个思路。
 */
const MAX_CHARS = 20000;
const MAX_BYTES = 50 * 1024 * 1024;
/** Excel 每个工作表最多输出多少行：表格大时先看结构，具体分析交给 run_python */
const MAX_ROWS = 2000;

type Args = { path: string; pages?: string; sheet?: string; offset?: number };

export const readDocument: Tool<Args> = {
  parallelSafe: true,
  spec: {
    name: "read_document",
    description:
      "读取 PDF、Word（.docx）、Excel（.xlsx）、PowerPoint（.pptx）文件里的文字，返回 {path, type, content, totalChars, nextOffset?, ...}。" +
      "PDF 按页标出“--- 第 N 页 ---”，可以用 pages 只读某几页；Excel 每个工作表输出成制表符分隔的行，可以用 sheet 只读一个表；PPT 按幻灯片标出。内容超过 20000 字时返回 nextOffset，用 offset 接着读。" +
      "适合：用户上传或授权目录里的文档，先读出来再回答。" +
      "不要用于：纯文本和代码（用 read_file）；要对表格做计算、筛选、画图（用 run_python + pandas）。扫描版 PDF（整页是图片）没有文字层，读不出来；旧格式 .doc/.xls/.ppt 不支持。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径：相对工作区，或授权目录里的绝对路径。例：reports/q3.pdf、/Users/me/Documents/合同.docx" },
        pages: { type: "string", description: "只读 PDF 的这些页，例：3、1-5、2,4,10-12。不填 = 全部" },
        sheet: { type: "string", description: "只读 Excel 里这个工作表（名称）。不填 = 全部工作表" },
        offset: { type: "integer", description: "从第几个字开始返回（上次结果里的 nextOffset）。不填 = 0" },
      },
      required: ["path"],
    },
  },
  async run({ path: p, pages, sheet, offset }, ctx) {
    const { full, shown } = resolvePath(ctx.workspace, p, "read");
    const st = await fs.stat(/*turbopackIgnore: true*/ full).catch(() => null);
    if (!st) throw new Error(`文件不存在：${shown}。先用 glob 按文件名找（例：*.pdf），用户上传的文件在 uploads/ 下`);
    if (st.isDirectory()) throw new Error(`${shown} 是目录不是文件，用 list_files 看里面有什么`);
    if (st.size > MAX_BYTES) throw new Error(`文件太大（${(st.size / 1048576).toFixed(1)} MB），超过 50 MB 上限。可以用 pages 只读几页（PDF），或用 run_python 分块处理`);
    const ext = path.extname(full).toLowerCase();
    const buf = await fs.readFile(/*turbopackIgnore: true*/ full);

    let text: string;
    const extra: Record<string, unknown> = {};
    if (ext === ".pdf") {
      const r = await readPdf(buf, pages);
      text = r.text;
      extra.totalPages = r.totalPages;
      if (!text.replace(/--- 第 \d+ 页 ---/g, "").trim()) extra.note = "没有取到文字：可能是扫描版 PDF（整页是图片），需要 OCR 才能读";
    } else if (ext === ".docx") {
      const mammoth = await import("mammoth");
      text = (await mammoth.extractRawText({ buffer: buf })).value.replace(/\n{3,}/g, "\n\n").trim();
    } else if (ext === ".xlsx" || ext === ".xlsm") {
      const r = await readXlsx(buf, sheet);
      text = r.text;
      extra.sheets = r.sheets;
    } else if (ext === ".pptx") {
      const r = await readPptx(buf);
      text = r.text;
      extra.slides = r.slides;
    } else if ([".doc", ".xls", ".ppt"].includes(ext)) {
      throw new Error(`不支持旧格式 ${ext}（沙箱里也没有能转换它的软件）。用 ask_user 请用户另存为 ${ext}x 后重新上传`);
    } else if (buf.subarray(0, 8000).includes(0)) {
      throw new Error(`不认识的二进制格式 ${ext || "（无扩展名）"}。read_document 只支持 pdf、docx、xlsx、pptx；其他格式（图片、压缩包等）用 run_python 或 run_command 处理`);
    } else {
      text = buf.toString("utf8"); // csv、txt、md 之类：照样能读，顺便省得模型换工具
    }

    const start = Math.max(0, Math.floor(Number(offset) || 0));
    const end = Math.min(text.length, start + MAX_CHARS);
    return {
      content: JSON.stringify({
        path: shown,
        type: ext.slice(1) || "text",
        ...extra,
        totalChars: text.length,
        content: text.slice(start, end),
        ...(end < text.length ? { nextOffset: end } : {}),
      }),
    };
  },
};

/* ---------------- PDF ---------------- */

async function readPdf(buf: Buffer, pages?: string) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // 中文、日文 PDF 的字体编码要靠 cmaps 才能还原成文字；不给就只能取到空白（standard_fonts 同理）
  const base = pdfjsDir();
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    cMapUrl: path.join(base, "cmaps") + path.sep,
    cMapPacked: true,
    standardFontDataUrl: path.join(base, "standard_fonts") + path.sep,
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    const want = parsePages(pages, doc.numPages);
    const parts: string[] = [];
    for (const n of want) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      // 每个 item 是一小段文字；hasEOL = 这段后面换行
      const text = tc.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : "") : "")).join("");
      parts.push(`--- 第 ${n} 页 ---\n${text.trim()}`);
      page.cleanup();
    }
    return { totalPages: doc.numPages, text: parts.join("\n\n") };
  } finally {
    await task.destroy();
  }
}

/** pdfjs-dist 的安装目录（cmaps、standard_fonts 在里面）。standalone 部署时 node_modules 就在工作目录下 */
function pdfjsDir() {
  try {
    return path.dirname(createRequire(path.join(process.cwd(), "package.json")).resolve("pdfjs-dist/package.json"));
  } catch {
    return path.join(process.cwd(), "node_modules", "pdfjs-dist");
  }
}

/** "1-3,5" → {1,2,3,5}；不填 = 全部页 */
export function parsePages(spec: string | undefined, total: number): Set<number> {
  const all = new Set(Array.from({ length: total }, (_, i) => i + 1));
  if (!spec?.trim()) return all;
  const out = new Set<number>();
  for (const part of spec.split(/[,，\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:\s*[-~]\s*(\d+))?$/.exec(part);
    if (!m) throw new Error(`pages 格式不对：${spec}。例：3、1-5、2,4,10-12`);
    const a = +m[1];
    const b = m[2] ? +m[2] : a;
    for (let i = Math.max(1, Math.min(a, b)); i <= Math.min(total, Math.max(a, b)); i++) out.add(i);
  }
  if (!out.size) throw new Error(`pages 超出范围：这个 PDF 只有 ${total} 页`);
  return out;
}

/* ---------------- Excel（xlsx = zip 里的 XML） ---------------- */

async function readXlsx(buf: Buffer, only?: string) {
  const sheets = await xlsxSheets(buf);
  if (only && !sheets.some((s) => s.name === only)) throw new Error(`没有名为「${only}」的工作表。现有：${sheets.map((s) => s.name).join("、")}`);

  const parts: string[] = [];
  const info: { name: string; rows: number; cols: number }[] = [];
  for (const { name, rows } of sheets) {
    if (only && name !== only) continue;
    const cols = Math.max(0, ...rows.map((r) => r.length));
    info.push({ name, rows: rows.length, cols });
    const shownRows = rows.slice(0, MAX_ROWS).map((r) => r.join("\t"));
    if (rows.length > MAX_ROWS) shownRows.push(`…（还有 ${rows.length - MAX_ROWS} 行没显示，用 query_data 筛选统计，或用 run_python 处理）`);
    parts.push(`## 工作表「${name}」（${rows.length} 行 × ${cols} 列）\n${shownRows.join("\n")}`);
  }
  return { text: parts.join("\n\n"), sheets: info };
}

/** 把 xlsx 解析成 [{工作表名, 二维数组}]。read_document 用它显示文字，query_data 用它建表 */
export async function xlsxSheets(buf: Buffer): Promise<{ name: string; rows: string[][] }[]> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);
  const xml = async (name: string) => (await zip.file(name)?.async("string")) ?? "";

  // 共享字符串表：单元格里 t="s" 的值是这个表的下标
  const shared = [...(await xml("xl/sharedStrings.xml")).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1], "t").join(""));
  // 工作表名称 → 文件：workbook.xml 里有 name 和 r:id，rels 里 r:id → sheetN.xml
  const rels = new Map([...(await xml("xl/_rels/workbook.xml.rels")).matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], "Id"), attr(m[0], "Target")]));
  const sheets = [...(await xml("xl/workbook.xml")).matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
    name: decode(attr(m[0], "name")),
    file: "xl/" + (rels.get(attr(m[0], "r:id")) ?? "").replace(/^\/?xl\//, ""),
  }));

  const out: { name: string; rows: string[][] }[] = [];
  for (const s of sheets) {
    const rows: string[][] = [];
    for (const row of (await xml(s.file)).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const col = colIndex(attr(c[1], "r"));
        const type = attr(c[1], "t");
        const body = c[2] ?? "";
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
        const value = type === "s" ? shared[+v] ?? "" : type === "inlineStr" ? texts(body, "t").join("") : type === "b" ? (v === "1" ? "TRUE" : "FALSE") : decode(v);
        cells[col >= 0 ? col : cells.length] = value.replace(/[\t\r\n]+/g, " ");
      }
      rows.push(Array.from(cells, (x) => x ?? ""));
    }
    while (rows.length && rows.at(-1)!.every((x) => !x)) rows.pop();
    out.push({ name: s.name, rows });
  }
  return out;
}

/** "AB12" → 27（从 0 开始的列号） */
function colIndex(ref: string) {
  const letters = /^[A-Z]+/.exec(ref)?.[0];
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/* ---------------- PowerPoint ---------------- */

async function readPptx(buf: Buffer) {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => num(a) - num(b));
  const parts: string[] = [];
  for (const name of slides) {
    const x = (await zip.file(name)!.async("string")) ?? "";
    // 一个 <a:p> 是一段：段内的 <a:t> 拼起来，段之间换行
    const paras = [...x.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)].map((m) => texts(m[0], "a:t").join("")).filter((t) => t.trim());
    parts.push(`--- 第 ${num(name)} 张幻灯片 ---\n${paras.join("\n")}`);
  }
  return { text: parts.join("\n\n"), slides: slides.length };
}

const num = (s: string) => Number(/(\d+)\.xml$/.exec(s)?.[1] ?? 0);

/* ---------------- XML 小工具 ---------------- */

function texts(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => decode(m[1]));
}

function attr(tag: string, name: string): string {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? "";
}

function decode(s: string) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}
