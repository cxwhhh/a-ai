"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Artifact, StoredMessage } from "../../../protocol/src/lib/shared";
import type { View } from "../../../protocol/src/lib/outputs";
import { subagentIcon } from "../../../protocol/src/lib/agentIcons";
import type { TaskRecord } from "../../../subagent/src/ownership-claim";
import { api } from "../lib/client";
import { emptyLiveStore, LiveStoreContext } from "../lib/live";
import { ChatPane } from "./ChatPane";
import { Canvas } from "./Canvas";
import type { SubagentSelection } from "./SubagentThreads";
import "./SubagentConversation.css";

const noop = () => {};
const revisionStatus = {
  "matches-expected": "当前文件与最近一次写入的预期内容一致。",
  "matches-before": "当前文件与最近一次写入前的内容一致。",
  changed: "文件已变化，请核对实际内容。",
  unreadable: "无法读取文件，请核对路径和权限。",
  "not-started": "微调在保存写入检查点前中断。",
  unknown: "旧记录缺少写入检查点，请核对文件的实际内容。",
};

/** 右侧复用主对话的气泡、调用过程和输入框。每个分支有自己的消息与停止入口。 */
export function SubagentConversation({ sessionId, selected, sendKey, modKey, archived, canResume, artifacts, onClose }: {
  sessionId: string;
  selected: SubagentSelection;
  sendKey: "enter" | "mod-enter";
  modKey: string;
  archived: boolean;
  canResume: boolean;
  artifacts: Artifact[];
  onClose(): void;
}) {
  const [task, setTask] = useState<TaskRecord>();
  const [attemptId, setAttemptId] = useState(selected.id);
  const [view, setView] = useState<View | null>(null);
  const [fileEditable, setFileEditable] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const [accepted, setAccepted] = useState<StoredMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const focusAfterResume = useRef(false);
  const popupOpen = !!view;
  const running = task?.status === "running";
  const loadingFile = view?.type === "file" && fileEditable === null;
  const canSend = !!task?.chatActive && (running || canResume && task.status !== "queued" && !loadingFile);
  const revisionPath = fileEditable && view?.type === "file" ? view.path : undefined;
  const verification = task?.revisionVerification;
  const verificationPath = verification?.path;
  const messages = useMemo(() => {
    const items = [...(task?.messages ?? []), ...(task?.pendingMessages ?? [])];
    const known = new Set(items.map(({ id }) => id));
    return [...items, ...accepted.filter(({ id }) => !known.has(id))];
  }, [task, accepted]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const { task: current } = await api.subagentConversation(sessionId, attemptId, controller.signal);
        if (controller.signal.aborted) return;
        setTask((previous) => current.messages || previous?.id !== current.id ? current : { ...current, messages: previous.messages });
        setLoadError(null);
        if (current.status === "running" || current.status === "queued") timer = setTimeout(refresh, 650);
      } catch (error) {
        if (controller.signal.aborted) return;
        setLoadError(error instanceof Error ? error.message : "无法读取子 Agent 对话");
        timer = setTimeout(refresh, 1500);
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sessionId, attemptId]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!popupOpen || !dialog) return;
    dialog.showModal();
    if (!inputRef.current?.disabled) inputRef.current?.focus();
    return () => dialog.close();
  }, [popupOpen]);

  useLayoutEffect(() => {
    if (!canSend || !focusAfterResume.current) return;
    focusAfterResume.current = false;
    inputRef.current?.focus();
  }, [canSend]);

  function openFile(path: string) {
    if (view?.type === "file" && view.path === path) return;
    setFileEditable(null);
    setView({ type: "file", path });
  }

  function openArtifact(id: string) {
    const artifact = artifacts.find((item) => item.id === id);
    if (artifact?.file) openFile(artifact.file);
    else setView({ type: "artifact", id });
  }

  function openAttempt(next: TaskRecord, content?: string) {
    setAccepted([]);
    const followup = content ? [{ id: `${next.id}:followup`, role: "user" as const, content, createdAt: next.createdAt }] : [];
    setTask({ ...next, messages: next.messages ?? [...messages, ...followup] });
    setAttemptId(next.id);
  }

  async function recoverTask() {
    setSending(true);
    setError(null);
    try {
      openAttempt(await api.submitSubagentTask(sessionId, { retryTaskId: attemptId }));
    } catch (error) { setError(error instanceof Error ? error.message : "无法恢复子任务"); }
    finally { setSending(false); }
  }

  async function send() {
    const text = draft.trim();
    if (!canSend || sending || !text) return;
    setSending(true);
    setError(null);
    try {
      if (running) {
        const { message } = await api.sendSubagentMessage(sessionId, attemptId, text);
        setAccepted((previous) => [...previous, message]);
      } else {
        const next = await api.submitSubagentTask(sessionId, { continueTaskId: attemptId, message: text, path: revisionPath });
        openAttempt(next, text);
      }
      setDraft((current) => current.trim() === text ? "" : current);
    } catch (error) { setError(error instanceof Error ? error.message : "无法发送消息"); }
    finally { setSending(false); }
  }

  async function setChatActive(active: boolean) {
    setSending(true);
    setError(null);
    try {
      if (active) {
        const { task: resumed } = await api.resumeSubagentConversation(sessionId, attemptId);
        focusAfterResume.current = true;
        setTask((current) => ({ ...resumed, revisionVerification: current?.revisionVerification }));
      } else {
        await api.stopSubagentTask(sessionId, attemptId);
        setTask((current) => current?.id === attemptId ? { ...current, chatActive: false } : current);
      }
    } catch (error) { setError(error instanceof Error ? error.message : "无法切换子 Agent 对话状态"); }
    finally { setSending(false); }
  }

  const closePopup = () => setView(null);
  const chat = <section className="viewer subagent-chat-view" aria-label="子 Agent 对话">
    <LiveStoreContext.Provider value={emptyLiveStore}>
      <ChatPane title={selected.name} embedded={{ icon: subagentIcon(selected.id), close: popupOpen ? closePopup : onClose, ended: !canSend,
        approval: task?.pendingApproval,
        placeholder: task && !task.chatActive ? "恢复对话后即可继续发送消息" : running ? "给子 Agent 补充说明…" : loadingFile ? "正在读取所选文件…"
          : revisionPath ? "告诉子 Agent 要怎样调整这个文件…" : "给子 Agent 发消息…",
        notice: verification && <p className="panel-empty" role="status">
          {revisionStatus[verification.status]} {verificationPath && <button type="button" className="btn ghost"
            onClick={() => openFile(verificationPath)}>打开文件</button>}
        </p>,
        action: task && !running && task.status !== "queued" && canResume ? <>
          {task.status === "interrupted" && !verification && task.assignment?.mode !== "revision" && !task.writeAttempts?.length &&
            <button type="button" className="btn ghost" disabled={sending} onClick={() => void recoverTask()}>恢复任务</button>}
          <button type="button" className="btn ghost" disabled={sending} onClick={() => void setChatActive(!task.chatActive)}>
            {task.chatActive ? "暂停对话" : "恢复对话"}
          </button>
        </> : undefined }} messages={messages}
        sessionId={attemptId} conversationView="chat" onConversationView={noop} traceSessions={[]} traceProjects={[]}
        artifacts={artifacts} outputs={[]} running={{}} streaming={running} archived={archived} loading={!task && !loadError}
        error={error || loadError} onDismissError={() => { setError(null); setLoadError(null); }} draft={draft} setDraft={setDraft} inputRef={inputRef}
        sendKey={sendKey} modKey={modKey} queue={[]} queueReady={running} queueBusy={sending}
        onSend={() => void send()} onSteer={noop} onRemoveQueued={noop} onContinueQueue={noop}
        attachments={[]} onAttach={noop} onRemoveAttachment={noop} onAnswer={noop} onResend={noop}
        onOpenArtifact={openArtifact} onOpenFile={openFile} onOpenView={setView} leftOpen rightOpen={false} viewOpen
        onStop={() => void setChatActive(false)}
        onToggleLeft={noop} onToggleRight={noop} userName="" />
    </LiveStoreContext.Provider>
  </section>;
  return view ? createPortal(<dialog ref={dialogRef} className="subagent-output-dialog" aria-label={`${selected.name} · 产出物与对话`}
    onCancel={(event) => { event.preventDefault(); closePopup(); }} onKeyDown={(event) => event.stopPropagation()}>
    <Canvas sessionId={sessionId} view={view} artifacts={artifacts} messages={messages}
      refreshKey={`${attemptId}:${messages.filter(({ role, status }) => role === "tool" && status === "ok").length}`}
      splitSource onRevisionAvailability={setFileEditable} onOpenFile={openFile} onClose={closePopup} />
    {chat}
  </dialog>, document.body) : chat;
}
