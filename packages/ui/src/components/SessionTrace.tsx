"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../lib/client";
import type { Project, SessionMeta } from "../../../protocol/src/lib/shared";
import type { SessionTrace as TraceData, TraceKind, TraceRecordDetail, TraceRow } from "../../../conversation-trace/src/types";
import type { ToolSpec } from "../../../llm/src/types";
import {
  TraceJson, TraceMarkdown, TraceMeta, TraceNotice, TraceSchema, TraceSection, TraceSource, TraceThinking,
  TraceToolArguments, TraceToolResult, traceArgumentTab, traceDuration, traceTimestamp, type TraceMetaRow,
} from "./TraceDetailContent";
import { requestTabs, TraceRequestContent, TraceRequestOptions, TraceRequestTiming, TraceRequestUsage, traceRequestError, type RequestTab } from "./TraceRequestContent";
import { TraceStatistics } from "./TraceStatistics";
import { IChevron, IRetry, ISearchLine } from "./Icons";
import "./SessionTrace.css";

const labels: Record<TraceKind, string> = { input: "用户", model: "助手", tool: "工具", event: "事件" };
type TraceFilter = TraceKind | "flow" | "all";
type DetailTab = RequestTab | "概述" | "预览" | "原始内容" | "代码" | "参数" | "结果" | "Schema";
const pageSize = 150;

/** 流程聚焦当前分支的对话往来。历史版本、压缩和系统事件可在全部记录里查看。 */
const inFlow = (row: TraceRow) => !row.historical && row.kind !== "event" && row.requestPhase !== "compact";

/** 切换对话只改变读取范围。卸载或切换时取消旧请求，避免晚到的响应覆盖新对话。 */
export function SessionTrace({ sessionId, sessions, projects, streaming, showStats, onShowTrace }: {
  sessionId: string;
  sessions: readonly SessionMeta[];
  projects: readonly Project[];
  streaming: boolean;
  showStats: boolean;
  onShowTrace(): void;
}) {
  const [id, setId] = useState(sessionId);
  const [refresh, setRefresh] = useState(0);
  const grouped = useMemo(() => {
    const groups = new Map<string, SessionMeta[]>();
    for (const session of sessions) {
      const group = session.projectId ?? "";
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(session);
    }
    return [...groups];
  }, [sessions]);
  return (
    <section className="session-trace" id="session-trace" aria-label={showStats ? "对话统计" : "对话轨迹"}>
      <div className="trace-scope">
        <select className="set-input select" aria-label="追踪对话" value={id} onChange={(e) => setId(e.target.value)}>
          {!sessions.some((session) => session.id === id) && <option value={id}>当前对话</option>}
          {grouped.map(([projectId, items]) => {
            const project = projects.find((item) => item.id === projectId);
            return <optgroup key={projectId} label={project?.name ?? "未分配项目"}>
              {items.map((item) => <option key={item.id} value={item.id}>
                {item.title || "新对话"}{item.archivedAt || project?.archivedAt ? " · 已归档" : ""}
              </option>)}
            </optgroup>;
          })}
        </select>
        <button type="button" className="icon-btn" aria-label={showStats ? "刷新统计" : "刷新轨迹"} title={showStats ? "刷新统计" : "刷新轨迹"} onClick={() => setRefresh((value) => value + 1)}>
          <IRetry width={15} height={15} />
        </button>
      </div>
      <TraceTimeline key={id} id={id} refresh={refresh} streaming={id === sessionId && streaming} showStats={showStats} onShowTrace={onShowTrace} />
    </section>
  );
}

