"use client";
import { useEffect, useMemo, useState } from "react";
import type { DragEvent } from "react";
import type { Groups, Project, SessionMeta } from "@/lib/shared";
import { CoreLogo } from "./CoreLogo";
import { IChevron, ICode, IDoc, IFile, IFolder, IGlobe, IFolderPlus, IMore, IPanelLeft, IPencil, IPlus, IGear, ILayers, ISearch, ITable, IX } from "./Icons";
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
/** 收起的分组 id（见 Sidebar 里的 folded） */
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
  model: string;
  userName: string;
  modKey: string;
  groups: Groups;
  projects: Project[];
  floating?: boolean;
  onGroupsChange(g: Groups): void;
  onOpenSettings(tab: SettingsTab): void;
  onNew(): void;
  onOpen(id: string): void;
  onDelete(id: string): void;
  onRename(id: string, title: string): void;
  /** 项目：新建（弹窗）、改设置（弹窗）、删除、在项目里新建对话、把对话移进 / 移出项目（null） */
  onNewProject(): void;
  /** “产出物”页面：打开它；当前是否正在看它（高亮这一行） */
  onOpenArtifacts(): void;
  artifactsActive?: boolean;
  onEditProject(p: Project): void;
  onDeleteProject(id: string): void;
  onNewInProject(id: string): void;
  onMoveToProject(sessionId: string, projectId: string | null): void;
  /** 固定模式下是“收起”，悬浮模式下是“固定” */
  onCollapse(): void;
  onMouseEnter?(): void;
  onMouseLeave?(): void;
}) {
  const { sessions, currentId, model, modKey, groups } = props;
  const [q, setQ] = useState("");
  /** 搜索：平时只是“新建”下面的一行“搜索”，点了才变成输入框 */
  const [searching, setSearching] = useState(false);
  const closeSearch = () => {
    setQ("");
    setSearching(false);
  };
  /** 打开了“…”菜单的项目 */
  const [projMenu, setProjMenu] = useState<string | null>(null);
  // 收起的分组：存在 localStorage，并在模块变量里留一份。
  // 左栏收起 / 展开时 Sidebar 会被卸载再重新挂载，组件里的 state 会丢；重新挂载时直接从模块变量取，不会闪一下
  const [folded, setFolded] = useState<Set<string>>(() => foldedCache ?? new Set());
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
  /** 打开了“…”菜单的对话 */
  const [menu, setMenu] = useState<string | null>(null);
  useEffect(() => {
    if (!menu && !projMenu) return;
    const close = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest?.(".row-menu, .more")) return;
      setMenu(null);
      setProjMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
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
    return m;
  }, [sessions, groups, q]);

  const sections = [{ id: UNGROUPED, name: "未分组" }, ...groups.groups];

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
    props.onGroupsChange({ ...groups, assign });
  }
  function addGroup() {
    const id = "g" + Date.now().toString(36);
    props.onGroupsChange({ ...groups, groups: [...groups.groups, { id, name: "新分组" }] });
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
      if (id) onDrop(id);
    },
  });

  /** 一行对话（分组里和项目里共用）：点击打开，拖到别的分组 / 项目上移动，右边“…”菜单 */
  const renderRow = (s: SessionMeta) => (
    <div
      key={s.id}
      className={`side-item session ${s.id === currentId ? "active" : ""} ${dragging === s.id ? "dragging" : ""} ${menu === s.id ? "menu-open" : ""}`}
      draggable={renaming !== s.id}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, s.id);
        e.dataTransfer.effectAllowed = "move";
        setDragging(s.id);
      }}
      onDragEnd={() => (setDragging(null), setDropOn(null))}
      onClick={() => renaming !== s.id && props.onOpen(s.id)}
      title={s.title}
    >
      {renaming === s.id ? (
        <NameInput
          value={s.title}
          onDone={(v) => {
            setRenaming(null);
            if (v && v !== s.title) props.onRename(s.id, v);
          }}
        />
      ) : (
        // 点当前对话的名字（或双击任意对话）就能改名
        <span
          className="ellipsis"
          onClick={(e) => s.id === currentId && (e.stopPropagation(), setRenaming(s.id))}
          onDoubleClick={(e) => (e.stopPropagation(), setRenaming(s.id))}
        >
          {s.title}
        </span>
      )}
      {/* 最右边一格：平时显示文件图标（这个对话生成过文件），鼠标移上来换成“…”菜单按钮 */}
      <span className="row-end">
        {s.hasFiles && <IFile className="has-file" width={13} height={13} />}
        <button
          className="more"
          onClick={(e) => {
            e.stopPropagation();
            setMenu(menu === s.id ? null : s.id);
          }}
          title="更多"
        >
          <IMore width={14} height={14} />
        </button>
      </span>
      {menu === s.id && (
        <div className="row-menu" onClick={(e) => e.stopPropagation()}>
          <button className="pop-item" onClick={() => (setMenu(null), setRenaming(s.id))}>
            <IPencil width={13} height={13} />
            重命名
          </button>
          {/* 移到项目：列出全部项目；已经在项目里的对话多一个“移出项目” */}
          {props.projects
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
          <button className="pop-item danger" onClick={() => (setMenu(null), props.onDelete(s.id))}>
            <IX width={13} height={13} />
            删除
          </button>
        </div>
      )}
    </div>
  );

  return (
    <aside className={`side ${props.floating ? "floating" : ""}`} onMouseEnter={props.onMouseEnter} onMouseLeave={props.onMouseLeave}>
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
            <ISearch width={14} height={14} />
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
            <ISearch width={14} height={14} />
          </span>
          <span>搜索</span>
        </button>
      )}

      {/* 新建项目：和“新建”“搜索”同样的一行，点了弹出窗口（Workspace 里的 ProjectModal） */}
      <button className="new-btn search-btn" onClick={props.onNewProject}>
        <span className="plus">
          <IFolderPlus width={14} height={14} />
        </span>
        <span>新建项目</span>
      </button>

      {/* 产出物：所有对话里做出来的网页、文档、代码集中在一页（ArtifactsPage） */}
      <button className={`new-btn search-btn ${props.artifactsActive ? "on" : ""}`} onClick={props.onOpenArtifacts}>
        <span className="plus">
          <ILayers width={14} height={14} />
        </span>
        <span>产出物</span>
      </button>

      {/* 项目列表：只显示已经建好的项目；一个都没有时整块不出现 */}
      {props.projects.length > 0 && (
        <div className="side-section proj">
          <div className="side-label row">
            <span>项目</span>
          </div>
          {props.projects.map((p) => {
            const items = byProject.get(p.id) ?? [];
            if (q && !items.length) return null;
            const key = "p:" + p.id;
            // 项目默认收起，点开才显示里面的对话；搜索时、或当前打开的对话在这个项目里时自动展开
            const isFolded = !folded.has(key) && !q && !items.some((x) => x.id === currentId);
            return (
              <div key={p.id} className={`grp proj-grp ${dropOn === key ? "drop" : ""}`} {...dropHandlers(key, (sid) => props.onMoveToProject(sid, p.id))}>
                <div className={`grp-head proj-head ${projMenu === p.id ? "menu-open" : ""}`} onClick={() => toggleFold(key)} title={p.description || p.name}>
                  <IChevron width={10} height={10} className={`grp-chev ${isFolded ? "" : "rot"}`} />
                  <IFolder width={14} height={14} className="proj-ico" />
                  <span className="grp-name ellipsis">{p.name}</span>
                  <span className="grp-count">{items.length || ""}</span>
                  <button className="grp-act" title="在这个项目里新建对话" onClick={(e) => {
                      e.stopPropagation();
                      if (isFolded) toggleFold(key); // 在项目里新建时顺手展开它，发出去以后新对话就出现在下面
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
                      <button
                        className="pop-item danger"
                        onClick={() => (setProjMenu(null), confirm(`删除项目“${p.name}”？里面的对话不会删除，会回到“分组”里。`) && props.onDeleteProject(p.id))}
                      >
                        <IX width={13} height={13} />
                        删除项目
                      </button>
                    </div>
                  )}
                </div>
                {!isFolded && (
                  <div className="grp-items">
                    {items.map(renderRow)}
                    {!items.length && <div className="grp-empty">还没有对话。点右边的 + 新建，或把对话拖到这里</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
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
                    {items.map(renderRow)}
                    {!items.length && g.id && <div className="grp-empty">把对话拖到这里</div>}
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
