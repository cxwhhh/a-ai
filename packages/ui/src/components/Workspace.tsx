"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, AgentQueueSnapshot, Groups, Project, ProjectChat, Session, SessionMeta, StoredMessage, ToolInfo } from "../../../protocol/src/lib/shared";
import type { WorkspaceAppSummary } from "../../../protocol/src/workspace-app";
import { api, mod, streamChat, subscribeRun } from "../lib/client";
import { createLiveStore, emptyLiveStore, LiveStoreContext } from "../lib/live";
import { Sidebar } from "./Sidebar";
import { ChatPane, type ConversationView } from "./ChatPane";
import { Canvas } from "./Canvas";
import { WorkspaceAppCanvas } from "./WorkspaceAppCanvas";
import { OutputsCard } from "./OutputsCard";
import { SubagentConversation } from "./SubagentConversation";
import { SubagentThreadOverview, SubagentThreadTrigger, type SubagentSelection, type ThreadLayout } from "./SubagentThreads";
import { collectOutputs, type View } from "../../../protocol/src/lib/outputs";
import { DEFAULT_SETTINGS, currentOption, reasoningOptions, type Settings } from "../../../protocol/src/lib/settings";
import type { AgentEventScope, AgentModelSelection, ReasoningEffort } from "../../../protocol/src/agent-events";
import { ComposerBar } from "./ComposerBar";
import { joinAttachments, type PendingAttachment } from "../../../protocol/src/lib/attachments";
import { SettingsModal } from "./SettingsModal";
import { ProjectModal } from "./ProjectModal";
import { AgentLogModal } from "./AgentLogModal";
import { ArtifactsPage } from "./ArtifactsPage";
import { ProjectApps, ProjectChats, ProjectHead } from "./ProjectHome";
import { SkillToast } from "./SkillToast";
import type { SettingsTab } from "./UserMenu";

const emptySession = (): Session => ({ id: "", title: "", createdAt: 0, updatedAt: 0, messages: [], artifacts: [] });
const noTools: Record<string, number> = {};
const SIDEBAR_DEFAULT = 288;
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 480;
const SIDEBAR_WIDTH_KEY = "a.sidebarW";

/** 一条流自持快照，切换会话时继续消费自己的事件。新对话在拿到 sessionId 前使用草稿键。 */
type ChatRun = {
  key: string;
  controller: AbortController;
  session: Session;
  scope?: AgentEventScope;
  stopRequested?: boolean;
  queue: AgentQueueSnapshot | null;
  running: Record<string, number>;
  live: ReturnType<typeof createLiveStore>;
  error: string | null;
};

async function cancelRun(run: ChatRun, show: (run: ChatRun) => void) {
  if (!run.scope || run.controller.signal.aborted) return;
  try {
    await api.stopRun(run.scope.runId);
    run.controller.abort();
    run.live.reset();
  } catch (error) {
    run.stopRequested = false;
    run.error = error instanceof Error ? error.message : String(error);
  }
  show(run);
}

const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* 隐私模式等情况忽略 */
    }
  },
};

/**
 * 每个对话右侧的状态（右侧大视图打开的是哪个文件 / 产出物、右上角文件面板开没开），存在 localStorage 的 a.panels 里。
 * 切到别的对话再切回来、或者刷新页面，都恢复成离开时的样子；只有用户自己关掉才会关。
 */
type Panels = { view: View | null; list: boolean };
const PANELS_KEY = "a.panels";
function loadPanels(): Record<string, Panels> {
  try {
    return JSON.parse(store.get(PANELS_KEY) || "{}");
  } catch {
    return {};
  }
}
function savePanels(id: string, p: Panels) {
  const all = loadPanels();
  delete all[id]; // 删掉再加：让最近用过的排在最后，超出 200 个时从最旧的开始丢
  if (p.view || p.list) all[id] = p;
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete all[k];
  store.set(PANELS_KEY, JSON.stringify(all));
}

