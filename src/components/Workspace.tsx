"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, Groups, Project, ProjectChat, Session, SessionMeta, StoredMessage, ToolInfo } from "@/lib/shared";
import { api, mod, streamChat } from "@/lib/client";
import { liveStore } from "@/lib/live";
import { Sidebar } from "./Sidebar";
import { ChatPane } from "./ChatPane";
import { Canvas } from "./Canvas";
import { OutputsCard } from "./OutputsCard";
import { collectOutputs, type View } from "@/lib/outputs";
import { DEFAULT_SETTINGS, currentOption, type Settings } from "@/lib/settings";
import { ComposerBar } from "./ComposerBar";
import { joinAttachments, type PendingAttachment } from "@/lib/attachments";
import { SettingsModal } from "./SettingsModal";
import { ProjectModal } from "./ProjectModal";
import { ArtifactsPage } from "./ArtifactsPage";
import { ProjectChats, ProjectHead } from "./ProjectHome";
import { SkillToast } from "./SkillToast";
import type { SettingsTab } from "./UserMenu";

const emptySession = (): Session => ({ id: "", title: "", createdAt: 0, updatedAt: 0, messages: [], artifacts: [] });

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
  const [cur, setCur] = useState<Session>(emptySession);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** 输入框里的附件：选完文件立刻上传到工作区 uploads/，发送时把路径附在消息末尾 */
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [leftOpen, setLeftOpen] = useState(true);
  /** 左栏收起时，鼠标移到窗口左边缘弹出的悬浮左栏 */
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** 左栏“项目”里的对话分组 */
  const [groups, setGroups] = useState<Groups>({ groups: [], assign: {} });
  /** 项目列表；projectModal：正在新建（"new"）或修改哪个项目的弹窗 */
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectModal, setProjectModal] = useState<"new" | Project | null>(null);
  /** 中间显示什么：对话，或“产出物”页面 */
  const [page, setPage] = useState<"chat" | "artifacts">("chat");
  /** 项目页：点左栏项目名打开的那个项目（新对话输入框上面是项目头，下面是这个项目的全部对话）；projectChats：那些对话，null = 读取中 */
  const [projectHome, setProjectHome] = useState<string | null>(null);
  const [projectChats, setProjectChats] = useState<ProjectChat[] | null>(null);
  /** 右侧大视图正在显示什么（null = 关闭）：产出物或工作区文件 */
  const [view, setView] = useState<View | null>(null);
  /** 任务面板（点右上角文件按钮弹出的悬浮卡片：进度 / 输出 / 已使用）是否打开 */
  const [listOpen, setListOpen] = useState(false);
  /** 右侧大视图的宽度（px，用户拖动分隔条调整，保存在浏览器里）；null = 默认宽度 */
  const [viewW, setViewW] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  /** 窗口宽度：面板和文件都打开时，用它判断屏幕够不够宽 */
  const [winW, setWinW] = useState(1920);
  /** 屏幕挤的时候左栏会自动收起；用户在这时又手动展开了，就记一下，不再自动收 */
  const [keepLeft, setKeepLeft] = useState(false);
  // 面板 + 文件并排至少要 左栏 288 + 对话 420 + 面板 282 + 文件 480 ≈ 1540px，不够就先把左栏让出来
  const crowded = !!view && listOpen && winW < 1540;
  // 左栏实际是否显示：用户的设置（leftOpen，存在浏览器里）不变，只是挤的时候临时让位；面板或文件一关就自动回来
  const showLeft = leftOpen && (!crowded || keepLeft);
  const expandLeft = () => {
    setLeftOpen(true);
    setKeepLeft(true);
  };
  const uiRef = useRef({ view, listOpen, showLeft });
  uiRef.current = { view, listOpen, showLeft };
  /** 系统提示词、工具定义大约占多少 token（上下文环形图用） */
  const [fixedTokens, setFixedTokens] = useState({ system: 0, tools: 0 });
  const [tools, setTools] = useState<ToolInfo[]>([]);
  /** 正在执行的工具：callId → 开始时间（用于显示实时计时和 3D 动画） */
  const [running, setRunning] = useState<Record<string, number>>({});
  const [modKey, setModKey] = useState("Ctrl+");
  /** 用户设置（服务端保存）；settingsTab 不为 null 时显示设置弹窗 */
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  /** 上一次运行结束的时间：变了就去看看后台有没有学会新技能（SkillToast） */
  const [runEnd, setRunEnd] = useState(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const curIdRef = useRef("");
  /** 当前对话所在的项目（新对话还没发出去时也有：发第一条消息时告诉服务端建在哪个项目里） */
  const curProjectRef = useRef<string | undefined>(undefined);
  /** 已经发给服务端、但 agent 还没收到的补充想法（收到时服务端会推一条 note 消息回来） */
  const pendingNotes = useRef<string[]>([]);
  curIdRef.current = cur.id;
  curProjectRef.current = cur.projectId;

  /* ---------- 初始化 ---------- */
  useEffect(() => {
    setModKey(mod());
    setLeftOpen(store.get("a.left") !== "0");
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
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setRunning({});
    liveStore.reset();
  }, []);

  /** 新对话；传 projectId = 在这个项目里新建（发第一条消息时才真正建到项目里） */
  const newChat = useCallback((projectId?: string) => {
    stop();
    setPage("chat");
    setProjectHome(null);
    setCur({ ...emptySession(), ...(projectId ? { projectId } : {}) });
    setView(null);
    setListOpen(false);
    setError(null);
    setDraft("");
    setAttachments([]);
    setTimeout(() => inputRef.current?.focus());
  }, [stop]);

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
  async function moveToProject(sessionId: string, projectId: string | null) {
    const pid = projectId ?? undefined;
    setSessions((l) => l.map((s) => (s.id === sessionId ? { ...s, projectId: pid } : s)));
    if (sessionId === curIdRef.current) setCur((c) => ({ ...c, projectId: pid }));
    await api.moveSession(sessionId, projectId).catch(() => {});
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
  function sendDraft() {
    const paths = attachments.filter((a) => a.path).map((a) => a.path!);
    const text = joinAttachments(draft.trim(), paths);
    if (!text) return;
    setAttachments([]);
    void send(text);
  }

  /** 正在加载的对话 id：左栏马上高亮它，中间先变淡并显示一条细进度条，加载完再淡入 */
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const openSeq = useRef(0);

  /** 打开一个对话。artifactId：打开后右侧直接显示这个产出物（从“产出物”页面点进来时用） */
  async function open(id: string, artifactId?: string, file?: string) {
    setPage("chat");
    // 从产出物页点进来要打开的东西：面板里的产出物，或生成的文件（Word / Excel / PPT）
    const target: View | null = file ? { type: "file", path: file } : artifactId ? { type: "artifact", id: artifactId } : null;
    if (id === curIdRef.current) {
      // 从产出物页打开“当前这个对话”里的产出物：和对话里点开一样，右侧只留文件视图，把任务面板收起
      // （以前这里只设了 view，面板如果开着就会和产出物并排出现）
      if (target) openView(target);
      return;
    }
    stop();
    const seq = ++openSeq.current; // 连点几个对话时，只认最后一次点击，前面慢返回的结果丢掉
    setLoadingId(id);
    const s = await api.get(id).catch(() => null);
    if (seq !== openSeq.current) return;
    setLoadingId(null);
    if (!s) return;
    setCur(s);
    setError(null);
    // 恢复这个对话上次离开时右侧的样子（产出物已经不存在了就不恢复那个视图）
    const p = loadPanels()[id];
    const v = p?.view;
    setView(target ?? (v && (v.type === "file" || s.artifacts.some((a) => a.id === v.id)) ? v : null));
    // 右侧同一时间只放一样东西：上次两个都开着的话，只恢复文件视图
    setListOpen(!!p?.list && !(target || v));
    setTimeout(() => inputRef.current?.focus());
  }

  async function rename(id: string, title: string) {
    const t = title.slice(0, 80);
    setSessions((l) => l.map((s) => (s.id === id ? { ...s, title: t } : s)));
    if (id === curIdRef.current) setCur((c) => ({ ...c, title: t }));
    await api.rename(id, t).catch(() => {});
  }

  async function remove(id: string) {
    await api.remove(id);
    setSessions((l) => l.filter((s) => s.id !== id));
    if (id === curIdRef.current) newChat();
  }

  /* ---------- 发送与事件处理 ---------- */
  const apply = useCallback((e: AgentEvent) => {
    switch (e.type) {
      case "session":
        setCur((c) => ({ ...c, id: e.session.id, title: e.session.title, createdAt: e.session.createdAt }));
        setSessions((l) => [{ ...l.find((s) => s.id === e.session.id), ...e.session }, ...l.filter((s) => s.id !== e.session.id)]);
        break;
      case "message":
        if (e.message.feedback?.kind === "note") {
          const i = pendingNotes.current.indexOf(e.message.feedback.summary);
          if (i >= 0) pendingNotes.current.splice(i, 1);
        }
        setCur((c) => {
          const msgs = c.messages.slice();
          // 服务端确认的用户消息替换掉本地先显示的临时消息：补充想法换 tmpnote，正常发送换 tmp
          const note = e.message.feedback?.kind === "note";
          const tmp =
            e.message.role === "user" && (note || !e.message.feedback)
              ? msgs.findIndex((m) => (note ? m.id.startsWith("tmpnote") : m.id.startsWith("tmp") && !m.id.startsWith("tmpnote")))
              : -1;
          if (tmp >= 0) msgs[tmp] = e.message;
          else if (!msgs.some((m) => m.id === e.message.id)) msgs.push(e.message);
          return { ...c, messages: msgs };
        });
        if (e.message.toolCallId) {
          const id = e.message.toolCallId;
          setRunning((r) => {
            const { [id]: _done, ...rest } = r;
            return rest;
          });
        }
        break;
      case "reasoning":
      case "text": {
        // 增量拼接：找到这条 assistant 消息（没有就新建），把 delta 接到 reasoning 或 content 上
        const field = e.type === "text" ? "content" : "reasoning";
        setCur((c) => {
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
        setCur((c) => {
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
        setCur((c) => {
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
        setCur((c) => ({
          ...c,
          artifacts: c.artifacts.some((a) => a.id === e.artifact.id)
            ? c.artifacts.map((a) => (a.id === e.artifact.id ? e.artifact : a))
            : [...c.artifacts, e.artifact],
        }));
        if (settingsRef.current.autoOpen) {
          setView({ type: "artifact", id: e.artifact.id });
        }
        break;
      case "error":
        setError(e.message);
        break;
      case "tool_start":
        setRunning((r) => ({ ...r, [e.callId]: e.startedAt }));
        break;
      // 终端实时输出、确认请求：交给 liveStore，Trace 里对应的那一行自己订阅（src/lib/live.ts）
      case "tool_output":
      case "approval":
      case "approval_end":
        liveStore.apply(e);
        break;
      case "done":
        setRunning({});
        liveStore.reset();
        break;
    }
  }, []);

  /**
   * 事件按“帧”合并：本地模型每秒能推几百个事件，每个都更新状态会让页面重绘几百次而卡住。
   * 先放进队列，每帧（约 16ms）统一处理一次，并把相邻的文字增量拼成一个。
   */
  const batcher = useMemo(() => {
    let queue: AgentEvent[] = [];
    let raf = 0;
    const flush = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      const evs = coalesce(queue);
      queue = [];
      for (const e of evs) apply(e);
    };
    const push = (e: AgentEvent) => {
      queue.push(e);
      if (!raf) raf = requestAnimationFrame(flush);
    };
    return { push, flush };
  }, [apply]);

  /**
   * 发送。text 不传 = 发输入框里的内容；提问卡片点选项时直接传回答。
   * 运行中发送 = 补充想法：放进服务端队列，agent 下一步就能看到（不打断当前运行）
   */
  async function send(text = draft.trim()) {
    text = text.trim();
    if (!text) return;
    setDraft("");
    if (streaming && curIdRef.current) {
      const tmp: StoredMessage = { id: "tmpnote" + Date.now(), role: "user", content: text, feedback: { kind: "note", summary: text }, createdAt: Date.now() };
      setCur((c) => ({ ...c, messages: [...c.messages, tmp] }));
      pendingNotes.current.push(text);
      if (await api.note(curIdRef.current, text).catch(() => false)) return;
      // 服务端说已经不在运行了。如果本地的运行也已结束（finally 已经跑过），就直接当新消息发；
      // 否则留在 pendingNotes 里，等 start 的 finally 统一补发
      if (!abortRef.current) {
        pendingNotes.current.splice(pendingNotes.current.indexOf(text), 1);
        setCur((c) => ({ ...c, messages: c.messages.filter((m) => m.id !== tmp.id) }));
        await start(text);
      }
      return;
    }
    if (!streaming) await start(text);
  }

  /**
   * 重新生成 / 编辑后重发：从某条用户消息开始往后的内容都不要了，用 text 重新发一遍。
   * 先在界面上把那一段去掉（马上有反应），服务端收到 truncateFrom 后也会删掉同样的部分
   */
  async function resend(fromId: string, text: string) {
    text = text.trim();
    if (!text || streaming || !curIdRef.current) return;
    if (fromId.startsWith("tmp")) return; // 还没存到服务端的临时消息，没法从它截断
    await start(text, fromId);
  }

  async function start(text: string, truncate?: string) {
    setError(null);
    const tmp: StoredMessage = { id: "tmp" + Date.now(), role: "user", content: text, createdAt: Date.now() };
    setCur((c) => {
      const cut = truncate ? c.messages.findIndex((m) => m.id === truncate) : -1;
      const keep = cut >= 0 ? c.messages.slice(0, cut) : c.messages;
      const since = cut >= 0 ? c.messages[cut].createdAt : Infinity;
      return { ...c, messages: [...keep, tmp], artifacts: c.artifacts.filter((a) => a.createdAt < since) };
    });
    setStreaming(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await streamChat(
        { sessionId: curIdRef.current || undefined, message: text, truncateFrom: truncate, projectId: curIdRef.current ? undefined : curProjectRef.current },
        batcher.push,
        ac.signal,
      );
    } catch (err) {
      if (!ac.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      batcher.flush();
      if (settings.skills && !ac.signal.aborted) setRunEnd(Date.now());
      if (abortRef.current === ac) {
        abortRef.current = null;
        setStreaming(false);
      }
      setSessions((l) => {
        const id = curIdRef.current;
        const i = l.findIndex((s) => s.id === id);
        if (i <= 0) return l;
        return [{ ...l[i], updatedAt: Date.now() }, ...l.slice(0, i), ...l.slice(i + 1)];
      });
      // 运行结束时还有没被 agent 收到的补充想法（结束前一瞬间才发的）：当作下一条消息自动发出去
      const left = pendingNotes.current.splice(0);
      if (left.length && !ac.signal.aborted) {
        setCur((c) => ({ ...c, messages: c.messages.filter((m) => !m.id.startsWith("tmpnote")) }));
        await start(left.join("\n"));
      }
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
      } else if (e.key === "Escape" && uiRef.current.view && !abortRef.current) {
        e.preventDefault();
        setView(null);
      } else if (e.key === "Escape" && abortRef.current) {
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

  const model = currentOption(settings).group === "内置" ? currentOption(settings).label : `${currentOption(settings).group} · ${currentOption(settings).label}`;
  const pickModel = async (value: string) => {
    setSettings((s) => ({ ...s, currentModel: value }));
    setSettings(await api.saveSettings({ currentModel: value }));
  };

  const { outputs, used } = useMemo(() => collectOutputs(cur.messages, cur.artifacts), [cur.messages, cur.artifacts]);
  // 打开文件时任务面板不收起：面板是“钉住”的，只有点它的 × 才关
  // 打开一个文件 / 产出物时顺手收起任务面板（2026-10-29）：右侧只留文件视图，不再和面板并排挤在一起。
  // 想再看面板就点对话标题栏右边的按钮
  const openView = (v: View) => {
    setView(v);
    setListOpen(false);
  };
  // 开关任务面板（标题栏按钮和 ⌘\ 共用）：打开面板时把文件视图收起，右侧同一时间只显示一个（2026-10-29）
  const toggleList = () => {
    if (!uiRef.current.listOpen) setView(null);
    setListOpen((o) => !o);
  };
  // 右侧状态变化时记下来（按对话分开存）。切换对话时 open() 会把新对话的状态一次性设好，这里存的就是新对话自己的
  useEffect(() => {
    if (cur.id) savePanels(cur.id, { view, list: listOpen });
  }, [cur.id, view, listOpen]);

  // 任务面板：点空白处、按 Esc 都不会关；点面板右上角的 ×、或打开文件 / 产出物时收起（快捷键 ⌘\ 仍可切换）

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
  const hasSteps = cur.messages.some((m) => m.toolCalls?.length || m.drafts?.length);

  // 项目页只在“还没发消息的项目新对话”时显示；打开别的对话、发了消息、进产出物页，它自然就不满足了
  const homeProject =
    page === "chat" && projectHome && !cur.id && cur.messages.length === 0 && cur.projectId === projectHome
      ? projects.find((p) => p.id === projectHome)
      : undefined;
  const sessionsKey = sessions.filter((s) => s.projectId === homeProject?.id).map((s) => `${s.id}:${s.updatedAt}:${s.title}`).join("|");
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
    model,
    userName: settings.name,
    modKey,
    groups,
    onGroupsChange: changeGroups,
    onOpenSettings: setSettingsTab,
    onNew: () => newChat(),
    onOpen: (id: string) => void open(id),
    artifactsActive: page === "artifacts",
    onOpenArtifacts: () => setPage("artifacts"),
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
  };

  return (
    <div
      className={`app ${showLeft ? "left-open" : ""} ${view ? "right-open" : ""} ${resizing ? "resizing" : ""}`}
      style={viewW ? ({ "--canvas-w": `${viewW}px` } as React.CSSProperties) : undefined}
    >
      {showLeft ? (
        <Sidebar {...sidebarProps} onCollapse={() => setLeftOpen(false)} />
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
          leftOpen={showLeft}
          modKey={modKey}
          onToggleLeft={expandLeft}
          onOpen={(sid, aid, file) => void open(sid, aid, file)}
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
          home={
            homeProject && {
              head: <ProjectHead project={homeProject} onIcon={(i) => setProjectIcon(homeProject.id, i)} onSettings={() => setProjectModal(homeProject)} />,
              chats: <ProjectChats chats={projectChats} onOpen={(id) => void open(id)} />,
            }
          }
          title={cur.title}
          projectName={projects.find((p) => p.id === cur.projectId)?.name}
          projectIcon={projects.find((p) => p.id === cur.projectId)?.icon}
          onProjectIcon={cur.projectId ? (icon: string) => setProjectIcon(cur.projectId!, icon) : undefined}
          onRename={cur.id ? (t: string) => rename(cur.id, t) : undefined}
          messages={cur.messages}
          artifacts={cur.artifacts}
          outputs={outputs}
          onOpenView={openView}
          hasSteps={hasSteps}
          running={running}
          streaming={streaming}
          error={error}
          draft={draft}
          setDraft={setDraft}
          inputRef={inputRef}
          leftOpen={showLeft}
          rightOpen={listOpen}
          viewOpen={!!view}
          sendKey={settings.sendKey}
          bar={
            <ComposerBar
              settings={settings}
              messages={cur.messages}
              systemTokens={fixedTokens.system}
              toolsTokens={fixedTokens.tools}
              onPickModel={pickModel}
              onManage={() => setSettingsTab("model")}
              onUsage={() => setSettingsTab("usage")}
            />
          }
          modKey={modKey}
          onSend={sendDraft}
          attachments={attachments}
          onAttach={attach}
          onRemoveAttachment={(k) => setAttachments((l) => l.filter((a) => a.key !== k))}
          onAnswer={(t) => send(t)}
          onResend={(id, t) => void resend(id, t)}
          sessionId={cur.id}
          loading={!!loadingId}
          onStop={stop}
          onOpenArtifact={(id) => openView({ type: "artifact", id })}
          onOpenFile={(path) => openView({ type: "file", path })}
          onToggleLeft={expandLeft}
          onToggleRight={toggleList}
          userName={settings.name !== DEFAULT_SETTINGS.name ? settings.name : user}
          onDismissError={() => setError(null)}
        />
      )}
      {/* 右侧一列：任务面板（钉住时）和文件大视图并排放在同一列里，不再悬浮盖住对话。
          面板在左、文件在右：从面板点文件，文件就在它旁边打开 */}
      {page === "chat" && (view || listOpen) && (
        <div className={`right ${listOpen ? "with-panel" : ""} ${view ? "" : "panel-only"}`}>
          {/* 分隔条：按住左右拖动调整宽度，双击恢复默认 */}
          {view && <div className="resize-handle" onPointerDown={startResize} onDoubleClick={() => saveViewW(null)} title="拖动调整宽度，双击恢复" />}
          {listOpen && (
            <OutputsCard
              messages={cur.messages}
              artifacts={cur.artifacts}
              running={running}
              streaming={streaming}
              outputs={outputs}
              used={used}
              active={view}
              onOpen={openView}
              onClose={() => setListOpen(false)}
            />
          )}
          {view && (
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
