/**
 * 网页成品的“底线”：create_artifact 收到 kind=html 时，先过这里。
 *
 *   1. 套一层基础样式（BASE_CSS）：字体、颜色变量、表格、按钮、表单、卡片、图片自适应。
 *      放在 CSS 层 @layer aai-base 里。层里的样式优先级低于任何没分层的样式，
 *      所以模型自己写的 CSS 一定会覆盖它：模型认真设计时不受影响，偷懒时页面也不会是光秃秃的白底黑字。
 *   2. 缺了手机适配的 <meta viewport> 就补上（确定不会出错的问题直接修）。
 *   3. 静态检查（lintHtml）：查出的问题写进工具结果，让模型自己决定要不要改（自我纠正）。
 *      只做看源码就能判断的检查。真正打开页面量尺寸要无头浏览器，部署的镜像里没有，以后再加。
 *
 * 为什么不做深色模式：模型常常只给某个卡片写 background:#fff 却不写文字颜色，
 * 基础样式要是把文字改成浅色，这种卡片上的字就看不见了。深色模式交给模型按设计规范（技能）自己做。
 */

const MARK = "aai-base";

/** 默认样式。类名和变量写在内置技能「网页设计」里，模型可以直接用 */
export const BASE_CSS = `@layer ${MARK} {
:root {
  --bg: #f7f7f5; --surface: #ffffff; --text: #1f2328; --muted: #6b7280; --border: #e5e7eb;
  --accent: #2563eb; --accent-soft: #eff4ff; --ok: #16a34a; --warn: #d97706; --danger: #dc2626;
  --radius: 10px; --shadow: 0 1px 2px rgba(0,0,0,.04), 0 4px 16px rgba(0,0,0,.06);
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; font-family: var(--font); font-size: 16px; line-height: 1.65; color: var(--text); background: var(--bg); -webkit-font-smoothing: antialiased; }
h1, h2, h3, h4 { line-height: 1.3; margin: 1.4em 0 .5em; font-weight: 650; letter-spacing: -.01em; }
h1 { font-size: 2rem; } h2 { font-size: 1.45rem; } h3 { font-size: 1.15rem; }
:is(h1, h2, h3, h4):first-child { margin-top: 0; }
@media (max-width: 640px) { .container { padding: 20px 16px; } h1 { font-size: 1.6rem; } }
p { margin: 0 0 1em; }
a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
img, svg, video, canvas { max-width: 100%; height: auto; }
code, pre { font-family: var(--mono); font-size: .9em; }
pre { background: #f3f4f6; padding: 12px 14px; border-radius: 8px; overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: .95em; background: var(--surface); }
th, td { padding: 10px 12px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
th { font-weight: 600; color: var(--muted); background: #fafafa; }
tbody tr:hover { background: #fafafa; }
button, .btn { font: inherit; cursor: pointer; padding: 8px 16px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); transition: background .15s, border-color .15s; }
button:hover, .btn:hover { border-color: #cbd5e1; background: #f9fafb; }
.btn-primary, button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn-primary:hover, button.primary:hover { filter: brightness(1.08); background: var(--accent); }
input, select, textarea { font: inherit; padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); max-width: 100%; }
input:focus, select:focus, textarea:focus, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.container { max-width: 1080px; margin: 0 auto; padding: 32px 20px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 20px; }
.grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
.row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.muted { color: var(--muted); }
.badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: .8em; background: var(--accent-soft); color: var(--accent); }
.stat { font-size: 2rem; font-weight: 700; line-height: 1.1; }
.table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius); }
.table-wrap table { border: 0; }
}`;

const STYLE_TAG = `<style id="${MARK}">\n${BASE_CSS}\n</style>`;
const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';

