"use client";
import { useState } from "react";
import "./AskCard.css";

/**
 * agent 的提问卡片（模型调用了 ask_user）。
 *   问题
 *   [选项 A] [选项 B] [选项 C]      ← 点选（multiple 时可多选）
 *   补充想法（可选）……             ← 选项之外的要求，也可以不选只写
 *                          [发送]
 * 回答拼成一条普通的用户消息发出去：“选项 A\n补充：……”，模型收到后接着做下一步。
 * 已经回答过的（不是最后一轮）只显示问题，不能再点。
 */
export function AskCard(props: {
  question: string;
  options: string[];
  multiple?: boolean;
  /** 只有最后一轮、且 agent 没在运行时才能回答 */
  active: boolean;
  onAnswer(text: string): void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const toggle = (o: string) =>
    setPicked((p) => (p.includes(o) ? p.filter((x) => x !== o) : props.multiple ? [...p, o] : [o]));
  const answer = [picked.join("、"), note.trim() && (picked.length ? `补充：${note.trim()}` : note.trim())].filter(Boolean).join("\n");
  const submit = () => answer && props.onAnswer(answer);

  return (
    <div className={`ask-card ${props.active ? "" : "done"}`}>
      <div className="ask-label">{props.active ? "需要你确认" : "已提问"}</div>
      <div className="ask-q">{props.question}</div>
      {props.active && (
        <>
          {props.options.length > 0 && (
            <div className="ask-opts" role={props.multiple ? "group" : "radiogroup"}>
              {props.options.map((o) => (
                <button
                  key={o}
                  type="button"
                  className={`ask-opt ${picked.includes(o) ? "on" : ""}`}
                  aria-pressed={picked.includes(o)}
                  onClick={() => toggle(o)}
                  // 双击直接发送：只想选一个时不用再点“发送”
                  onDoubleClick={() => props.onAnswer(o)}
                >
                  {o}
                </button>
              ))}
            </div>
          )}
          <div className="ask-foot">
            <textarea
              className="ask-note"
              rows={1}
              value={note}
              placeholder={props.options.length ? "补充想法（可选）" : "输入你的回答"}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <button type="button" className="ask-send" disabled={!answer} onClick={submit}>
              发送
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** 从一轮的消息里找出“以 ask_user 结束”的那次提问 */
export function findAsk(steps: { role: string; toolCalls?: { name: string; arguments: string }[] }[]) {
  const last = [...steps].reverse().find((s) => s.role === "assistant");
  const c = last?.toolCalls?.find((t) => t.name === "ask_user");
  if (!c) return null;
  try {
    const a = JSON.parse(c.arguments || "{}");
    const options = Array.isArray(a.options) ? a.options.map(String).filter(Boolean) : [];
    return a.question ? { question: String(a.question), options, multiple: !!a.multiple } : null;
  } catch {
    return null;
  }
}
