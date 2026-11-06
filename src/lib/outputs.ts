import type { Artifact, StoredMessage } from "./shared";
import { isSvg } from "./svg";

/**
 * 从对话历史里整理出右上角“输出”卡片要显示的内容：
 * - outputs：本次会话产出的东西（右栏产出物 + 写入过的文件），最新的在前
 * - used：本次会话用到的东西（读过的文件、看过的目录、抓过的网页）
 * 纯前端计算，不需要额外接口：工具调用和结果本来就在消息里。
 */

export type View = { type: "artifact"; id: string } | { type: "file"; path: string };

export interface OutputItem {
  key: string;
  name: string;
  ext: string; // 右侧的类型标签：MD / HTML / PY / TXT …
  icon: "code" | "doc" | "web" | "chart" | "file" | "folder";
  view: View;
  ts: number; // 产生时间，用于排序
}

export interface UsedItem {
  key: string;
  label: string; // 读取 / 目录 / 网页
  detail: string;
  icon: "file" | "folder" | "web";
  view?: View; // 网页没有可预览的内容
  href?: string;
}

const CODE_EXT = new Set(["py", "js", "ts", "tsx", "jsx", "json", "sh", "sql", "go", "rs", "java", "c", "cpp", "css", "yml", "yaml", "toml"]);
const LANG_EXT: Record<string, string> = {
  python: "py", javascript: "js", typescript: "ts", bash: "sh", shell: "sh", rust: "rs", golang: "go", yaml: "yml",
};

export function extOf(name: string) {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : "";
}

export function artifactExt(a: Artifact) {
  if (a.kind === "markdown") return "md";
  if (a.kind === "html") return "html";
  if (isSvg(a.content)) return "svg"; // kind=code 但内容是 SVG（language 写成 svg、xml 或没写）
  const l = (a.language || "").toLowerCase();
  return LANG_EXT[l] || l || "txt";
}

/** 按扩展名决定显示哪种图标（和颜色，见 KindIcon）：svg 是图表，html 是网页 */
export function iconForExt(ext: string): OutputItem["icon"] {
  if (ext === "dir") return "folder";
  if (ext === "md" || ext === "txt" || ext === "csv" || ext === "docx" || ext === "pptx" || ext === "pdf") return "doc";
  if (ext === "xlsx") return "code";
  if (ext === "svg") return "chart";
  if (ext === "html" || ext === "htm") return "web";
  if (CODE_EXT.has(ext)) return "code";
  return "file";
}

export function collectOutputs(messages: StoredMessage[], artifacts: Artifact[]) {
  const results = new Map<string, StoredMessage>();
  for (const m of messages) if (m.role === "tool" && m.toolCallId) results.set(m.toolCallId, m);

  const outputs: OutputItem[] = [];
  const used: UsedItem[] = [];
  const seen = new Set<string>();

  // 产出物
  for (const a of artifacts) {
    const ext = artifactExt(a);
    outputs.push({ key: "a:" + a.id, name: a.title, ext, icon: iconForExt(ext), view: { type: "artifact", id: a.id }, ts: a.createdAt });
  }

  // 工具调用：写入的文件算“输出”，读取 / 目录 / 网页算“已使用”
  for (const m of messages) {
    for (const c of m.toolCalls ?? []) {
      const r = results.get(c.id);
      if (!r || r.isError) continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(c.arguments || "{}");
      } catch {
        continue;
      }
      const path = String(args.path ?? "");
      // 写入或修改过的文件都算“输出”，点开能看改动；write_document 生成的 Word / Excel / PPT 也算（以前漏了，生成了却不在“输出”里）
      if ((c.name === "write_file" || c.name === "edit_file" || c.name === "write_document") && path) {
        const k = "f:" + path;
        const i = outputs.findIndex((o) => o.key === k);
        if (i >= 0) outputs.splice(i, 1); // 同一文件写多次只保留最新一次
        const ext = extOf(path);
        outputs.push({ key: k, name: path, ext: ext || "file", icon: iconForExt(ext), view: { type: "file", path }, ts: r.createdAt });
      } else if (c.name === "read_file" && path && !seen.has("r:" + path)) {
        seen.add("r:" + path);
        used.push({ key: "r:" + path, label: "读取", detail: path, icon: "file", view: { type: "file", path } });
      } else if (c.name === "list_files" && !seen.has("d:" + (path || "."))) {
        const p = path || ".";
        seen.add("d:" + p);
        used.push({ key: "d:" + p, label: "目录", detail: p === "." ? "工作区" : p, icon: "folder", view: { type: "file", path: p } });
      } else if (c.name === "web_fetch" && args.url && !seen.has("w:" + args.url)) {
        seen.add("w:" + args.url);
        let host = String(args.url);
        try {
          host = new URL(host).host + new URL(host).pathname.replace(/\/$/, "");
        } catch {
          /* keep raw */
        }
        used.push({ key: "w:" + args.url, label: "网页", detail: host, icon: "web", href: String(args.url) });
      }
    }
  }

  // 产出物和文件按时间混排：后产生的在前
  return { outputs: outputs.sort((a, b) => b.ts - a.ts), used };
}
