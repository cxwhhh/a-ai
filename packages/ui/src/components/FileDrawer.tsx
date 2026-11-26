"use client";
import { useEffect, useState } from "react";
import { Markdown, type MarkdownTaskActions } from "./Markdown";
import { IFile, IFolder } from "./Icons";
import { SvgFrame } from "./SvgFrame";
import { HlLines } from "./Code";
import { filesUrl } from "../lib/client";
import "./FileDrawer.css";

/**
 * 工作区文件的内容区：在右侧大视图里显示文件（带行号）或目录列表。
 * 服务端验证账号和对话，再在该对话的目录下读取文件。
 * 文件名保留为 FileDrawer.tsx 是历史原因：最早它是一个独立弹窗。
 */

export type FileRes =
  | { path: string; type: "dir"; items: { name: string; dir: boolean }[] }
  | { path: string; type: "file"; id?: string; revision?: string; size: number; mtime: number; binary: boolean; content: string; truncated: boolean; ext: string; preview?: string }
  | { path: string; error: string };

export function useFile(sessionId: string, path: string, refreshKey: unknown, keepPrevious = false, legacy = false) {
  const [res, setRes] = useState<FileRes | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!sessionId || !path) return;
    const controller = new AbortController();
    // 文件树刷新已打开的目录时保留原列表，以免整支子树重挂载。
    if (!keepPrevious) setRes(null);
    fetch(filesUrl(sessionId, { path, ...(legacy ? { legacy: "1" } : {}) }), { cache: "no-store", signal: controller.signal })
      .then(async (response): Promise<FileRes> => {
        const data = await response.json();
        return response.ok ? data : { path, error: data.error || "无法读取工作区文件" };
      })
      .then((data) => { if (!controller.signal.aborted) setRes(data); })
      .catch((error) => { if (!controller.signal.aborted) setRes({ path, error: String(error) }); });
    return () => controller.abort();
  }, [sessionId, path, refreshKey, generation, keepPrevious, legacy]);
  return { res: sessionId && path && res?.path === path ? res : null, setRes, reload: () => setGeneration((n) => n + 1) };
}

export function FileBody({ sessionId, path, res, raw, onOpen, tasks }: { sessionId: string; path: string; res: FileRes | null; raw: boolean; onOpen(p: string): void; tasks?: MarkdownTaskActions }) {
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
  const src = filesUrl(sessionId, { path, raw: "1" });
  if (/^(png|jpe?g|gif|webp|bmp|avif)$/.test(res.ext)) {
    return (
      <div className="file-img">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={path} />
      </div>
    );
  }
  if (res.ext === "pdf") return <iframe className="file-pdf" src={src} title={path} />;
  if (res.binary) {
    // Word / Excel / PPT：显示取出来的文字（排版看不到），并给一个下载原文件的链接
    const dl = filesUrl(sessionId, { path, download: "1" });
    const kind = { docx: "Word 文档", xlsx: "Excel 表格", pptx: "PPT 演示文稿" }[res.ext];
    return (
      <div className="office-pv">
        <div className="office-note">
          <span>{kind ? `${kind}，这里只显示文字内容，排版请下载后用 Office 打开` : "二进制文件，无法预览"}</span>
          <a className="btn" href={dl} download>
            下载
          </a>
        </div>
        {res.preview && <pre className="office-text">{res.preview}</pre>}
      </div>
    );
  }
  if ((res.ext === "md" || res.ext === "markdown") && !raw) {
    return (
      <div className="doc">
        <Markdown text={res.content} tasks={tasks} />
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
