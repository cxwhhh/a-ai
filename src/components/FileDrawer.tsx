"use client";
import { useEffect, useState } from "react";
import { Markdown } from "./Markdown";
import { IFile, IFolder } from "./Icons";
import { SvgFrame } from "./SvgFrame";
import { HlLines } from "./Code";
import "./FileDrawer.css";

/**
 * 工作区文件的内容区：在右侧大视图里显示文件（带行号）或目录列表。
 * 数据来自 GET /api/files?path=…（与文件工具共用 safePath，读不到工作区之外）。
 * 文件名保留为 FileDrawer.tsx 是历史原因：最早它是一个独立弹窗。
 */

export type FileRes =
  | { path: string; type: "dir"; items: { name: string; dir: boolean }[] }
  | { path: string; type: "file"; size: number; mtime: number; binary: boolean; content: string; truncated: boolean; ext: string }
  | { path: string; error: string };

export function useFile(path: string, refreshKey: unknown) {
  const [res, setRes] = useState<FileRes | null>(null);
  useEffect(() => {
    let alive = true;
    setRes(null);
    fetch(`/api/files?path=${encodeURIComponent(path)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => alive && setRes(d))
      .catch((e) => alive && setRes({ path, error: String(e) }));
    return () => {
      alive = false;
    };
  }, [path, refreshKey]);
  return res;
}

export function FileBody({ path, res, raw, onOpen }: { path: string; res: FileRes | null; raw: boolean; onOpen(p: string): void }) {
  if (!res) return <div className="view-empty">读取中…</div>;
  if ("error" in res) return <div className="view-empty err">{res.error}</div>;

  if (res.type === "dir") {
    const parent = path.includes("/") ? path.replace(/\/[^/]*\/?$/, "") : ".";
    return (
      <div className="dir-list">
        {path !== "." && (
          <button className="dir-item" onClick={() => onOpen(parent)}>
            <IFolder /> ..
          </button>
        )}
        {res.items.map((i) => (
          <button key={i.name} className="dir-item" onClick={() => onOpen(join(path, i.name))}>
            {i.dir ? <IFolder /> : <IFile />}
            <span className="mono">{i.name}</span>
          </button>
        ))}
        {!res.items.length && <div className="view-empty">空目录</div>}
      </div>
    );
  }

  // 图片和 PDF（多半是用户上传的附件）：直接让浏览器显示原文件
  const src = `/api/files?raw=1&path=${encodeURIComponent(path)}`;
  if (/^(png|jpe?g|gif|webp|bmp|avif)$/.test(res.ext)) {
    return (
      <div className="file-img">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={path} />
      </div>
    );
  }
  if (res.ext === "pdf") return <iframe className="file-pdf" src={src} title={path} />;
  if (res.binary) return <div className="view-empty">二进制文件，无法预览</div>;
  if ((res.ext === "md" || res.ext === "markdown") && !raw) {
    return (
      <div className="doc">
        <Markdown text={res.content} />
      </div>
    );
  }
  if (res.ext === "svg" && !raw) return <SvgFrame svg={res.content} title={path} />;
  if ((res.ext === "html" || res.ext === "htm") && !raw) {
    return <iframe className="frame" sandbox="allow-scripts allow-forms allow-modals" srcDoc={res.content} title={path} />;
  }
  return <CodeLines text={res.content} lang={path} />;
}

/** 带行号的代码 / 文本显示（产出物的代码视图也用它）。lang 可以是语言名或文件路径，用来决定高亮规则 */
export function CodeLines({ text, lang }: { text: string; lang?: string }) {
  return <HlLines text={text} lang={lang} />;
}

export const join = (dir: string, name: string) => (!dir || dir === "." ? name : `${dir.replace(/\/+$/, "")}/${name}`).replace(/\/+$/, "");

export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
