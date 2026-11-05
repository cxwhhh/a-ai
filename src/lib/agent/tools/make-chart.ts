import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolvePath } from "../../server/access";
import type { Tool } from "./types";

/**
 * 画图表：折线图、柱状图、饼图，输出 SVG 文件，同时显示在右侧面板。
 *
 * 为什么不只靠 run_python + matplotlib：那条路要 Docker 沙箱，还要模型写 20 行画图代码、调字体。
 * 常见的“把这几个数画成图”只需要给数据，这个工具在 A.ai 进程里直接拼出 SVG：
 *   - SVG 是文本格式的矢量图，放大不糊，浏览器、Word、PPT 都能打开
 *   - 不需要字体文件：文字由打开它的设备用自己的中文字体显示，不会出现方块
 * 复杂的统计图（散点回归、热力图、多子图）仍然用 run_python。
 */
type Series = { name?: string; values: number[] };
type Args = { type: "line" | "bar" | "pie"; labels: string[]; series: Series[]; title?: string; x_label?: string; y_label?: string; path?: string };

const W = 860;
const H = 500;
const COLORS = ["#2563eb", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16", "#64748b", "#f97316"];
const FONT = `font-family="-apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Hiragino Sans', sans-serif"`;

export const makeChart: Tool<Args> = {
  spec: {
    name: "make_chart",
    description:
      "画折线图、柱状图或饼图，保存成 SVG 文件并显示在右侧面板，返回 {path, type, points}。不依赖 Docker 沙箱。" +
      "labels 是横轴（或饼图各块）的名称，series 是一组或多组数值，每组的 values 和 labels 一一对应。数据要先算好（可以先用 query_data 汇总）。" +
      "适合：把已经算出来的数字画成图（趋势用 line，比较用 bar，占比用 pie）。" +
      "不要用于：要 PNG 图片、散点图、热力图、多子图等复杂图表（用 run_python + matplotlib）；交互式图表网页（用 create_artifact 的 html）。",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["line", "bar", "pie"], description: "line=折线（趋势），bar=柱状（比较），pie=饼图（占比，只用第一组数据）" },
        labels: { type: "array", items: { type: "string" }, description: "横轴标签。例：[\"1月\",\"2月\",\"3月\"]" },
        series: {
          type: "array",
          items: { type: "object", description: "{name: 系列名, values: 数字数组}" },
          description: "数据系列。例：[{\"name\":\"东京\",\"values\":[120,130,150]},{\"name\":\"大阪\",\"values\":[80,95,110]}]",
        },
        title: { type: "string", description: "图表标题" },
        x_label: { type: "string", description: "横轴名称（饼图不用）" },
        y_label: { type: "string", description: "纵轴名称，可以带单位。例：销售额（万元）" },
        path: { type: "string", description: "保存位置（.svg）。不填 = charts/<标题>.svg" },
      },
      required: ["type", "labels", "series"],
    },
  },
  async run(args, ctx) {
    const labels = (Array.isArray(args.labels) ? args.labels : []).map(String);
    const series = normalizeSeries(args.series, labels.length);
    if (!labels.length) throw new Error('labels 不能为空，例：["1月","2月","3月"]');
    if (labels.length > 200) throw new Error(`labels 有 ${labels.length} 个，太多了画出来看不清。先汇总（例如按月），或用 run_python 画`);
    const type = args.type === "bar" || args.type === "pie" ? args.type : "line";
    const svg = type === "pie" ? pie(labels, series[0], args.title) : xy(type, labels, series, args);

    const name = String(args.path ?? "").trim() || `charts/${(args.title || "chart").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60)}.svg`;
    const dst = resolvePath(ctx.workspace, name.endsWith(".svg") ? name : name + ".svg", "write");
    await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(dst.full), { recursive: true });
    await fs.writeFile(/*turbopackIgnore: true*/ dst.full, svg, "utf8");
    const a = ctx.emitArtifact({ title: args.title || "图表", kind: "code", language: "svg", content: svg });
    return {
      content: JSON.stringify({ path: dst.shown, type, points: labels.length, series: series.map((s) => s.name), note: "图已显示在右侧面板，并保存为 SVG 文件。回答里告诉用户文件路径，不要再贴 SVG 代码" }),
      artifactId: a.id,
    };
  },
};

