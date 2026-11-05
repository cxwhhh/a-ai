import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolvePath } from "../../server/access";
import { xlsxSheets } from "./documents";
import type { Tool } from "./types";

/**
 * 用 SQL 查表格数据：把 CSV / TSV / Excel / JSON 文件读成临时表，执行一条 SELECT，返回结果。
 *
 * 为什么需要它：“按月汇总、筛出前 10、两张表按客户 id 对一下”是最常见的数据问题。
 * 以前只能 read_document 把整张表读进上下文让模型心算（又贵又容易算错），或者在 run_python 里写 pandas（要 Docker）。
 * SQL 是模型写得最熟的查询语言之一，一条 GROUP BY 就能拿到准确结果，只把结果（而不是整张表）放进上下文。
 *
 * 实现：Node 自带的 node:sqlite，内存数据库，查完就丢，不碰 A.ai 自己的 a.db。
 * SQLite 是同步执行的，一条写坏的 SQL（比如两张大表笛卡尔积）会卡住整个服务，
 * 所以查询放进一个单独的 node 子进程里跑，超过 15 秒直接 kill。
 * （试过 worker 线程：worker.terminate() 要等 JS 走到安全点才生效，SQLite 在 C 代码里死循环时根本停不下来，线程会一直占着 CPU）
 */
const MAX_FILE = 50 * 1024 * 1024;
const MAX_ROWS_IN = 200_000;
const TIMEOUT_MS = 15_000;

type Args = { files: string[]; sql: string; max_rows?: number };
type Table = { name: string; file: string; columns: string[]; types: ("REAL" | "TEXT")[]; rows: (string | number | null)[][] };

export const queryData: Tool<Args> = {
  parallelSafe: true,
  spec: {
    name: "query_data",
    description:
      "用 SQL（SQLite 语法）查询表格文件，返回 {columns, rows, rowCount, truncated, tables}。支持 .csv、.tsv、.xlsx、.json（对象数组）。" +
      "每个文件变成一张表：表名 = 文件名（不含扩展名）；Excel 有多个工作表时表名是“文件名_工作表名”。第一行是列名，列名含空格或中文时用双引号括起来。数字列可以直接 SUM、AVG、排序。" +
      "适合：汇总、分组、筛选、排序、去重、几张表按某一列关联（JOIN）。不知道列名时先查 SELECT * FROM 表 LIMIT 5。" +
      "不要用于：画图、复杂的清洗和变换（用 run_python）；只看文件里写了什么（用 read_document / read_file）。只能执行一条 SELECT，不能修改文件。",
    parameters: {
      type: "object",
      properties: {
        files: { type: "array", items: { type: "string" }, description: "要查询的文件路径。例：[\"uploads/sales.csv\", \"uploads/客户.xlsx\"]" },
        sql: { type: "string", description: "一条 SELECT 语句。例：SELECT month, SUM(amount) AS total FROM sales GROUP BY month ORDER BY month" },
        max_rows: { type: "integer", description: "最多返回几行，默认 200，最大 1000" },
      },
      required: ["files", "sql"],
    },
  },
  async run({ files, sql, max_rows }, ctx) {
    const list = (Array.isArray(files) ? files : [files]).map(String).filter(Boolean);
    if (!list.length) throw new Error('files 不能为空，例：["uploads/sales.csv"]');
    const q = String(sql ?? "").trim().replace(/;\s*$/, "");
    checkSql(q);
    const limit = Math.min(Math.max(1, Math.floor(Number(max_rows) || 200)), 1000);

    const tables: Table[] = [];
    for (const f of list.slice(0, 10)) tables.push(...(await loadFile(ctx.workspace, f)));
    // 表名重复（两个 data.csv 在不同目录）时加序号
    const seen = new Map<string, number>();
    for (const t of tables) {
      const n = seen.get(t.name) ?? 0;
      seen.set(t.name, n + 1);
      if (n) t.name = `${t.name}_${n + 1}`;
    }
    const schema = tables.map((t) => ({ name: t.name, file: t.file, rows: t.rows.length, columns: t.columns.map((c, i) => `${c}（${t.types[i] === "REAL" ? "数字" : "文字"}）`) }));

    const r = await runInWorker(tables, q, limit);
    if ("error" in r)
      throw new Error(`SQL 执行出错：${r.error}。可用的表和列：${JSON.stringify(schema)}。列名含空格或中文时用双引号，例：SELECT "销售额" FROM sales`);
    return { content: JSON.stringify({ columns: r.columns, rows: r.rows, rowCount: r.rowCount, truncated: r.rowCount > r.rows.length, tables: schema }) };
  },
};