/** 套基础样式、补 viewport。返回处理后的页面和“自动做了什么” */
export function polishHtml(html: string): { html: string; fixed: string[] } {
  const fixed: string[] = [];
  let out = html;
  // 只有片段（没有 <html>）：包成完整页面，右栏和下载后直接打开都能正常显示
  if (!/<html[\s>]/i.test(out)) {
    out = `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n</head>\n<body>\n${out}\n</body>\n</html>`;
    fixed.push("内容不是完整页面，已包上 <html>/<head>/<body>");
  }
  if (!/<head[\s>]/i.test(out)) out = out.replace(/<html([^>]*)>/i, "<html$1>\n<head></head>");
  const head = (s: string) => {
    out = out.replace(/<head([^>]*)>/i, (m) => `${m}\n${s}`);
  };
  // 样式放在 </head> 前面：<meta charset> 必须在页面前 1024 字节里，不能被一大段 CSS 挤到后面。
  // 放在模型自己的 <style> 后面也不影响：分了层的样式不管位置，优先级都比没分层的低。重新提交同一个页面时不重复加
  if (!out.includes(`id="${MARK}"`)) out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, `${STYLE_TAG}\n</head>`) : out.replace(/<head([^>]*)>/i, (m) => `${m}\n${STYLE_TAG}`);
  if (!/<meta[^>]+name=["']?viewport/i.test(out)) {
    head(VIEWPORT);
    fixed.push("补上了手机适配的 <meta viewport>");
  }
  if (!/<meta[^>]+charset/i.test(out)) head('<meta charset="utf-8">');
  return { html: out, fixed };
}

/**
 * 看源码能查出来的问题。每条都写清楚“为什么是问题、怎么改”，模型看了就能改。
 * 不追求查全：宁可漏掉，也不要误报一堆让模型白改。
 */
export function lintHtml(html: string): string[] {
  const issues: string[] = [];
  // 去掉基础样式本身，免得查到自己
  const src = html.replace(new RegExp(`<style id="${MARK}">[\\s\\S]*?</style>`), "");
  const css = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n") + [...src.matchAll(/style="([^"]*)"/gi)].map((m) => m[1]).join(";");
  const text = src.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, " ");

  if (/(此处省略|其余(同上|类似|省略)|以下省略|\.\.\.\s*(更多|其他)|<!--\s*(…|\.\.\.)\s*-->)/.test(src))
    issues.push("页面里有“省略/其余同上”之类的占位，内容不完整。补全后重新提交完整页面");

  const wide = [...css.matchAll(/(?<![-\w])(min-)?width\s*:\s*(\d{3,})px/gi)].filter((m) => Number(m[2]) > 600).map((m) => m[0]);
  if (wide.length) issues.push(`写死了较大的宽度（${[...new Set(wide)].slice(0, 3).join("、")}），手机上会出现横向滚动。改成 max-width，或用百分比 / grid 自适应`);

  const colors = new Set((css.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi) ?? []).map((c) => c.toLowerCase().replace(/\s+/g, "")));
  if (colors.size > 14) issues.push(`用了 ${colors.size} 种颜色，看起来会乱。收敛成“中性色 + 1 个主色 + 状态色”，写成 CSS 变量（基础样式里已有 --accent、--muted、--border 等）`);

  const tiny = [...css.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/gi)].filter((m) => Number(m[1]) < 12);
  if (tiny.length) issues.push("有小于 12px 的字号，看不清。正文 15～16px，说明文字最小 12px");

  const ext = [...src.matchAll(/<(?:script|link)[^>]+(?:src|href)=["'](https?:\/\/[^"']+)/gi)].map((m) => m[1].replace(/^https?:\/\/([^/:]+).*$/, "$1"));
  if (ext.some((h) => /googleapis|gstatic|google\.com/.test(h)))
    issues.push("引用了 Google 的字体或脚本，在中国大陆打不开，页面会卡住或字体缺失。去掉，用系统字体（基础样式的 var(--font) 已经包含中文字体）");
  else if (ext.length) issues.push(`引用了外部资源（${[...new Set(ext)].join("、")}），断网或网络受限时页面会坏。能内联就内联；图表优先用内联 SVG`);

  const noAlt = (src.match(/<img(?![^>]*\balt=)[^>]*>/gi) ?? []).length;
  if (noAlt) issues.push(`${noAlt} 张图片没有 alt，图片加载失败时用户不知道这里是什么。加上简短说明`);

  if (!/<title>[^<]+<\/title>/i.test(src)) issues.push("没有 <title>，浏览器标签页和下载的文件名会是空的。加一个简短标题");

  if (/lorem ipsum/i.test(text)) issues.push("还有 Lorem ipsum 占位文字。换成和主题相关的真实内容");

  return issues;
}
