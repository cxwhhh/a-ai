"use client";

import { useState, type ReactNode } from "react";
import type { RequestMetrics, TraceRecordDetail, TraceRow } from "../../../conversation-trace/src/types";
import { IChevron, IWrench } from "./Icons";
import {
  TraceJson, TraceMarkdown, TraceMeta, TraceNotice, TraceSchema, TraceSection, TraceSource, TraceThinking,
  TraceToolArguments, traceDuration, traceNumber, traceTimestamp, type TraceMetaRow,
} from "./TraceDetailContent";

type RequestRecord = Extract<TraceRecordDetail, { kind: "request" }>;
export const requestTabs = ["选项", "用量", "计时", "提示词", "请求消息", "工具清单", "助手输出"] as const;
export type RequestTab = typeof requestTabs[number];
const phaseNames = { chat: "主请求", compact: "历史压缩", research: "子 Agent" };
const errorNames = { auth: "鉴权失败", "rate-limit": "限流", request: "请求错误", service: "提供方服务错误", other: "适配器异常" };
const tokenValue = (value: number) => `${traceNumber(value)} token`;

export function traceRequestError(error: RequestMetrics["error"]) {
  return error && `${errorNames[error.kind]}${error.status === undefined ? "" : ` · HTTP ${error.status}`}`;
}

/** 请求详情先展示可读摘要，完整选项保留在参数树里供调试核对。 */
export function TraceRequestOptions({ record, preview }: { record: RequestRecord; preview?: boolean }) {
  const { request, meta } = record;
  if (meta.kind !== "request") return null;
  const adapter = request.provider?.options;
  const rows: TraceMetaRow[] = [
    { label: "阶段", value: phaseNames[meta.phase] },
    { label: "模型", value: <code>{adapter?.model ?? meta.model}</code> },
    { label: "选定强度", value: <code>{meta.effort}</code> },
    ...(adapter?.reasoningEffort ? [{ label: "适配器强度", value: <code>{adapter.reasoningEffort}</code> }] : []),
    { label: "消息 / 工具", value: `${request.messages.length} / ${request.tools.length}` },
  ];
  if (preview) return <TraceMeta rows={rows} />;

  const agent = request.agent;
  return <>
    <TraceSection title="Agent 请求">
      <TraceMeta rows={[
        ...rows,
        { label: "连接标识", value: request.provider?.label ?? "—" },
        { label: "模型选择", value: <code>{meta.model}</code> },
        { label: "运行 ID", value: <code>{meta.runId}</code> },
        { label: "输入 ID", value: <code>{meta.inputId}</code> },
        ...(agent?.stepBudget === undefined ? [] : [{ label: "本轮步数预算", value: agent.stepBudget }]),
        ...(agent?.contextWindow === undefined ? [] : [{ label: "配置上下文", value: tokenValue(agent.contextWindow) }]),
        ...(agent?.compactAt === undefined ? [] : [{ label: "压缩触发阈值", value: tokenValue(agent.compactAt) }]),
        ...(agent?.guidanceIds?.length ? [{ label: "本步引导", value: agent.guidanceIds.map((id) => <div key={id}><code>{id}</code></div>) }] : []),
        ...(request.temperature === undefined ? [] : [{ label: "请求温度", value: request.temperature }]),
      ]} />
    </TraceSection>
    <TraceSection title="适配器选项">
      {adapter ? <TraceJson value={adapter} label="适配器选项 JSON" /> : <TraceNotice>这条记录没有保存适配器选项</TraceNotice>}
    </TraceSection>
  </>;
}

export function TraceRequestUsage({ response }: { response: RequestMetrics | undefined }) {
  const usage = response?.usage;
  if (!usage) return <TraceNotice>没有上报用量</TraceNotice>;
  const rows: TraceMetaRow[] = [{ label: "来源", value: usage.estimated ? "估算" : "提供方上报" }];
  const add = (label: string, value: number | undefined) => {
    if (value !== undefined && Number.isFinite(value) && value >= 0) rows.push({ label, value: tokenValue(value) });
  };
  add("输入", usage.inputTokens);
  add("命中缓存", usage.cacheHitTokens);
  if (usage.cacheHitTokens !== undefined) add("未命中输入", usage.inputTokens - usage.cacheHitTokens);
  add("新建缓存", usage.cacheWriteTokens);
  add("输出", usage.outputTokens);
  add("思考", usage.reasoningTokens);
  if (usage.reasoningTokens !== undefined) add("其余输出", usage.outputTokens - usage.reasoningTokens);
  add("合计", usage.inputTokens + usage.outputTokens);
  return <TraceMeta rows={rows} />;
}

export function TraceRequestTiming({ record, row, preview }: { record: RequestRecord; row: TraceRow; preview?: boolean }) {
  const metrics = record.response;
  const elapsed = metrics?.streamMs ?? row.durationMs;
  const first = metrics?.firstOutputMs;
  const generation = elapsed !== undefined && first !== undefined && elapsed >= first ? elapsed - first : undefined;
  const rows: TraceMetaRow[] = [
    { label: "开始时间", value: traceTimestamp(metrics?.providerStartedAt ?? record.at) },
    { label: "流耗时", value: traceDuration(elapsed) },
    { label: "首段输出", value: traceDuration(first) },
  ];
  if (!preview) {
    rows.push(
      { label: "结束时间", value: record.finishedAt === null ? "—" : traceTimestamp(record.finishedAt) },
      { label: "首段思考", value: traceDuration(metrics?.firstReasoningMs) },
      { label: "首段正文", value: traceDuration(metrics?.firstTextMs) },
      { label: "首段工具", value: traceDuration(metrics?.firstToolMs) },
      { label: "生成阶段", value: traceDuration(generation) },
    );
    const usage = metrics?.usage;
    if (usage && !usage.estimated && generation && Number.isFinite(usage.outputTokens) && usage.outputTokens >= 0) {
      rows.push({ label: "解码速率", value: `${(usage.outputTokens * 1_000 / generation).toFixed(1)} token/s` });
    }
    rows.push({ label: "计时基准", value: metrics?.streamMs === undefined ? "会话时间戳" : "适配器可见流" });
  }
  return <TraceMeta rows={rows} />;
}

