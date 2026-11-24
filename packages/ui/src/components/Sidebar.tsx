"use client";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, DragEvent } from "react";
import type { Groups, Project, SessionMeta } from "../../../protocol/src/lib/shared";
import type { ConversationView } from "./ChatPane";
import { CoreLogo } from "./CoreLogo";
import { AgentIcon, IArchive, IChart, IChevron, IClock, ICode, IDoc, IFile, IFolder, IGlobe, IMore, IPanelLeft, IPencil, IPlus, IGear, IFolderPlusLine, ILayersLine, IRetry, ISearchLine, ITable, IX } from "./Icons";
import "./Sidebar.css";
import { UserMenu, type SettingsTab } from "./UserMenu";

export interface QuickAction {
  label: string;
  prefix: string;
  icon: React.ReactNode | null;
}

/** 空白对话页上的快捷开头：点一下把常用开头填进输入框 */
export const QUICK_ACTIONS: QuickAction[] = [
  { label: "写文档", prefix: "写一份文档：", icon: <IDoc /> },
  { label: "做网页", prefix: "做一个网页：", icon: <IGlobe /> },
  { label: "写代码", prefix: "写一段代码：", icon: <ICode /> },
  { label: "整理表格", prefix: "整理成表格：", icon: <ITable /> },
];

/** “未分组”没有真实的分组 id，用空字符串代表 */
const UNGROUPED = "";
const DRAG_TYPE = "text/a-session";
const ARCHIVE_FOLD = ":archive";
/** 侧栏折叠偏好：分组默认展开，项目和归档区默认收起。 */
let foldedCache: Set<string> | null = null;

/**
 * 左栏：logo + 新建 + 项目 + 分组（对话分组）+ 用户菜单。
 * - 项目：搜索下面的“新建项目”弹出窗口填名字和设置；建好的项目才出现在“项目”列表里，展开能看到里面的对话
 * - 对话不按时间划分，而是按用户自建的分组；新对话都在“未分组”
 * - 把对话拖到另一个分组上松手，就移过去（HTML5 原生拖拽，不需要库）
 * - floating：收起后鼠标移到窗口左边缘时弹出的悬浮版本
 */
