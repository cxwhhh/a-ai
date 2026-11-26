"use client";

import { useState, type FormEvent } from "react";
import type { Artifact, StoredMessage } from "../../../protocol/src/lib/shared";
import type { View } from "../../../protocol/src/lib/outputs";
import { FileTree } from "./FileTree";
import { TurnFileChanges } from "./OutputsCard";
import { IArrowUp, IFileEdit, IFolder, ISearch, IThreads, IWrench, IX } from "./Icons";
import "./WorkspaceTab.css";

type TabPage = "start" | "files" | "changes";

/** 新标签页只提供现有工作区能力的入口，可以在首轮发送前打开。 */
export function WorkspaceTab({ fileSessionId, messages, artifacts, refreshKey, canImport, onOpenFile, onOpenView, onOpenTasks, onOpenThreads, onClose }: {
  fileSessionId: string;
  messages: StoredMessage[];
  artifacts: Artifact[];
  refreshKey: string;
  canImport: boolean;
  onOpenFile(path: string): void;
  onOpenView(view: View): void;
  onOpenTasks(): void;
  onOpenThreads?: () => void;
  onClose(): void;
}) {
  const [page, setPage] = useState<TabPage>("start");
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState("");
  const title = page === "files" ? "对话文件" : page === "changes" ? "文件变更" : "新标签页";

  function openAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = address.trim();
    if (!value) return;
    if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//")) {
      // 网页入口只接受完整的 HTTP(S) 地址。网页由浏览器打开，不进入会话的文件接口。
      const url = URL.canParse(value) ? new URL(value) : null;
      if (!url || !["http:", "https:"].includes(url.protocol) || !/^https?:\/\//i.test(value)) {
        setAddressError("请输入以 http:// 或 https:// 开头的网址，或相对工作区的文件路径。");
        return;
      }
      window.open(url.href, "_blank", "noopener,noreferrer");
      return;
    }
    if (!fileSessionId) {
      setAddressError("当前对话尚没有工作区文件。");
      return;
    }
    onOpenFile(value);
  }

  return (
    <section className="viewer workspace-tab" id="conversation-workspace-tab" aria-label={title}>
      <div className="viewer-head">
        {page !== "start" && (
          <button type="button" className="icon-btn workspace-tab-back" aria-label="返回新标签页" title="返回新标签页" onClick={() => setPage("start")}>
            <IArrowUp />
          </button>
        )}
        <div className="viewer-title">{title}</div>
        <div className="spacer" />
        <button type="button" className="icon-btn" aria-label="关闭标签页" title="关闭标签页" onClick={onClose}><IX /></button>
      </div>
      <div className={`viewer-body workspace-tab-body workspace-tab-${page}`}>
        {page === "start" ? (
          <div className="workspace-tab-launcher">
            <form className="workspace-tab-address" onSubmit={openAddress}>
              <ISearch width={16} height={16} aria-hidden />
              <input type="text" aria-label="文件路径或网址" placeholder="输入文件路径或网址" value={address}
                onChange={(event) => { setAddress(event.target.value); setAddressError(""); }} />
              <button type="submit" className="icon-btn workspace-tab-submit" aria-label="打开路径或网址" title="打开" disabled={!address.trim()}>
                <IArrowUp width={16} height={16} />
              </button>
            </form>
            {addressError && <div className="workspace-tab-error" role="status">{addressError}</div>}
            <div className="workspace-tab-links" aria-label="工作区功能">
              <button type="button" onClick={() => setPage("files")}><IFolder aria-hidden />对话文件</button>
              <button type="button" onClick={() => setPage("changes")}><IFileEdit aria-hidden />文件变更</button>
              <button type="button" onClick={onOpenTasks}><IWrench aria-hidden />任务与产出</button>
              <button type="button" onClick={onOpenThreads} disabled={!onOpenThreads}><IThreads aria-hidden />子 Agent</button>
            </div>
          </div>
        ) : page === "files" ? (
          <FileTree key={fileSessionId} sessionId={fileSessionId} refreshKey={refreshKey} canImport={canImport} onOpen={onOpenFile} />
        ) : (
          <TurnFileChanges steps={messages} artifacts={artifacts} onOpenView={onOpenView} emptyMessage="这个对话还没有文件变更。" />
        )}
      </div>
    </section>
  );
}
