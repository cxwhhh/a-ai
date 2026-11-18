"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { ToolSpec } from "../../../llm/src/types";
import { HlLines } from "./Code";
import { Markdown } from "./Markdown";
import { ICheck, IChevron, ICopy } from "./Icons";

export type TraceMetaRow = { label: string; value: ReactNode; error?: boolean };
const number = new Intl.NumberFormat("zh-CN");
const timestamp = new Intl.DateTimeFormat("sv-SE", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

export const traceNumber = (value: number) => number.format(value);
export const traceDuration = (ms?: number) => ms === undefined ? "—" : `${traceNumber(Math.round(ms))} 毫秒`;
export const traceTimestamp = (at: number) => `${timestamp.format(at)}.${String(new Date(at).getMilliseconds()).padStart(3, "0")}`;

/** 概述、计时和统计沿用同一套标签和数值对齐方式。 */
export function TraceMeta({ rows }: { rows: TraceMetaRow[] }) {
  if (!rows.length) return null;
  return <dl className="trace-record-meta">
    {rows.map(({ label, value, error }) => <div key={label}>
      <dt>{label}</dt><dd className={error ? "trace-error" : undefined}>{value}</dd>
    </div>)}
  </dl>;
}

/** 区段标题可以跳到完整标签页，概述中的内容保留原来的阅读顺序。 */
export function TraceSection({ title, children, onOpen, actions }: {
  title: string;
  children: ReactNode;
  onOpen?(): void;
  actions?: ReactNode;
}) {
  return <section className="trace-section" data-preview={onOpen ? "" : undefined}>
    <h3 className="trace-section-heading">
      {onOpen ? <button type="button" className="trace-section-link" onClick={onOpen}>{title}<IChevron width={12} height={12} /></button> : title}
      {actions && <span className="trace-section-actions">{actions}</span>}
    </h3>
    {onOpen ? <div className="trace-section-body">{children}</div> : children}
  </section>;
}

export function TraceNotice({ children, error }: { children: ReactNode; error?: boolean }) {
  return <p className={error ? "trace-notice trace-error" : "trace-notice"} role={error ? "alert" : undefined}>{children}</p>;
}

function CopyTrace({ value, label }: { value: () => string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 1500);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    const text = value();
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      // 本地 HTTP 部署可能没有 Clipboard API，仍允许核对和复制原始数据。
      const field = Object.assign(document.createElement("textarea"), { value: text });
      field.style.position = "fixed";
      field.style.opacity = "0";
      const focus = document.activeElement;
      document.body.append(field);
      try {
        field.select();
        setState(document.execCommand("copy") ? "copied" : "failed");
      } catch {
        setState("failed");
      } finally {
        field.remove();
        if (focus instanceof HTMLElement) focus.focus();
      }
    }
  }

  const title = state === "copied" ? "已复制" : state === "failed" ? "复制失败" : label;
  return <button type="button" className="trace-icon-action" data-state={state} onClick={() => void copy()} aria-label={title} title={title}>
    {state === "copied" ? <ICheck width={12} height={12} /> : <ICopy width={12} height={12} />}
  </button>;
}

function parseContainer(text: string): object | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null) return value;
  } catch { /* 非 JSON 内容保留原文。 */ }
}

function jsonBrackets(value: object) {
  return Array.isArray(value) ? ["[", "]"] : ["{", "}"];
}

function JsonAtom({ value }: { value: unknown }) {
  const kind = typeof value === "string" ? "string" : typeof value === "number" ? "number" : "keyword";
  const text = typeof value === "string" && value.length > 160 ? JSON.stringify(value.slice(0, 160) + "…") : JSON.stringify(value);
  return <span data-json-value={kind}>{text}</span>;
}

/** 折叠行仅预览少量字段，展开时再挂载子节点，长结果也能快速打开。 */
function JsonPreview({ value }: { value: object }) {
  const [open, close] = jsonBrackets(value);
  const fields = Object.entries(value);
  return <span>{open}{fields.slice(0, 3).map(([name, item], index) => (
    <span key={name}>{index > 0 && ", "}{!Array.isArray(value) && <><span className="trace-json-key">{name}</span>{": "}</>}
      {item !== null && typeof item === "object" ? (Array.isArray(item) ? "[…]" : "{…}") : <JsonAtom value={item} />}
    </span>
  ))}{fields.length > 3 && ", …"}{close}</span>;
}

function JsonFields({ value }: { value: object }) {
  const [limit, setLimit] = useState(80);
  const fields = Object.entries(value);
  return <ul className="trace-json-fields">
    {fields.slice(0, limit).map(([name, child], index) => (
      <li key={name}><JsonField name={name} value={child} comma={index < fields.length - 1} /></li>
    ))}
    {limit < fields.length && <li><button className="trace-json-more" type="button" onClick={() => setLimit((n) => n + 80)}>显示更多字段</button></li>}
  </ul>;
}

function JsonField({ name, value, comma }: { name: string; value: unknown; comma: boolean }) {
  const [open, setOpen] = useState(false);
  const key = <span className="trace-json-key">{name || '""'}:</span>;
  const punctuation = comma ? "," : "";
  if (value !== null && typeof value === "object") {
    const [start, end] = jsonBrackets(value);
    if (Object.keys(value).length === 0) {
      return <div className="trace-json-line">{key} {start}{end}{punctuation}</div>;
    }
    return <details className="trace-json-node" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{key} {open ? start : <JsonPreview value={value} />}{!open && punctuation}</summary>
      {open && <><JsonFields value={value} /><div>{end}{punctuation}</div></>}
    </details>;
  }
  if (typeof value === "string" && (value.length > 160 || value.includes("\n"))) {
    return <details className="trace-json-node" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{key} <JsonAtom value={value} />{punctuation}</summary>
      {open && <pre className="trace-json-string">{value}</pre>}
    </details>;
  }
  return <div className="trace-json-line">{key} <JsonAtom value={value} />{punctuation}</div>;
}

