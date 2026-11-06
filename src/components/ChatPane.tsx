"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Artifact, StoredMessage } from "@/lib/shared";
import { PLAN_MARK } from "@/lib/agent/steer";
import { Markdown } from "./Markdown";
import { resolveFileName } from "@/lib/file-chips";
import { Trace } from "./Trace";
import { AskCard, findAsk } from "./AskCard";
import { ApprovalDock } from "./ApprovalDock";
import { Loader3D } from "./Loader3D";
import { IconPicker } from "./IconPicker";
import { DotSpinner } from "./DotSpinner";
import { CoreLogo } from "./CoreLogo";
import { IArrowUp, IClip, IFile, IImage, IPanelLeft, ILayers, IStop, IX } from "./Icons";
import { ACCEPT, isImage, joinAttachments, splitAttachments } from "@/lib/attachments";
import type { PendingAttachment } from "@/lib/attachments";
import { NameInput } from "./Sidebar";
import "./ChatPane.css";
import { FilesPeek } from "./OutputsCard";
import { EditBubble, MessageActions } from "./MessageActions";
import type { OutputItem, View } from "@/lib/outputs";
import type { ReactNode } from "react";

interface Turn {
  user?: StoredMessage;
  steps: StoredMessage[]; // assistant + tool + 自动反馈（feedback）
}

/** 把扁平的消息列表切成“轮”：一条用户消息 + 之后 agent 的所有步骤 */
function toTurns(messages: StoredMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.role === "user" && !m.feedback) turns.push({ user: m, steps: [] });
    else {
      if (!turns.length) turns.push({ steps: [] });
      turns[turns.length - 1].steps.push(m);
    }
  }
  return turns;
}

