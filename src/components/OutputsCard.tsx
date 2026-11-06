"use client";
import { toolStatus, type Artifact, type StoredMessage } from "@/lib/shared";
import type { OutputItem, UsedItem, View } from "@/lib/outputs";
import { describeStep, rowState, type RowState } from "./Trace";
import { useEffect, useMemo, useState } from "react";
import { countDiff, diffLines, fileChanges } from "@/lib/diff";
import "./OutputsCard.css";
import { ICheck, IChevron, IX } from "./Icons";
import { KindIcon } from "./KindIcon";

/** 类型图标带颜色（KindIcon）：代码绿、网页蓝、文档橙、图表粉 */
const ICON = {
  code: <KindIcon kind="code" />,
  doc: <KindIcon kind="doc" />,
  web: <KindIcon kind="web" />,
  chart: <KindIcon kind="chart" />,
  file: <KindIcon kind="file" />,
  folder: <KindIcon kind="folder" />,
};

/**
 * 任务面板：点右上角的“任务与文件”按钮弹出的悬浮卡片（仿 Claude），大小固定，不能拖动。
 * 它是“钉住”的：点空白处、打开文件都不会收起，只有点右上角的 × 才关。
 * 从上到下（2026-10-29 改）：
 *   - 输出：标题行“输出 ×”，下面两列缩略图卡片（内容开头的小白纸 + 名字 + 产出物/新建/已修改 · 类型），
 *     默认只显示最新 2 个，多的点“展开全部”
 *   - 进度：最近一次任务里 agent 走过的每一步（工具调用），节点连成的链路，右侧是每步耗时（可折叠）
 *   - 本次会话中已使用：读过的文件、看过的目录、抓过的网页（可折叠）
 * 原来顶部的“已完成 · N 步 · 耗时”状态行、进度条和用户原话已去掉。折叠状态存在 localStorage 的 a.panelOpen 里。
 */
