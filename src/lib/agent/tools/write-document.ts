import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { resolvePath } from "../../server/access";
import type { Tool } from "./types";

/**
 * 生成 Office 文件：Word（.docx）、Excel（.xlsx）、PowerPoint（.pptx）。和 read_document 正好相反。
 *
 * 以前要交付 Word / Excel / PPT，只能让模型在 run_python 里现写 python-docx、openpyxl 代码：
 * 代码长、容易写错，Docker 沙箱不可用时还完全做不了。这个工具直接在 A.ai 进程里生成：
 *   - docx、pptx：模型只写 Markdown（标题、列表、表格、加粗），由程序排版。模型最擅长写 Markdown，出错面积最小
 *   - xlsx：模型给二维数组，数字保持数字（能在 Excel 里继续求和、排序）
 * Word 用 docx 库，PPT 用 pptxgenjs 库；xlsx 的结构简单，直接用 jszip 拼 XML（和 read_document 读 xlsx 是同一套格式）。
 */
type Sheet = { name?: string; rows: unknown[][] };
type Args = { path: string; content?: string; sheets?: Sheet[]; title?: string; overwrite?: boolean };

export const writeDocument: Tool<Args> = {
  spec: {
    name: "write_document",
    description:
      "生成 Word（.docx）、Excel（.xlsx）或 PowerPoint（.pptx）文件，保存到工作区，返回 {path, bytes, ...}。格式由 path 的扩展名决定。" +
      "docx：content 写 Markdown（# 标题、- 列表、1. 编号、| 表格 |、**加粗**）。" +
      "pptx：content 写 Markdown，每个 # 标题开始一张新幻灯片，下面的 - 列表是要点，| 表格 | 会画成表格，> 开头的行是演讲者备注。" +
      "xlsx：sheets 给工作表数组，每个 {name, rows}，rows 第一行是表头，数字直接写数字。" +
      "适合：用户要 Word、Excel、PPT 文件。不要用于：只在界面上看的报告（用 create_artifact）；纯文本、Markdown、CSV（用 write_file）；读取这些文件（用 read_document）。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "保存位置，扩展名必须是 .docx / .xlsx / .pptx。例：output/周报.docx" },
        content: { type: "string", description: "docx、pptx 的内容（Markdown）" },
        sheets: {
          type: "array",
          description: "xlsx 的工作表。例：[{\"name\":\"销售\",\"rows\":[[\"月份\",\"金额\"],[\"1月\",250]]}]",
          items: { type: "object", description: "{name: 工作表名, rows: 二维数组}" },
        },
        title: { type: "string", description: "文档标题（写进文件属性；pptx 没有 # 标题时用作第一张幻灯片标题）" },
        overwrite: { type: "boolean", description: "文件已存在时是否覆盖，默认 false" },
      },
      required: ["path"],
    },
  },
  async run({ path: p, content, sheets, title, overwrite }, ctx) {
    const ext = path.extname(String(p ?? "")).toLowerCase();
    if (![".docx", ".xlsx", ".pptx"].includes(ext))
      throw new Error(`path 的扩展名必须是 .docx、.xlsx 或 .pptx，收到：${p}。纯文本、Markdown、CSV 用 write_file`);
    const dst = resolvePath(ctx.workspace, p, "write");
    if (!overwrite && (await fs.stat(/*turbopackIgnore: true*/ dst.full).catch(() => null)))
      throw new Error(`${dst.shown} 已存在。要覆盖就设 overwrite=true（覆盖用户的文件前先确认），或者换一个文件名`);

    let buf: Buffer;
    const info: Record<string, unknown> = {};
    if (ext === ".xlsx") {
      if (!Array.isArray(sheets) || !sheets.length) throw new Error('xlsx 需要 sheets，例：[{"name":"Sheet1","rows":[["月份","金额"],["1月",250]]}]');
      buf = await buildXlsx(sheets, title);
      info.sheets = sheets.map((s, i) => ({ name: sheetName(s.name, i), rows: Array.isArray(s.rows) ? s.rows.length : 0 }));
    } else {
      const md = String(content ?? "").trim();
      if (!md) throw new Error(`${ext} 需要 content（Markdown）。例：# 标题\\n- 要点一\\n- 要点二`);
      if (ext === ".docx") buf = await buildDocx(md, title);
      else {
        const r = await buildPptx(md, title);
        buf = r.buf;
        info.slides = r.slides;
      }
    }
    await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(dst.full), { recursive: true });
    await fs.writeFile(/*turbopackIgnore: true*/ dst.full, buf);
    return { content: JSON.stringify({ path: dst.shown, bytes: buf.length, ...info, note: "文件已保存到工作区。告诉用户文件路径；需要检查内容时用 read_document 读回来" }) };
  },
};

