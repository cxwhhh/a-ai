"use client";
import { useEffect, useState } from "react";
import type { Project, ProjectMemoryMode } from "@/lib/shared";
import { IX } from "./Icons";
import "./ProjectModal.css";

const MEMORY: { v: ProjectMemoryMode; label: string; hint: string }[] = [
  { v: "global", label: "全局记忆", hint: "和平时的对话共用一份记忆：A.ai 记得你的习惯，这个项目里学到的也会记进去。" },
  { v: "project", label: "项目独立", hint: "这个项目单独一份记忆，只在项目里用，不和其他项目、平时的对话混在一起。" },
  { v: "off", label: "不用记忆", hint: "项目里的对话既不读取记忆，也不往记忆里写东西。" },
];

/**
 * 新建项目 / 修改项目设置的弹窗。
 * 外观沿用设置窗口的写法（.modal-mask 遮罩、set-input 输入框、seg 分段按钮、switch 开关），只是窄一些。
 * project 不传 = 新建；传了 = 修改这个项目。
 */
export function ProjectModal(props: { project?: Project; onSave(p: Omit<Project, "id" | "createdAt">): Promise<void>; onClose(): void }) {
  const p = props.project;
  const [name, setName] = useState(p?.name ?? "");
  const [description, setDescription] = useState(p?.description ?? "");
  const [memory, setMemory] = useState<ProjectMemoryMode>(p?.memory ?? "global");
  const [share, setShare] = useState(p?.share ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [props]);

  async function submit() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setErr("");
    try {
      await props.onSave({ name: name.trim(), description: description.trim(), memory, share });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <form
        className="pm"
        role="dialog"
        aria-label={p ? "项目设置" : "新建项目"}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <header className="pm-head">
          <h2>{p ? "项目设置" : "新建项目"}</h2>
          <button type="button" className="icon-btn" onClick={props.onClose} title="关闭 Esc">
            <IX width={14} height={14} />
          </button>
        </header>

        <label className="pm-field">
          <span className="set-label">项目名字</span>
          <input className="set-input" autoFocus value={name} maxLength={40} placeholder="例如：求职准备、A.ai 开发" onChange={(e) => setName(e.target.value)} />
        </label>

        <label className="pm-field">
          <span className="set-label">
            项目说明 <span className="pm-opt">可选</span>
          </span>
          <textarea
            className="set-input area"
            rows={3}
            value={description}
            maxLength={4000}
            placeholder="这个项目是做什么的、有什么要求。项目里的每次对话都会先读这段话。"
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <div className="pm-field">
          <span className="set-label">记忆</span>
          <div className="seg text pm-seg" role="radiogroup">
            {MEMORY.map((m) => (
              <button type="button" key={m.v} role="radio" aria-checked={memory === m.v} className={memory === m.v ? "on" : ""} onClick={() => setMemory(m.v)}>
                {m.label}
              </button>
            ))}
          </div>
          <div className="set-hint">{MEMORY.find((m) => m.v === memory)!.hint}</div>
        </div>

        <div className="pm-field pm-row">
          <div>
            <div className="set-label">对话之间共享内容</div>
            <div className="set-hint">
              {share
                ? "打开：在项目里新开对话时，A.ai 会先看到这个项目其他对话做了什么、结论是什么，不用你再说一遍。"
                : "关闭：项目里的每个对话互相独立，只共用项目说明和记忆设置。"}
            </div>
          </div>
          <button type="button" className={`switch ${share ? "on" : ""}`} role="switch" aria-checked={share} onClick={() => setShare(!share)}>
            <span />
          </button>
        </div>

        {err && <div className="pm-err">{err}</div>}
        <footer className="pm-foot">
          <button type="button" className="btn ghost" onClick={props.onClose}>
            取消
          </button>
          <button type="submit" className="btn primary" disabled={!name.trim() || busy}>
            {p ? "保存" : "创建项目"}
          </button>
        </footer>
      </form>
    </div>
  );
}