/** user：当前用户名，用来拼地址 /A.ai/chat/用户名/对话ID；initialId：地址里带的对话 ID */
export function Workspace({ user, initialId }: { user: string; initialId?: string }) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [cur, setCurState] = useState<Session>(emptySession);
  const [runView, setRunView] = useState<Pick<ChatRun, "scope" | "running" | "live"> | null>(null);
  const streaming = runView !== null;
  const runId = runView?.scope?.runId ?? null;
  const running = runView?.running ?? noTools;
  const [draftModel, setDraftModel] = useState<AgentModelSelection>();
  const [modelBusyIds, setModelBusyIds] = useState<string[]>([]);
  const [logView, setLogView] = useState<{ sessionId?: string } | null>(null);
  const [queue, setQueue] = useState<AgentQueueSnapshot | null>(null);
  const [queueBusyIds, setQueueBusyIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** 输入框里的附件：选完文件立刻上传到工作区 uploads/，发送时把路径附在消息末尾 */
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [leftOpen, setLeftOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const sidebarDrag = useRef<{ pointerId: number; x: number; width: number; next: number } | null>(null);
  /** 左栏收起时，鼠标移到窗口左边缘弹出的悬浮左栏 */
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** 左栏“项目”里的对话分组 */
  const [groups, setGroups] = useState<Groups>({ groups: [], assign: {} });
  /** 项目列表；projectModal：正在新建（"new"）或修改哪个项目的弹窗 */
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectModal, setProjectModal] = useState<"new" | Project | null>(() =>
    window.aaiWorkspace && new URLSearchParams(location.search).get("newLocalProject") === "1" ? "new" : null);
  /** 中间显示什么：对话，或“产出物”页面 */
  const [page, setPage] = useState<"chat" | "artifacts">("chat");
  const [conversationView, setConversationView] = useState<ConversationView>("chat");
  const [traceScopeVersion, setTraceScopeVersion] = useState(0);
  /** 项目页：点左栏项目名打开的那个项目（新对话输入框上面是项目头，下面是这个项目的全部对话）；projectChats：那些对话，null = 读取中 */
  const [projectHome, setProjectHome] = useState<string | null>(null);
  const [projectChats, setProjectChats] = useState<ProjectChat[] | null>(null);
  /** 右侧大视图正在显示什么（null = 关闭）：产出物或工作区文件 */
  const [view, setView] = useState<View | null>(null);
  const [libraryApp, setLibraryApp] = useState<WorkspaceAppSummary | null>(null);
  const [childView, setChildView] = useState<{ sessionId: string; task: SubagentSelection } | null>(null);
  const [threadsSessionId, setThreadsSessionId] = useState<string>();
  const [threadLayout, setThreadLayout] = useState<ThreadLayout>("cards");
  const threadsOpen = !!cur.id && threadsSessionId === cur.id;
  const child = childView && childView.sessionId === cur.id ? childView.task : null;
  function openSubagent(task: SubagentSelection) {
    if (viewKey.current !== cur.id) return;
    setView(null);
    setThreadsSessionId(undefined);
    setChildView({ sessionId: cur.id, task });
    setListOpen(false);
  }
  function toggleThreads() {
    if (threadsOpen) { setThreadsSessionId(undefined); return; }
    setView(null);
    setChildView(null);
    setLibraryApp(null);
    setListOpen(false);
    setThreadsSessionId(cur.id);
  }
  const openedApp = libraryApp;
  const rightView = !openedApp && page === "chat" && !!(view || child || threadsOpen);
  /** 任务面板（点右上角文件按钮弹出的悬浮卡片：进度 / 输出 / 已使用）是否打开 */
  const [listOpen, setListOpen] = useState(false);
  /** 右侧大视图的宽度（px，用户拖动分隔条调整，保存在浏览器里）；null = 默认宽度 */
  const [viewW, setViewW] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  /** 窗口宽度：面板和文件都打开时，用它判断屏幕够不够宽 */
  const [winW, setWinW] = useState(1920);
  const defaultViewWidth = Math.max(400, Math.min(940, winW * 0.46));
  const rightWidth = rightView || openedApp ? viewW ?? defaultViewWidth : page === "chat" && listOpen ? 320 : 0;
  // 限制自定义宽度，右侧面板打开时给对话留出空间，窗口变宽后可恢复用户选的宽度。
  const sidebarLimit = Math.max(SIDEBAR_DEFAULT, Math.min(SIDEBAR_MAX, Math.floor(winW - rightWidth - 380)));
  const displayedSidebarWidth = winW > 900 ? Math.min(sidebarWidth, sidebarLimit) : SIDEBAR_DEFAULT;
  /** 屏幕挤的时候左栏会自动收起；用户在这时又手动展开了，就记一下，不再自动收 */
  const [keepLeft, setKeepLeft] = useState(false);
  // 面板 + 文件并排至少要 左栏 288 + 对话 420 + 面板 282 + 文件 480 ≈ 1540px，不够就先把左栏让出来
  // 窄屏的详情页和产出物页为内容让位，仍可手动展开左栏。
  const crowded = (!!view && listOpen && winW < 1540)
    || (winW <= 900 && (page === "artifacts" || threadsOpen || (!!cur.id && conversationView !== "chat")));
  // 左栏实际是否显示：用户的设置（leftOpen，存在浏览器里）不变，只是挤的时候临时让位；面板或文件一关就自动回来
  const showLeft = leftOpen && (!crowded || keepLeft);
  const expandLeft = () => {
    setLeftOpen(true);
    setKeepLeft(true);
  };
  const uiRef = useRef({ view, child, threadsOpen, openedApp, listOpen, showLeft });
  uiRef.current = { view, child, threadsOpen, openedApp, listOpen, showLeft };
  /** 系统提示词、工具定义大约占多少 token（上下文环形图用） */
  const [fixedTokens, setFixedTokens] = useState({ system: 0, tools: 0 });
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [modKey, setModKey] = useState("Ctrl+");
  /** 用户设置（服务端保存）；settingsTab 不为 null 时显示设置弹窗 */
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  /** 上一次运行结束的时间：变了就去看看后台有没有学会新技能（SkillToast） */
  const [runEnd, setRunEnd] = useState(0);
  const [libraryVersion, setLibraryVersion] = useState(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modelAction = useRef(new Set<string>());
  const queueAction = useRef(new Set<string>());
  const runs = useRef(new Map<string, ChatRun>());
  const viewKey = useRef("draft:0");
  const curRef = useRef(cur);

  const setCur = useCallback((update: Session | ((current: Session) => Session)) => {
    const session = typeof update === "function" ? update(curRef.current) : update;
    curRef.current = session;
    const run = runs.current.get(viewKey.current);
    if (run) run.session = session;
    setCurState(session);
  }, []);

  /** 只有正在看的会话会更新 React 视图，其他流仍继续积累各自的快照。 */
  const showRun = useCallback((run: ChatRun) => {
    if (viewKey.current !== run.key) return;
    setCur(run.session);
    setRunView(run.controller.signal.aborted ? null : { scope: run.scope, running: run.running, live: run.live });
  }, [setCur]);

  /** 队列可经聊天流和独立请求同时更新，以服务端版本为准。 */
  const applyQueue = useCallback((snapshot: AgentQueueSnapshot) => {
    const newer = (previous: AgentQueueSnapshot | null) =>
      previous?.sessionId === snapshot.sessionId && previous.epoch === snapshot.epoch && previous.version > snapshot.version ? previous : snapshot;
    const run = runs.current.get(snapshot.sessionId);
    if (run) run.queue = newer(run.queue);
    if (viewKey.current === snapshot.sessionId) setQueue(newer);
  }, []);

  useEffect(() => {
    if (!cur.id) return;
    let active = true;
    api.queue(cur.id).then((snapshot) => { if (active) applyQueue(snapshot); }).catch(() => {});
    return () => { active = false; };
  }, [cur.id, applyQueue]);

  /* ---------- 初始化 ---------- */
  useEffect(() => {
    setModKey(mod());
    setLeftOpen(store.get("a.left") !== "0");
    const storedSidebarWidth = Number(store.get(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(storedSidebarWidth) && storedSidebarWidth > 0) {
      setSidebarWidth(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(storedSidebarWidth))));
    }
    api
      .info()
      .then((r) => {
        setTools(r.tools ?? []);
        setFixedTokens({ system: r.systemTokens ?? 0, tools: r.toolsTokens ?? 0 });
      })
      .catch(() => {});
    api.list().then(setSessions).catch(() => {});
    api.groups().then(setGroups).catch(() => {});
    api.projects().then(setProjects).catch(() => {});
    api.settings().then((r) => setSettings(r.settings)).catch(() => {});
    // 兼容旧链接 /?s=对话ID
    const id = initialId || new URLSearchParams(location.search).get("s");
    if (id) void open(id);
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    store.set("a.left", leftOpen ? "1" : "0");
    setPeek(false);
  }, [leftOpen]);
  useEffect(() => setPeek(false), [showLeft]);

  useEffect(() => {
    const onResize = () => setWinW(window.innerWidth);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // 不挤了就清掉“手动展开”的记号，下次挤的时候还是自动收
  useEffect(() => {
    if (!crowded) setKeepLeft(false);
  }, [crowded]);

  // 悬浮左栏：鼠标离开后稍等一下再隐藏，避免手抖一下就消失
  const showPeek = () => {
    clearTimeout(peekTimer.current);
    setPeek(true);
  };
  const hidePeek = () => {
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeek(false), 220);
  };

  const changeGroups = (g: Groups) => {
    setGroups(g);
    api.saveGroups(g).catch(() => {});
  };

  // 关闭设置后重新取一次：系统提示词可能改了，固定占用的 token 数会变
  useEffect(() => {
    if (settingsTab) return;
    api
      .info()
      .then((r) => setFixedTokens({ system: r.systemTokens ?? 0, tools: r.toolsTokens ?? 0 }))
      .catch(() => {});
  }, [settingsTab]);

  // 主题：写到 <html data-theme>，CSS 里按它切换颜色变量；system 时删掉属性，跟随系统
  useEffect(() => {
    const el = document.documentElement;
    if (settings.theme === "system") el.removeAttribute("data-theme");
    else el.setAttribute("data-theme", settings.theme);
  }, [settings.theme]);
  // 对话宽度和字号：同样写到 <html> 上（data-width / data-fs / data-side-fs），CSS 里换成对应的变量
  useEffect(() => {
    const el = document.documentElement;
    el.setAttribute("data-width", settings.chatWidth);
    el.setAttribute("data-fs", settings.fontSize);
    el.setAttribute("data-side-fs", settings.sideFontSize);
    el.setAttribute("data-code-font", settings.codeFont);
  }, [settings.chatWidth, settings.fontSize, settings.sideFontSize, settings.codeFont]);

  // URL 与当前会话同步：刷新不丢位置。只换地址不跳转（replaceState），页面不会重新加载
  useEffect(() => {
    const base = `/A.ai/chat/${encodeURIComponent(user)}`;
    history.replaceState(null, "", cur.id ? `${base}/${cur.id}` : base);
  }, [cur.id, user]);

  /* ---------- 会话操作 ---------- */
  const stop = useCallback(() => {
    const run = runs.current.get(viewKey.current);
    if (!run) return;
    run.stopRequested = true;
    // 新对话的首帧分配 runId。先记下点击，拿到身份后才能停止正确的任务。
    if (run.scope) void cancelRun(run, showRun);
  }, [showRun]);

  /** 新对话；传 projectId = 在这个项目里新建（发第一条消息时才真正建到项目里） */
  const newChat = useCallback((projectId?: string) => {
    viewKey.current = `draft:${++openSeq.current}`;
    setRunView(null);
    setQueue(null);
    setLoadingId(null);
    setDraftModel(undefined);
    setPage("chat");
    setConversationView("chat");
    setProjectHome(null);
    setLibraryApp(null);
    setCur({ ...emptySession(), ...(projectId ? { projectId } : {}) });
    setView(null);
    setChildView(null);
    setThreadsSessionId(undefined);
    setListOpen(false);
    setError(null);
    setDraft("");
    setAttachments([]);
    setTimeout(() => inputRef.current?.focus());
  }, [setCur]);

  /* ---------- 项目 ---------- */
  /** 点左栏项目名：开项目页 = 在这个项目里开一个新对话 + 标记成项目页（发出第一条消息后就是普通对话） */
  function openProject(id: string) {
    newChat(id);
    setProjectHome(id);
  }
  async function saveProject(p: Omit<Project, "id" | "createdAt">) {
    const editing = projectModal && projectModal !== "new" ? projectModal : null;
    const saved = await api.saveProject(p, editing?.id);
    setProjects((l) => (editing ? l.map((x) => (x.id === saved.id ? saved : x)) : [...l, saved]));
    setProjectModal(null);
  }
  /** 换项目图标：先改界面（立刻看到），再存到服务端；失败了改回去 */
  async function setProjectIcon(id: string, icon: string) {
    const p = projects.find((x) => x.id === id);
    if (!p || p.icon === icon) return;
    setProjects((l) => l.map((x) => (x.id === id ? { ...x, icon } : x)));
    try {
      await api.saveProject({ name: p.name, description: p.description, memory: p.memory, share: p.share, icon }, id);
    } catch {
      setProjects((l) => l.map((x) => (x.id === id ? { ...x, icon: p.icon } : x)));
    }
  }
  async function deleteProject(id: string) {
    await api.deleteProject(id);
    setProjects((l) => l.filter((x) => x.id !== id));
    // 项目删了，里面的对话回到分组里（服务端外键自动置空，这里同步一下界面）
    setSessions((l) => l.map((s) => (s.projectId === id ? { ...s, projectId: undefined } : s)));
    setCur((c) => (c.projectId === id ? { ...c, projectId: undefined } : c));
  }

  async function archive(target: "session" | "project", id: string, archived: boolean) {
    try {
      await api.archive(target, id, archived);
      const [nextSessions, nextProjects] = await Promise.all([api.list(), api.projects()]);
      setSessions(nextSessions);
      setProjects(nextProjects);
      if (target === "session") setCur((s) => s.id === id ? { ...s, archivedAt: nextSessions.find((item) => item.id === id)?.archivedAt } : s);
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "无法更新归档状态");
    }
  }
  async function moveToProject(sessionId: string, projectId: string | null) {
    try { await api.moveSession(sessionId, projectId); }
    catch (error) {
      setError(error instanceof Error ? error.message : "无法移动对话");
      return;
    }
    const pid = projectId ?? undefined;
    setSessions((l) => l.map((s) => (s.id === sessionId ? { ...s, projectId: pid } : s)));
    setCur((c) => c.id === sessionId ? { ...c, projectId: pid } : c);
  }

  /** 选了文件：先在输入框里显示“上传中”的卡片，每个文件单独上传，哪个失败只标红那一个 */
  function attach(files: File[]) {
    const items = files.map((f, i) => ({ key: `${Date.now()}-${i}-${f.name}`, name: f.name, size: f.size }));
    setAttachments((l) => [...l, ...items]);
    items.forEach((it, i) => {
      const f = files[i];
      const done = (patch: Partial<PendingAttachment>) => setAttachments((l) => l.map((a) => (a.key === it.key ? { ...a, ...patch } : a)));
      if (f.size > 50 * 1024 * 1024) return done({ error: "超过 50 MB" });
      api.upload([f]).then(
        ([r]) => done({ path: r.path, name: r.name }),
        (e) => done({ error: e instanceof Error ? e.message : "上传失败" }),
      );
    });
    inputRef.current?.focus();
  }

  /** 发送输入框：文字 + 已上传好的附件。失败的附件不发 */
  async function sendDraft() {
    const key = viewKey.current;
    if (queueAction.current.has(key) || modelAction.current.has(key) || isArchived) return;
    const paths = attachments.filter((a) => a.path).map((a) => a.path!);
    const text = joinAttachments(draft.trim(), paths);
    if (!text) return;
    const run = runs.current.get(key);
    if (run) {
      if (!run.scope || run.controller.signal.aborted) return;
      const seq = openSeq.current;
      const accepted = await updateQueue({ action: "enqueue", runId: run.scope.runId, message: text });
      if (!accepted || openSeq.current !== seq) return;
      // 请求期间可能又输入了下一条，只清理已经提交的草稿和附件。
      setDraft((value) => value === draft ? "" : value);
      setAttachments((items) => items.filter((item) => !attachments.some((sent) => sent.key === item.key)));
      return;
    }
    setDraft("");
    setAttachments([]);
    await start(text);
  }

  async function updateQueue(input: Parameters<typeof api.updateQueue>[1]): Promise<boolean> {
    const sessionId = curRef.current.id;
    if (!sessionId || queueAction.current.has(sessionId)) return false;
    queueAction.current.add(sessionId);
    setQueueBusyIds([...queueAction.current]);
    try {
      applyQueue(await api.updateQueue(sessionId, input));
      return viewKey.current === sessionId;
    } catch (error) {
      if (viewKey.current === sessionId) setError(error instanceof Error ? error.message : "无法更新排队消息");
      api.queue(sessionId).then(applyQueue).catch(() => {});
      return false;
    } finally {
      queueAction.current.delete(sessionId);
      setQueueBusyIds([...queueAction.current]);
    }
  }

  /** 正在加载的对话 id：左栏马上高亮它，中间先变淡并显示一条细进度条，加载完再淡入 */
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const openSeq = useRef(0);

  /** 默认打开正文。侧栏菜单可在同一次切换里指定目标对话和详情视图。 */
  async function open(id: string, artifactId?: string, file?: string, nextView: ConversationView = "chat") {
    setPage("chat");
    setLibraryApp(null);
    // 从产出物页点进来要打开的东西：面板里的产出物，或生成的文件（Word / Excel / PPT）
    const target: View | null = file ? { type: "file", path: file } : artifactId ? { type: "artifact", id: artifactId } : null;
    const seq = ++openSeq.current; // 连点几个对话时，只认最后一次点击，前面慢返回的结果丢掉
    if (id === viewKey.current) {
      setLoadingId(null);
      // 轨迹和统计能在详情里追踪别的会话。重新从侧栏打开时，要回到菜单所属的会话。
      if (nextView === "trace" || nextView === "stats") setTraceScopeVersion((version) => version + 1);
      setConversationView(nextView);
      // 从产出物页打开“当前这个对话”里的产出物：和对话里点开一样，右侧只留文件视图，把任务面板收起
      // （以前这里只设了 view，面板如果开着就会和产出物并排出现）
      if (target) openView(target);
      return;
    }
    setLoadingId(id);
    const saved = runs.current.get(id)?.session ?? await api.get(id).catch(() => null);
    if (seq !== openSeq.current) return;
    setLoadingId(null);
    const run = runs.current.get(id);
    const s = run?.session ?? saved;
    if (!s) return;
    viewKey.current = id;
    setConversationView(nextView);
    setDraftModel(undefined);
    setChildView(null);
    setThreadsSessionId(undefined);
    if (run) showRun(run);
    else {
      setCur(s);
      setRunView(null);
    }
    setQueue(run?.queue ?? null);
    setError(run?.error ?? null);
    // 恢复这个对话上次离开时右侧的样子（产出物已经不存在了就不恢复那个视图）
    const p = loadPanels()[id];
    const v = p?.view;
    setView(target ?? (v && (v.type === "file" || s.artifacts.some((a) => a.id === v.id)) ? v : null));
    // 右侧同一时间只放一样东西：上次两个都开着的话，只恢复文件视图
    setListOpen(!!p?.list && !(target || v));
    if (nextView === "chat") setTimeout(() => inputRef.current?.focus());
    if (!run) void reconnect(s);
  }

  async function rename(id: string, title: string) {
    const t = title.slice(0, 80);
    setSessions((l) => l.map((s) => (s.id === id ? { ...s, title: t } : s)));
    const run = runs.current.get(id);
    if (run) run.session = { ...run.session, title: t };
    if (viewKey.current === id) setCur((c) => ({ ...c, title: t }));
    await api.rename(id, t).catch(() => {});
  }

  async function remove(id: string) {
    await api.remove(id);
    setSessions((l) => l.filter((s) => s.id !== id));
    if (viewKey.current === id) newChat();
  }

  /* ---------- 发送与事件处理 ---------- */
  function apply(e: AgentEvent, run: ChatRun) {
    const update = (mutate: (session: Session) => Session) => { run.session = mutate(run.session); };
    switch (e.type) {
      case "session":
        // 首个事件为草稿分配正式 ID。只有仍停留在该草稿时才更新当前选中键。
        if (run.key !== e.session.id) {
          runs.current.delete(run.key);
          if (viewKey.current === run.key) viewKey.current = e.session.id;
          run.key = e.session.id;
          runs.current.set(run.key, run);
        }
        update((c) => ({ ...c, ...e.session,
          projectId: e.session.projectId, modelSelection: e.session.modelSelection ?? c.modelSelection }));
        setSessions((l) => [{ ...l.find((s) => s.id === e.session.id), ...e.session }, ...l.filter((s) => s.id !== e.session.id)]);
        break;
      case "queue":
        if (e.queue.sessionId === run.key) applyQueue(e.queue);
        break;
      case "message":
        update((c) => {
          const msgs = c.messages.slice();
          // 正常发送的乐观消息由已提交记录替换；排队和引导只在实际提交后加入历史。
          const tmp =
            e.message.role === "user" && !e.message.feedback
              ? msgs.findIndex((m) => m.id.startsWith("tmp"))
              : -1;
          if (tmp >= 0) msgs[tmp] = e.message;
          else if (!msgs.some((m) => m.id === e.message.id)) msgs.push(e.message);
          return { ...c, messages: msgs };
        });
        if (e.message.toolCallId) {
          const { [e.message.toolCallId]: _done, ...rest } = run.running;
          run.running = rest;
        }
        break;
      case "reasoning":
      case "text": {
        // 增量拼接：找到这条 assistant 消息（没有就新建），把 delta 接到 reasoning 或 content 上
        const field = e.type === "text" ? "content" : "reasoning";
        update((c) => {
          const i = c.messages.findIndex((m) => m.id === e.messageId);
          const msgs = c.messages.slice();
          const base: StoredMessage = i < 0 ? { id: e.messageId, role: "assistant", content: "", createdAt: e.createdAt } : msgs[i];
          const next = { ...base, [field]: (base[field] ?? "") + e.delta };
          if (i < 0) msgs.push(next);
          else msgs[i] = next;
          return { ...c, messages: msgs };
        });
        break;
      }
      case "tool_input":
        // 工具参数增量：拼到 drafts[index] 上，Trace 用它实时显示正在写的代码；assistant_end 时被完整的 toolCalls 取代
        update((c) => {
          const i = c.messages.findIndex((m) => m.id === e.messageId);
          const msgs = c.messages.slice();
          const base: StoredMessage = i < 0 ? { id: e.messageId, role: "assistant", content: "", createdAt: e.createdAt } : msgs[i];
          const drafts = (base.drafts ?? []).slice();
          const d = drafts[e.index] ?? { name: "", arguments: "" };
          drafts[e.index] = { name: e.name || d.name, arguments: d.arguments + e.delta };
          if (i < 0) msgs.push({ ...base, drafts });
          else msgs[i] = { ...base, drafts };
          return { ...c, messages: msgs };
        });
        break;
      case "assistant_end":
        update((c) => {
          const i = c.messages.findIndex((m) => m.id === e.message.id);
          const msgs = c.messages.slice();
          if (i < 0) msgs.push(e.message);
          else msgs[i] = e.message;
          return { ...c, messages: msgs };
        });
        break;
      case "artifact":
        // 新产出（代码 / 文档 / 网页）直接在右侧大视图打开
        // 同一个 id 再来一次 = 这一轮里改好重新提交的版本，原地替换，不多出一份
        update((c) => ({
          ...c,
          artifacts: c.artifacts.some((a) => a.id === e.artifact.id)
            ? c.artifacts.map((a) => (a.id === e.artifact.id ? e.artifact : a))
            : [...c.artifacts, e.artifact],
        }));
        if (viewKey.current === run.key && settingsRef.current.autoOpen) {
          setView({ type: "artifact", id: e.artifact.id });
        }
        break;
      case "error":
        run.error = e.message;
        if (viewKey.current === run.key) setError(run.error);
        break;
      case "tool_start":
        run.running = { ...run.running, [e.callId]: e.startedAt };
        break;
      // 终端实时输出、确认请求由此流的 Trace 行订阅。
      case "tool_output":
      case "approval":
      case "approval_end":
        run.live.apply(e);
        break;
      case "done":
        run.running = {};
        run.live.reset();
        break;
    }
  }

  /**
   * 重新生成 / 编辑后重发：替换当前有效视图的后缀，原问题与后续记录由服务端保留。
   * 先显示乐观结果，服务端保留旧历史；请求结束后回读有效视图，失败时也不会把旧回答藏在本地。
   */
  async function resend(fromId: string, text: string) {
    text = text.trim();
    if (!text || runs.current.has(viewKey.current) || !curRef.current.id) return;
    if (fromId.startsWith("tmp")) return; // 还没存到服务端的临时消息，没法从它截断
    await start(text, fromId);
  }

  async function start(text: string, truncate?: string, queuedId?: string) {
    const key = viewKey.current;
    if (runs.current.has(key) || queueAction.current.has(key) || modelAction.current.has(key) || isArchived) return;
    setError(null);
    const original = curRef.current;
    const requestSessionId = original.id;
    if (!queuedId) setCur((c) => {
      const tmp: StoredMessage = { id: "tmp" + Date.now(), role: "user", content: text, createdAt: Date.now() };
      const cut = truncate ? c.messages.findIndex((m) => m.id === truncate) : -1;
      const keep = cut >= 0 ? c.messages.slice(0, cut) : c.messages;
      const since = cut >= 0 ? c.messages[cut].createdAt : Infinity;
      return { ...c, messages: [...keep, tmp], artifacts: c.artifacts.filter((a) => a.createdAt < since) };
    });
    const run: ChatRun = {
      key,
      controller: new AbortController(),
      session: curRef.current,
      queue: queue?.sessionId === requestSessionId ? queue : null,
      running: {},
      live: createLiveStore(),
      error: null,
    };
    await track(run, original, (onEvent) => streamChat(
      { sessionId: requestSessionId || undefined, revision: requestSessionId && !queuedId ? original.revision : undefined, message: queuedId ? undefined : text, queuedId, truncateFrom: truncate,
        projectId: requestSessionId ? undefined : original.projectId, modelSelection: requestSessionId ? undefined : draftModel,
        multiAgent: requestSessionId || original.projectId ? undefined : original.multiAgent },
      onEvent, run.controller.signal,
    ));
  }

  /** 回放时历史里已保存的 assistant 消息已有正文，跳过这些消息的增量以免拼接两次。 */
  async function reconnect(session: Session) {
    const scope = await api.activeRun(session.id).catch(() => null);
    if (!scope || runs.current.has(session.id)) return;
    const completed = new Set(session.messages.map((message) => message.id));
    const run: ChatRun = { key: session.id, scope, session, controller: new AbortController(), queue: null, running: {}, live: createLiveStore(), error: null };
    await track(run, session, (onEvent) => subscribeRun(scope.runId, (event) => {
      if ((event.type === "text" || event.type === "reasoning" || event.type === "tool_input") && completed.has(event.messageId)) return;
      onEvent(event);
    }, run.controller.signal));
  }

  async function track(run: ChatRun, original: Session, consume: (onEvent: (event: AgentEvent) => void) => Promise<void>) {
    const key = run.key;
    const requestSessionId = original.id;
    runs.current.set(key, run);
    showRun(run);
    // 每条流各自按帧合并相邻增量，防止不同会话复用消息或调用 ID 时串数据。
    let pending: AgentEvent[] = [];
    let frame = 0;
    const flush = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      const events = coalesce(pending);
      pending = [];
      for (const event of events) apply(event, run);
      showRun(run);
    };
    try {
      await consume((event) => {
          if (run.controller.signal.aborted || !event.scope) return;
          if (event.type === "session" && (event.session.id !== event.scope.sessionId || event.runId !== event.scope.runId)) return;
          if (!run.scope) {
            if (event.type !== "session" || (requestSessionId && requestSessionId !== event.scope.sessionId)) return;
            run.scope = event.scope;
            if (run.stopRequested) void cancelRun(run, showRun);
          }
          if (run.scope.sessionId !== event.scope.sessionId || run.scope.runId !== event.scope.runId) return;
          pending.push(event);
          if (!frame) frame = requestAnimationFrame(flush);
        });
    } catch (err) {
      if (!run.controller.signal.aborted) run.error = err instanceof Error ? err.message : String(err);
    } finally {
      flush();
      run.live.reset();
      // 服务端确认的记录决定最终视图。后台任务结束也同步列表，但只能写回同一会话。
      const savedId = run.session.id;
      if (savedId) {
        void api.queue(savedId).then(applyQueue).catch(() => {});
        try {
          const saved = await api.get(savedId);
          if (saved) {
            run.session = saved;
            setSessions((items) => items.map((item) => item.id === savedId ? { ...item, updatedAt: saved.updatedAt } : item));
          }
        } catch {
          run.error ??= "无法刷新会话，请刷新页面后确认保存结果";
        }
      } else {
        run.session = original;
      }
      runs.current.delete(run.key);
      if (viewKey.current === run.key) {
        setCur(run.session);
        if (run.error) setError(run.error);
        setRunView(null);
      }
      if (savedId) setLibraryVersion((version) => version + 1);
      if (settingsRef.current.skills && !run.controller.signal.aborted) setRunEnd(Date.now());
    }
  }

  /* ---------- 快捷键 ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const m = e.metaKey || e.ctrlKey;
      if (m && e.key === ",") {
        e.preventDefault();
        setSettingsTab("general");
      } else if (m && e.key.toLowerCase() === "k") {
        e.preventDefault();
        newChat();
      } else if (m && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (uiRef.current.showLeft) setLeftOpen(false);
        else expandLeft();
      } else if (m && e.key === "\\") {
        e.preventDefault();
        toggleList();
      } else if (e.key === "Escape" && uiRef.current.openedApp) {
        e.preventDefault();
        setLibraryApp(null);
      } else if (e.key === "Escape" && uiRef.current.threadsOpen) {
        e.preventDefault();
        setThreadsSessionId(undefined);
      } else if (e.key === "Escape" && uiRef.current.child) {
        e.preventDefault();
        setChildView(null);
        setListOpen(true);
      } else if (e.key === "Escape" && uiRef.current.view && !runs.current.has(viewKey.current)) {
        e.preventDefault();
        setView(null);
      } else if (e.key === "Escape" && runs.current.has(viewKey.current)) {
        e.preventDefault();
        stop();
      } else if (e.key === "/" && !isTyping(e.target)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newChat, stop]);

  const isArchived = !!(cur.archivedAt || projects.some((p) => p.id === cur.projectId && p.archivedAt));
  const multiAgent = !!(cur.projectId || cur.multiAgent);
  const selection = cur.modelSelection ?? (!cur.id ? draftModel : undefined) ?? { model: settings.currentModel, effort: settings.reasoningEffort };
  const chatSettings = { ...settings, currentModel: selection.model, reasoningEffort: selection.effort };
  const modelOption = currentOption(chatSettings);
  const model = modelOption.group === "内置" ? modelOption.label : `${modelOption.group} · ${modelOption.label}`;
  const pickModel = async (value: string, effort: ReasoningEffort = "default") => {
    const key = viewKey.current;
    if (modelAction.current.has(key) || runs.current.has(key) || isArchived) return;
    const next = { model: value, effort: reasoningOptions(settings, value).includes(effort) ? effort : "default" as const };
    const id = curRef.current.id;
    if (!id) {
      setDraftModel(next);
      return;
    }
    modelAction.current.add(id);
    setModelBusyIds([...modelAction.current]);
    try {
      const saved = await api.selectAgentModel(id, next);
      setCur((s) => s.id === id ? { ...s, modelSelection: saved } : s);
    } catch (error) {
      if (viewKey.current === id) setError(error instanceof Error ? error.message : "无法保存对话模型");
    } finally {
      modelAction.current.delete(id);
      setModelBusyIds([...modelAction.current]);
    }
  };

  const changeMultiAgent = async (enabled: boolean) => {
    const { id, projectId } = curRef.current;
    const key = viewKey.current;
    if (projectId || modelAction.current.has(key) || runs.current.has(key) || isArchived) return;
    if (!id) { setCur((s) => ({ ...s, multiAgent: enabled })); return; }
    modelAction.current.add(id);
    setModelBusyIds([...modelAction.current]);
    try {
      await api.setMultiAgent(id, enabled);
      setCur((s) => s.id === id ? { ...s, multiAgent: enabled } : s);
      setSessions((items) => items.map((s) => s.id === id ? { ...s, multiAgent: enabled } : s));
    } catch (err) {
      if (viewKey.current === id) setError(err instanceof Error ? err.message : "无法保存多agent智能体模式");
    } finally {
      modelAction.current.delete(id);
      setModelBusyIds([...modelAction.current]);
    }
  };

  const { outputs, used } = useMemo(() => {
    const collected = collectOutputs(cur.messages, cur.artifacts);
    const unavailable = new Set(cur.unavailableOutputKeys);
    return { ...collected, outputs: collected.outputs.filter(({ key }) => !unavailable.has(key)) };
  }, [cur.messages, cur.artifacts, cur.unavailableOutputKeys]);
  // 打开文件时任务面板不收起：面板是“钉住”的，只有点它的 × 才关
  // 打开一个文件 / 产出物时顺手收起任务面板（2026-10-29）：右侧只留文件视图，不再和面板并排挤在一起。
  // 想再看面板就点对话标题栏右边的按钮
  const openView = (v: View) => {
    setChildView(null);
    setThreadsSessionId(undefined);
    setView(v);
    setListOpen(false);
  };
  // 开关任务面板（标题栏按钮和 ⌘\ 共用）：打开面板时把文件视图收起，右侧同一时间只显示一个（2026-10-29）
  const toggleList = () => {
    if (!uiRef.current.listOpen) { setView(null); setChildView(null); setThreadsSessionId(undefined); }
    setListOpen((o) => !o);
  };
  // 右侧状态变化时记下来（按对话分开存）。切换对话时 open() 会把新对话的状态一次性设好，这里存的就是新对话自己的
  useEffect(() => {
    if (cur.id) savePanels(cur.id, { view, list: listOpen });
  }, [cur.id, view, listOpen]);

  // 任务面板：点空白处、按 Esc 都不会关；点面板右上角的 ×、或打开文件 / 产出物时收起（快捷键 ⌘\ 仍可切换）

  const clampSidebarWidth = (width: number) => Math.max(SIDEBAR_MIN, Math.min(sidebarLimit, Math.round(width)));
  const saveSidebarWidth = (width: number) => {
    const next = clampSidebarWidth(width);
    setSidebarWidth(next);
    store.set(SIDEBAR_WIDTH_KEY, String(next));
  };
  /** 用分隔条抓住指针。拖动只更新画面，结束后才把宽度存到当前浏览器。 */
  const sidebarHandle = (
    <div
      className="resize-handle side-resize-handle"
      role="separator"
      tabIndex={0}
      aria-label="调整左侧栏宽度"
      aria-orientation="vertical"
      aria-controls="workspace-sidebar"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={sidebarLimit}
      aria-valuenow={displayedSidebarWidth}
      title="拖动调整宽度，双击恢复"
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        sidebarDrag.current = { pointerId: event.pointerId, x: event.clientX, width: displayedSidebarWidth, next: displayedSidebarWidth };
        setResizing(true);
      }}
      onPointerMove={(event) => {
        const drag = sidebarDrag.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        drag.next = clampSidebarWidth(drag.width + event.clientX - drag.x);
        setSidebarWidth(drag.next);
      }}
      onLostPointerCapture={(event) => {
        const drag = sidebarDrag.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        sidebarDrag.current = null;
        setResizing(false);
        if (drag.next !== drag.width) saveSidebarWidth(drag.next);
      }}
      onDoubleClick={() => saveSidebarWidth(SIDEBAR_DEFAULT)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") saveSidebarWidth(displayedSidebarWidth - 16);
        else if (event.key === "ArrowRight") saveSidebarWidth(displayedSidebarWidth + 16);
        else if (event.key === "Home") saveSidebarWidth(SIDEBAR_MIN);
        else if (event.key === "End") saveSidebarWidth(sidebarLimit);
        else return;
        event.preventDefault();
      }}
    />
  );

  /* ---------- 右侧一列的宽度：拖动左边缘的分隔条调整 ---------- */
  useEffect(() => {
    try {
      const w = Number(localStorage.getItem("a.viewW"));
      if (w > 0) setViewW(w);
    } catch {}
  }, []);
  const saveViewW = (w: number | null) => {
    setViewW(w);
    try {
      if (w) localStorage.setItem("a.viewW", String(w));
      else localStorage.removeItem("a.viewW");
    } catch {}
  };
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const side = document.querySelector(".side:not(.floating)")?.getBoundingClientRect().width ?? 0;
    // 最窄 320px；最宽要给对话区留 380px
    const panel = document.querySelector(".right .panel")?.getBoundingClientRect().width ?? 0; // 面板钉在旁边时也要算进去
    const clampW = (w: number) => Math.round(Math.min(Math.max(w, 320), window.innerWidth - side - panel - 380 - 20));
    let next = viewW;
    const move = (ev: PointerEvent) => {
      next = clampW(window.innerWidth - ev.clientX - 10 - panel);
      setViewW(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setResizing(false);
      saveViewW(next);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    setResizing(true);
  };
  // 项目页只在“还没发消息的项目新对话”时显示；打开别的对话、发了消息、进产出物页，它自然就不满足了
  const homeProject =
    page === "chat" && projectHome && !cur.id && cur.messages.length === 0 && cur.projectId === projectHome
      ? projects.find((p) => p.id === projectHome)
      : undefined;
  const sessionsKey = sessions.filter((s) => s.projectId === homeProject?.id).map((s) => `${s.id}:${s.updatedAt}:${s.title}:${s.archivedAt ?? ""}`).join("|");
  // 换了项目先显示“读取中”，再读这个项目的对话
  useEffect(() => setProjectChats(null), [homeProject?.id]);
  useEffect(() => {
    if (!homeProject) return;
    let off = false;
    api.projectChats(homeProject.id).then((l) => !off && setProjectChats(l));
    return () => {
      off = true;
    };
    // 左栏里这个项目的对话有变化（新建、改名、删除、移动）就重新读一次
  }, [homeProject?.id, sessionsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const sidebarProps = {
    // 当前对话有没有文件，直接用前端算好的 outputs（生成过程中就能实时出现图标）
    sessions: sessions.map((s) => (s.id === cur.id ? { ...s, hasFiles: outputs.length > 0 } : s)),
    currentId: page === "artifacts" ? undefined : loadingId ?? cur.id,
    viewingDetails: conversationView !== "chat",
    model,
    userName: settings.name,
    modKey,
    groups,
    onGroupsChange: changeGroups,
    onOpenSettings: setSettingsTab,
    onNew: () => newChat(),
    onOpen: (id: string, view?: ConversationView) => void open(id, undefined, undefined, view),
    artifactsActive: page === "artifacts",
    onOpenArtifacts: () => {
      setKeepLeft(false);
      setPeek(false);
      setPage("artifacts");
    },
    projects,
    onNewProject: () => setProjectModal("new"),
    onEditProject: (p: Project) => setProjectModal(p),
    onDeleteProject: (id: string) => void deleteProject(id),
    onNewInProject: (id: string) => newChat(id),
    onOpenProject: openProject,
    projectHomeId: homeProject?.id,
    onMoveToProject: (sid: string, pid: string | null) => void moveToProject(sid, pid),
    onDelete: remove,
    onRename: rename,
    onArchive: (target: "session" | "project", id: string, archived: boolean) => void archive(target, id, archived),
    onAgentLog: (sessionId?: string) => setLogView({ sessionId }),
  };

  const content = (
    <div
      className={`app ${showLeft ? "left-open" : ""} ${rightView ? "right-open" : ""} ${resizing ? "resizing" : ""}`}
      style={{ "--side-w": `${displayedSidebarWidth}px`, ...(viewW ? { "--canvas-w": `${viewW}px` } : {}) } as React.CSSProperties}
    >
      {showLeft ? (
        <Sidebar {...sidebarProps} resizeHandle={sidebarHandle} onCollapse={() => setLeftOpen(false)} />
      ) : (
        <>
          {/* 收起后：左边缘一条看不见的感应区，鼠标碰到就弹出悬浮左栏 */}
          <div className="side-edge" onMouseEnter={showPeek} />
          {peek && <Sidebar {...sidebarProps} floating onCollapse={expandLeft} onMouseEnter={showPeek} onMouseLeave={hidePeek} />}
        </>
      )}
      {page === "artifacts" ? (
        <ArtifactsPage
          projects={projects}
          libraryVersion={libraryVersion}
          leftOpen={showLeft}
          modKey={modKey}
          onToggleLeft={expandLeft}
          onOpen={(sid, aid, file) => void open(sid, aid, file)}
          onOpenApp={setLibraryApp}
          onCreate={(text) => {
            // 产出物页顶部的“新建”卡片：开一个新对话，输入框预填开头，光标放到末尾（newChat 先清空草稿，这里再填）
            newChat();
            setDraft(text);
            setTimeout(() => {
              const el = inputRef.current;
              if (el) (el.focus(), el.setSelectionRange(text.length, text.length));
            }, 30);
          }}
        />
      ) : (
        <ChatPane
          conversationView={conversationView}
          traceScopeVersion={traceScopeVersion}
          onConversationView={setConversationView}
          home={
            homeProject && {
              head: <ProjectHead project={homeProject} onIcon={(i) => setProjectIcon(homeProject.id, i)} onSettings={() => setProjectModal(homeProject)} />,
              chats: <>
                <ProjectApps key={homeProject.id} projectId={homeProject.id} version={libraryVersion}
                  onOpenArtifact={(artifact) => void open(artifact.sessionId, artifact.id)} onOpen={(app) => {
                  setView(null);
                  setListOpen(false);
                  setLibraryApp(app);
                }} />
                <ProjectChats chats={projectChats} onOpen={(id) => void open(id)} />
              </>,
            }
          }
          title={cur.title}
          multiAgent={multiAgent}
          projectName={projects.find((p) => p.id === cur.projectId)?.name}
          projectIcon={projects.find((p) => p.id === cur.projectId)?.icon}
          onProjectIcon={cur.projectId ? (icon: string) => setProjectIcon(cur.projectId!, icon) : undefined}
          onRename={cur.id ? (t: string) => rename(cur.id, t) : undefined}
          messages={cur.messages}
          artifacts={cur.artifacts}
          outputs={outputs}
          onOpenView={openView}
          running={running}
          streaming={streaming}
          archived={isArchived}
          error={error}
          draft={draft}
          setDraft={setDraft}
          inputRef={inputRef}
          leftOpen={showLeft}
          rightOpen={listOpen}
          viewOpen={rightView}
          sendKey={settings.sendKey}
          bar={
            <ComposerBar
              settings={chatSettings}
              messages={cur.messages}
              systemTokens={fixedTokens.system}
              toolsTokens={fixedTokens.tools}
              onPickModel={(value) => void pickModel(value)}
              onPickEffort={(effort) => void pickModel(selection.model, effort)}
              modelDisabled={isArchived || modelBusyIds.includes(cur.id) || streaming}
              multiAgent={cur.projectId ? undefined : { enabled: multiAgent, onChange: (enabled) => void changeMultiAgent(enabled) }}
              onManage={() => setSettingsTab("model")}
              onUsage={() => setSettingsTab("usage")}
            />
          }
          modKey={modKey}
          onSend={() => void sendDraft()}
          queue={queue?.sessionId === cur.id ? queue.items : []}
          queueReady={!!runId}
          queueBusy={queueBusyIds.includes(cur.id)}
          onSteer={(id) => { if (runId) void updateQueue({ action: "steer", runId, id }); }}
          onRemoveQueued={(id) => void updateQueue({ action: "remove", id })}
          onContinueQueue={(id) => void start("", undefined, id)}
          attachments={attachments}
          onAttach={attach}
          onRemoveAttachment={(k) => setAttachments((l) => l.filter((a) => a.key !== k))}
          onAnswer={(t) => void start(t)}
          onResend={(id, t) => void resend(id, t)}
          sessionId={cur.id}
          traceSessions={sessions}
          traceProjects={projects}
          loading={!!loadingId}
          onStop={stop}
          onOpenArtifact={(id) => openView({ type: "artifact", id })}
          onOpenFile={(path) => openView({ type: "file", path })}
          onToggleLeft={expandLeft}
          onToggleRight={toggleList}
          threadControl={cur.id && !loadingId && <SubagentThreadTrigger key={cur.id} sessionId={cur.id}
            expanded={threadsOpen} onToggle={toggleThreads} />}
          userName={settings.name !== DEFAULT_SETTINGS.name ? settings.name : user}
          onDismissError={() => setError(null)}
        />
      )}
      {/* 右侧一列：任务面板（钉住时）和文件大视图并排放在同一列里，不再悬浮盖住对话。
          面板在左、文件在右：从面板点文件，文件就在它旁边打开 */}
      {page === "chat" && (rightView || listOpen) && (
        <div className={`right ${listOpen ? "with-panel" : ""} ${rightView ? "" : "panel-only"}`}>
          {/* 分隔条：按住左右拖动调整宽度，双击恢复默认 */}
          {rightView && <div className="resize-handle" onPointerDown={startResize} onDoubleClick={() => saveViewW(null)} title="拖动调整宽度，双击恢复" />}
          {listOpen && (
            <OutputsCard
              messages={cur.messages}
              artifacts={cur.artifacts}
              running={running}
              streaming={streaming}
              outputs={outputs}
              used={used}
              active={view}
              subagents={multiAgent ? { sessionId: cur.id, runId, open: openSubagent } : undefined}
              onOpen={openView}
              onClose={() => setListOpen(false)}
            />
          )}
          {threadsOpen ? <SubagentThreadOverview key={cur.id} sessionId={cur.id}
            layout={threadLayout} onLayout={setThreadLayout} onSelect={openSubagent} onClose={() => setThreadsSessionId(undefined)} />
          : child ? <SubagentConversation key={`${cur.id}:${child.id}`} sessionId={cur.id} selected={child}
            archived={isArchived} canResume={multiAgent && !isArchived} onResume={openSubagent}
            sendKey={settings.sendKey} modKey={modKey} onOpenFile={(path) => openView({ type: "file", path })}
            onClose={() => setChildView(null)} /> : view && (
            <Canvas
              view={view}
              artifacts={cur.artifacts}
              messages={cur.messages}
              refreshKey={cur.messages.length}
              onOpenFile={(path) => openView({ type: "file", path })}
              onClose={() => setView(null)}
            />
          )}
        </div>
      )}
      {openedApp && (
        <div className="right">
          <div className="resize-handle" onPointerDown={startResize} onDoubleClick={() => saveViewW(null)} title="拖动调整宽度，双击恢复" />
          <WorkspaceAppCanvas key={openedApp.id} id={openedApp.id} revision={openedApp.revision} title={openedApp.title} onClose={() => setLibraryApp(null)} />
        </div>
      )}
      {logView && <AgentLogModal key={logView.sessionId ?? "all"} sessionId={logView.sessionId} onClose={() => setLogView(null)} />}
      {projectModal && (
        <ProjectModal project={projectModal === "new" ? undefined : projectModal} onSave={saveProject} onClose={() => setProjectModal(null)} />
      )}
      <SkillToast runEnd={runEnd} onOpen={() => setSettingsTab("skills")} />
      {settingsTab && (
        <SettingsModal
          tab={settingsTab}
          settings={settings}
          model={model}
          tools={tools}
          modKey={modKey}
          onTab={setSettingsTab}
          onChange={setSettings}
          onClose={() => setSettingsTab(null)}
        />
      )}
    </div>
  );
  return <LiveStoreContext.Provider value={runView?.live ?? emptyLiveStore}>{content}</LiveStoreContext.Provider>;
}

function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

/** 把相邻、同一条消息的增量事件合并：100 个 text 增量 → 1 个，状态只更新一次 */
function coalesce(evs: AgentEvent[]): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const e of evs) {
    const last = out[out.length - 1];
    if (
      last &&
      (e.type === "text" || e.type === "reasoning" || e.type === "tool_input") &&
      last.type === e.type &&
      last.messageId === e.messageId &&
      (e.type !== "tool_input" || (last.type === "tool_input" && last.index === e.index))
    ) {
      out[out.length - 1] = { ...last, delta: last.delta + e.delta } as AgentEvent;
    } else if (e.type === "tool_output" && last?.type === "tool_output" && last.callId === e.callId && last.stream === e.stream) {
      out[out.length - 1] = { ...last, delta: last.delta + e.delta };
    } else out.push(e);
  }
  return out;
}
