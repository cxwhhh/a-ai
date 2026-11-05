"use client";
import { useEffect, useRef, useState } from "react";
import { ICheck, ICopy, IPencil, IRetry } from "./Icons";

/**
 * 消息下方的一排小按钮（鼠标移到这条消息上才出现；最后一轮一直显示）：
 *   - 用户消息：复制、编辑（编辑后重发）
 *   - 回答：复制、重新生成
 * 只负责按钮本身；真正的“截断后重发”在 Workspace.resend 里做
 */
export function MessageActions({ text, onEdit, onRetry, disabled, always }: {
  text: string;
  onEdit?(): void;
  onRetry?(): void;
  /** agent 运行中：编辑和重新生成先禁用（复制不受影响） */
  disabled?: boolean;
  /** 最后一轮的回答：按钮一直显示，不用先移上去 */
  always?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = Object.assign(document.createElement("textarea"), { value: text });
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className={`msg-actions ${always ? "always" : ""}`}>
      <button className="icon-btn" onClick={copy} title={copied ? "已复制" : "复制"} aria-label="复制">
        {copied ? <ICheck width={14} height={14} /> : <ICopy width={14} height={14} />}
      </button>
      {onEdit && (
        <button className="icon-btn" onClick={onEdit} disabled={disabled} title="编辑后重发" aria-label="编辑">
          <IPencil width={14} height={14} />
        </button>
      )}
      {onRetry && (
        <button className="icon-btn" onClick={onRetry} disabled={disabled} title="重新生成" aria-label="重新生成">
          <IRetry width={14} height={14} />
        </button>
      )}
    </div>
  );
}

/**
 * 编辑用户消息：气泡变成输入框，Enter 发送、Shift+Enter 换行、Esc 取消。
 * 发送后，这条消息之后的内容会被丢掉，从这里重新开始
 */
export function EditBubble({ initial, onCancel, onSubmit }: { initial: string; onCancel(): void; onSubmit(text: string): void }) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  // 高度跟着内容走（最多 240px，再多就滚动）
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }, [text]);
  const send = () => text.trim() && text.trim() !== initial.trim() ? onSubmit(text) : onCancel();
  return (
    <div className="edit-bubble">
      <textarea
        ref={ref}
        value={text}
        rows={1}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="edit-foot">
        <span>发送后会从这里重新开始，后面的回答不再保留</span>
        <button className="edit-cancel" onClick={onCancel}>取消</button>
        <button className="edit-send" onClick={send} disabled={!text.trim()}>发送</button>
      </div>
    </div>
  );
}
