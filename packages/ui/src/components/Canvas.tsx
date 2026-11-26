"use client";
import { useEffect, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Artifact, StoredMessage } from "../../../protocol/src/lib/shared";
import { fileChanges, originalOf } from "../lib/diff";
import { artifactExt, extOf, iconForExt, type View } from "../../../protocol/src/lib/outputs";
import { KindIcon } from "./KindIcon";
import { Markdown } from "./Markdown";
import { WorkspaceAppCanvas } from "./WorkspaceAppCanvas";
import { CodeLines, FileBody, fmtSize, useFile } from "./FileDrawer";
import { SvgFrame } from "./SvgFrame";
import { FileDiff, diffStat } from "./Code";
import { ICheck, ICode, ICopy, IDownload, IEye, IFolder, IRetry, IX } from "./Icons";
import { api, filesUrl } from "../lib/client";
import { FileTree } from "./FileTree";
import "./Canvas.css";

/**
 * 右侧大视图（嵌入式卡片）：代码、Markdown、网页、工作区文件都在这里“大”显示。
 * 由 Workspace 的 view 状态驱动：{type:"artifact", id} 或 {type:"file", path}。
 */
export function Canvas(props: {
  sessionId: string;
  view: View;
  artifacts: Artifact[];
  /** 当前对话的消息：用来找出这个文件在本次对话里被改了哪些地方 */
  messages: StoredMessage[];
  refreshKey: unknown; // 会话消息变化时刷新文件内容（文件可能被再次写入）
  splitSource?: boolean;
  canImport?: boolean;
  onRevisionAvailability?(available: boolean | null): void;
  outputSwitch?: ReactNode;
  onOpenFile(path: string): void;
  onClose(): void;
}) {
  const { view } = props;
  const [raw, setRaw] = useState(Boolean(view.source));
  const [copied, setCopied] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false);
  const [treeRefresh, setTreeRefresh] = useState(0);
  const treeId = useId();
  // 文件在本次对话里的改动（edit_file / write_file）。有“修改”时打开文件默认显示改动，没有就显示内容
  const changes = useMemo(() => (view.type === "file" ? fileChanges(props.messages, view.path) : []), [view, props.messages]);

  const [tab, setTab] = useState<"content" | "diff">("content");
  const viewKey = JSON.stringify(view);
  useEffect(() => setRaw(Boolean(view.source)), [view]);
  const previewableFile = view.type === "file" && isPreviewable(extOf(view.path));
  useEffect(() => setTab(!previewableFile && !props.splitSource && changes.some((c) => view.source || !c.isNew) ? "diff" : "content"), [viewKey, previewableFile, props.splitSource]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedArtifact = view.type === "artifact" ? props.artifacts.find((a) => a.id === view.id) : undefined;
  // Markdown 产出的聊天快照还能用于回看，右侧可编辑视图以工作区文件为准。
  const sourcePath = view.type === "file" ? view.path : selectedArtifact?.file ?? "";
  const { res: fileRes, setRes: setFileRes, reload } = useFile(props.sessionId, sourcePath, props.refreshKey, props.splitSource);
  const file = fileRes && "type" in fileRes ? fileRes : null;
  const missingFile = !!fileRes && "error" in fileRes && fileRes.error === "文件不存在";
  // 历史变更卡和旧的预览状态可能依旧保存文件路径。仅用本对话中完全匹配的快照恢复预览。
  const artifact = selectedArtifact ?? (view.type === "file" && missingFile
    ? props.artifacts.find((item) => item.file === view.path && !item.workspaceApp) : undefined);
  const filePath = view.type === "file" ? view.path : artifact?.kind === "markdown" ? sourcePath : "";
  const [saving, setSaving] = useState(false);
  const [taskError, setTaskError] = useState<{ id: string; text: string } | null>(null);
  const taskFile = file?.type === "file" && file.id && file.revision ? file : undefined;

  // 统一出标题、类型、内容
  const title = artifact ? artifact.title : view.type === "file" ? (view.path === "." ? "工作区" : view.path) : "";
  const ext = artifact ? artifactExt(artifact) : view.type === "file" ? (file?.type === "dir" ? "dir" : extOf(view.path)) : "";
  const loadingMarkdown = artifact?.kind === "markdown" && Boolean(filePath) && !fileRes;
  const content = loadingMarkdown ? ""
    : file?.type === "file" && (!artifact || (!file.binary && !file.truncated)) ? file.content : artifact?.content ?? "";
  // 整体改动：对话开始前 → 现在（现在的内容来自刚读到的文件）
  const comparableFile = changes.length > 0 && file?.type === "file" && !file.binary && !file.truncated ? file : null;
  const original = useMemo(() => comparableFile ? originalOf(comparableFile.content, changes) : "", [changes, comparableFile]);
  const total = useMemo(() => comparableFile ? diffStat(original, comparableFile.content) : null, [comparableFile, original]);
  const canToggle = isPreviewable(ext) || artifact?.kind === "code";
  const split = props.splitSource && isPreviewable(ext) && (file?.type === "file" && !file.binary || !!artifact && !loadingMarkdown);
  const canRevise = view.type === "file" && !fileRes ? null
    : view.type === "file" && file?.type === "file" && !file.binary && file.size <= 1024 * 1024;
  const { onRevisionAvailability } = props;
  useEffect(() => onRevisionAvailability?.(canRevise), [canRevise, onRevisionAvailability, viewKey]);
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

  const toggleTask = async (itemStart: number, checked: boolean) => {
    const id = taskFile?.id;
    if (!id || saving) return;
    setSaving(true);
    setTaskError(null);
    try {
      const response = await fetch(filesUrl(props.sessionId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, revision: taskFile.revision, itemStart, checked }),
      });
      const result = await response.json();
      if (response.status === 409) reload();
      if (!response.ok) throw new Error(result.error || "保存失败");
      setFileRes((current) => current && "type" in current && current.type === "file" &&
        current.id === id && current.revision === taskFile.revision
        ? { ...current, content: result.content, revision: result.revision, mtime: result.mtime, size: result.size }
        : current);
    } catch (error) {
      setTaskError({ id, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  };
  const tasks = taskFile ? { toggle: toggleTask, disabled: saving } : undefined;
  const markdownDownload = file?.type === "file" && file.id && /^(md|markdown)$/.test(ext)
    ? filesUrl(props.sessionId, { id: file.id, download: "1" })
    : undefined;

  if (artifact?.workspaceApp) {
    return <WorkspaceAppCanvas {...artifact.workspaceApp} title={artifact.title} outputSwitch={props.outputSwitch} onClose={props.onClose} />;
  }
  // 成品导出后仍可能直接编辑保存的文件。已有新文件内容时，用导出快照作这次差异的基线。
  const sourceContent = file?.type === "file" && !file.binary && !file.truncated ? file.content : artifact?.content ?? "";
  const source = (raw || split) && (artifact
    ? sourcePath && !fileRes
      ? <div className="view-empty" role="status">读取源码…</div>
      : <ArtifactSource sessionId={props.sessionId} artifact={artifact} content={sourceContent} lang={artifact.language || ext} />
    : comparableFile && <FileDiff before={original} after={comparableFile.content} lang={filePath} />);

  return (
    <section className="viewer">
      <div className="viewer-head">
        <KindIcon kind={isDir ? "folder" : iconForExt(ext)} tile className="viewer-icon" />
        <div className="viewer-title">
          <div className={`ellipsis ${view.type === "file" ? "mono" : ""}`}>{title}</div>
          {artifact?.file && file?.type === "file" && <div className="viewer-sub ellipsis" title={artifact.file}>已保存到 {artifact.file}</div>}
          {artifact && (!artifact.file || (fileRes && !file)) && <div className="viewer-sub">会话快照 · 可下载</div>}
          {file?.type === "file" && (
            <div className="viewer-sub">
              {fmtSize(file.size)} · {new Date(file.mtime).toLocaleString()}
              {file.truncated && " · 已截断"}
            </div>
          )}
        </div>
        {ext && !isDir && <span className="tag">{ext.toUpperCase()}</span>}
        <div className="spacer" />
        {!canToggle && total && (
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
        {canToggle && !split && tab === "content" && (
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
          <a className="icon-btn" href={filesUrl(props.sessionId, { path: file.path, download: "1" })} download title="下载">
            <IDownload />
          </a>
        )}
        {(content || markdownDownload) && (
          <>
            <button className="icon-btn" onClick={copy} title="复制">
              {copied ? <ICheck /> : <ICopy />}
            </button>
            {markdownDownload ? (
              <a className="icon-btn" href={markdownDownload} download title="下载"><IDownload /></a>
            ) : (
              <button className="icon-btn" onClick={download} title="下载"><IDownload /></button>
            )}
          </>
        )}
        {props.sessionId && (
          <button type="button" className="icon-btn canvas-tree-toggle" onClick={() => setTreeOpen((open) => !open)}
            aria-expanded={treeOpen} aria-controls={treeId} aria-label={treeOpen ? "收起文件树" : "显示文件树"}
            title={treeOpen ? "收起文件树" : "显示文件树"}>
            <IFolder />
          </button>
        )}
        {props.outputSwitch}
        <button className="icon-btn" onClick={props.onClose} title="关闭 Esc">
          <IX />
        </button>
      </div>

      <div className="canvas-content">
        <aside className="canvas-file-tree" id={treeId} aria-label="当前对话文件树" hidden={!treeOpen}>
          {treeOpen && <>
            <div className="canvas-file-tree-head">
              <span>当前对话文件</span>
              <button type="button" className="icon-btn" title="刷新文件树" aria-label="刷新文件树" onClick={() => setTreeRefresh((count) => count + 1)}>
                <IRetry width={14} height={14} aria-hidden />
              </button>
            </div>
            <FileTree key={props.sessionId} sessionId={props.sessionId} activePath={view.type === "file" ? view.path : artifact?.file}
              canImport={Boolean(props.canImport)} refreshKey={`${props.refreshKey}:${treeRefresh}`} onOpen={props.onOpenFile} />
          </>}
        </aside>
      <div className={split && tab === "content" ? "viewer-body subagent-output-split" : "viewer-body"} key={viewKey}>
        {taskError?.id === taskFile?.id && taskError && <div className="set-hint" role="status">{taskError.text}</div>}
        {split && tab === "content" ? <>
          <section aria-label="产出物预览">
            <div className="subagent-output-label">预览</div>
            {filePath && !artifact ? <FileBody sessionId={props.sessionId} path={filePath} res={fileRes} raw={false} onOpen={props.onOpenFile} />
              : ext === "svg" ? <SvgFrame svg={content} title={title} />
              : ext === "html" || ext === "htm" ? <iframe className="frame" sandbox="allow-scripts allow-forms allow-modals" srcDoc={content} title={title} />
              : <div className="doc"><Markdown text={content} /></div>}
          </section>
          <section aria-label="源码">
            <div className="subagent-output-label">源码</div>
            {source || <CodeLines text={content} lang={artifact?.language || filePath || ext} />}
          </section>
        </> : loadingMarkdown ? (
          <div className="view-empty">读取中…</div>
        ) : source ? source : artifact ? (
          artifact.kind === "html" && !raw ? (
            <iframe className="frame" sandbox="allow-scripts allow-forms allow-modals" srcDoc={content} title={artifact.title} />
          ) : ext === "svg" && !raw ? (
            <SvgFrame svg={content} title={artifact.title} />
          ) : artifact.kind === "markdown" && !raw ? (
            <div className="doc">
              <Markdown text={content} tasks={tasks} />
            </div>
          ) : (
            <CodeLines text={content} lang={artifact.language || ext} />
          )
        ) : tab === "diff" && comparableFile ? (
          <FileDiff before={original} after={comparableFile.content} lang={filePath} />
        ) : view.type === "file" ? (
          <FileBody sessionId={props.sessionId} path={view.path} res={fileRes} raw={raw} onOpen={props.onOpenFile} tasks={tasks} />
        ) : (
          <div className="view-empty">内容已不存在</div>
        )}
      </div>
      </div>
    </section>
  );
}

const isPreviewable = (ext: string) => ["md", "markdown", "html", "htm", "svg"].includes(ext);

/** 只在查看源码时请求版本，避免打开网页预览即读取额外正文。 */
function ArtifactSource({ sessionId, artifact, content, lang }: { sessionId: string; artifact: Artifact; content: string; lang: string }) {
  if (content !== artifact.content) return <FileDiff before={artifact.content} after={content} lang={lang} />;
  return <ArtifactVersionSource sessionId={sessionId} artifact={artifact} lang={lang} />;
}

function ArtifactVersionSource({ sessionId, artifact, lang }: { sessionId: string; artifact: Artifact; lang: string }) {
  const [comparison, setComparison] = useState<{ before: string | null; after: string } | null>(null);
  const [error, setError] = useState("");
  const { id, content: snapshot, sourceToolCallId } = artifact;
  useEffect(() => {
    const controller = new AbortController();
    setComparison(null);
    setError("");
    api.artifactSource(sessionId, id, controller.signal).then((result) => {
      if (!controller.signal.aborted) setComparison(result);
    }).catch(() => {
      if (!controller.signal.aborted) setError("无法读取版本差异，以下显示完整源码。");
    });
    return () => controller.abort();
  }, [sessionId, id, snapshot, sourceToolCallId]);

  if (comparison?.after === snapshot && comparison.before !== null) {
    return <FileDiff before={comparison.before} after={snapshot} lang={lang} />;
  }
  if (!comparison && !error) return <div className="view-empty" role="status">读取版本差异…</div>;
  return <>
    <div className="canvas-source-note" role="status">{error || "此产出缺少匹配的旧版本，以下显示完整源码。"}</div>
    <CodeLines text={snapshot} lang={lang} />
  </>;
}

function safeName(s: string) {
  return s.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60) || "artifact";
}
