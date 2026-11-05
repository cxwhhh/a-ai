"use client";
import { useState } from "react";
import type { Project, ProjectChat } from "@/lib/shared";
import { IconPicker } from "./IconPicker";
import { IFile, IGear, ISearch } from "./Icons";
import "./ProjectHome.css";

/**
 * 项目页（2026-10-29）：点左栏项目名进来。复用新对话的输入框（ChatPane 空状态），只换掉上下两块：
 *   上面 ProjectHead：项目图标（可换）+ 名字 + 说明 + 记忆方式 / 互通标签 + 项目设置
 *   下面 ProjectChats：这个项目的全部对话，最近的在前，可以搜索
 * 发出第一条消息后就是一个普通的项目对话，这两块自然消失。
 */
export function ProjectHead(props: { project: Project; onIcon(name: string): void; onSettings(): void }) {
  const p = props.project;
  const mem = { global: "使用全局记忆", project: "项目独立记忆", off: "不使用记忆" }[p.memory];
  return (
    <div className="ph">
      <div className="ph-top">
        <span className="ph-ico">
          <IconPicker value={p.icon} size={22} onPick={props.onIcon} />
        </span>
        <div className="ph-txt">
          <h1 className="ellipsis">{p.name}</h1>
          {p.description && <p>{p.description}</p>}
        </div>
        <button className="btn ph-set" onClick={props.onSettings}>
          <IGear width={14} height={14} />
          项目设置
        </button>
      </div>
      <div className="ph-chips">
        <span>{mem}</span>
        {p.share && <span>对话互相可见</span>}
      </div>
    </div>
  );
}

export function ProjectChats(props: { chats: ProjectChat[] | null; onOpen(id: string): void }) {
  const [q, setQ] = useState("");
  const k = q.trim().toLowerCase();
  const list = (props.chats ?? []).filter((c) => !k || c.title.toLowerCase().includes(k) || c.preview.toLowerCase().includes(k));
  return (
    <section className="pc">
      <div className="pc-head">
        <h2>对话</h2>
        <span className="pc-n">{props.chats ? `${props.chats.length} 个` : ""}</span>
        <label className="pc-search">
          <ISearch width={13} height={13} />
          <input id="project-chat-search" placeholder="搜索本项目对话" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      {props.chats === null ? (
        <div className="pc-empty">读取中…</div>
      ) : !list.length ? (
        <div className="pc-empty">{k ? "没有找到相关对话" : "还没有对话。在上面输入，第一条对话就会放进这个项目。"}</div>
      ) : (
        <div className="pc-list">
          {list.map((c) => (
            <button key={c.id} className="pc-row" onClick={() => props.onOpen(c.id)}>
              <span className="pc-title ellipsis">{c.title}</span>
              <span className="pc-pre ellipsis">{c.preview || "（还没有回复）"}</span>
              <span className="pc-meta">
                {c.files > 0 && (
                  <span className="pc-files" title={`生成了 ${c.files} 个文件`}>
                    <IFile width={13} height={13} />
                    {c.files}
                  </span>
                )}
                {ago(c.updatedAt)}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function ago(ts: number) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return new Date(ts).toLocaleDateString();
}
