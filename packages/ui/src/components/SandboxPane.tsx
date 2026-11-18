"use client";
import { useEffect, useState } from "react";

/**
 * 设置 → Agent 里的「沙箱与审计」：
 *   上半部分：隔离方式与目录展示部署配置；Docker 联网可由管理账号在这里保存。
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
  const [data, setData] = useState<{ info: Info; audit: Entry[]; canManageNetwork: boolean } | null>(null);
  const [savingNetwork, setSavingNetwork] = useState(false);
  const [networkMessage, setNetworkMessage] = useState("");
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState<"all" | "blocked">("all");
  const [open, setOpen] = useState<number | null>(null);

  const load = () =>
    fetch("/api/sandbox", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  useEffect(() => void load(), []);

  /** 以服务器回执为准更新开关；失败保留原状态，避免界面显示已联网而实际未保存。 */
  const changeNetwork = async (network: boolean) => {
    if (savingNetwork) return;
    setSavingNetwork(true);
    setNetworkMessage("");
    try {
      const response = await fetch("/api/sandbox", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ network }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "保存失败");
      setData((old) => old ? { ...old, info: { ...old.info, network: result.network } } : old);
      setNetworkMessage("已保存，从下一次工具执行生效；正在运行的命令不受影响。");
    } catch (e) {
      setNetworkMessage(e instanceof Error ? e.message : "保存失败，请重试");
    } finally {
      setSavingNetwork(false);
    }
  };

  if (err) return <div className="set-hint">沙箱信息读取失败：{err}</div>;
  if (!data) return null;
  const { info } = data;
  const rows = data.audit.filter((e) => filter === "all" || e.decision !== "allowed");

  return (
    <>
      <section className="set-sec">
        <div className="set-sec-head">
          <h3>沙箱</h3>
          <div className="set-hint">终端命令和 Python 在这里执行。隔离方式与授权目录由服务器配置，Docker 联网可在下面切换。</div>
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
              <div className="set-label">Docker 沙箱联网</div>
              <div className="set-hint">{info.mode === "docker" ? "允许终端命令和 Python 访问网络。对所有会话生效，服务器仍需具备外网连接。" : "此开关仅用于 Docker 沙箱，当前使用其他执行方式。"}</div>
            </div>
            <div className="set-ctl">
              <label>
                <input type="checkbox" role="switch" aria-label="允许 Docker 沙箱联网"
                  checked={info.network} disabled={savingNetwork || !data.canManageNetwork || info.mode !== "docker"}
                  onChange={(e) => void changeNetwork(e.target.checked)} />
                {savingNetwork ? " 保存中…" : info.network ? " 已开启" : " 已关闭"}
              </label>
            </div>
          </div>
          {!data.canManageNetwork && <div className="set-hint">请使用最早注册的管理账号修改全局联网设置。</div>}
          {networkMessage && <div className="set-hint" role="status">{networkMessage}</div>}
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