function RequestDisclosure({ title, catalog, children }: { title: ReactNode; catalog?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <details className={catalog ? "trace-block trace-catalog" : "trace-block"} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><IChevron width={12} height={12} />{title}</summary>
    {open && children}
  </details>;
}

function RequestContext({ record, onOpen }: { record: RequestRecord; onOpen(id: string): void }) {
  const { context } = record;
  if (!context) return null;
  const { messages, previous } = context;
  return <>
    <TraceSection title="上下文构成">
      <TraceMeta rows={[
        { label: "消息来源", value: "A.ai 传给适配器的消息" },
        { label: "输入估算", value: tokenValue(context.estimatedInputTokens) },
        { label: "系统 / 用户", value: `${messages.system} / ${messages.user}` },
        { label: "助手 / 工具", value: `${messages.assistant} / ${messages.tool}` },
      ]} />
    </TraceSection>
    <TraceSection title="与同轮上一请求对比">
      {previous ? <TraceMeta rows={[
        { label: "对比基准", value: <button type="button" className="trace-hierarchy-link" onClick={() => onOpen(previous.id)}>
          <span>第 {previous.step} 步{previous.childStep === undefined ? "" : ` · 子步骤 ${previous.childStep}`}</span>
          <IChevron width={11} height={11} />
        </button> },
        { label: "首个变化位置", value: previous.firstChanged === undefined ? "消息顺序与内容一致" : `第 ${previous.firstChanged} 条消息` },
        { label: "消息增 / 减", value: `+${previous.added} / −${previous.removed}` },
        { label: "系统提示词", value: previous.systemChanged ? "已变化" : "一致" },
        { label: "工具新增", value: previous.toolsAdded.join("、") || "—" },
        { label: "工具移除", value: previous.toolsRemoved.join("、") || "—" },
        { label: "定义变化", value: previous.toolsChanged.join("、") || "—" },
        ...(previous.toolOrderChanged ? [{ label: "工具顺序", value: "已有工具的相对顺序已变化" }] : []),
      ]} /> : <TraceNotice>暂无同轮、同阶段、同父调用的上一份请求快照</TraceNotice>}
    </TraceSection>
  </>;
}

export function TraceRequestContent({ tab, record, row, onOpen }: { tab: RequestTab; record: RequestRecord; row: TraceRow; onOpen(id: string): void }) {
  const { request, response } = record;
  if (tab === "选项") return <TraceRequestOptions record={record} />;
  if (tab === "用量") return <TraceRequestUsage response={response} />;
  if (tab === "计时") return <TraceRequestTiming record={record} row={row} />;
  if (tab === "提示词") {
    const system = request.messages.filter((message) => message.role === "system");
    return system.length ? system.map((message, index) => <div key={index}>
      <TraceMarkdown text={message.content} />
      <RequestDisclosure title="提示词原文"><TraceSource text={message.content} label="系统提示词" /></RequestDisclosure>
    </div>) : <TraceNotice>本次请求没有系统消息</TraceNotice>;
  }
  if (tab === "请求消息") return <>
    <RequestContext record={record} onOpen={onOpen} />
    <RequestDisclosure title="原始消息 JSON"><TraceJson value={request.messages} label="请求消息 JSON" /></RequestDisclosure>
    {request.messages.map((message, index) => <RequestDisclosure key={index}
      title={<><code>{index + 1}. {message.role}</code>{message.toolCallId && <span className="ellipsis">{message.toolCallId}</span>}</>}>
      {message.reasoning && <TraceThinking text={message.reasoning} />}
      {message.content && <TraceMarkdown text={message.content} />}
      {message.toolCalls?.map((call) => <TraceSection key={call.id} title={`${call.name} · ${call.id}`}>
        <TraceToolArguments raw={call.arguments} tool={call.name} />
      </TraceSection>)}
    </RequestDisclosure>)}
  </>;
  if (tab === "工具清单") {
    return request.tools.length ? request.tools.map((tool) => <RequestDisclosure key={tool.name} catalog
      title={<><IWrench width={12} height={12} /><code>{tool.name}</code><span className="ellipsis">{tool.description}</span></>}>
      <TraceSchema schema={tool} />
    </RequestDisclosure>) : <TraceNotice>本次请求没有提供工具</TraceNotice>;
  }
  if (!response?.blocks.length) return <TraceNotice>{record.outcome === null ? "请求尚未收尾" : "这次请求没有返回可展示内容"}</TraceNotice>;
  return response.blocks.map((block, index) => (
    <TraceSection key={index} title={block.kind === "tool-call" ? `工具调用 · ${block.call.name}`
      : block.kind === "tool-draft" ? `工具参数片段 · ${block.name}` : block.kind === "reasoning" ? "思考" : "正文"}>
      {block.kind === "tool-call" ? <TraceToolArguments raw={block.call.arguments} tool={block.call.name} />
        : block.kind === "tool-draft" ? <pre className="trace-payload">{block.text}</pre>
        : <TraceMarkdown text={block.text} compact={block.kind === "reasoning"} />}
    </TraceSection>
  ));
}