function TraceTimeline({ id, refresh, streaming, showStats, onShowTrace }: {
  id: string; refresh: number; streaming: boolean; showStats: boolean; onShowTrace(): void;
}) {
  const [data, setData] = useState<TraceData>();
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<TraceFilter>("flow");
  const [path, setPath] = useState("");
  const [turn, setTurn] = useState("");
  const [selected, setSelected] = useState<string>();
  const [limit, setLimit] = useState(pageSize);
  const list = useRef<HTMLDivElement>(null);
  const jump = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const next = await api.sessionTrace(id, controller.signal, showStats);
        if (controller.signal.aborted) return;
        setData(next);
        setError("");
        if (streaming || next.running) timer = setTimeout(load, 2500);
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "无法读取轨迹");
      }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, refresh, streaming, showStats]);

  const paths = useMemo(() => [...new Set(data?.rows.flatMap((row) => row.paths ?? []))].sort(), [data]);
  const turns = useMemo(() => [...new Set(data?.rows.flatMap((row) => row.turn ?? []))].sort((a, b) => a - b), [data]);
  const ordered = useMemo(() => [...(data?.rows ?? [])].sort((a, b) => (b.turn ?? 0) - (a.turn ?? 0)), [data]);
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return ordered.filter((row) =>
      (kind === "all" || (kind === "flow" ? inFlow(row) : kind === row.kind)) && (!path || row.paths?.includes(path)) && (!turn || row.turn === Number(turn)) &&
      (!term || [row.title, row.tool, row.status, row.result, row.args, row.reasoning, row.preview?.reasoning, row.preview?.text, ...(row.paths ?? [])]
        .some((part) => part?.toLowerCase().includes(term))));
  }, [ordered, kind, path, query, turn]);
  const row = filtered.find((item) => item.id === selected);
  const linkedRequests = useMemo(() => new Set((data?.rows ?? []).filter((item) => item.kind === "model" && !item.traceId && item.requestId).map((item) => item.requestId)), [data]);
  const visibleTurns = new Map<number | undefined, TraceRow[]>();
  for (const item of filtered.slice(0, limit)) {
    const items = visibleTurns.get(item.turn);
    if (items) items.push(item);
    else visibleTurns.set(item.turn, [item]);
  }
  const openRecord = (targetId: string, targetTurn?: number) => {
    const target = ordered.find((item) => item.id === targetId);
    if (!target) return;
    const nextKind = kind === "flow" && inFlow(target) ? "flow" : "all";
    const candidates = ordered.filter((item) => (nextKind === "all" || inFlow(item)) && (targetTurn === undefined || item.turn === targetTurn));
    const index = candidates.findIndex((item) => item.id === targetId);
    if (index < 0) return;
    setKind(nextKind);
    setPath("");
    setQuery("");
    setTurn(targetTurn === undefined ? "" : String(targetTurn));
    jump.current = targetId;
    setSelected(targetId);
    setLimit((value) => Math.max(value, Math.ceil((index + 1) / pageSize) * pageSize));
    list.current?.querySelector(`[data-row="${CSS.escape(targetId)}"]`)?.scrollIntoView({ block: "nearest" });
    if (showStats) onShowTrace();
  };
  useEffect(() => {
    if (!jump.current) return;
    const item = list.current?.querySelector(`[data-row="${CSS.escape(jump.current)}"]`);
    item?.scrollIntoView({ block: "nearest" });
    jump.current = null;
  }, [selected, filtered, limit, showStats]);

  if (showStats) return <>
    {error && <p className="trace-empty" role="alert">{error}</p>}
    {data?.analysis ? <TraceStatistics analysis={data.analysis} rows={data.rows} onOpen={openRecord} />
      : !error && <p className="trace-empty" role="status">正在读取统计…</p>}
  </>;

  return (
    <>
      <div className="trace-filters">
        <span className="trace-count">{data ? `${filtered.length} 条记录 · ${new Set(filtered.flatMap((item) => item.turn ?? [])).size} 轮` : "对话轨迹"}</span>
        <select className="set-input select" aria-label="轨迹视图" value={kind} onChange={(e) => { setKind(e.target.value as TraceFilter); setLimit(pageSize); }}>
          <option value="flow">对话流程</option>
          <option value="all">全部记录</option>
          {Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        {turns.length > 0 && <select className="set-input select" aria-label="按轮次筛选" value={turn} onChange={(e) => { setTurn(e.target.value); setLimit(pageSize); }}>
          <option value="">全部轮次</option>
          {turns.map((number) => <option key={number} value={number}>第 {number} 轮</option>)}
        </select>}
        {paths.length > 0 && <select className="set-input select trace-path" aria-label="文件与目录" value={path} onChange={(e) => { setPath(e.target.value); setLimit(pageSize); }}>
          <option value="">文件与目录</option>
          {paths.map((value) => <option key={value} value={value}>{value === "." ? "工作区" : value}</option>)}
        </select>}
        <label className="trace-search">
          <ISearchLine width={12} height={12} aria-hidden="true" />
          <input type="search" aria-label="搜索轨迹" placeholder="搜索" value={query}
            onChange={(e) => { setQuery(e.target.value); setLimit(pageSize); }} />
        </label>
      </div>
      {error && <p className="trace-empty" role="alert">{error}</p>}
      {!data && !error && <p className="trace-empty" role="status">正在读取轨迹…</p>}
      {data && filtered.length === 0 && <p className="trace-empty">{data.rows.length ? "没有匹配的记录" : "这段对话还没有轨迹记录"}</p>}
      {filtered.length > 0 && <>
        <div className="trace-body">
          <div className="trace-list" ref={list} aria-label="轨迹记录">
            {[...visibleTurns].map(([number, items]) => <section className="trace-turn" key={number ?? "session"}>
              <h3 className="trace-turn-title text-caption-1-semibold">{number === undefined ? "会话记录" : `第 ${number} 轮`}</h3>
              {items.map((item) => {
                const status = displayStatus(item);
                return (
                  <button type="button" className="trace-row" data-row={item.id} key={item.id}
                    data-child={!!item.parentId} aria-pressed={item.id === row?.id} onClick={() => setSelected(item.id)}>
                    <span className="trace-badge" data-kind={item.kind} data-subtool={!!(item.kind === "tool" && item.parentId)}>{recordLabel(item)}</span>
                    <TraceRowContent row={item} summary={rowSummary(item)} showResponse={!linkedRequests.has(item.id)} showPayload={kind !== "flow"} />
                    <span className="trace-row-meta">
                      {item.historical && <span className="trace-meta">历史版本</span>}
                      {status && <span className="trace-meta">{status}</span>}
                      {item.durationMs !== undefined && <span className="trace-meta">{traceDuration(item.durationMs)}</span>}
                    </span>
                  </button>
                );
              })}
            </section>)}
            {limit < filtered.length && <button type="button" className="btn trace-more" onClick={() => setLimit((value) => value + pageSize)}>显示更多</button>}
          </div>
          {row && <TraceDetails key={row.id} sessionId={id} row={row}
            schema={row.tool ? data?.schemas[row.tool] : undefined}
            related={data?.rows.filter((item) => item.id === row.parentId || item.id === row.requestId || item.parentId === row.id || item.requestId === row.id) ?? []}
            onOpenRecord={openRecord} onClose={() => setSelected(undefined)} />}
        </div>
      </>}
    </>
  );
}