/** 检查数据：values 必须是数字、长度和 labels 一致。报错写清楚是哪一组错了 */
function normalizeSeries(input: unknown, n: number): Required<Series>[] {
  if (!Array.isArray(input) || !input.length) throw new Error('series 不能为空，例：[{"name":"销售额","values":[120,130,150]}]');
  // 只给了一个数字数组：当成一组
  if (input.every((v) => typeof v === "number")) input = [{ name: "", values: input }];
  // [[1,2,3],[4,5,6]]：每个数组是一组
  input = (input as unknown[]).map((v) => (Array.isArray(v) ? { name: "", values: v } : v));
  return (input as unknown[]).slice(0, COLORS.length).map((raw, i) => {
    const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const values = (Array.isArray(s.values) ? s.values : []).map((v) => (typeof v === "string" ? parseFloat(v.replace(/,/g, "")) : Number(v)));
    if (values.length !== n)
      throw new Error(`第 ${i + 1} 组 series（${String(s.name ?? "")}）有 ${values.length} 个值，labels 有 ${n} 个，两者要一一对应`);
    if (values.some((v) => !Number.isFinite(v))) throw new Error(`第 ${i + 1} 组 series 里有不是数字的值，values 只能是数字`);
    return { name: String(s.name ?? (i ? `系列${i + 1}` : "")), values };
  });
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 数字显示：大数用 万 / k 缩写，小数最多 2 位 */
function fmt(v: number) {
  const a = Math.abs(v);
  if (a >= 1e8) return +(v / 1e8).toFixed(2) + "亿";
  if (a >= 1e4) return +(v / 1e4).toFixed(2) + "万";
  return String(+v.toFixed(2));
}

/** “好看”的刻度：最大值 437 → 0、100、200、300、400、500 */
function niceTicks(min: number, max: number, count = 5) {
  if (min === max) max = min + 1;
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

function header(title?: string) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" ${FONT}>` +
    `<rect width="${W}" height="${H}" fill="#ffffff"/>` +
    (title ? `<text x="${W / 2}" y="34" text-anchor="middle" font-size="20" font-weight="600" fill="#111827">${esc(title)}</text>` : "")
  );
}

function legend(names: string[], y: number) {
  if (names.length < 2 && !names[0]) return "";
  const items = names.map((n, i) => ({ n: n || `系列${i + 1}`, c: COLORS[i] }));
  const widths = items.map((it) => 28 + [...it.n].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 14 : 8), 0));
  let x = (W - widths.reduce((a, b) => a + b, 0)) / 2;
  return items
    .map((it, i) => {
      const g = `<rect x="${x}" y="${y - 10}" width="12" height="12" rx="2" fill="${it.c}"/><text x="${x + 18}" y="${y}" font-size="13" fill="#374151">${esc(it.n)}</text>`;
      x += widths[i];
      return g;
    })
    .join("");
}