export function OutputsCard(props: {
  messages: StoredMessage[];
  /** 本对话的产出物全文：输出缩略图里要显示内容开头 */
  artifacts: Artifact[];
  running: Record<string, number>;
  streaming: boolean;
  outputs: OutputItem[];
  used: UsedItem[];
  active?: View | null;
  onOpen(v: View): void;
  onClose(): void;
}) {
  const { outputs, used, active, messages, streaming } = props;
  const isActive = (v?: View) => !!v && !!active && JSON.stringify(v) === JSON.stringify(active);
  const steps = lastTaskSteps(messages, props.running, streaming);
  const real = steps.filter((s) => s.id !== "thinking");
  const done = real.filter((s) => s.state === "done").length;
  const [open, setOpen] = useState<Record<string, boolean>>({ steps: true, out: true });
  useEffect(() => {
    try {
      const saved = localStorage.getItem("a.panelOpen");
      if (saved) setOpen(JSON.parse(saved));
    } catch {}
  }, []);
  const toggle = (k: string) =>
    setOpen((o) => {
      const n = { ...o, [k]: !o[k] };
      try {
        localStorage.setItem("a.panelOpen", JSON.stringify(n));
      } catch {}
      return n;
    });

  // 每个写过的文件：新建还是修改、一共 +几行 -几行（把这次对话里对它的每次改动加起来）
  const stats = useMemo(() => {
    const m = new Map<string, { add: number; del: number; isNew: boolean }>();
    for (const o of outputs) {
      if (o.view.type !== "file") continue;
      const ch = fileChanges(messages, o.view.path);
      if (!ch.length) continue;
      let add = 0, del = 0;
      for (const c of ch) {
        const d = countDiff(diffLines(c.before, c.after));
        add += d.add;
        del += d.del;
      }
      m.set(o.key, { add, del, isNew: ch[0].isNew });
    }
    return m;
  }, [outputs, messages]);

  const [allOuts, setAllOuts] = useState(false);
  // 缩略图里的内容：产出物取全文，写入的文件取这次对话里最后一次写进去的内容；都转成一小段纯文字
  const previews = useMemo(() => {
    const m = new Map<string, { text?: string; svg?: string }>();
    for (const o of outputs) {
      let raw = "";
      if (o.view.type === "artifact") {
        const id = o.view.id;
        raw = props.artifacts.find((a) => a.id === id)?.content ?? "";
      } else {
        const ch = fileChanges(messages, o.view.path);
        raw = ch.length ? ch[ch.length - 1].after : "";
      }
      if (o.ext === "svg" && /<svg[\s>]/i.test(raw)) m.set(o.key, { svg: raw });
      else if (raw) m.set(o.key, { text: previewText(raw, o.ext) });
    }
    return m;
  }, [outputs, messages, props.artifacts]);

  // 定时重绘：运行中每秒一次（总耗时在走），平时 30 秒一次（刷新“几分钟前”）
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), streaming ? 1000 : 30_000);
    return () => clearInterval(t);
  }, [streaming]);


  return (
    <aside className="panel oc" aria-label="任务面板" data-panel>
      {/* 输出放在最上面（2026-10-29，仿 Claude）：标题行“输出 ×”，下面两列缩略图卡片。
          默认只显示最新的 2 个，多了点“展开全部”看其余的 */}
      <section className="oc-outs">
        <div className="oc-outs-head">
          <b>输出</b>
          <button className="icon-btn oc-x" onClick={props.onClose} title="关闭">
            <IX width={14} height={14} />
          </button>
        </div>
        {outputs.length === 0 ? (
          <div className="panel-empty">生成的网页、文档、代码和写入的文件会出现在这里。</div>
        ) : (
          <div className="oc-thumbs">
            {(allOuts ? outputs : outputs.slice(0, 2)).map((o) => {
              const pv = previews.get(o.key);
              const st = stats.get(o.key);
              const slash = o.name.lastIndexOf("/");
              const base = o.view.type === "file" && slash >= 0 ? o.name.slice(slash + 1) : o.name;
              return (
                <button key={o.key} className={`oc-thumb ${isActive(o.view) ? "active" : ""}`} onClick={() => props.onOpen(o.view)} title={o.name}>
                  <span className={`oc-thumb-pv ${o.icon}`}>
                    {pv?.svg ? (
                      // SVG 用 <img> 画，里面的脚本不会执行
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(pv.svg)}`} alt="" />
                    ) : pv?.text ? (
                      <>
                        <b>{base}</b>
                        <span>{pv.text}</span>
                      </>
                    ) : (
                      <span className="oc-thumb-ico">{ICON[o.icon]}</span>
                    )}
                  </span>
                  <span className="oc-thumb-name ellipsis">{base}</span>
                  <span className="oc-thumb-sub ellipsis">
                    {o.view.type === "artifact" ? "产出物" : st && !st.isNew ? "已修改" : "新建"} · {o.ext.toUpperCase() || "文件"}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {outputs.length > 2 && (
          <button className="oc-more" onClick={() => setAllOuts((v) => !v)}>
            {allOuts ? "收起" : `展开全部 ${outputs.length} 个`}
            <IChevron className={allOuts ? "up" : ""} width={12} height={12} />
          </button>
        )}
      </section>

      {/* 原来这里是“已完成 · N 步 · 耗时”状态行、进度条和用户这次说的话（2026-10-29 按用户要求去掉）。
          状态还能从下面“进度”一栏和对话里看到 */}
      <Sec k="steps" open={open} onToggle={toggle} label="进度" meta={real.length ? `${done}/${real.length}` : undefined}>
        {steps.length === 0 ? (
          <div className="panel-empty">这次对话还没有调用工具。</div>
        ) : (
          <ol className="chain">
            {steps.map((s) => (
              <li key={s.id} className={`chain-step s-${s.state}`}>
                <span className="chain-dot">{s.state === "done" && <ICheck width={9} height={9} strokeWidth={2.2} />}</span>
                <span className="chain-verb">{s.verb}</span>
                {s.target ? <span className="chain-target ellipsis">{s.target}</span> : <span className="chain-target" />}
                {s.ms !== undefined && <span className="chain-ms">{fmtMs(s.ms)}</span>}
              </li>
            ))}
          </ol>
        )}
      </Sec>

      <Sec k="used" open={open} onToggle={toggle} label="本次会话中已使用" meta={used.length ? String(used.length) : undefined}>
        {used.length === 0 && <div className="panel-empty">读过的文件、看过的网页会出现在这里。</div>}
        {used.map((u) =>
          u.view ? (
            <button key={u.key} className={`out-row used ${isActive(u.view) ? "active" : ""}`} onClick={() => props.onOpen(u.view!)}>
              <span className="out-ico">{ICON[u.icon]}</span>
              <span className="out-label">{u.label}</span>
              <span className="out-name ellipsis mono">{u.detail}</span>
            </button>
          ) : (
            <a key={u.key} className="out-row used" href={u.href} target="_blank" rel="noreferrer">
              <span className="out-ico">{ICON[u.icon]}</span>
              <span className="out-label">{u.label}</span>
              <span className="out-name ellipsis">{u.detail}</span>
            </a>
          ),
        )}
      </Sec>
    </aside>
  );
}

/** 缩略图用的纯文字：网页去掉 <style>/<script> 和标签，Markdown 去掉 # * ` 这些符号，代码保留换行 */
function previewText(raw: string, ext: string) {
  let t = raw.slice(0, 4000);
  if (ext === "html" || ext === "htm") t = t.replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  else if (ext === "md") t = t.replace(/[#>*_`|-]+/g, " ");
  if (ext === "html" || ext === "htm" || ext === "md" || ext === "txt") t = t.replace(/\s+/g, " ");
  return t.trim().slice(0, 240);
}

function fmtMs(ms: number) {
  if (ms < 100) return "<0.1s";
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function ago(ts: number) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 面板里的一行：标题 + 折叠箭头 + 右侧的简短数字。
 *  必须定义在组件外面：定义在里面的话，每次重绘都是一个“新组件”，整段 DOM 会被拆掉重建，转圈动画会一直从头开始 */
function Sec(props: {
  k: string;
  label: string;
  meta?: string;
  open: Record<string, boolean>;
  onToggle(k: string): void;
  children: React.ReactNode;
}) {
  const on = !!props.open[props.k];
  return (
    <section className={`psec ${on ? "open" : ""}`}>
      <div className="psec-head">
        <button className="psec-btn" onClick={() => props.onToggle(props.k)} aria-expanded={on}>
          <span>{props.label}</span>
          <IChevron className="psec-chev" width={13} height={13} />
          {props.meta && <span className="psec-meta">{props.meta}</span>}
        </button>
      </div>
      {on && <div className="psec-body">{props.children}</div>}
    </section>
  );
}

/** 鼠标停在右上角文件按钮上时弹出的文件列表（只看文件，点一下直接打开） */
export function FilesPeek({ outputs, onOpen }: { outputs: OutputItem[]; onOpen(v: View): void }) {
  return (
    <div className="peek" data-panel>
      <div className="pop-group">文件</div>
      {outputs.length === 0 && <div className="panel-empty">还没有生成文件，点击查看任务进度。</div>}
      {outputs.map((o) => (
        <button key={o.key} className="pop-item" onClick={() => onOpen(o.view)} title={o.name}>
          <span className="out-ico">{ICON[o.icon]}</span>
          <span className="ellipsis">{o.name}</span>
          <span className="pop-dim">{o.ext.toUpperCase()}</span>
        </button>
      ))}
    </div>
  );
}

/** 最近一次任务（最后一条用户消息之后）的每一步：工具调用 + 状态；还在运行且在等模型时，末尾补一个“思考中” */
function lastTaskSteps(messages: StoredMessage[], running: Record<string, number>, streaming: boolean) {
  let from = 0;
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i].role === "user" && !messages[i].feedback) { // 自动检查的反馈不算新任务
      from = i + 1;
      break;
    }
  const turn = messages.slice(from);
  const results = new Map<string, StoredMessage>();
  for (const m of turn) if (m.role === "tool" && m.toolCallId) results.set(m.toolCallId, m);

  const steps: { id: string; state: RowState; verb: string; target: string; ms?: number }[] = [];
  for (const m of turn) {
    if (m.role !== "assistant") continue;
    // 正在生成参数的调用（drafts）也算一步，这样“正在写代码”时链路上就有它
    const calls = m.toolCalls ?? m.drafts?.map((d, i) => ({ id: `${m.id}:${i}`, name: d.name, arguments: d.arguments })) ?? [];
    for (const c of calls) {
      if (!c.name) continue;
      const r = results.get(c.id);
      // 和过程面板用同一套状态：退出码 1 是失败，用户拒绝 / 取消 / 跳过是灰色，不算失败（M1-02）
      const state: RowState = r ? rowState(toolStatus(r)) : streaming || running[c.id] ? "run" : "err";
      steps.push({ id: c.id, state, ms: r?.durationMs, ...describeStep(c.name, c.arguments, state) });
    }
  }
  if (!steps.length) return steps;
  const last = turn[turn.length - 1];
  const waiting = streaming && !steps.some((s) => s.state === "run") && (last?.role === "tool" || last?.durationMs !== undefined);
  if (waiting) steps.push({ id: "thinking", state: "run", verb: "思考下一步", target: "" });
  return steps;
}