function recordLabel(row: TraceRow) {
  if (row.kind === "model") {
    if (row.requestPhase === "compact") return "历史压缩";
    if (row.requestPhase === "research") return "子 Agent → 模型";
    return row.traceId || row.requestPhase === "chat" ? "Agent → 模型" : "模型 → Agent";
  }
  if (row.kind === "input") return row.input?.kind === "guidance" ? "用户补充" : "用户 → Agent";
  if (row.kind === "tool" && row.parentId) return "子工具";
  return labels[row.kind];
}

/** 老用户消息缺少工作日志时，保留正文，状态只在确有记录时显示。 */
function displayStatus(row: TraceRow) {
  return row.kind === "input" && row.status === "结果未知" ? undefined : row.status;
}

/** 列表只需要一行助手摘要，完整 Markdown 在详情里解析。 */
function rowSummary(row: TraceRow) {
  if (row.traceId && row.kind === "model") {
    const step = row.childStep ?? row.step;
    const location = step && (row.childStep ? `子步骤 ${step}` : `第 ${step} 步`);
    return [location, row.detail?.model ?? row.title].filter(Boolean).join(" · ");
  }
  if (row.kind !== "model") return row.title;
  const line = row.title.slice(0, 2048).split("\n").map((part) => part.trim())
    .find((part) => part && !/^(?:```|~~~)/.test(part));
  if (!line) return "助手输出";
  const text = line.replace(/^(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`)(.+?)\1/g, "$2").trim();
  return text.length > 160 ? `${text.slice(0, 160)}…` : text || "助手输出";
}

