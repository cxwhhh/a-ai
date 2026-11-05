"use client";

/**
 * 显示 SVG：放进沙箱 iframe 里渲染，而不是当成 <img> 或纯文本。
 * - <img src="x.svg"> 里 SVG 的 <script> 不会执行，用 JS 写的动画就是静态的
 * - iframe 里是一个完整的文档：SMIL 动画（<animate>）、CSS 动画、<script> 都能跑
 * - sandbox 只给 allow-scripts，不给 allow-same-origin：脚本能跑，但碰不到 A.ai 页面的 Cookie 和数据
 */
export function SvgFrame({ svg, title, inline }: { svg: string; title: string; inline?: boolean }) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%}
body{display:grid;place-items:center;padding:16px;box-sizing:border-box;background:#fff}
body>svg{max-width:100%;max-height:100%;height:auto}
</style></head><body>${svg.replace(/^\s*<\?xml[^>]*>/i, "")}</body></html>`;
  // inline：嵌在 Markdown 里时没有固定高度，按 viewBox 的宽高比给 iframe 定一个高度
  const style = inline ? { aspectRatio: ratioOf(svg), maxHeight: 420 } : undefined;
  return <iframe className={inline ? "frame svg-inline" : "frame"} style={style} sandbox="allow-scripts" srcDoc={doc} title={title} />;
}

/** 从 viewBox="0 0 宽 高"（或 width/height 属性）算出宽高比，算不出来就用 16/9 */
function ratioOf(svg: string) {
  const head = svg.slice(0, 2000);
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(head);
  const w = vb ? +vb[1] : +(/\swidth\s*=\s*["']([\d.]+)/i.exec(head)?.[1] ?? 0);
  const h = vb ? +vb[2] : +(/\sheight\s*=\s*["']([\d.]+)/i.exec(head)?.[1] ?? 0);
  return w > 0 && h > 0 ? `${w} / ${h}` : "16 / 9";
}
