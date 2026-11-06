"use client";
import { useEffect, useRef, useState } from "react";
import { IChart, IGear, IInfo, IKeyboard, ILogout, IUpDown } from "./Icons";
import { api } from "@/lib/client";

export type SettingsTab = "general" | "model" | "agent" | "memory" | "skills" | "usage" | "keys" | "about";

/**
 * 左下角：头像 + 名字。点击弹出菜单（仿 Claude），再从菜单进入设置的各个页面。
 * 点菜单外任意位置或按 Esc 关闭。
 */
export function UserMenu(props: { name: string; model: string; modKey: string; onOpenSettings(tab: SettingsTab): void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const go = (tab: SettingsTab) => {
    setOpen(false);
    props.onOpenSettings(tab);
  };

  return (
    <div className="account" ref={ref}>
      {open && (
        <div className="user-pop" role="menu">
          <div className="user-pop-head">
            <Avatar name={props.name} size={32} />
            <div className="user-pop-id">
              <div className="ellipsis">{props.name}</div>
            </div>
          </div>
          <div className="user-pop-sep" />
          <button className="user-pop-item" role="menuitem" onClick={() => go("general")}>
            <IGear />
            <span>设置</span>
            <kbd>{props.modKey},</kbd>
          </button>
          <button className="user-pop-item" role="menuitem" onClick={() => go("usage")}>
            <IChart />
            <span>用量</span>
          </button>
          <button className="user-pop-item" role="menuitem" onClick={() => go("keys")}>
            <IKeyboard />
            <span>快捷键</span>
          </button>
          <div className="user-pop-sep" />
          <button className="user-pop-item" role="menuitem" onClick={() => go("about")}>
            <IInfo />
            <span>关于 A.ai</span>
          </button>
          <button className="user-pop-item" role="menuitem" onClick={() => api.logout()}>
            <ILogout />
            <span>退出登录</span>
          </button>
        </div>
      )}

      <button className={`user-btn ${open ? "on" : ""}`} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        <Avatar name={props.name} size={28} />
        <span className="user-id ellipsis">{props.name}</span>
        <IUpDown className="user-caret" width={14} height={14} />
      </button>
    </div>
  );
}

/** 头像：取名字第一个字符，细线圆圈 + 灰字，不填充 */
export function Avatar({ name, size }: { name: string; size: number }) {
  const ch = Array.from(name.trim())[0]?.toUpperCase() ?? "?";
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}>
      {ch}
    </span>
  );
}