/** 主模型回复已有独立记录。子请求等没有独立回复行的记录在请求下显示已保存的回复。 */
function TraceRowContent({ row, summary, showResponse, showPayload }: { row: TraceRow; summary: string; showResponse: boolean; showPayload: boolean }) {
  const reasoning = row.reasoning ?? (showResponse ? row.preview?.reasoning : undefined);
  const response = showResponse ? row.preview?.text : undefined;
  const hasMainSummary = row.kind !== "model" || row.traceId || !reasoning || row.body?.trim();
  const plain = (value: string) => value.slice(0, 640).replace(/\s+/g, " ").trim();
  const args = row.args ? plain(row.args) : "";
  const result = row.result ? plain(row.result) : "";
  return (
    <span className="trace-summary">
      {row.kind === "tool" && showPayload && (args || result) ? (
        <span className="trace-tool-line">
          <span className="ellipsis trace-tool-name" title={summary}><code>{row.tool}</code>{row.tool !== summary && ` ${summary}`}</span>
          {args && <code className="ellipsis trace-inline-code" title={args}>{args}</code>}
          {result && <><span className="trace-inline-label" aria-label="结果">→</span><code className="ellipsis trace-inline-code" title={result}>{result}</code></>}
        </span>
      ) : hasMainSummary && <span className="ellipsis trace-row-main" title={summary}>{row.tool && row.tool !== summary && <code>{row.tool} </code>}{summary}</span>}
      {reasoning && !row.body?.trim() && !response && <span className="ellipsis trace-row-facts" title={plain(reasoning)}><strong>思考</strong> {plain(reasoning)}</span>}
      {response && <span className="ellipsis trace-row-facts" title={plain(response)}><strong>{row.requestPhase === "research" ? "模型 → 子 Agent" : "模型回复"}</strong> {plain(response)}</span>}
    </span>
  );
}

/** 只有打开的记录才请求正文。停止后的行状态变化会重新读取对应的结果。 */
function useTraceRecord(sessionId: string, recordId: string | undefined, status?: string, compare = false) {
  const [record, setRecord] = useState<TraceRecordDetail>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!recordId) return;
    const controller = new AbortController();
    api.traceRecord(sessionId, recordId, controller.signal, compare).then((detail) => {
      if (!controller.signal.aborted) {
        setRecord(detail);
        setError("");
      }
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "无法读取轨迹详情");
    });
    return () => controller.abort();
  }, [sessionId, recordId, status, compare]);
  return { record: record?.id === recordId ? record : undefined, error: recordId ? error : "" };
}

function TraceTiming({ row }: { row: TraceRow }) {
  return <TraceMeta rows={[
    { label: "开始时间", value: traceTimestamp(row.at) },
    { label: "时长", value: traceDuration(row.durationMs) },
  ]} />;
}

function TraceMessage({ row, preview }: { row: TraceRow; preview?: boolean }) {
  return <>
    {row.reasoning && <TraceThinking text={row.reasoning} />}
    {row.body && <TraceMarkdown text={row.body} preview={preview} />}
    {!!row.paths?.length && <ul className="trace-attachments">
      {row.paths.map((path) => <li key={path}><code>{path}</code></li>)}
    </ul>}
  </>;
}

