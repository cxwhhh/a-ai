import hljs from "highlight.js/lib/common";

/**
 * 代码高亮：用 highlight.js 把代码切成一个个“词”（关键字、字符串、注释、数字、函数名……），
 * 每个词包一层 <span class="hljs-xxx">，颜色由 components/code.css 里的 GitHub 配色决定。
 * lib/common 只带常用的约 40 种语言（Python、JS/TS、Bash、JSON、HTML、CSS、SQL、Go、Rust、Java…），体积比全量小很多。
 *
 * 安全：hljs 输出前会把 < > & 等字符转义，所以结果可以直接放进 dangerouslySetInnerHTML。
 */

/** 文件扩展名 / 代码块语言名 → highlight.js 的语言名 */
const ALIAS: Record<string, string> = {
  py: "python", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
  sh: "bash", shell: "bash", zsh: "bash", console: "bash", yml: "yaml", md: "markdown", htm: "xml", html: "xml", svg: "xml",
  rs: "rust", golang: "go", "c++": "cpp", hpp: "cpp", h: "c", kt: "kotlin", rb: "ruby", ps1: "powershell", txt: "plaintext",
};

/** 根据语言名或文件路径猜语言；猜不到返回 "" */
export function langOf(hint?: string) {
  if (!hint) return "";
  const h = hint.toLowerCase().trim();
  const ext = /\.([a-z0-9+]+)$/.exec(h)?.[1] ?? h; // 传的是路径就取扩展名
  const l = ALIAS[ext] ?? ext;
  return hljs.getLanguage(l) ? l : "";
}

/** 高亮一段代码，返回 HTML。太长的不高亮（防止页面卡顿），没给语言时自动识别 */
export function highlight(code: string, hint?: string): string {
  if (code.length > 80_000) return escape(code);
  const lang = langOf(hint);
  try {
    if (lang === "plaintext") return escape(code);
    if (lang) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    // 自动识别只在常用语言里挑，避免把普通文字误判成冷门语言、涂得五颜六色
    return hljs.highlightAuto(code, ["python", "javascript", "typescript", "bash", "json", "xml", "css", "sql", "yaml", "go", "rust", "java"]).value;
  } catch {
    return escape(code);
  }
}

/**
 * 按行高亮（带行号的视图、改动对比要一行一行地画）。
 * 先整段高亮再按换行切开：多行注释、多行字符串的颜色不会断掉。
 * 切开时，跨行的 <span> 要在行尾补上 </span>、在下一行开头重新打开。
 */
export function highlightLines(code: string, hint?: string): string[] {
  const html = highlight(code, hint);
  const out: string[] = [];
  let open: string[] = []; // 当前还没闭合的 <span ...> 开头标签
  for (const raw of html.split("\n")) {
    let line = open.join("") + raw;
    for (const m of raw.matchAll(/<span[^>]*>|<\/span>/g)) {
      if (m[0] === "</span>") open.pop();
      else open.push(m[0]);
    }
    line += "</span>".repeat(open.length);
    out.push(line);
  }
  return out;
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
