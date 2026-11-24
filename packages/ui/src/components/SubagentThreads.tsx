"use client";

import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import type { SubagentThread } from "../../../subagent/src/ownership-claim";
import { subagentIcon } from "../../../protocol/src/lib/agentIcons";
import { api } from "../lib/client";
import { cx } from "../utils/cx";
import { IconButton } from "./base/buttons/icon-button";
import { IconPicker } from "./IconPicker";
import { ICards, IChart, IListRows, IThreads, IX } from "./Icons";
import { subagentStatusLabels } from "./SubagentTasks";
import { traceDuration } from "./TraceDetailContent";
import "./SubagentThreads.css";

export type SubagentSelection = Pick<SubagentThread, "id" | "name">;
export type ThreadLayout = "cards" | "list";
const active = ({ status }: SubagentThread) => status === "queued" || status === "running";

/** 查看预览时只读运行中的线程。历史和使用统计由右侧汇总单独加载。 */
function useThreadPage(sessionId: string, enabled: boolean, currentOnly = false) {
  const [page, setPage] = useState<Awaited<ReturnType<typeof api.subagentThreads>>>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const data = await api.subagentThreads(sessionId, controller.signal, undefined, currentOnly);
        if (controller.signal.aborted) return;
        setPage(data);
        setError("");
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "无法读取子 Agent 线程");
      }
      if (!controller.signal.aborted) timer = setTimeout(load, currentOnly ? 1250 : 2200);
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sessionId, enabled, currentOnly]);
  return { page, error };
}

export function SubagentThreadTrigger({ sessionId, expanded, onToggle }: {
  sessionId: string;
  expanded: boolean;
  onToggle(): void;
}) {
  const previewId = useId();
  const [position, setPosition] = useState<{ top: number; right: number }>();
  const { page, error } = useThreadPage(sessionId, !!position, true);
  const show = ({ currentTarget }: { currentTarget: HTMLButtonElement }) => {
    if (expanded) return;
    const anchor = currentTarget.getBoundingClientRect();
    setPosition({ top: anchor.bottom + 8, right: window.innerWidth - anchor.right });
  };
  useEffect(() => {
    if (!position) return;
    const close = () => setPosition(undefined);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, [position]);
  return <>
    <IconButton size="small" icon={IThreads} className="subagent-thread-trigger"
      aria-label="子 Agent 线程" aria-expanded={expanded} aria-describedby={position ? previewId : undefined}
      onFocus={show} onMouseEnter={show} onBlur={() => setPosition(undefined)} onMouseLeave={() => setPosition(undefined)}
      onClick={() => { setPosition(undefined); onToggle(); }} />
    {position && createPortal(<section id={previewId} role="tooltip" style={position} className="row-menu subagent-thread-preview">
      <div className="subagent-thread-preview-title">当前线程</div>
      {error && <p className="panel-empty">{error}</p>}
      {!error && !page?.tasks.length && <p className="panel-empty">{page ? "暂无运行中的子 Agent" : "正在读取子 Agent…"}</p>}
      {page?.tasks.slice(0, 6).map((task) => <div key={task.id} className="out-row">
        <ThreadName task={task} />
        <span className="chain-ms">{subagentStatusLabels[task.status]}</span>
      </div>)}
      {(page?.nextBefore || (page?.tasks.length ?? 0) > 6) && <p className="panel-empty">点击查看全部线程</p>}
    </section>, document.body)}
  </>;
}

export function SubagentThreadOverview({ sessionId, layout, onLayout, onSelect, onClose }: {
  sessionId: string;
  layout: ThreadLayout;
  onLayout(layout: ThreadLayout): void;
  onSelect(task: SubagentSelection): void;
  onClose(): void;
}) {
  const { page, error } = useThreadPage(sessionId, true);
  const [older, setOlder] = useState<SubagentThread[]>([]);
  const [olderNext, setOlderNext] = useState<string>();
  const [loadedOlder, setLoadedOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [actionError, setActionError] = useState("");
  const cursor = loadedOlder ? olderNext : page?.nextBefore;
  const tasks = [...new Map([...older, ...(page?.tasks ?? [])].map((task) => [task.id, task])).values()]
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));

  async function loadOlder() {
    if (!cursor) return;
    setLoadingOlder(true);
    setActionError("");
    try {
      const data = await api.subagentThreads(sessionId, new AbortController().signal, cursor);
      setOlder((items) => [...items, ...data.tasks]);
      setOlderNext(data.nextBefore);
      setLoadedOlder(true);
    } catch { setActionError("无法读取更早的子 Agent"); }
    finally { setLoadingOlder(false); }
  }

  const groups = [
    { label: "进行中", tasks: tasks.filter(active) },
    { label: "已结束", tasks: tasks.filter((task) => !active(task)) },
  ];
  return <section className="viewer subagent-thread-overview" aria-label="子 Agent 线程汇总">
    <header className="viewer-head">
      <IThreads width={16} height={16} />
      <div className="viewer-title ellipsis">子 Agent 线程</div>
      <div className="spacer" />
      <div className="seg" role="group" aria-label="线程视图">
        <button type="button" className={cx(!showStats && layout === "cards" && "on")} aria-pressed={!showStats && layout === "cards"}
          aria-label="卡片视图" title="卡片视图" onClick={() => { setShowStats(false); onLayout("cards"); }}><ICards width={15} height={15} /></button>
        <button type="button" className={cx(!showStats && layout === "list" && "on")} aria-pressed={!showStats && layout === "list"}
          aria-label="列表视图" title="列表视图" onClick={() => { setShowStats(false); onLayout("list"); }}><IListRows width={15} height={15} /></button>
        <button type="button" className={cx(showStats && "on")} aria-pressed={showStats}
          aria-label="线程统计" title="线程统计" onClick={() => setShowStats((current) => !current)}><IChart width={15} height={15} /></button>
      </div>
      <button type="button" className="icon-btn" aria-label="关闭线程汇总" onClick={onClose}><IX width={16} height={16} /></button>
    </header>
    <div className="viewer-body subagent-thread-groups">
      {(actionError || error) && <p className="panel-empty" role="alert">{actionError || error}</p>}
      {!error && !tasks.length && <p className="panel-empty">{page ? "当前对话暂无子 Agent 线程" : "正在读取子 Agent…"}</p>}
      {groups.filter((group) => group.tasks.length).map((group) => <section key={group.label} className="subagent-thread-group" aria-label={group.label}>
        <h3>{group.label}<span>{group.tasks.length}</span></h3>
        <div className="subagent-thread-entries" data-layout={showStats ? "stats" : layout}>
          {group.tasks.map((task) => <button key={task.id} type="button" className="subagent-thread-open"
            title={task.name} onClick={() => onSelect(task)}>
            <span className="subagent-thread-entry-head">
              <ThreadName task={task} />
              <span className="subagent-thread-status">{subagentStatusLabels[task.status]}</span>
            </span>
            {showStats && task.metrics && <ThreadMetrics metrics={task.metrics} />}
          </button>)}
        </div>
      </section>)}
      {cursor && <button type="button" className="btn ghost" disabled={loadingOlder} onClick={() => void loadOlder()}>加载更早线程</button>}
    </div>
  </section>;
}

