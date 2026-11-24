"use client";

import { useEffect, useState } from "react";
import { ICheck, IDownload, IInfo, IRetry } from "./Icons";
import { cx } from "../utils/cx";

type UpdateAction = "check" | "download" | "install";
type UpdateState = { currentVersion: string } & (
  | { phase: "idle" | "checking" | "current" }
  | { phase: "available" | "ready" | "installing"; version: string }
  | { phase: "downloading"; version: string; progress: number }
  | { phase: "unavailable"; message: string }
  | { phase: "error"; message: string; action: UpdateAction; version?: string }
);

interface UpdateBridge {
  state(): Promise<UpdateState>;
  check(): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  install(): Promise<UpdateState>;
  subscribe(onChange: (state: UpdateState) => void): () => void;
}

declare global {
  interface Window { aaiUpdates?: UpdateBridge }
}

function buttonFor(state: Exclude<UpdateState, { phase: "unavailable" }>) {
  switch (state.phase) {
    case "idle": return { icon: IRetry, label: "检查更新", action: "check" } as const;
    case "checking": return { icon: IRetry, label: "正在检查更新", text: "检查中" } as const;
    case "current": return { icon: ICheck, label: `已是最新版本 ${state.currentVersion}，点击检查更新`, action: "check" } as const;
    case "available": return { icon: IDownload, label: `下载更新 ${state.version}`, text: "下载", action: "download", tone: "available" } as const;
    case "downloading": return { icon: IDownload, label: `正在下载更新 ${state.version}，${state.progress}%`, text: `${state.progress}%` } as const;
    case "ready": return { icon: IRetry, label: `安装并重启 ${state.version}`, text: "安装", action: "install", tone: "available" } as const;
    case "installing": return { icon: IRetry, label: "正在安装更新", text: "安装中" } as const;
    case "error": return { icon: IInfo, label: state.message, text: "重试", action: state.action, tone: "error" } as const;
  }
}

/** 网页模式没有桌面桥接。桌面模式显示主进程状态，刷新或收起侧栏不会影响下载。 */
export function DesktopUpdateButton({ onAction }: { onAction(): void }) {
  const bridge = typeof window === "undefined" ? undefined : window.aaiUpdates;
  const [state, setState] = useState<UpdateState>();

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    let receivedChange = false;
    const unsubscribe = bridge.subscribe((value) => {
      receivedChange = true;
      if (active) setState(value);
    });
    void bridge.state().then((value) => {
      // 先订阅，避免状态快照比刚收到的下载进度更旧。
      if (active && !receivedChange) setState(value);
    }).catch(() => { /* 当前窗口不具备更新权限。 */ });
    return () => { active = false; unsubscribe(); };
  }, [bridge]);

  if (!bridge || !state || state.phase === "unavailable") return null;
  const button = buttonFor(state);
  const action = "action" in button ? button.action : undefined;
  const Icon = button.icon;
  return (
    <button
      className={cx("icon-btn account-update", "tone" in button && button.tone)}
      type="button"
      title={button.label}
      aria-label={button.label}
      disabled={!action}
      onClick={() => {
        if (!action) return;
        onAction();
        void bridge[action]().catch(() => {
          setState({ phase: "error", action, message: "客户端更新连接中断，请重试。", currentVersion: state.currentVersion });
        });
      }}
    >
      <Icon width={14} height={14} />
      {"text" in button && <span>{button.text}</span>}
    </button>
  );
}