/* ---------------- Markdown → 块 ---------------- */

type Block =
  | { t: "h"; level: number; text: string }
  | { t: "p"; text: string }
  | { t: "li"; text: string; ordered: boolean; level: number }
  | { t: "table"; rows: string[][] }
  | { t: "note"; text: string }
  | { t: "hr" };

/** 只认常用的几种 Markdown：够写报告、周报、提案，又简单到不会出错 */
export function parseMarkdown(md: string): Block[] {
  const out: Block[] = [];
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const s = line.trim();
    if (!s) continue;
    let m: RegExpExecArray | null;
    if (/^(-{3,}|\*{3,})$/.test(s)) out.push({ t: "hr" });
    else if ((m = /^(#{1,6})\s+(.*)$/.exec(s))) out.push({ t: "h", level: m[1].length, text: m[2] });
    else if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(line))) out.push({ t: "li", text: m[2], ordered: false, level: Math.min(2, Math.floor(m[1].length / 2)) });
    else if ((m = /^(\s*)\d+[.)]\s+(.*)$/.exec(line))) out.push({ t: "li", text: m[2], ordered: true, level: Math.min(2, Math.floor(m[1].length / 2)) });
    else if (s.startsWith(">")) out.push({ t: "note", text: s.replace(/^>\s?/, "") });
    else if (s.startsWith("|")) {
      const rows: string[][] = [];
      for (; i < lines.length && lines[i].trim().startsWith("|"); i++) {
        const cells = lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells); // 跳过 |---|---| 分隔行
      }
      i--;
      out.push({ t: "table", rows });
    } else {
      // 连续的普通行合成一段
      const prev = out.at(-1);
      if (prev?.t === "p" && lines[i - 1]?.trim()) prev.text += " " + s;
      else out.push({ t: "p", text: s });
    }
  }
  return out;
}

/** 行内格式：**加粗**、`代码`，其余原样 */
function inlineRuns(text: string): { text: string; bold?: boolean; code?: boolean }[] {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/)
    .filter(Boolean)
    .map((part) =>
      part.startsWith("**") && part.endsWith("**") && part.length > 4
        ? { text: part.slice(2, -2), bold: true }
        : part.startsWith("`") && part.endsWith("`") && part.length > 2
          ? { text: part.slice(1, -1), code: true }
          : { text: part },
    );
}
const plain = (text: string) => inlineRuns(text).map((r) => r.text).join("");

/* ---------------- Word ---------------- */

