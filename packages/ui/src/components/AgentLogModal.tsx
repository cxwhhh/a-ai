"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/client";
import type { AgentLogEntry, AgentLogKind } from "../../../protocol/src/agent-events";
import { IX } from "./Icons";
import "./AgentLogModal.css";

const labels: Record<AgentLogKind, string> = {
  queued: "排队", steered: "改为引导", accepted: "输入已提交", guidance: "引导已写入当前轮", deferred: "转回排队",
  cancelled: "取消待执行输入", truncated: "历史截断", "turn-start": "开始一轮", "turn-end": "本轮结束",
  "stop-requested": "请求停止", "model-request": "发起模型步骤", "model-result": "模型步骤结果",
  "tool-start": "开始工具调用", "tool-result": "工具结果", artifact: "生成产出", "model-selected": "会话模型选择",
  archived: "归档", restored: "恢复归档",
  "step-start": "开始步骤", "step-end": "步骤收尾",
};
const outcomes: Record<string, string> = {
  completed: "已完成", cancelled: "已取消", failed: "失败", "waiting-for-answer": "等待用户回答", "output-truncated": "模型输出达到长度上限", interrupted: "运行中断，未确认完成",
};
const detailLabels: Record<string, string> = {
  model: "模型", effort: "思考强度", step: "步骤", outcome: "结果", durationMs: "耗时（毫秒）", messageId: "消息 ID",
  callId: "工具调用 ID", name: "工具", status: "状态", inputTokens: "输入 token", outputTokens: "输出 token", errorKind: "错误类型",
  reason: "原因", finishReason: "模型结束原因", revision: "历史修订 ID", cutMessageId: "截断起点", target: "目标",
  guidanceIds: "纳入本步的引导 ID", turnInputId: "所属轮输入 ID", artifactId: "产出 ID", path: "文件路径", title: "标题",
  targetId: "目标 ID", messageCount: "模型输入消息数", toolCount: "模型可用工具数", toolCalls: "模型发起的工具调用数", estimatedUsage: "用量为估算值",
};

function describe(entry: AgentLogEntry) {
  if (entry.kind === "truncated") return "旧输入退出当前视图，原记录保留";
  return "outcome" in entry.detail ? outcomes[entry.detail.outcome] : undefined;
}

/** 只从已经记录的事件判断状态。没有结束事件时，不能把曾经接收的输入当成已运行。 */
function summarize(entries: AgentLogEntry[]) {
  const end = entries.find((e) => e.kind === "turn-end" || e.kind === "cancelled");
  const step = entries.find((e) => e.kind === "model-result");
  const truncated = entries.some((e) => e.kind === "truncated");
  const limited = entries.some((e) => "outcome" in e.detail && e.detail.outcome === "output-truncated");
  const started = entries.some((e) => e.kind === "turn-start" || e.kind === "model-request");
  const result = end ? describe(end) ?? "已取消，未执行" : step ? `引导已进入模型步骤 · ${describe(step) ?? "有结果"}`
    : started ? "已开始执行，暂无结束记录" : truncated ? "暂无执行结果记录" : "已接收，暂无执行记录";
  return [result, end && limited && "曾达到模型输出上限", truncated && "旧输入已退出当前历史"].filter(Boolean).join(" · ");
}

export function AgentLogModal({ sessionId, onClose }: { sessionId?: string; onClose(): void }) {
  const [entries, setEntries] = useState<AgentLogEntry[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [more, setMore] = useState(false);
  const [focus, setFocus] = useState<{ sessionId: string; inputId: string }>();
  const request = useRef(0);
  const load = useCallback(async (before?: number) => {
    const id = ++request.current;
    setBusy(true);
    setError("");
    try {
      const rows = await api.agentLog(focus?.sessionId ?? sessionId, before, focus?.inputId);
      if (request.current !== id) return;
      setEntries((previous) => before ? [...previous, ...rows] : rows);
      setMore(rows.length === 100);
    } catch (e) {
      if (request.current === id) setError(e instanceof Error ? e.message : "读取日志失败");
    } finally { if (request.current === id) setBusy(false); }
  }, [focus, sessionId]);
  useEffect(() => {
    setEntries([]);
    setMore(false);
    void load();
    return () => { request.current++; };
  }, [load]);
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="agent-log" role="dialog" aria-modal="true" aria-label="Agent 运行日志" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
        <header><h2>{sessionId ? "此对话的运行日志" : "所有对话的运行日志"}</h2>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose} autoFocus><IX width={14} height={14} /></button></header>
        <p className="agent-log-hint">按时间倒序。点击输入 ID 可追踪一条输入。排队记录表示当时已接收，查看后续事件可判断是否执行。</p>
        <div className="agent-log-actions">
          <button type="button" disabled={busy} onClick={() => void load()}>刷新</button>
          {focus && <button type="button" onClick={() => setFocus(undefined)}>显示全部输入</button>}
        </div>
        <div className="agent-log-list" aria-busy={busy}>
          {error && <p role="alert">{error}</p>}
          {focus && entries.length > 0 && <p role="status">{summarize(entries)}</p>}
          {!busy && !entries.length && <p>暂无符合条件的记录</p>}
          {entries.map((entry) => (
            <article key={entry.id}>
              <div className="agent-log-row"><strong>{labels[entry.kind]}</strong><span>{describe(entry)}</span><time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleString()}</time></div>
              <div className="agent-log-meta">{entry.sessionTitle}{entry.runId ? ` · 运行 ${entry.runId.slice(0, 8)}` : ""}
                {entry.inputId && <button type="button" disabled={busy || focus?.inputId === entry.inputId} title={entry.inputId} onClick={() => setFocus({ sessionId: entry.sessionId, inputId: entry.inputId! })}>输入 {entry.inputId}</button>}
              </div>
              {"preview" in entry.detail && entry.detail.preview && <p className="agent-log-preview">{entry.detail.preview}</p>}
              <dl>{Object.entries(entry.detail).filter(([key, value]) => key !== "preview" && value !== null && value !== "").map(([key, value]) => (
                <div key={key}><dt>{detailLabels[key] ?? key}</dt><dd>{key === "outcome" ? outcomes[String(value)] ?? String(value) : String(value)}</dd></div>
              ))}</dl>
            </article>
          ))}
          {busy && <p role="status">正在读取…</p>}
          {more && <button type="button" className="agent-log-more" disabled={busy} onClick={() => void load(entries.at(-1)?.id)}>加载更早记录</button>}
        </div>
      </section>
    </div>
  );
}
