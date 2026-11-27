"use client";
import { useState } from "react";
import { AuthCard, AuthMediaCarousel } from "./base/auth/auth-card";
import { LinkButton } from "./base/buttons/link-button";
import { CoreLogo } from "./CoreLogo";
import "./LoginForm.css";

const slides = [
  { src: new URL("./base/auth/media/shark-collage.webp", import.meta.url).href },
  { src: new URL("./base/auth/media/floral.webp", import.meta.url).href },
  { src: new URL("./base/auth/media/space-squid.webp", import.meta.url).href },
  { src: new URL("./base/auth/media/sunrise.webp", import.meta.url).href },
];

/** BoardUI 负责表单和媒体布局，A.ai 的原有接口负责登录、注册及会话。 */
export function LoginForm() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const registering = mode === "register";

  const submit = async (data: FormData) => {
    const password = String(data.get("password") ?? "");
    if (registering && password !== data.get("confirmPassword")) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: data.get("username"), password }),
      });
      if (res.ok) {
        location.replace("/A.ai/chat");
        return;
      }
      const body = await res.json().catch(() => ({})) as { error?: string };
      setError(body.error || `请求失败（${res.status}）`);
    } catch {
      setError("网络错误，请重试");
    }
    setBusy(false);
  };

  return (
    <main className="aai-auth">
      <AuthCard
        mode={registering ? "signup" : "signin"}
        className="aai-auth-card"
        identifier="username"
        username={username}
        onUsernameChange={setUsername}
        centered
        logo={registering ? undefined : <CoreLogo size={72} morph={false} />}
        confirmPassword
        providers={[]}
        media={<AuthMediaCarousel slides={slides} />}
        footnote={<LinkButton href="/A.ai" size="xs" variant="secondary">返回 A.ai 介绍页</LinkButton>}
        submitting={busy}
        error={error}
        onSubmit={submit}
        onSwitch={() => {
          setMode(registering ? "login" : "register");
          setError("");
        }}
      />
    </main>
  );
}
