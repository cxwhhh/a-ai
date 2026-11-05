"use client";
import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SvgFrame } from "./SvgFrame";
import { MdCodeBlock } from "./Code";
import { isSvg } from "@/lib/svg";
import { isFileName, rehypeFileChips } from "@/lib/file-chips";

/**
 * onOpenFile：传了就让文件名可以点（鼠标移上去出现下划线，点击后在右侧打开）。
 * 要传一个“稳定”的函数（每次渲染都是同一个），否则 memo 失效，长回答会反复重新解析
 */
export const Markdown = memo(function Markdown({ text, onOpenFile }: { text: string; onOpenFile?: (name: string) => void }) {
  // 文件名：可点时渲染成带 role=button 的 span（保持行内排版），回车 / 空格也能打开
  const chip = (name: string, Tag: "span" | "code") =>
    onOpenFile ? (
      <Tag
        className="file-chip link"
        role="button"
        tabIndex={0}
        title="在右侧打开"
        onClick={() => onOpenFile(name)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpenFile(name))}
      >
        {name}
      </Tag>
    ) : (
      <Tag className="file-chip">{name}</Tag>
    );

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeFileChips]}
        components={{
          a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noreferrer" />,
          // ```svg 代码块：直接显示成图（动画会动），而不是一段代码
          pre: ({ node, ...p }) => {
            const code = node?.children[0];
            const text = code?.type === "element" && code.children[0]?.type === "text" ? code.children[0].value : "";
            const cls = code?.type === "element" ? String(code.properties?.className ?? "") : "";
            // 流式输出时代码还没写完，等出现 </svg> 再显示成图，避免半张图不停刷新
            if (/language-(svg|xml)/.test(cls) && isSvg(text) && /<\/svg>\s*$/i.test(text)) return <SvgFrame svg={text} title="SVG" inline />;
            // 其他代码块：按 ```语言 高亮（GitHub 配色）；没写语言时自动识别
            const lang = /language-([\w+-]+)/.exec(cls)?.[1];
            return <MdCodeBlock code={text.replace(/\n$/, "")} lang={lang} />;
          },
          // 行内代码如果正好是一个文件名（`report.md`），也显示成浅蓝底的文件名
          code: ({ node: _n, className, children, ...p }) =>
            !className && typeof children === "string" && isFileName(children) ? (
              chip(children, "code")
            ) : (
              <code className={className} {...p}>
                {children}
              </code>
            ),
          // rehypeFileChips 插进来的文件名
          span: ({ node: _n, className, children, ...p }) =>
            className === "file-chip" && typeof children === "string" ? chip(children, "span") : (
              <span className={className} {...p}>
                {children}
              </span>
            ),
          table: ({ node: _n, ...p }) => (
            <div className="md-table">
              <table {...p} />
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
