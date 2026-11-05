"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import type { QueuedMessage } from "@/lib/shared";
import { IArrowUp, IPencil, IX } from "./Icons";
import "./MessageQueue.css";

const labels = { queued: "待处理", ready: "等待接收", received: "已加入对话，等待模型", sent: "已送达模型" };

/**
 * 草稿操作与模型投递是两回事：上移只调整顺序，第一条的按钮才请求插队。
 * 轮询只读服务端状态；等待/送达由服务端确认，不用定时器或乐观文案假装模型已经接收。
 */
export function MessageQueue(props: {
  sessionId: string; streaming: boolean; refreshKey: number;
  onSend(item: QueuedMessage): void;
  onRunningChange(running: boolean): void;
  onHistoryChange(): void;
}) {
  const [items, setItems] = useState<QueuedMessage[]>([]);
  const [remoteRunning, setRemoteRunning] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const latest = useRef(props); latest.current = props;
  const alive = useRef(true);
  const mutating = useRef(false);
  const sequence = useRef(0);
  const fingerprint = useRef("");
  const refresh = useCallback(async () => {
    if (mutating.current) return;
    const request = ++sequence.current;
    if (!props.sessionId) return;
    try {
      const data = await api.queue(props.sessionId);
      if (!alive.current || request !== sequence.current) return;
      setItems(data.queue); setRemoteRunning(data.running); latest.current.onRunningChange(data.running);
      const next = data.queue.map((m) => m.id + m.status).join("|");
      if (next !== fingerprint.current) {
        fingerprint.current = next;
        if (!latest.current.streaming) latest.current.onHistoryChange();
      }
    } catch (e) {
      if (alive.current && request === sequence.current) setError(e instanceof Error ? e.message : "队列读取失败");
    }
  }, [props.sessionId]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), props.streaming ? 1000 : 3000);
    return () => { alive.current = false; sequence.current++; clearInterval(timer); };
  }, [refresh, props.streaming, props.refreshKey]);

  async function act(item: QueuedMessage, action: "edit" | "remove" | "up" | "steer") {
    if (mutating.current) return;
    mutating.current = true;
    setBusy(true); setError(""); sequence.current++;
    try {
      if (action === "steer" && !props.streaming && !remoteRunning) props.onSend(item);
      else {
        const data = await api.queue(props.sessionId, action, item.id, action === "edit" ? text : undefined);
        if (!alive.current) return;
        if (data.idle) props.onSend(item);
        else { sequence.current++; setItems(data.queue); setRemoteRunning(data.running); latest.current.onRunningChange(data.running); }
      }
      setEditing(null);

    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "操作失败，请重试"); }
    finally { mutating.current = false; if (alive.current) { setBusy(false); void refresh(); } }
  }

  if (!props.sessionId || (!items.length && !error)) return null;
  const first = items.find((m) => m.status === "queued")?.id;
  return <section className="message-queue" aria-label="待处理消息" aria-busy={busy}>
    <div className="queue-heading">待处理消息 <span>上移调整顺序，第一条可插队</span></div>
    {error && <div className="queue-error" role="alert">{error}</div>}
    <ol>{items.map((item) => <li key={item.id} className={item.status}>
      <div className="queue-body">
        <small>{labels[item.status]}</small>
        {editing === item.id ? <div className="queue-editor">
          <textarea aria-label="编辑队列消息" value={text} onChange={(e) => setText(e.target.value)} autoFocus maxLength={12000} />
          <button type="button" disabled={busy || !text.trim()} onClick={() => void act(item, "edit")}>保存</button>
          <button type="button" disabled={busy} onClick={() => setEditing(null)}>取消</button>
        </div> : <p>{item.text}</p>}
      </div>
      {editing !== item.id && <div className="queue-actions">
        {(item.status === "queued" || (!props.streaming && !remoteRunning && item.status !== "sent")) &&
          <button type="button" className="icon-btn" disabled={busy} title={item.id === first || item.status !== "queued" ? (props.streaming || remoteRunning ? "插入当前任务" : "作为新任务发送") : "上移一位"}
            aria-label={item.id === first || item.status !== "queued" ? "插入或发送消息" : "上移一位"}
            onClick={() => void act(item, item.id === first || item.status !== "queued" ? "steer" : "up")}><IArrowUp width={14} height={14} /></button>}
        {item.status === "queued" && <>
          <button type="button" className="icon-btn" disabled={busy} title="编辑" aria-label="编辑队列消息" onClick={() => { setEditing(item.id); setText(item.text); }}><IPencil width={14} height={14} /></button>
          <button type="button" className="icon-btn" disabled={busy} title="删除" aria-label="删除队列消息" onClick={() => void act(item, "remove")}><IX width={14} height={14} /></button>
        </>}
      </div>}
    </li>)}</ol>
    <div className="queue-hint">已送达仅表示模型请求已收到响应，任务是否完成请看后续结果。</div>
  </section>;
}
