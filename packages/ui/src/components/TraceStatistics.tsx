"use client";

import { useState, type ReactNode } from "react";
import type { AgentWorkStatus } from "../../../protocol/src/agent-events";
import type { SubagentTraceKind, TraceAnalysis, TraceRequestTotals, TraceRow, TraceToolState, TraceUsageTotal } from "../../../conversation-trace/src/types";
import { STATUS_LABEL } from "../../../protocol/src/lib/shared";
import { IChevron } from "./Icons";
import { TraceMeta, TraceNotice, TraceSection, traceDuration, traceNumber, traceTimestamp, type TraceMetaRow } from "./TraceDetailContent";
import { subagentKindNames, traceRequestError } from "./TraceRequestContent";

const workLabels: Record<AgentWorkStatus, string> = {
  queued: "排队", accepted: "已领取", running: "执行中", completed: "完成", cancelled: "取消", failed: "失败",
  "waiting-for-answer": "等待回答", "output-truncated": "输出截断", interrupted: "中断", unknown: "结果未知",
};
const toolLabels: Record<TraceToolState, string> = { ...STATUS_LABEL, running: "执行中", interrupted: "中断" };
const usagePair = (total: TraceUsageTotal) => total.count ? `${traceNumber(total.input)} / ${traceNumber(total.output)}` : "—";
const firstOutput = ({ firstOutput: time }: TraceRequestTotals) => traceDuration(time.count ? time.ms / time.count : undefined);

function StatsTable({ label, columns, rows }: { label: string; columns: readonly string[]; rows: ReactNode[] }) {
  const [limit, setLimit] = useState(50);
  return <>
    <div className="trace-stats-table" role="region" aria-label={label} tabIndex={0}>
      <table aria-label={label}>
        <thead><tr>{columns.map((column) => <th scope="col" key={column}>{column}</th>)}</tr></thead>
        <tbody>{rows.slice(0, limit)}</tbody>
      </table>
    </div>
    {rows.length > limit && <button type="button" className="trace-stat-more" onClick={() => setLimit((value) => value + 50)}>显示更多</button>}
  </>;
}

function StatsLink({ children, onClick }: { children: ReactNode; onClick(): void }) {
  return <button type="button" className="trace-stat-link" onClick={onClick}>{children}<IChevron width={11} height={11} /></button>;
}

