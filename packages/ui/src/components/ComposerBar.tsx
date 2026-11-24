"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { StoredMessage } from "../../../protocol/src/lib/shared";
import { currentOption, modelOptions, reasoningOptions, type Settings } from "../../../protocol/src/lib/settings";
import type { ReasoningEffort } from "../../../protocol/src/agent-events";
import { ICheck, IChevron, IModel, IUpDown } from "./Icons";
import { cx } from "../utils/cx";
import "./ChartContrast.css";

/**
 * 输入框下方的一行，全部靠右：上下文占用在左，模型名在最右边，中间空约 4 个字。
 *                                           [◔ 1.2%]    [◇ deepseek… ▾]
 * 模型名最多显示 7 个字，超出用 … 截断，鼠标停上去显示全名。
 */
export function ComposerBar(props: {
  settings: Settings;
  messages: StoredMessage[];
  systemTokens: number;
  toolsTokens: number;
  onPickModel(value: string): void;
  onPickEffort(value: ReasoningEffort): void;
  modelDisabled?: boolean;
  multiAgent?: { enabled: boolean; onChange(value: boolean): void };
  onManage(): void;
  onUsage(): void;
}) {
  return (
    <div className="cbar">
      <div className="spacer" />
      <ContextRing {...props} />
      <ModelPicker settings={props.settings} onPick={props.onPickModel} onPickEffort={props.onPickEffort} onManage={props.onManage} disabled={props.modelDisabled} multiAgent={props.multiAgent} />
    </div>
  );
}

/* ---------------- 模型切换 ---------------- */

const EFFORT_LABEL: Record<ReasoningEffort, string> = { default: "Default", low: "Low", medium: "Medium", high: "High", max: "Max" };

