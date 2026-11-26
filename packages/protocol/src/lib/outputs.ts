import { toolStatus, type Artifact, type StoredMessage } from "./shared";
import { isSvg } from "../../../ui/src/lib/svg";

/**
 * 从对话历史里整理出右上角“输出”卡片要显示的内容：
 * - outputs：本次会话产出的东西（右栏产出物 + 写入过的文件），最新的在前
 * - used：本次会话用到的东西（读过的文件、看过的目录、抓过的网页）
 * 纯前端计算，不需要额外接口：工具调用和结果本来就在消息里。
 */

export type View = ({ type: "artifact"; id: string } | { type: "file"; path: string }) & { source?: boolean };

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

const FILE_WRITE_TOOLS = new Set(["write_file", "edit_file", "write_document", "download_file", "make_chart"]);

/** 聊天下方汇总有实际写入记录的文件，独立于看板的产出去重和展示规则。 */
export function collectChangedPaths(messages: StoredMessage[], artifacts: Artifact[]): string[] {
  const files = new Set<string>();
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  let calls = new Map<string, NonNullable<StoredMessage["toolCalls"]>[number]>();

  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const path = value.replace(/\\/g, "/").replace(/^\/workspace\//, "");
    if (path.startsWith("/") || /^[a-z]:/i.test(path)) return;
    const parts = path.split("/").filter((part) => part && part !== ".");
    if (!parts.length || parts.includes("..")) return;
    const normalized = parts.join("/");
    files.delete(normalized);
    files.add(normalized);
  };

  for (const message of messages) {
    if (message.role !== "tool") {
      // 调用 ID 只用来匹配这一批工具，避免同一会话后续模型响应复用 ID 时覆盖旧结果。
      if (message.role === "assistant") calls = new Map(message.toolCalls?.map((call) => [call.id, call]));
      else if (!message.feedback) calls.clear();
      continue;
    }
    const call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
    if (call) calls.delete(call.id);
    for (const file of message.outputFiles ?? []) add(file);
    if (toolStatus(message) !== "ok") continue;
    if (message.artifactId) add(byId.get(message.artifactId)?.file);
    const name = call?.name ?? message.toolResult?.name;
    if (!name) continue;
    const result = { ...message.toolResult?.fields, ...fileFields(message.content) };
    if (FILE_WRITE_TOOLS.has(name)) {
      // 路径以执行结果为准。旧消息只有参数时，再读参数中的路径。
      add(result.path || (call && fileFields(call.arguments).path));
    } else if (name === "run_python" || name === "run_command") {
      if (Array.isArray(result.outputs)) {
        for (const path of result.outputs) if (typeof path === "string" && path.startsWith("output/")) add(path);
      }
    } else if (name === "archive" && call && fileFields(call.arguments).action === "zip") {
      add(result.path);
    }
  }
  return [...files].reverse();
}

function fileFields(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) ?? {};
  } catch {
    return {};
  }
}

