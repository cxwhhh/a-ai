"use client";
import { useEffect, useState } from "react";

/**
 * 设置 → 模型 里的「沙箱与审计」：
 *   上半部分：命令在哪里执行（docker / seatbelt / 本机）、能访问哪些本机目录、能不能联网 —— 只读展示，改要改服务端环境变量
 *   下半部分：审计日志，agent 执行过或被拦下的每一条命令（最近 200 条）
 * 数据来自 /api/sandbox。类型在这里单独写一份：服务端的 sandbox.ts / audit.ts 是 server-only，前端不能引用。
 */
type Info = { mode: "docker" | "seatbelt" | "local"; isolated: boolean; network: boolean; dirs: { path: string; mode: "ro" | "rw" }[]; warnings: string[] };
type Entry = {
  id: number;
  tool: string;
  command: string;
  cwd: string;
  sandbox: string;
  decision: "allowed" | "denied" | "blocked";
  reason: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  createdAt: number;
};

const MODE: Record<Info["mode"], string> = {
  docker: "Docker 容器（每个对话一个，用完回收）",
  seatbelt: "macOS 系统沙箱（sandbox-exec）",
  local: "本机，未隔离",
};
const DECISION: Record<Entry["decision"], string> = { allowed: "已执行", denied: "用户拒绝", blocked: "已拦截" };

export function SandboxPane() {
  const [data, setData] = useState<{ info: Info; audit: Entry[] } | null>(null);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState<"all" | "blocked">("all");
  const [open, setOpen] = useState<number | null>(null);

  const load = () =>
    fetch("/api/sandbox", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  useEffect(() => void load(), []);

  if (err) return <div className="set-hint">沙箱信息读取失败：{err}</div>;
  if (!data) return null;
  const { info } = data;
  const rows = data.audit.filter((e) => filter === "all" || e.decision !== "allowed");

  return (
    <>
      <section className="set-sec">
        <div className="set-sec-head">
          <h3>沙箱</h3>
          <div className="set-hint">终端命令和 Python 在这里执行。修改方式：服务端环境变量 A_SANDBOX、A_SANDBOX_DIRS、A_SANDBOX_NETWORK（见 .env.example）</div>
        </div>
        <div className="set-group">
          <div className="set-row">
            <div>
              <div className="set-label">隔离方式</div>
              <div className="set-hint">{info.isolated ? "命令只能读写工作区和下面的授权目录" : "命令能访问整台机器，只有路径检查和确认在起作用"}</div>
            </div>
            <div className={`sbx-badge ${info.isolated ? "ok" : "warn"}`}>{MODE[info.mode]}</div>
          </div>
          <div className="set-row">
            <div>
              <div className="set-label">网络</div>
              <div className="set-hint">{info.network ? "沙箱里可以联网（pip install 可用）" : "默认断网：数据不会被命令发到外面"}</div>
            </div>
            <div className="set-ctl sbx-dim">{info.network ? "允许" : "断开"}</div>
          </div>
          <div className="set-row sbx-dirs">
            <div>
              <div className="set-label">授权的本机目录</div>
              <div className="set-hint">除了工作区，agent 只能访问这些目录；里面的 .ssh、.env、私钥等也会被屏蔽</div>
            </div>
            <div className="sbx-dir-list">
              {info.dirs.length ? (
                info.dirs.map((d) => (
                  <div key={d.path} className="sbx-dir">
                    <span className="mono">{d.path}</span>
                    <span className={`sbx-tag ${d.mode}`}>{d.mode === "ro" ? "只读" : "读写"}</span>
                  </div>
                ))
              ) : (
                <span className="sbx-dim">未配置（只能访问工作区）</span>
              )}
            </div>
          </div>
          {info.warnings.map((w) => (
            <div key={w} className="sbx-warn">
              {w}
            </div>
          ))}
        </div>
      </section>

      <section className="set-sec">
        <div className="set-sec-head">
          <h3>审计日志</h3>
          <div className="set-hint">agent 执行过、被拒绝或被拦截的每一条命令（最近 200 条）。删除对话不会删除这里的记录</div>
        </div>
        <div className="sbx-bar">
          <div className="seg text">
            <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>
              全部
            </button>
            <button className={filter === "blocked" ? "on" : ""} onClick={() => setFilter("blocked")}>
              拒绝 / 拦截
            </button>
          </div>
          <button className="sbx-refresh" onClick={() => void load()}>
            刷新
          </button>
        </div>
        <div className="sbx-log">
          {rows.length === 0 && <div className="sbx-dim sbx-empty">还没有记录</div>}
          {rows.map((e) => (
            <div key={e.id} className={`sbx-item ${e.decision} ${open === e.id ? "open" : ""}`} onClick={() => setOpen(open === e.id ? null : e.id)}>
              <div className="sbx-line">
                <span className="sbx-time">{new Date(e.createdAt).toLocaleString()}</span>
                <span className={`sbx-dec ${e.decision}`}>{DECISION[e.decision]}</span>
                <code className="sbx-cmd">{e.tool === "run_python" ? "python " : "$ "}{e.command.split("\n")[0]}</code>
                <span className="sbx-dim">
                  {e.decision === "allowed" ? (e.timedOut ? "超时" : `退出码 ${e.exitCode ?? "-"}`) : ""}
                </span>
              </div>
              {open === e.id && (
                <div className="sbx-detail">
                  <pre className="sbx-pre">{e.command}</pre>
                  <div className="sbx-dim">
                    目录 {e.cwd} · {e.sandbox} · {e.durationMs}ms{e.reason ? ` · ${e.reason}` : ""}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