function ModelPicker(props: { settings: Settings; onPick(v: string): void; onPickEffort(v: ReasoningEffort): void; onManage(): void; disabled?: boolean; multiAgent?: { enabled: boolean; onChange(value: boolean): void } }) {
  const [view, setView] = useState<"summary" | "models" | "effort" | null>(null);
  const [query, setQuery] = useState("");
  const panelId = useId();
  const open = view !== null;
  const ref = usePopover(open, () => setView(null));
  const trigger = useRef<HTMLButtonElement>(null);
  const { currentModel, reasoningEffort } = props.settings;
  const current = currentOption(props.settings);
  const modelLabel = current.value === currentModel ? current.label : "模型不可用";
  const efforts = reasoningOptions(props.settings, currentModel);
  const effort = efforts.includes(reasoningEffort) ? reasoningEffort : "default";
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const g = new Map<string, ReturnType<typeof modelOptions>>();
    for (const o of modelOptions(props.settings)) {
      if (`${o.label} ${o.group}`.toLowerCase().includes(needle)) g.set(o.group, [...(g.get(o.group) ?? []), o]);
    }
    return [...g.entries()];
  }, [props.settings, query]);

  function closeSelection() {
    setView(null);
    trigger.current?.focus();
  }

  return (
    <div className="pop-anchor" ref={ref}>
      <button
        type="button"
        ref={trigger}
        className={`cbar-btn model-btn ${open ? "on" : ""}`}
        disabled={props.disabled}
        onClick={() => setView(open ? null : "summary")}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={`此对话的模型 · ${current.value === currentModel ? modelLabel : currentModel}`}
      >
        <IModel width={13} height={13} />
        <span>{clip(modelLabel, 7)}</span>
        <IUpDown width={12} height={12} />
      </button>
      {open && (
        <div className="pop pop-right model-pop" id={panelId} role="dialog" aria-label="此对话的模型设置">
          {/* 子页共用同一个弹层，切换内容时不会重新播放外层的打开动画。 */}
          {view === "summary" ? (
            <>
              <button type="button" className="pop-item model-pop-summary" disabled={props.disabled} onClick={() => { setQuery(""); setView("models"); }}>
                <span>模型</span><span className="ellipsis pop-dim" title={modelLabel}>{modelLabel}</span><IChevron width={13} height={13} />
              </button>
              <button type="button" className="pop-item model-pop-summary" disabled={props.disabled} onClick={() => setView("effort")}>
                <span>推理等级</span><span className="ellipsis pop-dim">{EFFORT_LABEL[effort]}</span><IChevron width={13} height={13} />
              </button>
              {props.multiAgent && <div className="pop-item model-pop-summary model-pop-agent-mode">
                <span>多agent智能体模式</span>
                <button type="button" className={cx("switch", props.multiAgent.enabled && "on")} role="switch" aria-label="多agent智能体模式"
                  aria-checked={props.multiAgent.enabled} disabled={props.disabled} onClick={() => props.multiAgent?.onChange(!props.multiAgent.enabled)}><span /></button>
              </div>}
            </>
          ) : (
            <>
              <div className="model-pop-head">
                {view === "models" ? (
                  <input type="search" className="picker-search" aria-label="搜索模型" placeholder="搜索模型…" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
                ) : (
                  <>
                    <button type="button" className="icon-btn" aria-label="返回模型设置" onClick={() => setView("summary")}><IChevron width={13} height={13} /></button>
                    <span>推理等级</span>
                  </>
                )}
              </div>
              <div className="model-pop-body">
                {view === "models" ? (
                  <>
                    {groups.map(([group, opts]) => (
                      <div key={group}>
                        <div className="pop-group">{group}</div>
                        {opts.map((o) => (
                          <button type="button" key={o.value} className="pop-item model-pop-option" aria-pressed={o.value === currentModel} disabled={props.disabled}
                            onClick={() => { closeSelection(); if (o.value !== currentModel) props.onPick(o.value); }}>
                            <span className="ellipsis">{o.label}</span>
                            <span className="pop-dim">{fmtK(o.contextWindow)}</span>
                            <span className="pop-check">{o.value === currentModel && <ICheck width={13} height={13} />}</span>
                          </button>
                        ))}
                      </div>
                    ))}
                    {!groups.length && <div className="pop-group" role="status">没有匹配的模型</div>}
                    <div className="pop-sep" />
                    <button type="button" className="pop-item" onClick={() => { setView(null); props.onManage(); }}>管理模型连接…</button>
                  </>
                ) : efforts.map((value) => (
                  <button type="button" key={value} className="pop-item model-pop-option" aria-pressed={value === effort} disabled={props.disabled}
                    onClick={() => { closeSelection(); if (value !== effort) props.onPickEffort(value); }}>
                    <span className="ellipsis">{EFFORT_LABEL[value]}</span>
                    <span className="pop-check">{value === effort && <ICheck width={13} height={13} />}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** 最后一个满足条件的下标（tsconfig 的 lib 是 es2022，还没有 Array.prototype.findLastIndex） */
function lastIndexOf<T>(arr: T[], ok: (x: T) => boolean) {
  for (let i = arr.length - 1; i >= 0; i--) if (ok(arr[i])) return i;
  return -1;
}

/* ---------------- 上下文环形图 ----------------
 * 上下文占用 = 最近一次请求的输入 token + 输出 token（下一次请求会把它们全部带上）。
 * 最近一次请求之后又做过上下文压缩：用压缩后的估算值（旧的数字已经不代表下一次请求了）。
 * 还没调用过模型时，用“系统提示词 + 工具说明书”的估算值。
 */
function ContextRing(props: {
  settings: Settings;
  messages: StoredMessage[];
  systemTokens: number;
  toolsTokens: number;
  onUsage(): void;
}) {
  const [open, setOpen] = useState(false);
  const ref = usePopover(open, () => setOpen(false));
  const opt = currentOption(props.settings);
  const window = opt.contextWindow;

  const lastIdx = lastIndexOf(props.messages, (m) => m.role === "assistant" && !!m.usage);
  const last = lastIdx >= 0 ? props.messages[lastIdx] : undefined;
  const compactIdx = lastIndexOf(props.messages, (m) => m.feedback?.kind === "compact" && !!m.compact);
  const compacted = compactIdx > lastIdx ? props.messages[compactIdx].compact : undefined;
  const fixed = props.systemTokens + props.toolsTokens;
  const used = compacted ? compacted.tokensAfter : last?.usage ? last.usage.inputTokens + last.usage.outputTokens : fixed;
  const pct = Math.min(100, (used / window) * 100);
  const conv = Math.max(0, used - fixed);

  // 本会话的调用：对话的每一步 + 上下文压缩（压缩也是一次模型调用，用量记在摘要消息上）
  const total = props.messages.filter((m) => m.usage && (m.role === "assistant" || m.feedback?.kind === "compact")).reduce(
    (t, m) => ({
      calls: t.calls + 1,
      input: t.input + (m.usage?.inputTokens ?? 0),
      output: t.output + (m.usage?.outputTokens ?? 0),
      cache: t.cache + (m.usage?.cacheHitTokens ?? 0),
      reasoning: t.reasoning + (m.usage?.reasoningTokens ?? 0),
    }),
    { calls: 0, input: 0, output: 0, cache: 0, reasoning: 0 },
  );

  // SVG 圆环：周长 = 2πr，用 stroke-dasharray 画出占比
  const R = 6.5;
  const C = 2 * Math.PI * R;
  const level = pct >= 90 ? "high" : pct >= 70 ? "mid" : "";

  const parts = [
    { k: "系统提示词", v: Math.min(props.systemTokens, used), cls: "p1" },
    { k: "工具定义", v: Math.min(props.toolsTokens, Math.max(0, used - props.systemTokens)), cls: "p2" },
    { k: "对话与工具结果", v: conv, cls: "p3" },
  ];

  return (
    <div className="pop-anchor" ref={ref}>
      <button className={`cbar-btn ring-btn ${open ? "on" : ""} ${level}`} onClick={() => setOpen((v) => !v)} title="上下文占用">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <circle cx="8" cy="8" r={R} className="ctx-track" />
          <circle cx="8" cy="8" r={R} className="ctx-fill" strokeDasharray={`${Math.max(pct > 0 ? 0.6 : 0, (pct / 100) * C)} ${C}`} transform="rotate(-90 8 8)" />
        </svg>
        <span className="tnum">{fmtPct(pct)}</span>
      </button>

      {open && (
        <div className="pop pop-right ctx-pop">
          <div className="ctx-head">
            <span>上下文</span>
            <span className="pop-dim">{opt.label}</span>
          </div>
          <div className="ctx-big">
            <b className="tnum">{fmtNum(used)}</b>
            <span className="pop-dim"> / {fmtK(window)} tokens · {fmtPct(pct)}</span>
          </div>

          {/* 堆叠条：系统提示词 / 工具定义 / 对话，剩余部分留空 */}
          <div className="ctx-bar" role="img" aria-label="上下文构成">
            {parts.map((p) => p.v > 0 && <span key={p.k} className={p.cls} style={{ width: `${Math.max(0.8, (p.v / window) * 100)}%` }} />)}
          </div>
          <div className="ctx-legend">
            {parts.map((p) => (
              <div key={p.k}>
                <i className={p.cls} />
                <span>{p.k}</span>
                <span className="tnum">{fmtNum(p.v)}</span>
              </div>
            ))}
            <div>
              <i className="p0" />
              <span>剩余</span>
              <span className="tnum">{fmtNum(Math.max(0, window - used))}</span>
            </div>
          </div>

          <div className="pop-sep" />
          <div className="ctx-title">本会话 Token</div>
          <Kv k="模型调用" v={`${total.calls} 次`} />
          <Kv k="输入" v={fmtNum(total.input)} sub={total.cache ? `缓存命中 ${fmtNum(total.cache)}（${Math.round((total.cache / Math.max(1, total.input)) * 100)}%）` : undefined} />
          <Kv k="输出" v={fmtNum(total.output)} sub={total.reasoning ? `其中思考 ${fmtNum(total.reasoning)}` : undefined} />
          {last?.usage && <Kv k="最近一次请求" v={`${fmtNum(last.usage.inputTokens)} → ${fmtNum(last.usage.outputTokens)}`} />}

          <div className="ctx-note">
            {compacted
              ? `刚刚压缩了上下文（${fmtNum(compacted.tokensBefore)} → ${fmtNum(compacted.tokensAfter)}），当前为估算值。`
              : !last?.usage
              ? "还没有调用模型，当前为系统提示词和工具定义的估算值。"
              : last.usage.estimated
              ? "这个模型没有返回用量，总量按字数估算；系统提示词与工具定义的拆分也为估算。"
              : opt.value === "mock"
                ? "Mock 模型的用量为估算值；系统提示词与工具定义的拆分也为估算。"
                : "总量来自 API 返回的 usage；系统提示词与工具定义的拆分为估算。"}
          </div>
          <button
            className="pop-item"
            onClick={() => {
              setOpen(false);
              props.onUsage();
            }}
          >
            查看全部用量…
          </button>
        </div>
      )}
    </div>
  );
}

function Kv({ k, v, sub }: { k: string; v: ReactNode; sub?: string }) {
  return (
    <div className="kv">
      <span>{k}</span>
      <span className="tnum">
        {v}
        {sub && <span className="kv-sub">{sub}</span>}
      </span>
    </div>
  );
}

/** 点外面或按 Esc 关闭弹层 */
function usePopover(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, close]);
  return ref;
}

const fmtNum = (n: number) => Math.round(n).toLocaleString();
const fmtK = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
const fmtPct = (p: number) => (p === 0 ? "0%" : p < 0.1 ? "<0.1%" : p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`);

/** 按“字”截断：用 Array.from 按字符切，中文、emoji 都算一个字 */
const clip = (t: string, n: number) => {
  const cs = Array.from(t);
  return cs.length > n ? cs.slice(0, n).join("") + "…" : t;
};