export function TraceJson({ value, label, raw }: { value: object; label: string; raw?: string }) {
  const [open, close] = jsonBrackets(value);
  return <div className="trace-json" aria-label={label}>
    <div className="trace-json-root">
      <span>{open}</span>
      <CopyTrace value={() => raw ?? JSON.stringify(value, null, 2)} label="复制 JSON" />
    </div>
    <JsonFields value={value} />
    <div>{close}</div>
  </div>;
}

/** 预览和原文分开，避免在概述里重复渲染同一段 Markdown。 */
export function TraceMarkdown({ text, preview, compact }: { text: string; preview?: boolean; compact?: boolean }) {
  return <div className={["trace-markdown", preview && "trace-markdown-preview", compact && "trace-markdown-compact"].filter(Boolean).join(" ")}>
    <Markdown text={text} />
  </div>;
}

export function TraceThinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return <details className="trace-thinking" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>思考<IChevron width={12} height={12} /></summary>
    {open && <TraceMarkdown text={text} compact />}
  </details>;
}

export function TraceSource({ text, label }: { text: string; label: string }) {
  return <div className="trace-source">
    <div className="trace-source-header"><span>{label}</span><CopyTrace value={() => text} label="复制原文" /></div>
    <pre className="trace-payload">{text}</pre>
  </div>;
}

export function TraceSchema({ schema, historical, preview }: { schema: ToolSpec; historical?: boolean; preview?: boolean }) {
  return <div className={preview ? "trace-schema trace-schema-preview" : "trace-schema"}>
    <header className="trace-schema-intro">
      <h3>{schema.name}</h3>
      {historical === false && <span className="trace-schema-origin">当前工具定义</span>}
      {schema.description && <p>{schema.description}</p>}
    </header>
    <section aria-label="参数">
      <h4>参数</h4>
      <TraceJson value={schema.parameters} label={schema.name + " 参数 JSON"} />
    </section>
  </div>;
}

function programOf(value: object | undefined, tool?: string) {
  if (!value || Array.isArray(value)) return;
  const args = value as Record<string, unknown>;
  if (typeof args.command === "string" && args.command) return { code: args.command, lang: "bash" };
  if (typeof args.code === "string" && args.code) return { code: args.code, lang: tool === "run_python" ? "python" : undefined };
}

export function traceArgumentTab(raw: string | undefined, tool?: string): "代码" | "参数" {
  return raw !== undefined && programOf(parseContainer(raw), tool) ? "代码" : "参数";
}

/** 脚本页沿用轨迹的行号、换行、原始 JSON 和复制操作，复制时保留完整输入。 */
export function TraceToolArguments({ raw, tool, onOpen }: { raw: string; tool?: string; onOpen?(): void }) {
  const [wrap, setWrap] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const value = parseContainer(raw);
  const program = programOf(value, tool);
  if (!program) {
    const body = value ? <TraceJson value={value} label="调用参数 JSON" raw={raw} /> : <pre className="trace-payload">{raw}</pre>;
    return onOpen ? <TraceSection title="参数" onOpen={onOpen}>{body}</TraceSection> : body;
  }
  return <TraceSection title="代码" onOpen={onOpen} actions={<>
    {!showJson && program.lang && <span className="trace-program-language">{program.lang}</span>}
    {!showJson && <button type="button" className="trace-icon-action" aria-label="换行" title="换行" aria-pressed={wrap} onClick={() => setWrap((v) => !v)}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
        <path d="M2 3h12M2 7h9a2.5 2.5 0 0 1 0 5H8m2-2-2 2 2 2M2 12h3" />
      </svg>
    </button>}
    {!onOpen && <button type="button" className="trace-icon-action trace-json-action" aria-label="原始 JSON" title="原始 JSON" aria-pressed={showJson} onClick={() => setShowJson((v) => !v)}>{"{}"}</button>}
    <CopyTrace value={() => showJson ? raw : program.code} label={showJson ? "复制原始 JSON" : "复制代码"} />
  </>}>
    {showJson && value ? <TraceJson value={value} label="原始参数 JSON" raw={raw} />
      : <div className="trace-program" data-wrap={wrap}><HlLines text={program.code} lang={program.lang} /></div>}
  </TraceSection>;
}

/** A.ai 已保存的结果作为原始区，终端文本另外按 DSH 的渲染结果方式呈现。 */
export function TraceToolResult({ raw, error, onOpen }: { raw: string; error?: boolean; onOpen?(): void }) {
  const value = parseContainer(raw);
  const fields = value && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const lines = fields && [fields.output, fields.stdout, fields.stderr, ...(Array.isArray(fields.logs) ? fields.logs : [])]
    .filter((item): item is string => typeof item === "string" && item.length > 0);
  const rendered = value ? lines?.join("\n") : raw;
  const body = rendered ? <pre className={error ? "trace-result-text trace-error" : "trace-result-text"}>{rendered}</pre> : undefined;
  if (onOpen) return <TraceSection title="结果" onOpen={onOpen}>
    {body ?? (value ? <TraceJson value={value} label="结果 JSON" raw={raw} /> : <TraceNotice>没有输出</TraceNotice>)}
  </TraceSection>;
  return <div className="trace-result-sections">
    <TraceSection title="原始结果" actions={<CopyTrace value={() => raw} label="复制原始结果" />}>
      {value ? <TraceJson value={value} label="结果 JSON" raw={raw} /> : <pre className="trace-payload">{raw}</pre>}
    </TraceSection>
    {value && body && <TraceSection title="渲染结果">{body}</TraceSection>}
  </div>;
}
