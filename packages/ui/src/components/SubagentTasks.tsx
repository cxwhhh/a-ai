"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { TaskRecord } from "../../../subagent/src/ownership-claim";
import type { SubagentRole } from "../../../subagent/src/role-budget";
import { api } from "../lib/client";
import { IChevron, IRetry } from "./Icons";
import { TraceMarkdown, TraceSection } from "./TraceDetailContent";
import "./SessionTrace.css";

export const subagentStatusLabels: Record<TaskRecord["status"], string> = {
  queued: "等待上游", running: "运行中", completed: "已完成", partial: "部分完成",
  blocked: "受阻", failed: "失败", "timed-out": "已超时", cancelled: "已取消", interrupted: "已中断",
};
export const subagentRoleLabels: Record<SubagentRole, string> = { research: "调研", review: "审阅", analysis: "分析" };
const active = (task: TaskRecord) => task.status === "queued" || task.status === "running";
const lines = (text: string) => text.split("\n").map((item) => item.trim()).filter(Boolean);

/** 独立管理任务，不占用对话输入。任务清单沿用轨迹字体、交互状态和细分隔线。 */
export function SubagentTasks({ sessionId, archived, streaming, enabled }: { sessionId: string; archived?: boolean; streaming: boolean; enabled?: boolean }) {
  const [tasks, setTasks] = useState<TaskRecord[]>();
  const [nextBefore, setNextBefore] = useState<string>();
  const [older, setOlder] = useState<TaskRecord[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [task, setTask] = useState("");
  const [role, setRole] = useState<SubagentRole>("research");
  const [paths, setPaths] = useState("");
  const [plan, setPlan] = useState("");
  const [acceptance, setAcceptance] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const data = await api.subagentTasks(sessionId, controller.signal);
        if (controller.signal.aborted) return;
        setTasks(data.tasks);
        setNextBefore((cursor) => older.length ? cursor : data.nextBefore);
        setLoadError("");
        if (streaming || data.tasks.some(active)) timer = setTimeout(load, 1500);
      } catch (error) {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "无法读取子任务");
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sessionId, refresh, streaming, older.length]);

  async function action(work: () => Promise<void>, reload = true) {
    setBusy(true);
    setActionError("");
    try {
      await work();
      if (reload) setRefresh((value) => value + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "子任务操作失败");
    } finally { setBusy(false); }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!task.trim()) return;
    void action(async () => {
      await api.submitSubagentTask(sessionId, {
        task: task.trim(), role,
        ...(paths.trim() ? { paths: lines(paths) } : {}),
        ...(plan.trim() ? { plan: lines(plan) } : {}),
        ...(acceptance.trim() ? { acceptance: lines(acceptance) } : {}),
      });
      setShowForm(false);
      setTask(""); setPaths(""); setPlan(""); setAcceptance("");
    });
  }

  const visible = [...new Map([...older, ...(tasks ?? [])].map((item) => [item.id, item])).values()]
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  return <section className="session-trace" aria-label="子任务管理">
    <div className="trace-scope">
      <span className="trace-count">{tasks ? `${visible.length} 项子任务` : "子任务"}</span>
      {enabled && !archived && <button type="button" className="btn ghost" onClick={() => setShowForm((value) => !value)}>
        {showForm ? "关闭表单" : "新建独立任务"}
      </button>}
      <button type="button" className="icon-btn" aria-label="刷新子任务" title="刷新子任务" onClick={() => setRefresh((value) => value + 1)}>
        <IRetry width={15} height={15} />
      </button>
    </div>
    <div className="trace-statistics">
      {enabled && showForm && <form className="subagent-form" onSubmit={submit}>
        <label>任务目标<textarea className="set-input area" rows={3} maxLength={4000} value={task} onChange={(e) => setTask(e.target.value)} required /></label>
        <label>角色<select className="set-input select" value={role} onChange={(e) => setRole(e.target.value as SubagentRole)}>
          {Object.entries(subagentRoleLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        <details>
          <summary>计划、范围和验收</summary>
          <label>执行步骤（每行一项）<textarea className="set-input area" rows={2} value={plan} onChange={(e) => setPlan(e.target.value)} /></label>
          <label>允许读取的文件或目录（每行一项）<textarea className="set-input area" rows={2} value={paths} onChange={(e) => setPaths(e.target.value)} /></label>
          <label>验收条件（每行一项）<textarea className="set-input area" rows={2} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} /></label>
        </details>
        <button className="btn primary" type="submit" disabled={busy || !task.trim()}>提交任务</button>
      </form>}
      {(actionError || loadError) && <p className="trace-empty" role="alert">{actionError || loadError}</p>}
      {!visible.length && !loadError && <p className="trace-empty" role="status">{tasks ? "当前会话暂无子任务。" : "正在读取子任务…"}</p>}
      <div className="subagent-list">
        {visible.map((item) => <details key={item.id}>
          <summary>
            <IChevron width={12} height={12} aria-hidden="true" />
            <span>{item.contract.name || item.contract.purpose || item.contract.task}</span>
            <small>{subagentRoleLabels[item.role]} · {subagentStatusLabels[item.status]}</small>
          </summary>
          <div className="subagent-result">
            <p className="trace-stats-note">{item.parentCallId ? "由父 Agent 委派" : "独立任务"} · {item.progress.steps}/{item.limits.steps} 步 · {item.progress.toolCalls} 次工具</p>
            {item.contract.plan?.length ? <TraceSection title="执行计划">
              <ol>{item.contract.plan.map((step) => <li key={step}>{step}</li>)}</ol>
            </TraceSection> : null}
            {item.result?.summary && <TraceSection title="结果"><TraceMarkdown text={item.result.summary} /></TraceSection>}
            {item.result?.acceptance.length ? <TraceSection title="逐项验收">
              <ul>{item.result.acceptance.map((criterion) => <li key={criterion.criterion}>{criterion.met ? "已确认" : "待核对"} · {criterion.criterion}</li>)}</ul>
            </TraceSection> : null}
            {item.evidence.length > 0 && <TraceSection title="证据">
              <ul>{item.evidence.map((evidence) => <li key={evidence.id}><code>{evidence.id}</code> · {evidence.source}</li>)}</ul>
            </TraceSection>}
            {item.progress.blockers.length > 0 && <TraceSection title="阻塞与未完成项">
              <ul>{[...item.progress.blockers.map(({ detail }) => detail), ...(item.result?.unresolved ?? [])].map((detail) => <li key={detail}>{detail}</li>)}</ul>
            </TraceSection>}
            {active(item) && <button type="button" className="btn ghost" disabled={busy}
              onClick={() => void action(() => api.stopSubagentTask(sessionId, item.id))}>停止任务</button>}
            {enabled && !active(item) && !archived && item.status !== "completed" && <button type="button" className="btn ghost" disabled={busy}
              onClick={() => void action(async () => { await api.submitSubagentTask(sessionId, { retryTaskId: item.id }); })}>重试任务</button>}
          </div>
        </details>)}
      </div>
      {nextBefore && <button className="trace-stat-more" type="button" disabled={busy}
        onClick={() => void action(async () => {
          const data = await api.subagentTasks(sessionId, new AbortController().signal, nextBefore);
          setOlder((previous) => [...previous, ...data.tasks]);
          setNextBefore(data.nextBefore);
        }, false)}>加载更早任务</button>}
    </div>
  </section>;
}