/** 只允许一条 SELECT / WITH。ATTACH 能打开磁盘上的数据库文件，VACUUM INTO 能写文件，PRAGMA 能改设置，都拦下 */
function checkSql(q: string) {
  if (!q) throw new Error("sql 不能为空。例：SELECT * FROM sales LIMIT 5");
  if (!/^(select|with)\b/i.test(q)) throw new Error("只能执行 SELECT 查询（可以用 WITH 开头）。这个工具不能修改数据；要改数据请用 run_python 处理后另存");
  const noStrings = q.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, "''");
  if (noStrings.includes(";")) throw new Error("一次只能执行一条 SQL。需要多步时用 WITH 子查询，或者分几次调用");
  if (/\b(attach|detach|vacuum|pragma|load_extension|readfile|writefile)\b/i.test(noStrings)) throw new Error("不允许 ATTACH、PRAGMA、VACUUM、load_extension 这类语句，只能查询已加载的表");
}

/* ---------------- 读文件 → 表 ---------------- */

async function loadFile(workspace: string, p: string): Promise<Table[]> {
  const { full, shown } = resolvePath(workspace, p, "read");
  const st = await fs.stat(/*turbopackIgnore: true*/ full).catch(() => null);
  if (!st) throw new Error(`文件不存在：${shown}。用 glob 按文件名找（例：*.csv），用户上传的文件在 uploads/ 下`);
  if (st.isDirectory()) throw new Error(`${shown} 是目录，files 里要写具体的文件`);
  if (st.size > MAX_FILE) throw new Error(`${shown} 太大（${(st.size / 1048576).toFixed(1)} MB），超过 50 MB。用 run_python 分块处理`);
  const buf = await fs.readFile(/*turbopackIgnore: true*/ full);
  const ext = path.extname(full).toLowerCase();
  const base = tableName(path.basename(full, ext));

  if (ext === ".xlsx" || ext === ".xlsm") {
    const sheets = (await xlsxSheets(buf)).filter((s) => s.rows.length);
    if (!sheets.length) throw new Error(`${shown} 里没有数据`);
    return sheets.map((s) => toTable(sheets.length === 1 ? base : `${base}_${tableName(s.name)}`, shown, s.rows));
  }
  if (ext === ".json") {
    let data: unknown;
    try {
      data = JSON.parse(decodeText(buf));
    } catch (e) {
      throw new Error(`${shown} 不是合法的 JSON：${e instanceof Error ? e.message : e}`);
    }
    // {"items": [...]} 这种外面包一层的，取第一个数组
    if (!Array.isArray(data) && data && typeof data === "object") data = Object.values(data).find(Array.isArray);
    if (!Array.isArray(data) || !data.length) throw new Error(`${shown} 需要是对象数组，例：[{"month":"1月","amount":250}]`);
    const cols = [...new Set(data.flatMap((o) => (o && typeof o === "object" ? Object.keys(o) : [])))];
    if (!cols.length) throw new Error(`${shown} 的数组元素不是对象，没有列名`);
    const rows = data.map((o) => cols.map((c) => { const v = (o as Record<string, unknown>)?.[c]; return v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); }));
    return [toTable(base, shown, [cols, ...rows])];
  }
  if ([".csv", ".tsv", ".txt"].includes(ext)) {
    const text = decodeText(buf);
    const delim = ext === ".tsv" ? "\t" : sniff(text);
    const rows = parseCsv(text, delim);
    if (!rows.length) throw new Error(`${shown} 是空文件`);
    return [toTable(base, shown, rows)];
  }
  if (ext === ".xls") throw new Error("不支持旧格式 .xls。用 ask_user 请用户另存为 .xlsx");
  throw new Error(`不支持 ${ext || "无扩展名"} 文件。query_data 支持 .csv、.tsv、.xlsx、.json`);
}

/** 表名：只留字母、数字、下划线和中日文，开头不能是数字 */
function tableName(s: string) {
  const n = s.replace(/[^\p{L}\p{N}_]+/gu, "_").replace(/^_+|_+$/g, "") || "t";
  return /^\d/.test(n) ? `t_${n}` : n;
}

/** 第一行当列名（空的、重复的自动改名）；整列都能转成数字的当数字列 */
function toTable(name: string, file: string, raw: string[][]): Table {
  const [head, ...body] = raw;
  const width = Math.max(...raw.slice(0, 1000).map((r) => r.length));
  const used = new Set<string>();
  const columns = Array.from({ length: width }, (_, i) => {
    let c = String(head[i] ?? "").trim() || `col${i + 1}`;
    for (let k = 2; used.has(c.toLowerCase()); k++) c = `${String(head[i] ?? "").trim() || "col"}_${k}`;
    used.add(c.toLowerCase());
    return c;
  });
  const rows = body.slice(0, MAX_ROWS_IN);
  const types = columns.map((_, i) => {
    let any = false;
    for (const r of rows) {
      const v = (r[i] ?? "").trim();
      if (!v) continue;
      any = true;
      if (toNum(v) === null) return "TEXT" as const;
    }
    return any ? ("REAL" as const) : ("TEXT" as const);
  });
  return {
    name, file, columns, types,
    rows: rows.map((r) => columns.map((_, i) => { const v = (r[i] ?? "").trim(); return !v ? null : types[i] === "REAL" ? toNum(v) : v; })),
  };
}