function xy(type: "line" | "bar", labels: string[], series: Required<Series>[], o: Args) {
  const top = o.title ? 70 : 40;
  const bottom = H - (o.x_label ? 78 : 58) - (series.length > 1 || series[0].name ? 22 : 0);
  const left = 78;
  const right = W - 28;
  const all = series.flatMap((s) => s.values);
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
  const lo = ticks[0];
  const hi = ticks.at(-1)!;
  const y = (v: number) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
  const band = (right - left) / labels.length;
  const cx = (i: number) => left + band * (i + 0.5);
  // 标签太多时隔几个显示一个，避免挤在一起
  const every = Math.max(1, Math.ceil(labels.length / 16));

  let g = header(o.title);
  for (const t of ticks)
    g += `<line x1="${left}" x2="${right}" y1="${y(t)}" y2="${y(t)}" stroke="${t === 0 ? "#9ca3af" : "#e5e7eb"}"/><text x="${left - 8}" y="${y(t) + 4}" text-anchor="end" font-size="12" fill="#6b7280">${fmt(t)}</text>`;
  labels.forEach((l, i) => {
    if (i % every === 0) g += `<text x="${cx(i)}" y="${bottom + 20}" text-anchor="middle" font-size="12" fill="#374151">${esc(l.length > 12 ? l.slice(0, 11) + "…" : l)}</text>`;
  });

  if (type === "bar") {
    // 柱子最宽 72px：只有两三根柱子时不会变成两块大色块
    const bw = Math.min((band * 0.72) / series.length, 72);
    const inner = bw * series.length;
    series.forEach((s, si) =>
      s.values.forEach((v, i) => {
        const x = cx(i) - inner / 2 + bw * si;
        const y0 = y(Math.max(0, v));
        const h = Math.abs(y(v) - y(0));
        g += `<rect x="${x + 1}" y="${y0}" width="${Math.max(1, bw - 2)}" height="${h}" rx="2" fill="${COLORS[si]}"/>`;
        if (labels.length * series.length <= 24) g += `<text x="${x + bw / 2}" y="${y0 - 5}" text-anchor="middle" font-size="11" fill="#374151">${fmt(v)}</text>`;
      }),
    );
  } else {
    series.forEach((s, si) => {
      const pts = s.values.map((v, i) => `${cx(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
      g += `<polyline points="${pts}" fill="none" stroke="${COLORS[si]}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
      if (labels.length <= 40) s.values.forEach((v, i) => (g += `<circle cx="${cx(i)}" cy="${y(v)}" r="3.5" fill="#fff" stroke="${COLORS[si]}" stroke-width="2"/>`));
      if (labels.length <= 12 && series.length <= 2) s.values.forEach((v, i) => (g += `<text x="${cx(i)}" y="${y(v) - 10}" text-anchor="middle" font-size="11" fill="#374151">${fmt(v)}</text>`));
    });
  }
  if (o.y_label) g += `<text transform="translate(18 ${(top + bottom) / 2}) rotate(-90)" text-anchor="middle" font-size="13" fill="#374151">${esc(o.y_label)}</text>`;
  if (o.x_label) g += `<text x="${(left + right) / 2}" y="${bottom + 46}" text-anchor="middle" font-size="13" fill="#374151">${esc(o.x_label)}</text>`;
  g += legend(series.map((s) => s.name), H - 16);
  return g + "</svg>";
}

function pie(labels: string[], s: Required<Series>, title?: string) {
  if (labels.length > 12) throw new Error(`饼图有 ${labels.length} 块，太多了看不清。把小的几项合并成“其他”，或改用 bar`);
  if (s.values.some((v) => v < 0)) throw new Error("饼图的值不能是负数。有负数时用 bar");
  const total = s.values.reduce((a, b) => a + b, 0);
  if (!total) throw new Error("饼图的值全是 0，画不出来");
  const cx = 300;
  const cy = (title ? 50 : 20) + 210;
  const r = 180;
  let a0 = -Math.PI / 2;
  let g = header(title);
  s.values.forEach((v, i) => {
    const a1 = a0 + (v / total) * Math.PI * 2;
    const c = COLORS[i % COLORS.length];
    if (v / total > 0.9999) g += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c}"/>`;
    else if (v > 0) {
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (a: number) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
      g += `<path d="M ${cx} ${cy} L ${p(a0)} A ${r} ${r} 0 ${large} 1 ${p(a1)} Z" fill="${c}" stroke="#fff" stroke-width="2"/>`;
    }
    // 右侧图例：名称、数值、百分比
    const ly = cy - (labels.length * 26) / 2 + i * 26 + 13;
    g += `<rect x="530" y="${ly - 11}" width="14" height="14" rx="3" fill="${c}"/><text x="552" y="${ly + 1}" font-size="14" fill="#374151">${esc(labels[i])}  ${fmt(v)}（${((v / total) * 100).toFixed(1)}%）</text>`;
    a0 = a1;
  });
  return g + "</svg>";
}
