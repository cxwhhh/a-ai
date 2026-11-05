"use client";
import { useEffect, useRef, useState } from "react";
import { AGENT_ICONS } from "@/lib/agentIcons";
import { AgentIcon } from "./Icons";
import "./IconPicker.css";

/**
 * 项目图标选择器：像表情面板一样，点图标弹出图标库的网格，选一个就换。
 * - 顶部搜索框：中文名、英文名都能搜（“代码”“code”）
 * - 底部预览条：鼠标停在哪个图标上，就放大显示它和名字（和表情面板底部一样）
 * - 点外面或按 Esc 关闭
 * 没传 onPick 时只显示图标，不能点。
 */
export function IconPicker(props: { value?: string; fallback?: string; size?: number; onPick?(name: string): void }) {
  const cur = props.value || props.fallback || "folder";
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hover, setHover] = useState<string | null>(null);
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!props.onPick) return <AgentIcon name={cur} width={props.size ?? 15} height={props.size ?? 15} className="ip-static" />;

  const k = q.trim().toLowerCase();
  const list = k ? AGENT_ICONS.filter((i) => i.name.includes(k) || i.label.toLowerCase().includes(k)) : AGENT_ICONS;
  const shown = AGENT_ICONS.find((i) => i.name === (hover ?? cur));

  return (
    <span className="ip" ref={box}>
      <button
        className={`ip-btn ${open ? "on" : ""}`}
        title="更换项目图标"
        onClick={() => {
          setOpen((o) => !o);
          setQ("");
          setHover(null);
        }}
      >
        <AgentIcon name={cur} width={props.size ?? 15} height={props.size ?? 15} />
      </button>
      {open && (
        <div className="ip-pop" role="dialog" aria-label="选择项目图标">
          <input className="ip-search" autoFocus placeholder="搜索图标" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="ip-grid" onMouseLeave={() => setHover(null)}>
            {list.map((i) => (
              <button
                key={i.name}
                className={`ip-cell ${i.name === cur ? "on" : ""}`}
                title={i.label}
                onMouseEnter={() => setHover(i.name)}
                onClick={() => {
                  props.onPick!(i.name);
                  setOpen(false);
                }}
              >
                <AgentIcon name={i.name} width={20} height={20} strokeWidth={1.6} />
              </button>
            ))}
            {!list.length && <div className="ip-empty">没有找到</div>}
          </div>
          <div className="ip-foot">
            {shown && (
              <>
                <span className="ip-big">
                  <AgentIcon name={shown.name} width={22} height={22} strokeWidth={1.6} />
                </span>
                <span className="ip-name">{shown.label}</span>
                <span className="ip-id mono">{shown.name}</span>
              </>
            )}
          </div>
        </div>
      )}
    </span>
  );
}