async function buildDocx(md: string, title?: string): Promise<Buffer> {
  const d = await import("docx");
  const runs = (text: string) => inlineRuns(text).map((r) => new d.TextRun({ text: r.text, bold: r.bold, font: r.code ? "Consolas" : undefined }));
  const HEADINGS = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3, d.HeadingLevel.HEADING_4, d.HeadingLevel.HEADING_5, d.HeadingLevel.HEADING_6];
  const children: (InstanceType<typeof d.Paragraph> | InstanceType<typeof d.Table>)[] = [];
  for (const b of parseMarkdown(md)) {
    if (b.t === "h") children.push(new d.Paragraph({ heading: HEADINGS[b.level - 1], children: runs(b.text) }));
    else if (b.t === "p" || b.t === "note") children.push(new d.Paragraph({ children: runs(b.text), spacing: { after: 120 } }));
    else if (b.t === "li")
      children.push(
        b.ordered
          ? new d.Paragraph({ children: runs(b.text), numbering: { reference: "num", level: b.level } })
          : new d.Paragraph({ children: runs(b.text), bullet: { level: b.level } }),
      );
    else if (b.t === "hr") children.push(new d.Paragraph({ children: [], border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: "BBBBBB", space: 1 } } }));
    else if (b.t === "table" && b.rows.length) {
      const cols = Math.max(...b.rows.map((r) => r.length));
      children.push(
        new d.Table({
          width: { size: 100, type: d.WidthType.PERCENTAGE },
          rows: b.rows.map(
            (r, ri) =>
              new d.TableRow({
                tableHeader: ri === 0,
                children: Array.from({ length: cols }, (_, ci) =>
                  new d.TableCell({
                    shading: ri === 0 ? { type: d.ShadingType.CLEAR, fill: "F2F2F2", color: "auto" } : undefined,
                    children: [new d.Paragraph({ children: ri === 0 ? [new d.TextRun({ text: plain(r[ci] ?? ""), bold: true })] : runs(r[ci] ?? "") })],
                  }),
                ),
              }),
          ),
        }),
        new d.Paragraph({ children: [] }), // 表格后空一行，不然下一段紧贴表格
      );
    }
  }
  const doc = new d.Document({
    title: title || undefined,
    creator: "A.ai",
    // 默认字体：英文 Calibri，中日文 微软雅黑（Mac 上没有时 Word 会自动换成相近字体）
    styles: { default: { document: { run: { font: { ascii: "Calibri", hAnsi: "Calibri", eastAsia: "Microsoft YaHei" }, size: 22 } } } },
    numbering: {
      config: [
        {
          reference: "num",
          levels: [0, 1, 2].map((level) => ({
            level,
            format: d.LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: d.AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 420 * (level + 1), hanging: 300 } } },
          })),
        },
      ],
    },
    sections: [{ children }],
  });
  return d.Packer.toBuffer(doc);
}

/* ---------------- PowerPoint ---------------- */

async function buildPptx(md: string, title?: string): Promise<{ buf: Buffer; slides: number }> {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE"; // 16:9，13.33 × 7.5 英寸
  if (title) pptx.title = title;
  const FONT = "Microsoft YaHei";

  // 按一级、二级标题或 --- 分页
  type S = { title: string; body: Block[]; notes: string[] };
  const slides: S[] = [];
  for (const b of parseMarkdown(md)) {
    if ((b.t === "h" && b.level <= 2) || b.t === "hr" || !slides.length) {
      slides.push({ title: b.t === "h" && b.level <= 2 ? plain(b.text) : slides.length ? "" : title || "", body: [], notes: [] });
      if ((b.t === "h" && b.level <= 2) || b.t === "hr") continue;
    }
    const cur = slides.at(-1)!;
    if (b.t === "note") cur.notes.push(b.text);
    else cur.body.push(b);
  }

  for (const s of slides) {
    const slide = pptx.addSlide();
    const onlyTitle = !s.body.length;
    if (s.title)
      slide.addText(s.title, onlyTitle
        ? { x: 0.8, y: 2.6, w: 11.7, h: 1.6, fontSize: 40, bold: true, fontFace: FONT, align: "center", color: "222222" }
        : { x: 0.6, y: 0.35, w: 12.1, h: 0.9, fontSize: 30, bold: true, fontFace: FONT, color: "222222" });
    let y = s.title ? 1.45 : 0.5;
    const text: { text: string; options: Record<string, unknown> }[] = [];
    const flush = () => {
      if (!text.length) return;
      const h = Math.min(7.5 - y - 0.3, 0.5 * text.length + 0.3);
      slide.addText(text.splice(0), { x: 0.7, y, w: 11.9, h, fontSize: 20, fontFace: FONT, color: "333333", valign: "top", paraSpaceAfter: 6 });
      y += h + 0.1;
    };
    for (const b of s.body) {
      if (b.t === "table" && b.rows.length) {
        flush();
        const rows = b.rows.map((r, ri) => r.map((c) => ({ text: plain(c), options: ri === 0 ? { bold: true, fill: { color: "F2F2F2" } } : {} })));
        slide.addTable(rows, { x: 0.7, y, w: 11.9, fontSize: 14, fontFace: FONT, border: { type: "solid", pt: 0.5, color: "BBBBBB" }, autoPage: false });
        y += Math.min(0.4 * rows.length + 0.2, 7.5 - y);
      } else if (b.t === "li") text.push({ text: plain(b.text), options: { bullet: b.ordered ? { type: "number" } : true, indentLevel: b.level, breakLine: true } });
      else if (b.t === "h") text.push({ text: plain(b.text), options: { bold: true, fontSize: 22, breakLine: true } });
      else if (b.t === "p") text.push({ text: plain(b.text), options: { breakLine: true } });
    }
    flush();
    if (s.notes.length) slide.addNotes(s.notes.join("\n"));
  }
  const buf = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  return { buf, slides: slides.length };
}