function ThreadName({ task }: { task: SubagentThread }) {
  return <>
    <span className="out-ico subagent-thread-glyph"><IconPicker value={subagentIcon(task.id)} size={16} /></span>
    <span className="out-name ellipsis">{task.name}</span>
  </>;
}

function ThreadMetrics({ metrics }: { metrics: NonNullable<SubagentThread["metrics"]> }) {
  const number = (value: number) => value.toLocaleString();
  const frequency = (count: number) => metrics.durationMs < 1000
    ? "时长不足 1 秒" : `${(count * 60_000 / metrics.durationMs).toLocaleString(undefined, { maximumFractionDigits: 1 })} / 分钟`;
  const dialogue = metrics.dialogue;
  const messages = dialogue && dialogue.user + dialogue.agent;
  return <span className="subagent-thread-metrics">
    <span><span>模型请求</span><b>{number(metrics.modelCalls)}</b><small>{frequency(metrics.modelCalls)}</small></span>
    <span><span>工具调用</span><b>{number(metrics.toolCalls)}</b><small>{frequency(metrics.toolCalls)}</small></span>
    <span><span>对话消息</span><b>{messages === undefined ? "—" : number(messages)}</b>
      <small title={dialogue ? `用户补充 ${dialogue.user} · Agent 回复 ${dialogue.agent}` : undefined}>
        {messages === undefined ? "历史未记录" : frequency(messages)}
      </small></span>
    <span><span>Token 用量</span><b>{metrics.estimated ? "约 " : ""}{number(metrics.tokens)}</b>
      <small>{traceDuration(metrics.durationMs)} · {metrics.attempts} 次尝试</small></span>
  </span>;
}