/** 数字来自会话全量投影。定位入口返回对应的原始记录或轮次。 */
export function TraceStatistics({ analysis, rows, onOpen }: { analysis: TraceAnalysis; rows: TraceRow[]; onOpen(id: string, turn?: number): void }) {
  const { requests, tools, turns, models, issues, inputs } = analysis;
  const { reported, estimated, phases, subagentKinds, states, decode } = requests;
  const subagentBreakdown = Object.entries(subagentKinds ?? {})
    .filter(([, count]) => typeof count === "number" && count > 0)
    .map(([kind, count]) => `${subagentKindNames[kind as SubagentTraceKind].replace(/^子 Agent · /, "")} ${count}`)
    .join(" · ");
  const byId = new Map(rows.map((row) => [row.id, row]));
  const timedTools = tools.reduce((count, tool) => count + tool.elapsed.count, 0);
  const usageRows: TraceMetaRow[] = [
    { label: "上报输入 / 输出", value: usagePair(reported) },
    { label: "估算输入 / 输出", value: usagePair(estimated) },
    { label: "用量覆盖", value: `上报 ${reported.count} · 估算 ${estimated.count} · 缺失 ${requests.count - reported.count - estimated.count}` },
  ];
  if (reported.cacheRead !== undefined) {
    const percent = reported.cacheReadInput ? ` · 命中率 ${(reported.cacheRead / reported.cacheReadInput * 100).toFixed(1)}%` : "";
    usageRows.push({ label: "命中缓存", value: traceNumber(reported.cacheRead) + percent });
  }
  if (reported.cacheWrite !== undefined) usageRows.push({ label: "新建缓存", value: traceNumber(reported.cacheWrite) });
  if (reported.reasoning !== undefined) usageRows.push({ label: "思考用量", value: traceNumber(reported.reasoning) });
  const inputStates = Object.entries(workLabels).flatMap(([key, label]) => {
    const count = inputs.counts[key as AgentWorkStatus];
    return count ? [`${label} ${count}`] : [];
  });
  const requestStates = Object.entries(states).map(([key, count]) => `${workLabels[key as AgentWorkStatus]} ${count}`).join(" · ");

  if (!rows.length && !turns.length) return <TraceNotice>这段对话还没有可分析的记录</TraceNotice>;
  return <div className="trace-statistics" aria-label="会话统计">
    <div className="trace-stats-overview">
      <TraceSection title="会话概况">
        <TraceMeta rows={[
          { label: "已跟踪轮次", value: turns.length },
          { label: "关闭 / 步骤", value: `${turns.reduce((n, turn) => n + turn.closedSteps, 0)} / ${turns.reduce((n, turn) => n + turn.steps, 0)}` },
          { label: "进入模型 / 输入", value: `${inputs.consumed} / ${inputs.total}` },
          { label: "输入状态", value: inputStates.join(" · ") || "—" },
          { label: "排队取消", value: inputs.dropped },
          { label: "模型请求", value: `主请求 ${phases.chat} · 压缩 ${phases.compact} · 子 Agent ${phases.research}${subagentBreakdown ? `（${subagentBreakdown}）` : ""}` },
          { label: "请求状态", value: requestStates || "—" },
          ...(analysis.legacyModelRows ? [{ label: "缺请求快照", value: `${analysis.legacyModelRows} 条旧模型记录` }] : []),
        ]} />
      </TraceSection>
      <TraceSection title="用量与计时">
        <TraceMeta rows={[
          ...usageRows,
          { label: "模型流累计", value: traceDuration(requests.elapsed.count ? requests.elapsed.ms : undefined) },
          { label: "工具累计", value: traceDuration(timedTools ? tools.reduce((ms, tool) => ms + tool.elapsed.ms, 0) : undefined) },
          { label: "平均首段", value: requests.firstOutput.count ? `${firstOutput(requests)} · ${requests.firstOutput.count} 次` : "—" },
          { label: "解码速率", value: decode.ms ? `${(decode.tokens * 1_000 / decode.ms).toFixed(1)} token/s · ${decode.count} 次` : "—" },
        ]} />
        <p className="trace-stats-note">累计耗时包含并行与嵌套调用。轮次时长按实际起止时间计算。</p>
      </TraceSection>
    </div>
    {issues.length > 0 && <TraceSection title="异常与未完成请求">
      <StatsTable label="异常请求" columns={["请求", "位置", "状态", "结束原因"]} rows={[...issues].reverse().map((issue) => {
        const row = byId.get(issue.rowId);
        if (!row) return null;
        const reason = traceRequestError(issue.error) ?? issue.finishReason;
        return <tr key={issue.rowId}>
          <td><StatsLink onClick={() => onOpen(row.id)}>{row.title}</StatsLink></td>
          <td>{row.turn ?? "—"}{row.step === undefined ? "" : `.${row.step}`}{row.childStep === undefined ? "" : `.${row.childStep}`}</td>
          <td>{issue.finishReason === "refusal" || issue.finishReason === "content_filter" ? "模型拒绝" : row.status}</td>
          <td>{reason ?? "—"}</td>
        </tr>;
      })} />
    </TraceSection>}
    {turns.length > 0 && <TraceSection title="Agent 轮次">
      <StatsTable label="Agent 轮次" columns={["轮次 / 输入", "状态", "输入与引导", "关闭 / 步骤", "请求 / 工具", "轮次时长"]} rows={[...turns].reverse().map((turn) => {
        const row = turn.rowId ? byId.get(turn.rowId) : undefined;
        const label = turn.number === undefined ? "未编号轮次" : `第 ${turn.number} 轮`;
        return <tr key={turn.inputId}>
          <td title={row?.title}>{row ? <StatsLink onClick={() => onOpen(row.id, turn.number)}>
            <span className="ellipsis">{label} · {row.title}</span>
          </StatsLink> : label}{turn.historical && <span className="trace-stat-muted"> · 历史版本</span>}</td>
          <td>{workLabels[turn.status]}</td>
          <td>{turn.consumed ? "已进入模型" : "无请求记录"}{turn.guidance ? ` · 引导 ${turn.consumedGuidance}/${turn.guidance}` : ""}</td>
          <td>{turn.closedSteps} / {turn.steps}</td>
          <td>{turn.requests} / {turn.tools}</td>
          <td title={turn.at === undefined ? undefined : traceTimestamp(turn.at)}>{traceDuration(turn.durationMs)}</td>
        </tr>;
      })} />
    </TraceSection>}
    {models.length > 0 && <TraceSection title="模型与思考强度">
      <StatsTable label="模型与思考强度" columns={["模型 / 强度", "请求", "上报输入 / 输出", "估算输入 / 输出", "平均首段"]} rows={models.map((model) => (
        <tr key={JSON.stringify([model.model, model.effort])}>
          <td><StatsLink onClick={() => onOpen(model.rowId)}><code>{model.model}</code> · {model.effort}</StatsLink></td>
          <td>{model.totals.count}</td><td>{usagePair(model.totals.reported)}</td><td>{usagePair(model.totals.estimated)}</td><td>{firstOutput(model.totals)}</td>
        </tr>
      ))} />
    </TraceSection>}
    {tools.length > 0 && <TraceSection title="工具调用">
      <StatsTable label="工具调用统计" columns={["工具", "启动 / 调用", "子调用", "结果", "累计耗时"]} rows={tools.map((tool) => (
        <tr key={tool.name}>
          <td><StatsLink onClick={() => onOpen(tool.rowId)}><code>{tool.name}</code></StatsLink></td>
          <td>{tool.started} / {tool.count}</td><td>{tool.children}</td>
          <td>{Object.entries(tool.states).map(([key, count]) => `${toolLabels[key as TraceToolState]} ${count}`).join(" · ")}</td>
          <td>{traceDuration(tool.elapsed.count ? tool.elapsed.ms : undefined)}</td>
        </tr>
      ))} />
    </TraceSection>}
  </div>;
}
