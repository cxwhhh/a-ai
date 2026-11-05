"use client";
import { useState } from "react";
import { CoreLogo } from "./CoreLogo";
import "./LoginForm.css";

/**
 * 登录 / 注册页：居中一张简洁的卡片，卡片上方是会散开再聚拢的粒子球（点它回介绍页）。
 * 背景有很轻的动效：漂移的点阵、两团缓慢移动的淡光、颗粒噪点。
 * 样式全部在 LoginForm.css，不动 globals.css。
 */
export function LoginForm() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [shake, setShake] = useState(0); // 每次出错 +1，用作 key 让抖动动画重播
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (r.ok) return location.replace("/A.ai/chat");
      setError(((await r.json().catch(() => ({}))) as { error?: string }).error || `请求失败 ${r.status}`);
    } catch {
      setError("网络错误，请重试");
    }
    setShake((n) => n + 1);
    setBusy(false);
  };

  const reg = mode === "register";
  const switchTo = (m: "login" | "register") => {
    setMode(m);
    setError("");
  };

  return (
    <div className="auth">
      {/* 背景小特效：缓慢漂移的点阵 + 两团很淡的光 + 颗粒噪点（样式见 LoginForm.css） */}
      <div className="auth-bg" aria-hidden>
        <i className="auth-glow a" />
        <i className="auth-glow b" />
      </div>

      <div className="auth-col">
        <a className="auth-orb" href="/A.ai" title="返回介绍页">
          <CoreLogo variant="particles" size={128} follow wild />
        </a>

        <form className="auth-card" onSubmit={submit}>
          <div className="auth-head" key={mode}>
            <h1>{reg ? "创建账号" : "登录 A.ai"}</h1>
            <p>{reg ? "只需要用户名和密码" : "继续你的对话和文件"}</p>
          </div>
          <label className="auth-field">
            <span>用户名</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required spellCheck={false} />
          </label>
          <label className="auth-field">
            <span>
              密码{reg && <em>至少 8 位</em>}
            </span>
            <div className="auth-pw">
              <input
                type={show ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={reg ? "new-password" : "current-password"}
                required
              />
              <button type="button" className="auth-eye" onClick={() => setShow((v) => !v)} aria-label={show ? "隐藏密码" : "显示密码"}>
                <Eye off={show} />
              </button>
            </div>
          </label>
          {error && (
            <div className="auth-error" key={shake}>
              {error}
            </div>
          )}
          <button className="login-submit" disabled={busy || !username || !password}>
            {busy ? <i className="auth-spin" /> : reg ? "注册并登录" : "登录"}
          </button>
          <button type="button" className="auth-switch" onClick={() => switchTo(reg ? "login" : "register")}>
            {reg ? "已有账号？去登录" : "没有账号？注册一个"}
          </button>
        </form>
      </div>
    </div>
  );
}

function Eye({ off }: { off: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="2" />
      {off && <path d="M2.5 13.5l11-11" />}
    </svg>
  );
}