export function collectOutputs(messages: StoredMessage[], artifacts: Artifact[]) {
  const results = new Map<string, StoredMessage>();
  for (const m of messages) if (m.role === "tool" && m.toolCallId) results.set(m.toolCallId, m);

  const outputs: OutputItem[] = [];
  const used: UsedItem[] = [];
  const seen = new Set<string>();
  const byId = new Map(artifacts.map((a) => [a.id, a]));
  const apps = new Set<string>();
  const duplicate = new Set<string>();
  const latestFileCall = new Map<string, string>();
  const backingFiles = new Set(artifacts.flatMap((a) => a.file ? [a.file] : []));

  // 同一轮成功部署网页后，临时预览和内容完全相同的 HTML 源文件共用应用入口。
  // 以真实用户消息分轮，别的轮次或会话里的独立网页仍可打开。
  const publishedTitles = new Set<string>();
  const publishedHtml = new Set<string>();
  const deliveredHtml = new Set<string>();
  const previews: { key: string; title: string; html: string }[] = [];
  const htmlWrites: { callId: string; html: string }[] = [];
  const duplicateFileCalls = new Set<string>();
  function finishRound() {
    for (const preview of previews) {
      if (publishedTitles.has(preview.title) || (preview.html && publishedHtml.has(preview.html))) duplicate.add(preview.key);
    }
    for (const write of htmlWrites) if (write.html && deliveredHtml.has(write.html)) duplicateFileCalls.add(write.callId);
    publishedTitles.clear();
    publishedHtml.clear();
    deliveredHtml.clear();
    previews.length = 0;
    htmlWrites.length = 0;
  }

  // 一个应用被多次更新时，列表只留最新入口，旧消息仍能按原引用打开。
  for (const a of [...artifacts].reverse()) {
    if (a.workspaceApp) {
      if (apps.has(a.workspaceApp.id)) continue;
      apps.add(a.workspaceApp.id);
    }
    const ext = artifactExt(a);
    outputs.push({ key: "a:" + a.id, name: a.title, ext, icon: iconForExt(ext), view: { type: "artifact", id: a.id }, ts: a.createdAt });
  }

  // 工具调用：写入的文件算“输出”，读取 / 目录 / 网页算“已使用”
  for (const m of messages) {
    if (m.role === "user" && !m.feedback) finishRound();
    for (const file of m.outputFiles ?? []) {
      const k = "f:" + file;
      const i = outputs.findIndex((item) => item.key === k);
      if (i >= 0) outputs.splice(i, 1);
      latestFileCall.set(k, m.toolCallId ?? m.id);
      const ext = extOf(file);
      outputs.push({ key: k, name: file, ext: ext || "file", icon: iconForExt(ext), view: { type: "file", path: file }, ts: m.createdAt });
    }
    for (const c of m.toolCalls ?? []) {
      const r = results.get(c.id);
      if (!r || toolStatus(r) !== "ok") continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(c.arguments || "{}");
      } catch {
        continue;
      }
      let path = String(args.path ?? "");
      const artifact = r.artifactId ? byId.get(r.artifactId) : undefined;
      const title = artifact?.title.trim();
      if (c.name === "deploy_app" && artifact?.workspaceApp && title) {
        const html = String(args.html ?? "").trim();
        publishedTitles.add(title);
        publishedHtml.add(html);
        deliveredHtml.add(html);
      }
      if (c.name === "create_artifact" && artifact?.kind === "html" && !artifact.workspaceApp && title) {
        const html = String(args.content ?? "").trim();
        previews.push({ key: "a:" + artifact.id, title, html });
        deliveredHtml.add(html);
      }
      // 写入或修改过的文件都算“输出”，点开能看改动；write_document 生成的 Word / Excel / PPT 也算（以前漏了，生成了却不在“输出”里）
      if ((c.name === "write_file" || c.name === "edit_file" || c.name === "write_document") && path) {
        // 优先用工具实际写入的工作区路径，兼容 /workspace/ 前缀或 ./ 等不同写法。
        try {
          const written = JSON.parse(r.content)?.path;
          if (typeof written === "string" && written) path = written;
        } catch { /* 旧工具结果可能是纯文本 */ }
        const k = "f:" + path;
        latestFileCall.set(k, c.id);
        const i = outputs.findIndex((o) => o.key === k);
        if (i >= 0) outputs.splice(i, 1); // 同一文件写多次只保留最新一次
        const ext = extOf(path);
        if (c.name === "write_file" && (ext === "html" || ext === "htm")) {
          htmlWrites.push({ callId: c.id, html: String(args.content ?? "").trim() });
        }
        outputs.push({ key: k, name: path, ext: ext || "file", icon: iconForExt(ext), view: { type: "file", path }, ts: r.createdAt });
      } else if (c.name === "run_python" || c.name === "run_command") {
        try {
          const published = JSON.parse(r.content)?.outputs;
          if (Array.isArray(published)) for (const file of published) {
            if (typeof file !== "string" || !file.startsWith("output/")) continue;
            const ext = extOf(file);
            outputs.push({ key: "f:" + file, name: file, ext: ext || "file", icon: iconForExt(ext), view: { type: "file", path: file }, ts: r.createdAt });
          }
        } catch { /* 旧结果或无产出的工具调用 */ }
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
  finishRound();

  // 产出物和文件按时间混排：后产生的在前
  return {
    outputs: outputs.filter((o) => !duplicate.has(o.key) && !duplicateFileCalls.has(latestFileCall.get(o.key) ?? "")
      && (o.view.type !== "file" || !backingFiles.has(o.view.path)))
      .sort((a, b) => b.ts - a.ts),
    used,
  };
}
