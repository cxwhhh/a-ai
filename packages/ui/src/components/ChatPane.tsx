"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { AgentQueueItem, Artifact, Project, SessionMeta, StoredMessage } from "../../../protocol/src/lib/shared";
import { PLAN_MARK } from "../../../protocol/src/plan";
import { Markdown } from "./Markdown";
import { resolveFileName } from "../lib/file-chips";
import { Trace } from "./Trace";
import { SessionTrace } from "./SessionTrace";
import { SubagentTasks } from "./SubagentTasks";
import { AskCard, findAsk } from "./AskCard";
import { ApprovalDock } from "./ApprovalDock";
import { Loader3D } from "./Loader3D";
import { IconPicker } from "./IconPicker";
import { RingSpinner } from "./RingSpinner";
import { CoreLogo } from "./CoreLogo";
import { IconButton } from "./base/buttons/icon-button";
import { IArrowUp, IChevron, IClock, IFile, IFiles, IImage, IPanelLeft, IPlus, IStop, IX } from "./Icons";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "./shadcn/input-group";
import { Button } from "./shadcn/button";
import { ACCEPT, isImage, joinAttachments, splitAttachments } from "../../../protocol/src/lib/attachments";
import type { PendingAttachment } from "../../../protocol/src/lib/attachments";
import { NameInput } from "./Sidebar";
import "./ChatPane.css";
import { FilesPeek, TurnFileChanges } from "./OutputsCard";
import { EditBubble, MessageActions } from "./MessageActions";
import type { OutputItem, View } from "../../../protocol/src/lib/outputs";
import type { ReactNode } from "react";
import { cx } from "../utils/cx";

interface Turn {
  user?: StoredMessage;
  steps: StoredMessage[]; // assistant + tool + 自动反馈（feedback）
}