export function ChatPane(props: {
  title?: string;
  /** 当前对话所在项目的名字（不在项目里时为空） */
  projectName?: string;
  /** 项目图标（图标库里的名字）和换图标的回调：点项目名左边的图标弹出图标面板 */
  projectIcon?: string;
  onProjectIcon?(name: string): void;
  /** 项目页：新对话的空状态换成项目头（head），输入框下面接这个项目的对话列表（chats）。见 ProjectHome.tsx */
  home?: { head: ReactNode; chats: ReactNode };
  /** 点标题改名；新对话还没保存时为空 */
  onRename?(title: string): void;
  messages: StoredMessage[];
  artifacts: Artifact[];
  outputs: OutputItem[];
  onOpenView(v: View): void;
  /** 对话里有工具调用（有“进度”可看） */
  hasSteps: boolean;
  running: Record<string, number>;
  streaming: boolean;
  error: string | null;
  draft: string;
  setDraft(v: string): void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  leftOpen: boolean;
  rightOpen: boolean;
  viewOpen: boolean;
  sendKey: "enter" | "mod-enter";
  /** 输入框下方那一行（模型切换 + 上下文环形图），由 Workspace 传入 */
  bar: ReactNode;
  modKey: string;
  onSend(): void;
  /** 输入框里待发送的附件（选完就开始上传） */
  attachments: PendingAttachment[];
  onAttach(files: File[]): void;
  onRemoveAttachment(key: string): void;
  /** 回答 agent 的提问（AskCard），直接把回答当作一条消息发出去 */
  onAnswer(text: string): void;
  /** 重新生成 / 编辑后重发：从 id 这条用户消息开始截断，再用 text 重新发 */
  onResend(id: string, text: string): void;
  /** 当前对话 id：切换对话时用它让内容重新淡入 */
  sessionId: string;
  /** 正在加载另一个对话 */
  loading?: boolean;
  onStop(): void;
  onOpenArtifact(id: string): void;
  onOpenFile(path: string): void;
  onToggleLeft(): void;
  onToggleRight(): void;
  /** 新对话欢迎语里显示的名字 */
  userName: string;
  onDismissError(): void;
}) {
  const { messages, streaming, draft, inputRef, modKey, home } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const turns = useMemo(() => toTurns(messages), [messages]);
  // 回答里点文件名 → 右侧打开。用 ref 拿最新的消息和产出物，函数本身保持不变，Markdown 的 memo 才有效
  const latest = useRef(props);
  latest.current = props;
  const openName = useCallback((name: string) => {
    const { messages, artifacts, onOpenArtifact, onOpenFile } = latest.current;
    const v = resolveFileName(name, messages, artifacts);
    if (v.type === "artifact") onOpenArtifact(v.id);
    else onOpenFile(v.path);
  }, []);
  /** 是否停在底部：不在底部时显示“回到底部”按钮 */
  const [atBottom, setAtBottom] = useState(true);
  const [renaming, setRenaming] = useState(false);
  /** 正在编辑的用户消息 id（气泡变成输入框） */
  const [editing, setEditing] = useState<string | null>(null);
  // 文件列表的悬停弹层：移入 150ms 后出现，移出 180ms 后消失（中间移到弹层上不会断）
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const showPeek = () => {
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeek(true), 150);
  };
  const hidePeek = () => {
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeek(false), 180);
  };

  // 只在“发出新消息”或“打开另一个对话”时滚到底部一次；
  // 模型输出过程中页面固定不动，想看最新内容就自己往下滑，或点“回到底部”
  const userCount = messages.filter((m) => m.role === "user" && !m.feedback).length;
  const firstId = messages[0]?.id;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [userCount, firstId]);
  // 内容变高（模型在输出、展开了过程）时也重新判断是否在底部，决定要不要显示“回到底部”
  useEffect(() => {
    const el = scroller.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    const check = () => setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    const ro = new ResizeObserver(check);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [turns.length === 0]);
  const toBottom = () => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });

  // 输入框自适应高度。新对话页和对话中的输入框最小高度不同，所以从新对话切到对话中（或反过来）时也要重新算，
  // 否则会留着新对话页那个较高的内联高度
  const isEmpty = turns.length === 0;
  useLayoutEffect(() => {
    const t = inputRef.current;
    if (!t) return;
    t.style.height = "0px";
    t.style.height = Math.min(t.scrollHeight, 220) + "px";
  }, [draft, inputRef, isEmpty]);

  const empty = turns.length === 0;
  const greeting = useGreeting();

  // 附件：上传中不能发（路径还没拿到）；只有附件没写字也可以发
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const uploading = props.attachments.some((a) => !a.path && !a.error);
  const ready = props.attachments.some((a) => a.path);
  const canSend = !uploading && (!!draft.trim() || ready);

  return (
    <main className={`chat ${empty ? "is-empty" : ""} ${empty && home ? "is-proj" : ""} ${props.loading ? "loading" : ""}`}>
      {props.loading && <div className="chat-loading" aria-hidden />}
      <header className="chat-head">
        {!props.leftOpen && (
          <button className="icon-btn" onClick={props.onToggleLeft} title={`展开左栏 ${modKey}B`}>
            <IPanelLeft />
          </button>
        )}
        {/* 在项目里的对话：标题前面显示“[图标] 项目名 /”，点图标可以换（IconPicker） */}
        {props.projectName && (
          <span className="head-proj">
            <IconPicker value={props.projectIcon} onPick={props.onProjectIcon} />
            <span className="ellipsis">{props.projectName}</span>
            <i>/</i>
          </span>
        )}
        {renaming && props.onRename ? (
          <NameInput
            className="title-input"
            value={props.title || ""}
            onDone={(v) => {
              setRenaming(false);
              if (v && v !== props.title) props.onRename?.(v);
            }}
          />
        ) : (
          <div
            className={`chat-title ellipsis ${props.onRename ? "editable" : ""}`}
            onClick={() => props.onRename && setRenaming(true)}
            title={props.onRename ? "点击改名" : undefined}
          >
            {props.title || ""}
          </div>
        )}
        {streaming && (
          <span className="head-status">
            <Loader3D running size={10} />
            运行中
          </span>
        )}
        {/* 任务与文件按钮：固定在窗口最右上角（CSS 里 position: fixed），右侧面板 / 大视图开没开都在同一个位置。
            鼠标停上去弹出文件列表，点击开关任务面板 */}
        {(props.outputs.length > 0 || props.hasSteps) && (
          <div className="out-wrap" onMouseEnter={showPeek} onMouseLeave={hidePeek}>
            <button
              className={`icon-btn out-btn ${props.rightOpen ? "on" : ""}`}
              onClick={() => {
                setPeek(false);
                props.onToggleRight();
              }}
              aria-label={`任务与文件 ${modKey}\\`}
            >
              <ILayers />
              {props.outputs.length > 0 && <span>{props.outputs.length}</span>}
            </button>
            {peek && !props.rightOpen && (
              <FilesPeek
                outputs={props.outputs}
                onOpen={(v) => {
                  setPeek(false);
                  props.onOpenView(v);
                }}
              />
            )}
          </div>
        )}
      </header>

      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
        }}
      >
        {empty && home ? (
          home.head
        ) : empty ? (
          // 新对话：logo + 问候语，输入框紧跟在下面，整体在页面中间（布局见 CSS .chat.is-empty）
          <div className="welcome">
            <CoreLogo size={72} morph={false} />
            <h1>
              {greeting}
              {props.userName && `，${props.userName}`}
            </h1>
            {/* 在项目里新建的对话：提示这次对话会放进哪个项目 */}
            {props.projectName && (
              <div className="welcome-proj">
                <IconPicker value={props.projectIcon} size={13} />
                {props.projectName}
              </div>
            )}
          </div>
        ) : (
          <div className="thread" key={props.sessionId}>
            {turns.map((t, i) => {
              const isLast = i === turns.length - 1;
              const live = streaming && isLast;
              const assistants = t.steps.filter((s) => s.role === "assistant");
              const last = assistants[assistants.length - 1];
              // 最终回答 = 最后一次模型调用且没有工具调用时的文字
              // （模型正在生成工具参数时 drafts 非空，这时的文字只是开场白，放进过程里）
              // 第一步写的「【规划】」也不是回答：它属于过程，执行完才有回答
              const answer = last && !last.toolCalls?.length && !last.drafts?.length && !last.content.trimStart().startsWith(PLAN_MARK) ? last.content.trim() : "";
              const hasTrace = live || t.steps.some((s) => s.reasoning || s.toolCalls?.length || s.content.trimStart().startsWith(PLAN_MARK));
              const ask = live ? null : findAsk(t.steps); // 这一轮以 ask_user 结束：显示提问卡片
              return (
                <section key={t.user?.id ?? i} className="turn">
                  {t.user &&
                    (editing === t.user.id ? (
                      <div className="msg user editing">
                        <EditBubble
                          initial={splitAttachments(t.user.content).text}
                          onCancel={() => setEditing(null)}
                          onSubmit={(text) => {
                            setEditing(null);
                            // 编辑只改文字，原来的附件原样带上
                            props.onResend(t.user!.id, joinAttachments(text, splitAttachments(t.user!.content).files));
                          }}
                        />
                      </div>
                    ) : (
                      <UserMsg content={t.user.content} disabled={streaming} onEdit={() => setEditing(t.user!.id)} onOpenFile={props.onOpenFile} />
                    ))}
                  {(hasTrace || answer) && (
                    <div className="msg assistant">
                      {hasTrace && (
                        <Trace
                          steps={t.steps}
                          live={live}
                          running={props.running}
                          artifacts={props.artifacts}
                          onOpenArtifact={props.onOpenArtifact}
                          onOpenFile={props.onOpenFile}
                        />
                      )}
                      {answer && (
                        <div className="answer">
                          <Markdown text={answer} onOpenFile={openName} />
                          {/* 回答还在往外吐字：末尾放一个稍大的点阵动画（18px，思维链里是 12px） */}
                          {live && (
                            <span className="answer-spinner">
                              <DotSpinner size={18} label="正在输出" />
                            </span>
                          )}
                        </div>
                      )}
                      {answer && !live && (
                        <MessageActions
                          text={answer}
                          always={isLast}
                          disabled={streaming}
                          onRetry={t.user ? () => props.onResend(t.user!.id, t.user!.content) : undefined}
                        />
                      )}
                      {ask && <AskCard {...ask} active={isLast && !streaming} onAnswer={props.onAnswer} />}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>

      <div className="composer-wrap">
        {!empty && !atBottom && (
          <button className="to-bottom" onClick={toBottom} title="回到底部">
            <IArrowUp width={14} height={14} />
          </button>
        )}
        {props.error && (
          <div className="error-bar">
            <span className="ellipsis">{props.error}</span>
            <button className="icon-btn" onClick={props.onDismissError}>
              <IX width={12} height={12} />
            </button>
          </div>
        )}
        <ApprovalDock />
        <form
          className={`composer ${streaming ? "busy" : ""} ${dragging ? "drag" : ""}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (canSend) props.onSend();
          }}
          // 文件直接拖进输入框也能上传
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            setDragging(false);
            props.onAttach([...e.dataTransfer.files]);
          }}
        >
          {props.attachments.length > 0 && (
            <div className="att-list">
              {props.attachments.map((a) => (
                <AttChip
                  key={a.key}
                  name={a.name}
                  sub={a.error ? a.error : a.path ? fmtSize(a.size) : "上传中…"}
                  state={a.error ? "err" : a.path ? "" : "up"}
                  onRemove={() => props.onRemoveAttachment(a.key)}
                />
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            value={draft}
            rows={1}
            placeholder={streaming ? "运行中：可以继续补充想法，agent 下一步会看到；Esc 停止" : "输入任务…"}
            onChange={(e) => props.setDraft(e.target.value)}
            // 截图直接粘贴：剪贴板里有文件时当附件上传，文字照常粘贴
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (!files.length) return;
              e.preventDefault();
              props.onAttach(files);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              // 发送方式由设置决定：Enter 发送，或 ⌘/Ctrl+Enter 发送
              const send = props.sendKey === "enter" ? !e.shiftKey && !e.metaKey && !e.ctrlKey : e.metaKey || e.ctrlKey;
              if (send) {
                e.preventDefault();
                if (canSend) props.onSend();
              }
            }}
          />
          {/* 运行中输入框有字：显示发送（补充想法）；没字：显示停止 */}
          {streaming && !draft.trim() ? (
            <button type="button" className="send stop" onClick={props.onStop} title="停止 Esc">
              <IStop />
            </button>
          ) : (
            <button type="submit" className="send" disabled={!canSend} title={uploading ? "附件上传中…" : "发送 Enter"}>
              <IArrowUp />
            </button>
          )}
        </form>
        {/* 输入框下面一行：左边上传文件，右边上下文占用和模型（props.bar）。上传按钮不放进输入框里，输入框只管打字和发送 */}
        <div className="under-row">
          <button type="button" className="cbar-btn att-under" onClick={() => fileRef.current?.click()} title="上传文件：PDF、图片、Word、Excel、PPT…">
            <IClip width={14} height={14} />
            <span>上传文件</span>
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              if (e.target.files?.length) props.onAttach([...e.target.files]);
              e.target.value = ""; // 清空，同一个文件删掉后还能再选
            }}
          />
          {props.bar}
        </div>
        {empty && home?.chats}
      </div>
    </main>
  );
}

/** 一条用户消息：正文 + 附件卡片（附件路径藏在消息末尾的 <附件> 块里，见 lib/attachments.ts） */
function UserMsg(p: { content: string; disabled: boolean; onEdit(): void; onOpenFile(path: string): void }) {
  const { text, files } = splitAttachments(p.content);
  return (
    <div className="msg user">
      {files.length > 0 && (
        <div className="att-list sent">
          {files.map((f) => (
            <AttChip key={f} name={f.split("/").pop()!} sub={f.split(".").pop()!.toUpperCase()} onOpen={() => p.onOpenFile(f)} />
          ))}
        </div>
      )}
      {text && <div className="bubble">{text}</div>}
      <MessageActions text={text} disabled={p.disabled} onEdit={p.onEdit} />
    </div>
  );
}

/** 附件小卡片：图标 + 文件名 + 第二行（大小 / 上传中 / 类型）。输入框里能删，消息里能点开 */
function AttChip(p: { name: string; sub: string; state?: "" | "up" | "err"; onRemove?(): void; onOpen?(): void }) {
  const Tag = p.onOpen ? "button" : "div";
  return (
    <Tag className={`att ${p.state || ""}`} {...(p.onOpen ? { type: "button" as const, onClick: p.onOpen, title: "在右侧打开" } : {})}>
      <span className="att-ico">{isImage(p.name) ? <IImage width={15} height={15} /> : <IFile width={15} height={15} />}</span>
      <span className="att-main">
        <span className="att-name ellipsis">{p.name}</span>
        <span className="att-sub ellipsis">{p.sub}</span>
      </span>
      {p.onRemove && (
        <button type="button" className="att-x" onClick={p.onRemove} title="移除">
          <IX width={10} height={10} />
        </button>
      )}
    </Tag>
  );
}

function fmtSize(n: number) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

/** 按当前时间问候。放在 useEffect 里算：服务端渲染时不知道用户的本地时间，直接算会和浏览器里的结果对不上 */
function useGreeting() {
  const [text, setText] = useState("你好");
  useEffect(() => {
    const h = new Date().getHours();
    setText(h < 5 ? "夜深了" : h < 11 ? "早上好" : h < 13 ? "中午好" : h < 18 ? "下午好" : "晚上好");
  }, []);
  return text;
}