function TraceDetails({ sessionId, row, schema, related, onOpenRecord, onClose }: {
  sessionId: string;
  row: TraceRow;
  schema?: ToolSpec;
  related: TraceRow[];
  onOpenRecord(id: string): void;
  onClose(): void;
}) {
  const requestId = row.kind === "model" ? row.traceId ?? row.requestId : undefined;
  const requestRow = !!requestId;
  const [tab, setTab] = useState<DetailTab>(() => {
    if (!requestRow || row.requestPhase === "compact") return "概述";
    return row.traceId ? "请求消息" : "助手输出";
  });
  const tabPrefix = useId();
  const toolRow = row.kind === "tool";
  const message = row.kind === "input" || (row.kind === "model" && !requestRow && !!(row.body || row.reasoning));
  const { record, error } = useTraceRecord(sessionId, requestId ?? row.traceId, row.status, requestRow);
  const schemaSource = useTraceRecord(sessionId, toolRow && (tab === "概述" || tab === "Schema") ? row.requestId : undefined);
  const request = record?.kind === "request" ? record : undefined;
  const historicalSchema = schemaSource.record?.kind === "request"
    ? schemaSource.record.request.tools.find((tool) => tool.name === row.tool)
    : undefined;
  const displayedSchema = row.requestId ? historicalSchema : schema;
  const tool = record?.kind === "tool" ? record : undefined;
  const args = tool?.call.arguments ?? row.args;
  const rawResult = tool?.result?.content ?? row.result;
  const status = displayStatus(row);
  const failed = /失败|超时|拒绝/.test(status ?? "");
  const argumentTab = traceArgumentTab(args, row.tool);
  // 子工具的参数按需读取。加载完发现有脚本时，已打开的参数标签自然切换为代码标签。
  const activeTab = tab === "参数" || tab === "代码" ? argumentTab : tab;
  const tabs: DetailTab[] = requestRow
    ? [...requestTabs.slice(0, 2), "概述", ...requestTabs.slice(2)]
    : toolRow ? ["概述", argumentTab, "结果", "Schema", "计时"]
    : message ? ["概述", "预览", "原始内容"] : ["概述", "计时"];

  const schemaView = (preview = false) => displayedSchema
    ? <TraceSchema schema={displayedSchema} historical={!!row.requestId} preview={preview} />
    : <TraceNotice error={!!schemaSource.error}>{schemaSource.error || (row.requestId && !schemaSource.record
      ? "正在读取调用时的工具定义…" : "Schema 不可用")}</TraceNotice>;

  const metaRows: TraceMetaRow[] = [];
  if (related.length) {
    metaRows.push({ label: "层级", value: <span className="trace-hierarchy">
      {related.map((item) => <button type="button" key={item.id} className="trace-hierarchy-link" onClick={() => onOpenRecord(item.id)}>
        <span>{item.tool || (item.kind === "model" && !item.traceId ? "助手消息" : item.title)}
          {item.childStep !== undefined ? ` · 子步骤 ${item.childStep}` : ""}</span>
        <IChevron width={11} height={11} />
      </button>)}
    </span> });
  }
  if (status) metaRows.push({ label: "状态", value: status, error: failed });
  if (row.input && row.input.kind !== "unknown") {
    metaRows.push({ label: "输入类型", value: row.input.kind === "guidance" ? "运行中引导" : row.input.kind === "queued" ? "排队输入" : "轮次输入" },
      { label: "领取", value: row.input.claimed ? "已领取" : "未领取" },
      { label: "进入模型", value: row.input.consumed ? "已进入请求" : "无请求记录" });
  }
  if (toolRow) {
    if (row.callId) metaRows.push({ label: "调用 ID", value: <code>{row.callId}</code> });
    if (row.toolStarted !== undefined) metaRows.push({ label: "启动", value: row.toolStarted ? "已记录启动" : "未见启动记录" });
    if (row.detail?.errorKind) metaRows.push({ label: "错误类别", value: <code>{row.detail.errorKind}</code> });
  }
  const failure = traceRequestError(request?.response?.error);
  if (failure) metaRows.push({ label: "异常", value: failure, error: true });
  if (request?.response?.finishReason) metaRows.push({ label: "结束原因", value: <code>{request.response.finishReason}</code> });
  const requestTab = requestRow && requestTabs.find((value) => value === activeTab);
  const selectedIndex = tabs.indexOf(activeTab);
  const location = [row.turn && `第 ${row.turn} 轮`, row.step && `第 ${row.step} 步`, row.childStep && `子步骤 ${row.childStep}`, row.historical && "历史版本"].filter(Boolean).join(" · ");
  return (
    <aside className="trace-details" aria-label="轨迹详情">
      <div className="trace-detail-head">
        <div className="trace-detail-title">
          {requestRow ? <><span className="trace-request-dot" aria-hidden="true" /><span className="trace-request-name">{recordLabel(row)}</span></>
            : <span className="trace-badge" data-kind={row.kind} data-subtool={!!(toolRow && row.parentId)}>{recordLabel(row)}</span>}
          <span className="trace-detail-location" title={location}>{location}</span>
        </div>
        <button className="trace-close" type="button" onClick={onClose} aria-label="关闭详情"><span aria-hidden="true">×</span></button>
      </div>
      <div className="trace-tabs" data-request={requestRow || undefined} role="tablist" aria-label="详情视图">
        {tabs.map((value, index) => (
          <button type="button" key={value} id={`${tabPrefix}-tab-${index}`} role="tab" aria-controls={`${tabPrefix}-panel`}
            aria-selected={activeTab === value} tabIndex={activeTab === value ? 0 : -1} onClick={() => setTab(value)}
            onKeyDown={(event) => {
              let next: number;
              if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
              else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = tabs.length - 1;
              else return;
              event.preventDefault();
              setTab(tabs[next]);
              document.getElementById(`${tabPrefix}-tab-${next}`)?.focus();
            }}
          >{value}</button>
        ))}
      </div>
      <div className="trace-detail-content" id={`${tabPrefix}-panel`} role="tabpanel" aria-labelledby={`${tabPrefix}-tab-${selectedIndex}`}>
        {error && <TraceNotice error>{error}</TraceNotice>}
        {activeTab === "概述" && <>
          {!message && !requestRow && row.title !== row.tool && <p className="trace-program-description">{row.title}</p>}
          <TraceMeta rows={metaRows} />
          {message && <TraceSection title="预览" onOpen={() => setTab("预览")}><TraceMessage row={row} preview /></TraceSection>}
          {toolRow && <>
            {args !== undefined && <TraceToolArguments raw={args} tool={row.tool} onOpen={() => setTab(argumentTab)} />}
            {rawResult !== undefined && <TraceToolResult raw={rawResult} error={failed} onOpen={() => setTab("结果")} />}
            <TraceSection title="Schema" onOpen={() => setTab("Schema")}>{schemaView(true)}</TraceSection>
            <TraceSection title="计时" onOpen={() => setTab("计时")}><TraceTiming row={row} /></TraceSection>
          </>}
          {request && <>
            <TraceSection title="选项" onOpen={() => setTab("选项")}><TraceRequestOptions record={request} preview /></TraceSection>
            <TraceSection title="用量" onOpen={() => setTab("用量")}><TraceRequestUsage response={request.response} /></TraceSection>
            <TraceSection title="计时" onOpen={() => setTab("计时")}><TraceRequestTiming record={request} row={row} preview /></TraceSection>
          </>}
          {requestRow && !request && !error && <TraceNotice>正在读取请求快照…</TraceNotice>}
          {message && row.durationMs !== undefined && <TraceSection title="计时"><TraceTiming row={row} /></TraceSection>}
          {!toolRow && !requestRow && !message && row.body && <TraceMarkdown text={row.body} preview />}
          {row.kind === "event" && row.detail && <TraceSection title="事件明细"><TraceJson value={row.detail} label="事件明细 JSON" /></TraceSection>}
        </>}
        {activeTab === "预览" && <TraceMessage row={row} />}
        {activeTab === "原始内容" && <>
          {row.reasoning && <TraceSource text={row.reasoning} label="思考" />}
          {row.body && <TraceSource text={row.body} label={row.kind === "input" ? "用户消息" : "助手消息"} />}
          {!!row.paths?.length && <TraceSource text={row.paths.join("\n")} label="文件与目录" />}
        </>}
        {requestTab && (request
          ? <TraceRequestContent tab={requestTab} record={request} row={row} onOpen={onOpenRecord} />
          : !error && <TraceNotice>正在读取请求快照…</TraceNotice>)}
        {(activeTab === "代码" || activeTab === "参数") && (args !== undefined
          ? <TraceToolArguments raw={args} tool={row.tool} />
          : <TraceNotice>{row.traceId && !record && !error ? "正在读取工具参数…" : "没有保存工具参数"}</TraceNotice>)}
        {activeTab === "结果" && (rawResult !== undefined ? <TraceToolResult raw={rawResult} error={failed} />
          : <TraceNotice>{row.traceId && !record && !error ? "正在读取工具结果…" : "没有保存工具结果"}</TraceNotice>)}
        {activeTab === "Schema" && schemaView()}
        {activeTab === "计时" && !requestRow && <TraceTiming row={row} />}
      </div>
    </aside>
  );
}
