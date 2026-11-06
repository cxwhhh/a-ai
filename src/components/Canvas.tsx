"use client";
import { useEffect, useMemo, useState } from "react";
import type { Artifact, StoredMessage } from "@/lib/shared";
import { fileChanges, originalOf } from "@/lib/diff";
import { artifactExt, extOf, iconForExt, type View } from "@/lib/outputs";
import { KindIcon } from "./KindIcon";
import { Markdown } from "./Markdown";
import { CodeLines, FileBody, fmtSize, useFile } from "./FileDrawer";
import { SvgFrame } from "./SvgFrame";
import { FileDiff, diffStat } from "./Code";
import { ICheck, ICode, ICopy, IDownload, IEye, IX } from "./Icons";

/**
 * 右侧大视图（嵌入式卡片）：代码、Markdown、网页、工作区文件都在这里“大”显示。
 * 由 Workspace 的 view 状态驱动：{type:"artifact", id} 或 {type:"file", path}。
 */
export function Canvas(props: {
  view: View;
  artifacts: Artifact[];
  /** 当前对话的消息：用来找出这个文件在本次对话里被改了哪些地方 */
  messages: StoredMessage[];
  refreshKey: unknown; // 会话消息变化时刷新文件内容（文件可能被再次写入）
  onOpenFile(path: string): void;
  onClose(): void;
}) {
  const { view } = props;
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  // 文件在本次对话里的改动（edit_file / write_file）。有“修改”时打开文件默认显示改动，没有就显示内容
  const changes = useMemo(() => (view.type === "file" ? fileChanges(props.messages, view.path) : []), [view, props.messages]);

  const [tab, setTab] = useState<"content" | "diff">("content");
  const viewKey = JSON.stringify(view);
  useEffect(() => setRaw(false), [view]);
  useEffect(() => setTab(changes.some((c) => !c.isNew) ? "diff" : "content"), [viewKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const artifact = view.type === "artifact" ? props.artifacts.find((a) => a.id === view.id) : undefined;
  const fileRes = useFile(view.type === "file" ? view.path : "", view.type === "file" ? props.refreshKey : null);
  const file = view.type === "file" && fileRes && "type" in fileRes ? fileRes : null;

  // 统一出标题、类型、内容
  const title = artifact ? artifact.title : view.type === "file" ? (view.path === "." ? "工作区" : view.path) : "";
  const ext = artifact ? artifactExt(artifact) : view.type === "file" ? (file?.type === "dir" ? "dir" : extOf(view.path)) : "";
  const content = artifact ? artifact.content : file?.type === "file" ? file.content : "";
  // 整体改动：对话开始前 → 现在（现在的内容来自刚读到的文件）
  const original = useMemo(() => (changes.length && file?.type === "file" ? originalOf(file.content, changes) : ""), [changes, file]);
  const total = useMemo(() => (changes.length && file?.type === "file" ? diffStat(original, file.content) : { add: 0, del: 0 }), [changes, file, original]);
  const canToggle = ["md", "markdown", "html", "htm", "svg"].includes(ext);
  const isDir = file?.type === "dir";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* 剪贴板不可用时忽略 */
    }
  };
  const download = () => {
    const name = view.type === "file" ? view.path.split("/").pop()! : `${safeName(title)}.${ext}`;
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    Object.assign(document.createElement("a"), { href: url, download: name }).click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="viewer">
      <div className="viewer-head">
        <KindIcon kind={isDir ? "folder" : iconForExt(ext)} tile className="viewer-icon" />
        <div className="viewer-title">
          <div className={`ellipsis ${view.type === "file" ? "mono" : ""}`}>{title}</div>
          {artifact?.file && <div className="viewer-sub">已保存到 {artifact.file}</div>}
          {file?.type === "file" && (
            <div className="viewer-sub">
              {fmtSize(file.size)} · {new Date(file.mtime).toLocaleString()}
              {file.truncated && " · 已截断"}
            </div>
          )}
        </div>
        {ext && !isDir && <span className="tag">{ext.toUpperCase()}</span>}
        <div className="spacer" />
        {changes.length > 0 && (
          <div className="seg text">
            <button className={tab === "content" ? "on" : ""} onClick={() => setTab("content")}>
              内容
            </button>
            <button className={tab === "diff" ? "on" : ""} onClick={() => setTab("diff")} title="本次对话里对这个文件的修改">
              改动
              <span className="tab-stat">
                <b className="add">+{total.add}</b>
                <b className="del">-{total.del}</b>
              </span>
            </button>
          </div>
        )}
        {canToggle && tab === "content" && (
          <div className="seg">
            <button className={!raw ? "on" : ""} onClick={() => setRaw(false)} title="预览">
              <IEye />
            </button>
            <button className={raw ? "on" : ""} onClick={() => setRaw(true)} title="源码">
              <ICode />
            </button>
          </div>
        )}
        {file?.type === "file" && file.binary && (
          <a className="icon-btn" href={`/api/files?download=1&path=${encodeURIComponent(file.path)}`} download title="下载">
            <IDownload />
          </a>
        )}
        {content && (
          <>
            <button className="icon-btn" onClick={copy} title="复制">
              {copied ? <ICheck /> : <ICopy />}
            </button>
            <button className="icon-btn" onClick={download} title="下载">
              <IDownload />
            </button>
          </>
        )}
        <button className="icon-btn" onClick={props.onClose} title="关闭 Esc">
          <IX />
        </button>
      </div>

      <div className="viewer-body" key={JSON.stringify(view)}>
        {artifact ? (
          artifact.kind === "html" && !raw ? (
            <iframe className="frame" sandbox="allow-scripts allow-forms allow-modals" srcDoc={artifact.content} title={artifact.title} />
          ) : ext === "svg" && !raw ? (
            <SvgFrame svg={artifact.content} title={artifact.title} />
          ) : artifact.kind === "markdown" && !raw ? (
            <div className="doc">
              <Markdown text={artifact.content} />
            </div>
          ) : (
            <CodeLines text={artifact.content} lang={artifact.language || ext} />
          )
        ) : view.type === "file" && tab === "diff" && changes.length ? (
          file?.type === "file" ? <FileDiff before={original} after={file.content} lang={view.path} /> : <div className="view-empty">读取中…</div>
        ) : view.type === "file" ? (
          <FileBody path={view.path} res={fileRes} raw={raw} onOpen={props.onOpenFile} />
        ) : (
          <div className="view-empty">内容已不存在</div>
        )}
      </div>
    </section>
  );
}

function safeName(s: string) {
  return s.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60) || "artifact";
}