export type ConversationView = "chat" | "trace" | "stats" | "subagents";

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
  embedded?: { icon: string; ended?: boolean; placeholder?: string; action?: ReactNode; close(): void };
  threadControl?: ReactNode;
  workspaceTabControl?: ReactNode;
  multiAgent?: boolean;
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
  running: Record<string, number>;
  streaming: boolean;
  archived?: boolean;
  error: string | null;
  draft: string;
  setDraft(v: string): void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  leftOpen: boolean;
  rightOpen: boolean;
  viewOpen: boolean;
  sendKey: "enter" | "mod-enter";
  /** Workspace 提供主会话的模型菜单和输入框下方的上下文状态。 */
  modelSelector?: ReactNode;
  contextStatus?: ReactNode;
  modKey: string;
  onSend(): void;
  queue: AgentQueueItem[];
  queueReady: boolean;
  queueBusy: boolean;
  onSteer(id: string): void;
  onRemoveQueued(id: string): void;
  onContinueQueue(id: string): void;
  /** 输入框里待发送的附件（选完就开始上传） */
  attachments: PendingAttachment[];
  onAttach(files: File[]): void;
  onRemoveAttachment(key: string): void;
  /** 回答 agent 的提问（AskCard），直接把回答当作一条消息发出去 */
  onAnswer(text: string): void;
  /** 从指定问题重新生成，原问题与后续记录由服务端归入历史。 */
  onResend(id: string, text: string): void;
  /** 当前对话 id：切换对话时用它让内容重新淡入 */
  sessionId: string;
  conversationView: ConversationView;
  traceScopeVersion?: number;
  onConversationView(view: ConversationView): void;
  traceSessions: readonly SessionMeta[];
  traceProjects: readonly Project[];
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
  const { messages, streaming, draft, inputRef, modKey, home, conversationView, onConversationView } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const composerWrap = useRef<HTMLDivElement>(null);
  const composerForm = useRef<HTMLFormElement>(null);
  const turns = useMemo(() => toTurns(messages), [messages]);
  const empty = turns.length === 0;
  const canViewTrace = !!props.sessionId && !props.loading && !props.embedded;
  const viewingTrace = conversationView !== "chat" && canViewTrace;
  const overlayComposer = !empty && !viewingTrace;
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

  // 正文可以经过输入框两侧，滚动区在表单底边结束。只为盖住正文的部分预留滚动空间。
  useLayoutEffect(() => {
    const el = scroller.current;
    const wrap = composerWrap.current;
    const form = composerForm.current;
    if (!overlayComposer || !el || !wrap || !form) return;
    const reserveSpace = () => {
      const wasAtEnd = el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
      const { top, bottom } = wrap.getBoundingClientRect();
      const formBottom = form.getBoundingClientRect().bottom;
      el.style.setProperty("--composer-overlap", `${formBottom - top}px`);
      el.style.setProperty("--composer-footer-height", `${bottom - formBottom}px`);
      if (wasAtEnd) el.scrollTop = el.scrollHeight;
    };
    reserveSpace();
    const observer = new ResizeObserver(reserveSpace);
    observer.observe(wrap, { box: "border-box" });
    observer.observe(form, { box: "border-box" });
    return () => {
      observer.disconnect();
      el.style.removeProperty("--composer-overlap");
      el.style.removeProperty("--composer-footer-height");
    };
  }, [overlayComposer]);

  // 只在“发出新消息”或“打开另一个对话”时滚到底部一次；
  // 模型输出过程中页面固定不动，想看最新内容就自己往下滑，或点“回到底部”
  const userCount = messages.filter((m) => m.role === "user" && !m.feedback).length;
  const firstId = messages[0]?.id;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [userCount, firstId]);

  const wasStreaming = useRef(streaming);
  useLayoutEffect(() => {
    const el = scroller.current;
    // 变更卡在收尾时才挂载。用户已经停在底部时，把新卡片带入视野。
    if (wasStreaming.current && !streaming && atBottom && el?.querySelector(".turn:last-child .turn-files")) {
      el.scrollTop = el.scrollHeight;
    }
    wasStreaming.current = streaming;
  }, [atBottom, streaming]);
  // 内容变高（模型在输出、展开了过程）时也重新判断是否在底部，决定要不要显示“回到底部”
  useEffect(() => {
    const el = scroller.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    const check = () => setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    const ro = new ResizeObserver(check);
    ro.observe(inner);
    ro.observe(el);
    return () => ro.disconnect();
  }, [empty, firstId, props.sessionId, viewingTrace]);
  const toBottom = () => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });

  // 主聊天优先按 CSS 随文字折行增高。子 Agent 和旧浏览器继续用原有的高度测量。
  useLayoutEffect(() => {
    const t = inputRef.current;
    if (!t || getComputedStyle(t).getPropertyValue("field-sizing") === "content") return;
    t.style.height = "0px";
    t.style.height = Math.min(t.scrollHeight, 220) + "px";
  }, [draft, inputRef, empty]);

  const greeting = useGreeting();

  // 附件：上传中不能发（路径还没拿到）；只有附件没写字也可以发
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const uploading = props.attachments.some((a) => !a.path && !a.error);
  const ready = props.attachments.some((a) => a.path);
  const canSend = !props.archived && !props.embedded?.ended && !uploading && !props.queueBusy && (!streaming || props.queueReady) && (!!draft.trim() || ready);
  const queuedHead = props.queue.find((item) => item.target === "next-turn");
  const awaitingAnswer = !streaming && !!findAsk(turns.at(-1)?.steps ?? []);
  const showStop = streaming && !draft.trim() && !ready;
  const sendLabel = props.embedded ? "发送给子 Agent" : streaming ? "排队发送" : "发送";
  // 草稿还没创建会话时也要有标题。项目首页由项目名称标识。
  const title = props.title || (home ? "" : "新对话");
  const Surface = props.embedded ? "section" : "main";

  return (
    <Surface className={cx("chat", empty && !props.embedded && "is-empty", empty && !!home && "is-proj", props.loading && "loading", viewingTrace && "trace-open", overlayComposer && "composer-overlay")}>
      {props.loading && <div className="chat-loading" aria-hidden />}
      {props.embedded ? <header className="viewer-head">
        <IconPicker value={props.embedded.icon} size={16} />
        <div className="viewer-title ellipsis">{props.title}</div>
        <div className="spacer" />
        {streaming && <span className="head-status"><Loader3D running size={10} />运行中</span>}
        {props.embedded.action}
        <button type="button" className="icon-btn" aria-label="关闭子 Agent 对话" onClick={props.embedded.close}><IX width={16} height={16} /></button>
      </header> : <header className="chat-head">
        {!props.leftOpen && (
          <button className="icon-btn" onClick={props.onToggleLeft} title={`展开左栏 ${modKey}B`}>
            <IPanelLeft />
          </button>
        )}
        {viewingTrace && (
          <button type="button" className="icon-btn chat-view-back" title="返回对话" aria-label="返回对话"
            onClick={() => onConversationView("chat")}>
            <IChevron width={16} height={16} />
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
            value={title}
            onDone={(v) => {
              setRenaming(false);
              if (v && v !== title) props.onRename?.(v);
            }}
          />
        ) : (
          <div
            className={`chat-title ellipsis ${props.onRename ? "editable" : ""}`}
            onClick={() => props.onRename && setRenaming(true)}
            title={props.onRename ? "点击改名" : undefined}
          >
            {title}
          </div>
        )}
        {/* 只开任务面板时，运行状态与按钮一起移到面板上方。 */}
        <div className={cx("head-actions", props.rightOpen && !props.viewOpen && "over-panel")}>
          {streaming && (
            <span className="head-status">
              <Loader3D running size={10} />
              运行中
            </span>
          )}
          {props.threadControl}
          {props.workspaceTabControl}
          <div className="out-wrap" onMouseEnter={showPeek} onMouseLeave={hidePeek}>
            <button
              type="button"
              className={`icon-btn out-btn ${props.rightOpen ? "on" : ""}`}
              onClick={() => {
                setPeek(false);
                props.onToggleRight();
              }}
              aria-label={`任务与文件 ${modKey}\\`}
              aria-expanded={props.rightOpen}
            >
              <IFiles />
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
        </div>
      </header>}
      {viewingTrace && conversationView === "subagents" && <SubagentTasks key={props.sessionId} sessionId={props.sessionId}
        archived={props.archived} streaming={streaming} enabled={props.multiAgent} />}
      {viewingTrace && conversationView !== "subagents" && <SessionTrace key={`${props.sessionId}:${props.traceScopeVersion}`} sessionId={props.sessionId} sessions={props.traceSessions}
        projects={props.traceProjects} streaming={streaming} showStats={conversationView === "stats"}
        onShowTrace={() => onConversationView("trace")} />}

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
        ) : empty && props.embedded ? null : empty ? (
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
                          disabled={streaming || !!props.archived}
                          onCancel={() => setEditing(null)}
                          onSubmit={(text) => {
                            // 等服务端接受后再替换这条消息。失败时原编辑框仍在，附件也跟着原消息保留。
                            props.onResend(t.user!.id, joinAttachments(text, splitAttachments(t.user!.content).files));
                          }}
                        />
                      </div>
                    ) : (
                      <UserMsg content={t.user.content} disabled={streaming || !!props.archived || !!props.embedded} onEdit={() => setEditing(t.user!.id)} onOpenFile={props.onOpenFile} />
                    ))}
                  {(hasTrace || answer) && (
                    <div className="msg assistant">
                      {hasTrace && (
                        <Trace
                          namesOnly={!!props.embedded}
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
                          {/* 回答仍在输出时，在末尾显示稍大的运行圆环。 */}
                          {live && (
                            <span className="answer-spinner">
                              <RingSpinner size={18} label="正在输出" />
                            </span>
                          )}
                        </div>
                      )}
                      {!live && <TurnFileChanges steps={t.steps} artifacts={props.artifacts} onOpenView={props.onOpenView} />}
                      {answer && !live && (
                        <MessageActions
                          text={answer}
                          always={isLast}
                          disabled={streaming || !!props.archived}
                          onRetry={t.user && !props.embedded ? () => props.onResend(t.user!.id, t.user!.content) : undefined}
                        />
                      )}
                      {ask && <AskCard {...ask} active={isLast && !streaming && !props.archived} onAnswer={props.onAnswer} />}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>

      <div className="composer-wrap" ref={composerWrap}>
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
        {props.archived && <div className="error-bar" role="status">已归档。可以阅读历史，恢复后可继续发送。</div>}
        {!props.embedded && props.queue.length > 0 && (
          <section className="chat-queue" aria-label="排队消息">
            {!streaming && (
              <div className="chat-queue-head">
                <span role="status">{awaitingAnswer ? "等待你回答，队列已暂停" : "队列已暂停"}</span>
                {!awaitingAnswer && !props.archived && queuedHead && (
                  <Button className="chat-queue-action" disabled={props.queueBusy} onClick={() => props.onContinueQueue(queuedHead.id)}>继续队列</Button>
                )}
              </div>
            )}
            <ol>
              {props.queue.map((item) => {
                const { text, files } = splitAttachments(item.message);
                const preview = [text.trim(), ...files.map((file) => file.split("/").at(-1))].filter(Boolean).join(" · ");
                return (
                  <li key={item.id}>
                    <IClock className="chat-queue-clock" width={15} height={15} />
                    <span className="chat-queue-text" title={preview}>{preview}</span>
                    {item.target === "next-step" ? <span className="chat-queue-status">等待加入下一步</span> : (
                      <>
                        {streaming && (
                          <Button className="chat-queue-action" disabled={props.queueBusy || !props.queueReady}
                            onClick={() => props.onSteer(item.id)} title="加入当前任务的下一步">引导本轮</Button>
                        )}
                        <IconButton className="chat-queue-remove" icon={IX} size="small" disabled={props.queueBusy || props.archived}
                          onClick={() => props.onRemoveQueued(item.id)} aria-label="移除排队消息" title="移除排队消息" />
                      </>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        )}
        <form
          ref={composerForm}
          className={cx("composer prompt-composer", streaming && "busy", dragging && "drag")}
          onSubmit={(e) => {
            e.preventDefault();
            if (canSend) props.onSend();
          }}
          // 文件直接拖进输入框也能上传
          onDragOver={(e) => {
            if (props.embedded || !e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            if (props.embedded) return;
            setDragging(false);
            props.onAttach([...e.dataTransfer.files]);
          }}
        >
          <InputGroup>
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
            <InputGroupTextarea
              ref={inputRef}
              value={draft}
              rows={1}
              disabled={props.archived || props.embedded?.ended}
              aria-label={props.embedded ? "给子 Agent 发消息" : undefined}
              placeholder={props.embedded ? props.embedded.placeholder ?? "给子 Agent 发消息…" : streaming ? "发送后排队，也可点「引导本轮」加入当前任务" : "输入任务…"}
              onChange={(e) => props.setDraft(e.target.value)}
              // 截图直接粘贴：剪贴板里有文件时当附件上传，文字照常粘贴
              onPaste={(e) => {
                const files = [...e.clipboardData.files];
                if (props.embedded || !files.length) return;
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
              <InputGroupAddon className="prompt-toolbar">
                {!props.embedded && <>
                  <InputGroupButton className="prompt-circle prompt-attach" disabled={props.archived} onClick={() => fileRef.current?.click()}
                    aria-label="上传文件" title="上传文件：PDF、图片、Word、Excel、PPT…">
                    <IPlus width={14} height={14} aria-hidden />
                  </InputGroupButton>
                  <input ref={fileRef} type="file" multiple accept={ACCEPT} hidden onChange={(e) => {
                    if (e.target.files?.length) props.onAttach([...e.target.files]);
                    e.target.value = ""; // 清空后才能再次选择同一个文件
                  }} />
                </>}
                {props.modelSelector}
                {showStop ? (
                  <InputGroupButton className="prompt-circle prompt-send composer-stop" onClick={props.onStop} aria-label={props.embedded ? "停止子 Agent" : "停止生成"} title={props.embedded ? "停止子 Agent" : "停止 Esc"}>
                    <IStop width={18} height={18} aria-hidden />
                  </InputGroupButton>
                ) : (
                  <InputGroupButton type="submit" className="prompt-circle prompt-send" disabled={!canSend} aria-label={sendLabel}
                    title={uploading ? "附件上传中…" : sendLabel}>
                    <IArrowUp width={18} height={18} aria-hidden />
                  </InputGroupButton>
                )}
              </InputGroupAddon>
          </InputGroup>
        </form>
        {props.contextStatus && <div className="prompt-context">{props.contextStatus}</div>}
        {empty && home?.chats}
      </div>
    </Surface>
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
