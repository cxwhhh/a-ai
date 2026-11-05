"use client";
import { useState } from "react";
import { api } from "@/lib/client";
import { useApprovals } from "@/lib/live";
import "./ApprovalDock.css";

/**
 * 命令确认弹窗：固定在输入框正上方（以前放在思维链里，过程收起时就看不到）。
 *   需要你确认                        还有 1 条
 *   原因
 *   $ 命令原文
 *   [1  允许          ]
 *   [2  本会话都允许  ]               ← 一行一个按钮
 *   [3  拒绝          ]
 * 同时有几条在等（模型并行调用了多个命令）时，一次只显示最早的一条，答完自动换下一条。
 * 点完按钮不马上消失，等服务端发来 approval_end 再收起，这样“已经被处理”才是真的。
 */
export function ApprovalDock() {
  const approvals = useApprovals();
  const ids = Object.keys(approvals);
  if (!ids.length) return null;
  const id = ids[0];
  // key=id：换到下一条时组件重建，busy/err 状态不会带过去
  return <ApprovalCard key={id} callId={id} {...approvals[id]} more={ids.length - 1} />;
}

const CHOICES = [
  { d: "allow", label: "允许" },
  { d: "allow_session", label: "本会话都允许", hint: "这次对话里后面的命令不再询问" },
  { d: "deny", label: "拒绝" },
] as const;

function ApprovalCard({ callId, command, reason, more }: { callId: string; command: string; reason: string; more: number }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const answer = async (d: (typeof CHOICES)[number]["d"]) => {
    setBusy(true);
    setErr("");
    try {
      await api.approve(callId, d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <div className="apd" role="alertdialog" aria-label="需要你确认">
      <div className="apd-head">
        <span>需要你确认</span>
        {more > 0 && <span className="apd-more">还有 {more} 条</span>}
      </div>
      {reason && <div className="apd-reason">{reason}</div>}
      <pre className="apd-cmd">{/^删除 /.test(command) ? command : `$ ${command}`}</pre>
      <div className="apd-actions">
        {CHOICES.map((c, i) => (
          <button key={c.d} className={`apd-btn ${c.d === "allow" ? "primary" : ""}`} disabled={busy} onClick={() => answer(c.d)}>
            <span className="apd-num">{i + 1}</span>
            <span>{c.label}</span>
            {"hint" in c && <span className="apd-hint">{c.hint}</span>}
          </button>
        ))}
      </div>
      {err && <div className="tr-err">{err}</div>}
    </div>
  );
}