/* ---------------- Excel ---------------- */

/** Excel 工作表名：最多 31 个字符，不能有 \ / ? * [ ] : */
function sheetName(name: unknown, i: number) {
  const n = String(name ?? "").replace(/[\\/?*[\]:]/g, "_").trim().slice(0, 31);
  return n || `Sheet${i + 1}`;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

/** 列号 → 字母：0 → A，26 → AA */
function colName(i: number) {
  let s = "";
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

/**
 * 最小的 xlsx：每个单元格用 inlineStr（文字直接写在单元格里，不用 sharedStrings 表）。
 * 第一行加粗（styles.xml 里第 1 号格式）并冻结，列宽按内容估算，中文按 2 个字符宽。
 */
async function buildXlsx(sheets: Sheet[], title?: string): Promise<Buffer> {
  const zip = new JSZip();
  const names = new Set<string>();
  const list = sheets.slice(0, 50).map((s, i) => {
    let n = sheetName(s.name, i);
    while (names.has(n)) n = `${n.slice(0, 28)}_${i + 1}`;
    names.add(n);
    if (!Array.isArray(s.rows)) throw new Error(`第 ${i + 1} 个工作表的 rows 必须是二维数组，例：[["月份","金额"],["1月",250]]`);
    return { name: n, rows: s.rows.slice(0, 100000).map((r) => (Array.isArray(r) ? r : [r])) };
  });

  list.forEach((s, si) => {
    const widths: number[] = [];
    const rowsXml = s.rows
      .map((r, ri) => {
        const cells = r
          .map((v, ci) => {
            if (v === null || v === undefined || v === "") return "";
            const ref = `${colName(ci)}${ri + 1}`;
            const style = ri === 0 ? ' s="1"' : "";
            const text = typeof v === "object" ? JSON.stringify(v) : String(v);
            widths[ci] = Math.max(widths[ci] ?? 6, Math.min(60, [...text].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 2 : 1), 0) + 2));
            if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
            if (typeof v === "boolean") return `<c r="${ref}" t="b"${style}><v>${v ? 1 : 0}</v></c>`;
            // "=SUM(B2:B4)" 这种以 = 开头的当公式。文件里只存公式不存结果，workbook.xml 的 fullCalcOnLoad 让 Excel 打开时算一遍
            if (text.startsWith("=") && text.length > 1) return `<c r="${ref}"${style}><f>${esc(text.slice(1))}</f></c>`;
            return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
          })
          .join("");
        return `<row r="${ri + 1}">${cells}</row>`;
      })
      .join("");
    const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
    const freeze = s.rows.length > 1 ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : "";
    zip.file(
      `xl/worksheets/sheet${si + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}${cols}<sheetData>${rowsXml}</sheetData></worksheet>`,
    );
  });

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
  );
  zip.file(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(title ?? "")}</dc:title><dc:creator>A.ai</dc:creator></cp:coreProperties>`,
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${list.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  zip.file(
    "xl/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