export function Sidebar(props: {
  sessions: SessionMeta[];
  currentId?: string;
  viewingDetails: boolean;
  model: string;
  userName: string;
  modKey: string;
  groups: Groups;
  projects: Project[];
  floating?: boolean;
  resizeHandle?: React.ReactNode;
  onGroupsChange(g: Groups): void;
  onOpenSettings(tab: SettingsTab): void;
  onNew(): void;
  onOpen(id: string, view?: ConversationView): void;
  onDelete(id: string): void;
  onRename(id: string, title: string): void;
  onArchive(target: "session" | "project", id: string, archived: boolean): void;
  onAgentLog(id?: string): void;
  /** 项目：新建（弹窗）、改设置（弹窗）、删除、在项目里新建对话、把对话移进 / 移出项目（null） */
  onNewProject(): void;
  /** “产出物”页面：打开它；当前是否正在看它（高亮这一行） */
  onOpenArtifacts(): void;
  artifactsActive?: boolean;
  onEditProject(p: Project): void;
  onDeleteProject(id: string): void;
  onNewInProject(id: string): void;
  /** 点项目名：打开项目页 */
  onOpenProject(id: string): void;
  /** 当前打开的项目页（左栏这一行高亮） */
  projectHomeId?: string;
  onMoveToProject(sessionId: string, projectId: string | null): void;
  /** 固定模式下是“收起”，悬浮模式下是“固定” */
  onCollapse(): void;
  onMouseEnter?(): void;
  onMouseLeave?(): void;
}) {
  const { currentId, model, modKey, groups } = props;
  const projects = props.projects.filter((project) => !project.archivedAt);
  const archivedProjects = props.projects.filter((project) => project.archivedAt);
  const archivedProjectIds = new Set(archivedProjects.map((project) => project.id));
  const archivedSessions = props.sessions.filter((session) => session.archivedAt || (session.projectId && archivedProjectIds.has(session.projectId)));
  // 项目和它的对话保持父子关系，单独归档的对话直接列在归档区。
  const archivedByProject = new Map<string, SessionMeta[]>();
  const archivedChats: SessionMeta[] = [];
  for (const session of archivedSessions) {
    const pid = session.projectId;
    if (pid && archivedProjectIds.has(pid)) {
      const items = archivedByProject.get(pid) ?? [];
      items.push(session);
      archivedByProject.set(pid, items);
    } else archivedChats.push(session);
  }
  const sessions = props.sessions.filter((session) => !session.archivedAt && (!session.projectId || !archivedProjectIds.has(session.projectId)));
  const [q, setQ] = useState("");
  /** 搜索：平时只是“新建”下面的一行“搜索”，点了才变成输入框 */
  const [searching, setSearching] = useState(false);
  const closeSearch = () => {
    setQ("");
    setSearching(false);
  };
  /** 打开了“…”菜单的项目 */
  const [projMenu, setProjMenu] = useState<string | null>(null);
  // 折叠偏好存在 localStorage，并在模块变量里留一份。
  // 左栏收起 / 展开时 Sidebar 会被卸载再重新挂载，组件里的 state 会丢；重新挂载时直接从模块变量取，不会闪一下
  const [folded, setFolded] = useState<Set<string>>(() => foldedCache ?? new Set());
  const archiveOpen = folded.has(ARCHIVE_FOLD);
  useEffect(() => {
    if (foldedCache) return;
    try {
      foldedCache = new Set(JSON.parse(localStorage.getItem("a.folded") || "[]"));
      setFolded(foldedCache);
    } catch {}
  }, []);
  const [editing, setEditing] = useState<string | null>(null);
  /** 正在改名的对话 */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  /** 拖到某一行上时，插入线画在这一行的上面还是下面 */
  const [rowDrop, setRowDrop] = useState<{ id: string; after: boolean } | null>(null);
  /** 右键和“…”共用一个菜单，定位到窗口以避开项目与分组列表的滚动裁切。 */
  const [menu, setMenu] = useState<{ id: string; position: CSSProperties } | null>(null);
  function showSessionMenu(id: string, row: HTMLElement) {
    const rect = row.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    const above = below < 216 && rect.top > below;
    setProjMenu(null);
    setMenu({
      id,
      position: {
        right: window.innerWidth - rect.right + 4,
        top: above ? "auto" : rect.bottom + 2,
        bottom: above ? window.innerHeight - rect.top + 2 : undefined,
        maxHeight: (above ? rect.top : below) - 8,
      },
    });
  }

  useEffect(() => {
    if (!menu && !projMenu) return;
    const close = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest?.(".row-menu, .more")) return;
      setMenu(null);
      setProjMenu(null);
    };
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setMenu(null);
      setProjMenu(null);
    };
    const closeOnMove = (e: Event) => {
      if (e.type === "scroll") {
        const target = e.target as HTMLElement | null;
        if (!target?.closest?.(".side") || target.closest(".session-view-menu")) return;
      }
      setMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape);
    if (menu) {
      window.addEventListener("scroll", closeOnMove, true);
      window.addEventListener("resize", closeOnMove);
    }
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("scroll", closeOnMove, true);
      window.removeEventListener("resize", closeOnMove);
    };
  }, [menu, projMenu]);

  // 每个分组里的对话，组内按最近更新排序（sessions 本身已排好）
  const byGroup = useMemo(() => {
    const valid = new Set(groups.groups.map((g) => g.id));
    const m = new Map<string, SessionMeta[]>();
    const kw = q.trim().toLowerCase();
    for (const s of sessions) {
      if (kw && !s.title.toLowerCase().includes(kw)) continue;
      if (s.projectId) continue; // 项目里的对话只显示在项目下面，不再出现在分组里
      const gid = valid.has(groups.assign[s.id]) ? groups.assign[s.id] : UNGROUPED;
      m.set(gid, [...(m.get(gid) ?? []), s]);
    }
    // 组内排序：没拖过的（新对话）按最近更新排在最上面，拖过的按 order 里的先后
    const rank = new Map((groups.order ?? []).map((id, i) => [id, i]));
    for (const [gid, list] of m) {
      const fresh = list.filter((s) => !rank.has(s.id));
      const placed = list.filter((s) => rank.has(s.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
      m.set(gid, [...fresh, ...placed]);
    }
    return m;
  }, [sessions, groups, q]);

  // 自建分组在上（新建的在最前面），“未分组”放在最下面
  const sections = [...groups.groups, { id: UNGROUPED, name: "未分组" }];

  // 每个项目里的对话（同样按最近更新排序；搜索时一起筛选）
  const byProject = useMemo(() => {
    const m = new Map<string, SessionMeta[]>();
    const kw = q.trim().toLowerCase();
    for (const s of sessions)
      if (s.projectId && (!kw || s.title.toLowerCase().includes(kw))) m.set(s.projectId, [...(m.get(s.projectId) ?? []), s]);
    return m;
  }, [sessions, q]);

  function move(sessionId: string, gid: string) {
    // 从项目里拖到分组：先移出项目
    if (sessions.find((x) => x.id === sessionId)?.projectId) props.onMoveToProject(sessionId, null);
    const assign = { ...groups.assign };
    if (gid === UNGROUPED) delete assign[sessionId];
    else assign[sessionId] = gid;
    // 拖到分组标题上：不指定位置，排到这个组的最上面
    props.onGroupsChange({ ...groups, assign, order: (groups.order ?? []).filter((x) => x !== sessionId) });
  }
  /** 拖到某个分组里某一行的上面 / 下面：先归到这个组，再把这个组的顺序整体写进 order */
  function placeAt(sessionId: string, gid: string, targetId: string, after: boolean) {
    if (sessionId === targetId) return;
    if (sessions.find((x) => x.id === sessionId)?.projectId) props.onMoveToProject(sessionId, null);
    const assign = { ...groups.assign };
    if (gid === UNGROUPED) delete assign[sessionId];
    else assign[sessionId] = gid;
    const list = (byGroup.get(gid) ?? []).map((s) => s.id).filter((id) => id !== sessionId);
    const at = list.indexOf(targetId);
    list.splice(after ? at + 1 : at, 0, sessionId);
    const inList = new Set(list);
    props.onGroupsChange({ ...groups, assign, order: [...(groups.order ?? []).filter((id) => !inList.has(id)), ...list] });
  }
  function addGroup() {
    const id = "g" + Date.now().toString(36);
    props.onGroupsChange({ ...groups, groups: [{ id, name: "新分组" }, ...groups.groups] });
    setEditing(id);
  }
  function rename(id: string, name: string) {
    setEditing(null);
    const n = name.trim();
    if (n) props.onGroupsChange({ ...groups, groups: groups.groups.map((g) => (g.id === id ? { ...g, name: n } : g)) });
  }
  function removeGroup(id: string) {
    // 删除分组不删对话：里面的对话回到“未分组”
    const assign = Object.fromEntries(Object.entries(groups.assign).filter(([, gid]) => gid !== id));
    props.onGroupsChange({ groups: groups.groups.filter((g) => g.id !== id), assign });
  }
  const toggleFold = (id: string) =>
    setFolded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      foldedCache = n;
      try {
        localStorage.setItem("a.folded", JSON.stringify([...n]));
      } catch {}
      return n;
    });

  const dropHandlers = (gid: string, onDrop: (sessionId: string) => void = (id) => move(id, gid)) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dropOn !== gid) setDropOn(gid);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropOn((v) => (v === gid ? null : v));
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const id = e.dataTransfer.getData(DRAG_TYPE);
      setDropOn(null);
      // 拖到别的分组后这一行会在新位置重新创建，原来那个元素收不到 dragend，所以在这里清掉“拖动中”的半透明状态
      setDragging(null);
      setRowDrop(null);
      if (id) onDrop(id);
    },
  });

  /**
   * 一行对话共用标题、文件标记和选中样式。归档行可打开历史，右侧提供日志和独立恢复。
   * 传了 gid（在分组里）时，这一行本身也能接住拖拽：鼠标在上半截插到它上面，下半截插到它下面。
   */
  const renderRow = (s: SessionMeta, gid?: string, archived = false) => (
    <div
      key={s.id}
      className={`side-item session ${s.id === currentId ? "active" : ""} ${dragging === s.id ? "dragging" : ""} ${menu?.id === s.id ? "menu-open" : ""} ${
        rowDrop?.id === s.id ? (rowDrop.after ? "drop-after" : "drop-before") : ""
      }`}
      draggable={!archived && renaming !== s.id}
      onDragStart={(e) => {
        if (archived) { e.preventDefault(); return; }
        e.dataTransfer.setData(DRAG_TYPE, s.id);
        e.dataTransfer.effectAllowed = "move";
        setDragging(s.id);
      }}
      onDragEnd={() => (setDragging(null), setDropOn(null), setRowDrop(null))}
      {...(gid !== undefined && {
        onDragOver: (e: DragEvent) => {
          if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
          const r = e.currentTarget.getBoundingClientRect();
          const after = e.clientY > r.top + r.height / 2;
          if (rowDrop?.id !== s.id || rowDrop.after !== after) setRowDrop({ id: s.id, after });
          if (dropOn !== gid) setDropOn(gid);
        },
        onDragLeave: (e: DragEvent) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setRowDrop((v) => (v?.id === s.id ? null : v));
        },
        onDrop: (e: DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          const id = e.dataTransfer.getData(DRAG_TYPE);
          const after = rowDrop?.id === s.id ? rowDrop.after : false;
          setRowDrop(null);
          setDropOn(null);
          setDragging(null);
          if (id) placeAt(id, gid, s.id, after);
        },
      })}
      onClick={() => renaming !== s.id && props.onOpen(s.id)}
      onContextMenu={(e) => {
        if (renaming === s.id) return;
        e.preventDefault();
        e.stopPropagation();
        showSessionMenu(s.id, e.currentTarget);
      }}
      title={s.title}
    >
      {archived ? (
        <button type="button" className="ellipsis archive-name" onClick={(e) => (e.stopPropagation(), props.onOpen(s.id))}>{s.title}</button>
      ) : renaming === s.id ? (
        <NameInput
          value={s.title}
          onDone={(v) => {
            setRenaming(null);
            if (v && v !== s.title) props.onRename(s.id, v);
          }}
        />
      ) : (
        // 在详情页单击当前对话可返回正文，正文里的标题单击仍用于改名。
        <span
          className="ellipsis"
          onClick={(e) => s.id === currentId && !props.viewingDetails && (e.stopPropagation(), setRenaming(s.id))}
          onDoubleClick={(e) => (e.stopPropagation(), setRenaming(s.id))}
        >
          {s.title}
        </span>
      )}
      {archived ? (
        <>
          {s.hasFiles && <IFile width={13} height={13} />}
          <div className="archive-actions">
            <button type="button" className="grp-act show" title="查看日志" onClick={(e) => (e.stopPropagation(), props.onAgentLog(s.id))}>
              <IClock width={13} height={13} />
            </button>
            {s.archivedAt && (
              <button type="button" className="grp-act show" title="恢复对话" onClick={(e) => (e.stopPropagation(), props.onArchive("session", s.id, false))}>
                <IRetry width={13} height={13} />
              </button>
            )}
          </div>
        </>
      ) : (
        // 活跃对话有产出时平时显示文件图标，鼠标移上来换成“…”菜单。
        <span className="row-end">
          {s.hasFiles && <IFile className="has-file" width={13} height={13} />}
          <button type="button" className="more" title="更多" aria-expanded={menu?.id === s.id} onClick={(e) => {
            e.stopPropagation();
            if (menu?.id === s.id) setMenu(null);
            else {
              const row = e.currentTarget.closest<HTMLElement>(".side-item.session");
              if (row) showSessionMenu(s.id, row);
            }
          }}>
            <IMore width={14} height={14} />
          </button>
        </span>
      )}
      {menu?.id === s.id && (
        <div className="row-menu session-view-menu" style={menu.position} onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}>
          {([["trace", "轨迹", IClock], ["stats", "统计", IChart], ["subagents", "子任务", ILayersLine]] as const).map(([view, label, Icon]) => (
            <button type="button" key={view} className="pop-item" onClick={() => (setMenu(null), props.onOpen(s.id, view))}>
              <Icon width={13} height={13} />
              {label}
            </button>
          ))}
          {!archived && (
            <>
              <div className="pop-sep" />
              <button className="pop-item" onClick={() => (setMenu(null), setRenaming(s.id))}>
                <IPencil width={13} height={13} />
                重命名
              </button>
              {/* 移到项目：列出全部项目；已经在项目里的对话多一个“移出项目” */}
              {projects
                .filter((p) => p.id !== s.projectId)
                .map((p) => (
                  <button key={p.id} className="pop-item" onClick={() => (setMenu(null), props.onMoveToProject(s.id, p.id))}>
                    <IFolder width={13} height={13} />
                    <span className="ellipsis">移到“{p.name}”</span>
                  </button>
                ))}
              {s.projectId && (
                <button className="pop-item" onClick={() => (setMenu(null), props.onMoveToProject(s.id, null))}>
                  <IFolder width={13} height={13} />
                  移出项目
                </button>
              )}
              <button className="pop-item" onClick={() => (setMenu(null), props.onArchive("session", s.id, true))}>
                <IArchive width={13} height={13} />
                归档对话
              </button>
              <button className="pop-item danger" onClick={() => (setMenu(null), props.onDelete(s.id))}>
                <IX width={13} height={13} />
                删除
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );

  /** 项目与归档项目共用文件夹行和子对话缩进，归档项目的右侧只提供恢复。 */
  function renderProject(p: Project, items: SessionMeta[]) {
    const archived = !!p.archivedAt;
    const key = "p:" + p.id;
    // 普通项目在搜索或打开其中一条对话时自动展开，归档项目由箭头独立控制。
    const isFolded = !folded.has(key) && (archived || (!q && !items.some((x) => x.id === currentId)));
    return (
      <div key={p.id} className={`grp proj-grp ${dropOn === key ? "drop" : ""}`} {...(!archived && dropHandlers(key, (sid) => props.onMoveToProject(sid, p.id)))}>
        <div
          className={`grp-head proj-head ${projMenu === p.id ? "menu-open" : ""} ${props.projectHomeId === p.id ? "on" : ""}`}
          onClick={() => props.onOpenProject(p.id)}
          title={p.description || p.name}
        >
          <button type="button" className="proj-fold" title={isFolded ? "展开" : "收起"} aria-expanded={!isFolded} onClick={(e) => (e.stopPropagation(), toggleFold(key))}>
            <IChevron width={10} height={10} className={`grp-chev ${isFolded ? "" : "rot"}`} />
          </button>
          <AgentIcon name={p.icon || "folder"} width={14} height={14} className="proj-ico" />
          {archived ? (
            <button type="button" className="grp-name archive-name" onClick={(e) => (e.stopPropagation(), props.onOpenProject(p.id))}>{p.name}</button>
          ) : <span className="grp-name ellipsis">{p.name}</span>}
          <span className="grp-count">{items.length || ""}</span>
          {archived ? (
            <div className="archive-actions">
              <button type="button" className="grp-act show" title="恢复项目" onClick={(e) => (e.stopPropagation(), props.onArchive("project", p.id, false))}>
                <IRetry width={13} height={13} />
              </button>
            </div>
          ) : (
            <>
              <button className="grp-act" title="在这个项目里新建对话" onClick={(e) => {
                e.stopPropagation();
                if (isFolded) toggleFold(key);
                props.onNewInProject(p.id);
              }}>
                <IPlus width={12} height={12} />
              </button>
              <button className="grp-act more" title="项目设置" onClick={(e) => (e.stopPropagation(), setProjMenu(projMenu === p.id ? null : p.id))}>
                <IMore width={13} height={13} />
              </button>
              {projMenu === p.id && (
                <div className="row-menu" onClick={(e) => e.stopPropagation()}>
                  <button className="pop-item" onClick={() => (setProjMenu(null), props.onEditProject(p))}>
                    <IGear width={13} height={13} />
                    项目设置
                  </button>
                  <button className="pop-item" onClick={() => (setProjMenu(null), props.onArchive("project", p.id, true))}>
                    <IArchive width={13} height={13} />
                    归档项目
                  </button>
                  <button
                    className="pop-item danger"
                    onClick={() => (setProjMenu(null), confirm(`删除项目“${p.name}”？里面的对话不会删除，会回到“分组”里。`) && props.onDeleteProject(p.id))}
                  >
                    <IX width={13} height={13} />
                    删除项目
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        {!isFolded && <div className="grp-items">{items.map((s) => renderRow(s, undefined, archived))}</div>}
      </div>
    );
  }

  return (
    <aside id={props.resizeHandle ? "workspace-sidebar" : undefined} className={`side ${props.floating ? "floating" : ""}`} onMouseEnter={props.onMouseEnter} onMouseLeave={props.onMouseLeave}>
      {props.resizeHandle}
      {/* 顶部：收起按钮在最左边，后面是 logo 和 “A.ai”（字体 Manrope，见 layout.tsx 和 Sidebar.css） */}
      <div className="side-head">
        <button className="icon-btn side-collapse" onClick={props.onCollapse} title={props.floating ? `固定左栏 ${modKey}B` : `收起 ${modKey}B`}>
          <IPanelLeft />
        </button>
        <span className="brand">
          <CoreLogo size={32} className="logo" />
          <span className="brand-text">A.ai</span>
        </span>
      </div>

      <button className="new-btn" onClick={props.onNew}>
        <span className="plus">
          <IPlus width={13} height={13} />
        </span>
        <span>新建</span>
        <kbd>{modKey}K</kbd>
      </button>

      {/* 搜索：和“新建”一样的一行。点一下原地变成输入框，边输边筛选下面的对话；Esc 或清空后点别处就收回 */}
      {searching ? (
        <div className="side-search-box">
          <span className="ico">
            <ISearchLine width={14} height={14} />
          </span>
          <input
            autoFocus
            placeholder="搜索对话"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && closeSearch()}
            onBlur={() => !q.trim() && closeSearch()}
          />
          <button className="icon-btn" onMouseDown={(e) => e.preventDefault()} onClick={closeSearch} title="关闭搜索 Esc">
            <IX width={11} height={11} />
          </button>
        </div>
      ) : (
        <button className="new-btn search-btn" onClick={() => setSearching(true)}>
          <span className="plus">
            <ISearchLine width={14} height={14} />
          </span>
          <span>搜索</span>
        </button>
      )}

      {/* 新建项目：和“新建”“搜索”同样的一行，点了弹出窗口（Workspace 里的 ProjectModal） */}
      <button className="new-btn search-btn" onClick={props.onNewProject}>
        <span className="plus">
          <IFolderPlusLine width={14} height={14} />
        </span>
        <span>新建项目</span>
      </button>

      {/* 产出物：所有对话里做出来的网页、文档、代码集中在一页（ArtifactsPage） */}
      <button className={`new-btn search-btn ${props.artifactsActive ? "on" : ""}`} onClick={props.onOpenArtifacts}>
        <span className="plus">
          <ILayersLine width={14} height={14} />
        </span>
        <span>产出物</span>
      </button>

      {/* 项目列表：只显示已经建好的项目；一个都没有时整块不出现 */}
      {projects.length > 0 && (
        <div className="side-section proj">
          <div className="side-label row">
            <span>项目</span>
          </div>
          {projects.map((p) => {
            const items = byProject.get(p.id) ?? [];
            return q && !items.length ? null : renderProject(p, items);
          })}
        </div>
      )}

      {(archivedProjects.length > 0 || archivedSessions.length > 0) && (
        <section className="side-section archive-section" aria-label="归档">
          <button type="button" className="side-label row toggle archive-toggle" aria-expanded={archiveOpen} onClick={() => toggleFold(ARCHIVE_FOLD)}>
            <span>已归档</span>
            <span className="grp-count">{archivedProjects.length + archivedSessions.length}</span>
            <span className="grp-act show" aria-hidden="true">
              <IChevron width={10} height={10} className={`grp-chev ${archiveOpen ? "rot" : ""}`} />
            </span>
          </button>
          {archiveOpen && (
            <div className="grp-items archive-items">
              {archivedProjects.map((p) => renderProject(p, archivedByProject.get(p.id) ?? []))}
              {archivedChats.map((s) => renderRow(s, undefined, true))}
            </div>
          )}
        </section>
      )}

      <div className="side-section grow">
        <div className="side-label row">
          <span>分组</span>
          <button className="grp-act show" onClick={addGroup} title="新建分组">
            <IPlus width={12} height={12} />
          </button>
        </div>

        <div className="side-list">
          {q.trim() && !sections.some((g) => byGroup.get(g.id)?.length) && <div className="side-empty">没有找到“{q.trim()}”</div>}
          {sections.map((g) => {
            const items = byGroup.get(g.id) ?? [];
            if (q && !items.length) return null;
            const isFolded = folded.has(g.id) && !q;
            return (
              <div key={g.id || "_"} className={`grp ${dropOn === g.id ? "drop" : ""}`} {...dropHandlers(g.id)}>
                <div className="grp-head" onClick={() => editing !== g.id && toggleFold(g.id)} onDoubleClick={() => g.id && setEditing(g.id)}>
                  <IChevron width={10} height={10} className={`grp-chev ${isFolded ? "" : "rot"}`} />
                  {editing === g.id ? (
                    <input
                      className="grp-input"
                      autoFocus
                      defaultValue={g.name}
                      onFocus={(e) => e.currentTarget.select()}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => rename(g.id, e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") setEditing(null);
                      }}
                    />
                  ) : (
                    <span className="grp-name">{g.name}</span>
                  )}
                  <span className="grp-count">{items.length || ""}</span>
                  {g.id && editing !== g.id && (
                    <>
                      <button className="grp-act" title="重命名" onClick={(e) => (e.stopPropagation(), setEditing(g.id))}>
                        <IPencil width={12} height={12} />
                      </button>
                      <button className="grp-act danger" title="删除分组（对话回到未分组）" onClick={(e) => (e.stopPropagation(), removeGroup(g.id))}>
                        <IX width={12} height={12} />
                      </button>
                    </>
                  )}
                </div>

                {!isFolded && (
                  <div className="grp-items">
                    {items.map((s) => renderRow(s, g.id))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <UserMenu name={props.userName} model={model} modKey={modKey} onOpenSettings={props.onOpenSettings} />
    </aside>
  );
}

/** 改名输入框：回车或点别处保存，Esc 取消 */
export function NameInput({ value, onDone, className = "grp-input" }: { value: string; onDone(v: string | null): void; className?: string }) {
  return (
    <input
      className={className}
      autoFocus
      defaultValue={value}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => onDone(e.currentTarget.value.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") onDone(null);
      }}
    />
  );
}
