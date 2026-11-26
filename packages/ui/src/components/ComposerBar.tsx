"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { StoredMessage } from "../../../protocol/src/lib/shared";
import { currentOption, modelOptions, reasoningOptions, type ModelOption, type Settings } from "../../../protocol/src/lib/settings";
import type { ReasoningEffort } from "../../../protocol/src/agent-events";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuFilterProvider, DropdownMenuGroup,
  DropdownMenuInput, DropdownMenuItem, DropdownMenuLabel, DropdownMenuList, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "./shadcn/dropdown-menu";
import { InputGroupButton } from "./shadcn/input-group";
import { Switch } from "./shadcn/switch";
import { cx } from "../utils/cx";
import "./ChartContrast.css";

const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  default: "默认", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高",
};

/** 优先展示自定义名称，搜索也可用真实模型 ID。 */
export function ModelSelector(props: {
  settings: Settings;
  onPickModel(value: string): void;
  onPickEffort(value: ReasoningEffort): void;
  onManage(): void;
  modelDisabled?: boolean;
  streaming?: boolean;
  multiAgent?: { enabled: boolean; onChange(value: boolean): void };
}) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const multiAgentLabel = useId();
  const { currentModel, reasoningEffort } = props.settings;
  const current = currentOption(props.settings);
  const modelLabel = current.value === currentModel ? current.label : "模型不可用";
  const efforts = reasoningOptions(props.settings, currentModel);
  const effortLabel = efforts.includes(reasoningEffort) ? EFFORT_LABEL[reasoningEffort] : "不可用";
  const options = modelOptions(props.settings);
  const needle = query.trim().toLowerCase();
  const groups = new Map<string, ModelOption[]>();
  for (const model of options) {
    if (!`${model.label} ${model.modelId ?? ""} ${model.group}`.toLowerCase().includes(needle)) continue;
    const group = groups.get(model.group);
    if (group) group.push(model);
    else groups.set(model.group, [model]);
  }
  const { multiAgent } = props;

  return (
    <div className="prompt-model-controls">
      <DropdownMenuFilterProvider filter={null} value={query} onValueChange={(value) => {
        setQuery(value);
        if (value) setSearching(true);
      }}>
        <DropdownMenu modal={false} onOpenChange={(open) => {
          if (!open) {
            setSearching(false);
            setQuery("");
          }
        }}>
          <DropdownMenuTrigger render={<InputGroupButton className="prompt-choice prompt-model-trigger" />}
            aria-label={`模型 · ${modelLabel}`} title={modelLabel}>
            <span className="prompt-model-label">{modelLabel}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="prompt-menu-model">
            {props.streaming && <div className="prompt-menu-note">模型从下一轮生效</div>}
            {/* Base UI 把实际焦点留在搜索框，过滤掉已高亮的选项时也能继续输入。 */}
            <DropdownMenuInput ref={searchRef} className={cx("prompt-menu-search", !searching && "prompt-menu-search-collapsed")}
              aria-label="搜索模型" placeholder="搜索模型…" />
            <DropdownMenuList aria-label="选择模型">
              <DropdownMenuRadioGroup value={currentModel} onValueChange={(value) => {
                if (value !== currentModel) props.onPickModel(value);
              }}>
                {[...groups].map(([group, models]) => (
                  <DropdownMenuGroup key={group} className="prompt-menu-group">
                    <DropdownMenuLabel className="prompt-menu-label">{group}</DropdownMenuLabel>
                    {models.map((model) => (
                      <DropdownMenuRadioItem key={model.value} value={model.value} disabled={props.modelDisabled}
                        className="prompt-menu-item" closeOnClick title={`${model.modelId ?? model.label} · ${fmtK(model.contextWindow)} tokens`}>
                        <span className="ellipsis">{model.label}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuGroup>
                ))}
              </DropdownMenuRadioGroup>
              {!groups.size && <div className="prompt-menu-note" role="status">没有匹配的模型</div>}
              <DropdownMenuSeparator className="prompt-menu-separator" />
              {options.length > 1 && !searching && <DropdownMenuItem className="prompt-menu-item prompt-menu-secondary"
                closeOnClick={false} onClick={() => {
                  setSearching(true);
                  searchRef.current?.focus();
                }}>搜索模型…</DropdownMenuItem>}
              <DropdownMenuItem className="prompt-menu-item prompt-menu-secondary" onClick={props.onManage}>管理模型连接…</DropdownMenuItem>
            </DropdownMenuList>
            {multiAgent && <div className="prompt-model-switch">
              <span id={multiAgentLabel}>多智能体模式</span>
              <Switch aria-labelledby={multiAgentLabel} checked={multiAgent.enabled}
                onCheckedChange={multiAgent.onChange} disabled={props.modelDisabled || props.streaming} />
            </div>}
          </DropdownMenuContent>
        </DropdownMenu>
      </DropdownMenuFilterProvider>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger render={<InputGroupButton className="prompt-choice prompt-effort-trigger" />}
          aria-label={`思考等级 · ${effortLabel}`} title={`思考等级 · ${effortLabel}`}>
          {effortLabel}
        </DropdownMenuTrigger>
        <DropdownMenuContent className="prompt-menu-effort" aria-label="选择思考等级">
          {efforts.length === 1 ? <div className="prompt-menu-note">此模型使用默认等级</div>
            : props.streaming && <div className="prompt-menu-note">思考等级从下一轮生效</div>}
          <DropdownMenuRadioGroup className="prompt-menu-group" value={reasoningEffort} onValueChange={(value) => {
            const selected = efforts.find((option) => option === value);
            if (selected && selected !== reasoningEffort) props.onPickEffort(selected);
          }}>
            {efforts.map((value) => (
              <DropdownMenuRadioItem key={value} value={value} className="prompt-menu-item"
                disabled={props.modelDisabled} closeOnClick title={value}>{EFFORT_LABEL[value]}</DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
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
export function ContextRing(props: {
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
  const pct = Math.max(0, Math.min(100, (used / window) * 100));
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

  const pctLabel = fmtPct(pct);
  const level = pct >= 90 ? "high" : pct >= 70 ? "mid" : "";

  const parts = [
    { k: "系统提示词", v: Math.min(props.systemTokens, used), cls: "p1" },
    { k: "工具定义", v: Math.min(props.toolsTokens, Math.max(0, used - props.systemTokens)), cls: "p2" },
    { k: "对话与工具结果", v: conv, cls: "p3" },
  ];

  return (
    <div className="pop-anchor" ref={ref}>
      <button type="button" className={cx("cbar-btn ring-btn", open && "on", level)} onClick={() => setOpen((v) => !v)}
        aria-label={`上下文占用 ${pctLabel}`} aria-expanded={open} title="上下文占用">
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
          <circle cx="9" cy="9" r="7" className="ctx-track" />
          {/* pathLength 把圆周映射到 100，弧长和旁边的百分比使用相同的数值。 */}
          {pct > 0 && <circle cx="9" cy="9" r="7" pathLength="100" className="ctx-fill"
            strokeDasharray={pct < 100 ? `${pct} 100` : undefined} transform="rotate(-90 9 9)" />}
        </svg>
        <span className="tnum">{pctLabel}</span>
      </button>

      {open && (
        <div className="pop pop-right ctx-pop">
          <div className="ctx-head">
            <span>上下文</span>
            <span className="pop-dim">{opt.label}</span>
          </div>
          <div className="ctx-big">
            <b className="tnum">{fmtNum(used)}</b>
            <span className="pop-dim"> / {fmtK(window)} tokens · {pctLabel}</span>
          </div>

          {/* 堆叠条：系统提示词 / 工具定义 / 对话，剩余部分留空 */}
          <div className="ctx-bar" role="img" aria-label="上下文构成">
            {parts.map((p) => p.v > 0 && <span key={p.k} className={p.cls} style={{ width: `${p.v / Math.max(window, used) * 100}%` }} />)}
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
