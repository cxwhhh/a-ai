"use client";
import { Questionnaire } from "@shadcn/react/questionnaire";
import { useState } from "react";
import "./AskCard.css";

/**
 * agent 的提问卡片（模型调用了 ask_user）。
 *   问题
 * Questionnaire 提供单题表单和原生单选、多选控件。补充想法独立填写，允许与选项一起发送。
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
  const options = [...new Set(props.options)];
  const noteLabel = options.length ? "补充想法（可选）" : "输入你的回答";
  const setChoice = (option: string, checked: boolean) => {
    setPicked((previous) => {
      if (!checked) return previous.filter((value) => value !== option);
      return props.multiple ? [...previous, option] : [option];
    });
  };
  const answer = [picked.join("、"), note.trim() && (picked.length ? `补充：${note.trim()}` : note.trim())].filter(Boolean).join("\n");
  const submit = () => {
    if (answer) props.onAnswer(answer);
  };

  return (
    <div className={`ask-card ${props.active ? "" : "done"}`}>
      <div className="ask-label">{props.active ? "需要你确认" : "已提问"}</div>
      {props.active ? (
        <Questionnaire.Root
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Questionnaire.Item name="answer" multiple={props.multiple} className="ask-question">
            <Questionnaire.Title className="ask-q">{props.question}</Questionnaire.Title>
            {options.length > 0 && (
              <Questionnaire.Choices className="ask-opts">
                {options.map((option) => (
                  <Questionnaire.Choice
                    key={option}
                    className="ask-opt"
                    value={option}
                    checked={picked.includes(option)}
                    onChange={(e) => setChoice(option, e.currentTarget.checked)}
                    // 沿用原有双击快捷发送，直接提交这一个选项。
                    onDoubleClick={() => props.onAnswer(option)}
                  >
                    <Questionnaire.ChoiceInput
                      className="ask-choice-input"
                      onClick={(e) => {
                        // 用户再次点当前单选项时可以清空选项，改成只写文字。
                        if (e.detail > 0 && !props.multiple && picked.includes(option)) setPicked([]);
                      }}
                    />
                    <Questionnaire.ChoiceLabel>{option}</Questionnaire.ChoiceLabel>
                  </Questionnaire.Choice>
                ))}
              </Questionnaire.Choices>
            )}
            <div className="ask-foot">
              <textarea
                className="ask-note"
                rows={1}
                value={note}
                aria-label={noteLabel}
                placeholder={noteLabel}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                    e.preventDefault();
                    if (!e.repeat) submit();
                  }
                }}
              />
              {/* 自由文字是独立补充字段，空选项时也按 A.ai 的规则提交。 */}
              <Questionnaire.Submit type="button" className="ask-send" disabled={!answer} onClick={submit}>
                发送
              </Questionnaire.Submit>
            </div>
          </Questionnaire.Item>
        </Questionnaire.Root>
      ) : (
        <div className="ask-q">{props.question}</div>
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
