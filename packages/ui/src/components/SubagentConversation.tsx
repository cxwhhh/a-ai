"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { StoredMessage } from "../../../protocol/src/lib/shared";
import { subagentIcon } from "../../../protocol/src/lib/agentIcons";
import type { TaskRecord } from "../../../subagent/src/ownership-claim";
import { api } from "../lib/client";
import { emptyLiveStore, LiveStoreContext } from "../lib/live";
import { ChatPane } from "./ChatPane";
import type { SubagentSelection } from "./SubagentThreads";

const noop = () => {};

/** 右侧复用主对话的气泡、调用过程和输入框。每个分支有自己的消息与停止入口。 */
export function SubagentConversation({ sessionId, selected, sendKey, modKey, archived, canResume, onResume, onOpenFile, onClose }: {
  sessionId: string;
  selected: SubagentSelection;
  sendKey: "enter" | "mod-enter";
  modKey: string;
  archived: boolean;
  canResume: boolean;
  onResume(task: SubagentSelection): void;
  onOpenFile(path: string): void;
  onClose(): void;
}) {
  const [task, setTask] = useState<TaskRecord>();
  const [draft, setDraft] = useState("");
  const [accepted, setAccepted] = useState<StoredMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const running = task?.status === "running";
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
        const { task: current } = await api.subagentConversation(sessionId, selected.id, controller.signal);
        if (controller.signal.aborted) return;
        setTask(current);
        setLoadError(null);
        if (current.status === "running") timer = setTimeout(refresh, 650);
      } catch (error) {
        if (controller.signal.aborted) return;
        setLoadError(error instanceof Error ? error.message : "无法读取子 Agent 对话");
        timer = setTimeout(refresh, 1500);
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sessionId, selected.id]);

  async function send() {
    const text = draft.trim();
    if (!running || sending || !text) return;
    setSending(true);
    setError(null);
    try {
      const { message } = await api.sendSubagentMessage(sessionId, selected.id, text);
      setAccepted((previous) => [...previous, message]);
      setDraft((current) => current.trim() === text ? "" : current);
    } catch (error) { setError(error instanceof Error ? error.message : "无法发送消息"); }
    finally { setSending(false); }
  }

  async function resume() {
    setSending(true);
    setError(null);
    try {
      const resumed = await api.submitSubagentTask(sessionId, { retryTaskId: selected.id });
      onResume({ id: resumed.id, name: selected.name });
    } catch (error) { setError(error instanceof Error ? error.message : "无法恢复子 Agent"); }
    finally { setSending(false); }
  }

  return <section className="viewer subagent-chat-view" aria-label="子 Agent 对话">
    <LiveStoreContext.Provider value={emptyLiveStore}>
      <ChatPane title={selected.name} embedded={{ icon: subagentIcon(selected.id), close: onClose, ended: !running,
        action: task && !running && task.status !== "queued" && canResume
          ? <button type="button" className="btn ghost" disabled={sending} onClick={() => void resume()}>恢复任务</button> : undefined }} messages={messages}
        sessionId={selected.id} conversationView="chat" onConversationView={noop} traceSessions={[]} traceProjects={[]}
        artifacts={[]} outputs={[]} running={{}} streaming={running} archived={archived} loading={!task && !loadError}
        error={error || loadError} onDismissError={() => { setError(null); setLoadError(null); }} draft={draft} setDraft={setDraft} inputRef={inputRef}
        sendKey={sendKey} modKey={modKey} bar={null} queue={[]} queueReady={running} queueBusy={sending}
        onSend={() => void send()} onSteer={noop} onRemoveQueued={noop} onContinueQueue={noop}
        attachments={[]} onAttach={noop} onRemoveAttachment={noop} onAnswer={noop} onResend={noop}
        onOpenArtifact={noop} onOpenFile={onOpenFile} onOpenView={noop} leftOpen rightOpen={false} viewOpen
        onStop={() => void api.stopSubagentTask(sessionId, selected.id).catch((err: Error) => setError(err.message))}
        onToggleLeft={noop} onToggleRight={noop} userName="" />
    </LiveStoreContext.Provider>
  </section>;
}