/** "1,234"、"¥1,200"、"12.5%" 这种常见写法也当数字 */
function toNum(v: string): number | null {
  const s = v.replace(/^[¥$€£￥]/, "").replace(/,/g, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?%?$/.test(s)) return null;
  const n = parseFloat(s);
  return s.endsWith("%") ? n / 100 : n;
}

/** UTF-8 解不干净（出现很多 �）时试试中文 GBK 和日文 Shift_JIS：国内外 Excel 导出的 CSV 经常是这两种 */
function decodeText(buf: Buffer) {
  const bad = (s: string) => (s.match(/�/g) ?? []).length;
  let best = new TextDecoder("utf-8").decode(buf);
  if (bad(best))
    for (const enc of ["gbk", "shift_jis"]) {
      try {
        const t = new TextDecoder(enc).decode(buf);
        if (bad(t) < bad(best)) best = t;
      } catch {
        /* 这个 Node 没带完整的 ICU */
      }
    }
  return best.replace(/^﻿/, "");
}

/** 看第一行里逗号、分号、制表符哪个多 */
function sniff(text: string) {
  const nl = text.indexOf("\n");
  const first = text.slice(0, nl === -1 ? 2000 : nl);
  const count = (c: string) => first.split(c).length;
  return [",", "\t", ";"].sort((a, b) => count(b) - count(a))[0];
}

/** 标准 CSV：引号里可以有分隔符、换行，"" 表示一个引号 */
export function parseCsv(text: string, delim = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && !cell) quoted = true;
    else if (c === delim) row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

/* ---------------- 在子进程里执行 ---------------- */

/**
 * 子进程的代码直接写成字符串，用 node -e 运行，不用单独的文件（Next.js 打包时不会带上单独的脚本文件）。
 * 表数据从 stdin 传进去，结果从 stdout 传回来，都是一行 JSON。
 */
const CHILD = `
const { DatabaseSync } = require("node:sqlite");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const out = (o) => process.stdout.write(JSON.stringify(o));
  try {
    const job = JSON.parse(input);
    const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    const db = new DatabaseSync(":memory:");
    for (const t of job.tables) {
      db.exec("CREATE TABLE " + q(t.name) + " (" + t.columns.map((c, i) => q(c) + " " + t.types[i]).join(", ") + ")");
      const ins = db.prepare("INSERT INTO " + q(t.name) + " VALUES (" + t.columns.map(() => "?").join(", ") + ")");
      db.exec("BEGIN");
      for (const r of t.rows) ins.run(...r);
      db.exec("COMMIT");
    }
    db.exec("PRAGMA query_only = 1");
    const stmt = db.prepare(job.sql);
    const columns = stmt.columns().map((c) => c.name);
    const rows = [];
    let rowCount = 0;
    for (const r of stmt.iterate()) {
      if (rows.length < job.limit) rows.push(columns.map((c) => r[c]));
      if (++rowCount >= 100000) break;
    }
    out({ columns, rows, rowCount });
  } catch (e) {
    out({ error: String((e && e.message) || e) });
  }
});
`;

function runInWorker(tables: Table[], sql: string, limit: number): Promise<{ columns: string[]; rows: unknown[][]; rowCount: number } | { error: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--no-warnings", "--max-old-space-size=512", "-e", CHILD], { stdio: ["pipe", "pipe", "pipe"], env: {} as NodeJS.ProcessEnv });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (r: { columns: string[]; rows: unknown[][]; rowCount: number } | { error: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(r);
    };
    const timer = setTimeout(
      () => finish({ error: `查询超过 ${TIMEOUT_MS / 1000} 秒被中止（可能是两张大表没写 JOIN 条件变成了笛卡尔积，或者递归没有终止条件）。加上 WHERE / JOIN ON 条件或 LIMIT 再试` }),
      TIMEOUT_MS,
    );
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => finish({ error: `启动查询进程失败：${e.message}` }));
    child.on("close", () => {
      try {
        finish(JSON.parse(stdout));
      } catch {
        finish({ error: stderr.trim().split("\n").at(-1) || "查询进程异常退出（可能是数据太大、内存不够）" });
      }
    });
    child.stdin.on("error", () => {}); // 子进程提前退出时写 stdin 会 EPIPE，结果以 close 为准
    child.stdin.end(JSON.stringify({ tables, sql, limit }));
  });
}
