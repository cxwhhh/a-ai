import type { Artifact, StoredMessage } from "./shared";

/**
 * 回答里提到的文件名（a-ai-代码块样式-20261024.zip、src/main.py、复利表.md……）显示成浅蓝底。
 *
 * 做法：写一个很小的 rehype 插件。react-markdown 先把 Markdown 解析成 HTML 语法树（hast），
 * 插件在渲染前遍历这棵树，找到普通文字节点，用正则把里面的文件名切出来，换成 <span class="file-chip">。
 * 代码块、行内代码、链接里的文字不动（代码块要保持原样；链接已经有自己的样式）。
 */

/** 常见文件扩展名。只认这些，避免把 “v1.2”“e.g.” 之类误当成文件 */
const EXTS =
  "zip|tar|gz|tgz|rar|7z|md|markdown|txt|csv|tsv|json|ya?ml|toml|ini|env|xml|html?|css|scss|svg|png|jpe?g|gif|webp|pdf|docx?|xlsx?|pptx?|" +
  "py|ipynb|js|mjs|cjs|jsx|ts|tsx|sh|bash|ps1|bat|sql|db|sqlite|go|rs|java|kt|c|h|cpp|hpp|cs|rb|php|swift|vue|log|lock";

/** 文件名：字母 / 数字 / 中文 / . _ - / 组成，以已知扩展名结尾，前后不能紧挨着其他字母数字 */
export const FILE_RE = new RegExp(`(?<![\\w./-])((?:[\\w\\u4e00-\\u9fff][\\w\\u4e00-\\u9fff.\\-]*/)*[\\w\\u4e00-\\u9fff][\\w\\u4e00-\\u9fff.\\-]*\\.(?:${EXTS}))(?![\\w\\u4e00-\\u9fff])`, "gi");

/** 名字里带 .js 但其实是框架名，不当文件 */
const NOT_FILE = /^(node|next|vue|nuxt|three|chart|d3|express|deno|react|ember|backbone|socket\.io)\.js$/i;

export const isFileName = (s: string) => {
  const t = s.trim();
  FILE_RE.lastIndex = 0;
  const m = FILE_RE.exec(t);
  return !!m && m[0] === t && !NOT_FILE.test(t);
};

type HNode = { type: string; tagName?: string; value?: string; children?: HNode[]; properties?: Record<string, unknown> };
const SKIP = new Set(["code", "pre", "a", "script", "style"]);

export function rehypeFileChips() {
  return (tree: HNode) => walk(tree);
}

function walk(node: HNode) {
  if (!node.children) return;
  const next: HNode[] = [];
  for (const child of node.children) {
    if (child.type === "element") {
      if (!SKIP.has(child.tagName!)) walk(child);
      next.push(child);
    } else if (child.type === "text" && child.value) {
      next.push(...split(child.value));
    } else next.push(child);
  }
  node.children = next;
}

/** 把一段文字切成 [文字, 文件名, 文字, …] */
function split(text: string): HNode[] {
  const out: HNode[] = [];
  let last = 0;
  FILE_RE.lastIndex = 0;
  for (const m of text.matchAll(FILE_RE)) {
    if (NOT_FILE.test(m[0])) continue;
    if (m.index! > last) out.push({ type: "text", value: text.slice(last, m.index) });
    out.push({ type: "element", tagName: "span", properties: { className: ["file-chip"] }, children: [{ type: "text", value: m[0] }] });
    last = m.index! + m[0].length;
  }
  if (last === 0) return [{ type: "text", value: text }];
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}

/**
 * 点击文件名时打开什么：
 *   1. 名字和某个产出物的标题一样 → 打开这个产出物
 *   2. 本次对话里工具读写过的路径，和名字一样或以 “/名字” 结尾 → 打开这个文件（回答里常只写 fib.py，实际路径是 demo/fib.py）
 *   3. 都不是 → 按名字当作工作区里的路径打开（找不到时右侧会提示）
 */
export function resolveFileName(name: string, messages: StoredMessage[], artifacts: Artifact[]): { type: "artifact"; id: string } | { type: "file"; path: string } {
  const a = artifacts.find((x) => x.title === name);
  if (a) return { type: "artifact", id: a.id };
  const n = name.replace(/^\.\//, "");
  let hit = "";
  for (const m of messages)
    for (const c of m.toolCalls ?? []) {
      let p = "";
      try {
        p = String(JSON.parse(c.arguments || "{}").path ?? "").replace(/^\.\//, "");
      } catch {
        continue;
      }
      if (p && (p === n || p.endsWith("/" + n))) hit = p; // 取最后一次出现的
    }
  return { type: "file", path: hit || n };
}
