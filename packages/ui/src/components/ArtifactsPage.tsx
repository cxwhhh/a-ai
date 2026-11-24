"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactMeta, Project } from "../../../protocol/src/lib/shared";
import type { WorkspaceAppSummary } from "../../../protocol/src/workspace-app";
import { api } from "../lib/client";
import { AgentIcon, ICode, IDoc, IFolder, IGlobe, IMore, IPanelLeft, IPlus, ISearch, IX } from "./Icons";
import "./ArtifactsPage.css";

/** 每种产出物：名字、小图标（卡片底部）。颜色在 CSS 里按 c-html / c-markdown / c-code 区分 */
const KIND: Record<ArtifactMeta["kind"], { label: string; icon: React.ReactNode }> = {
  html: { label: "网页", icon: <IGlobe width={18} height={18} /> },
  markdown: { label: "文档", icon: <IDoc width={18} height={18} /> },
  code: { label: "代码", icon: <ICode width={18} height={18} /> },
};

type SavedCategory = "chart" | ArtifactMeta["kind"];
type CreationKey = SavedCategory | "spreadsheet" | "slides" | "flow";

/** 创建入口按用途组织，用草稿指定现有生成工具支持的格式。 */
const CREATE: { k: ArtifactMeta["kind"]; label: string; text: string }[] = [
  { k: "html", label: "网页", text: "帮我做一个网页：" },
  { k: "markdown", label: "文档", text: "帮我写一份文档：" },
  { k: "code", label: "代码", text: "帮我写一段代码：" },
];
const CREATE_OFFICE = [
  { k: "chart", label: "图表", text: "帮我做一个图表：" },
  { k: "spreadsheet", label: "表格", text: "帮我制作一个 Excel 表格（.xlsx）：" },
  { k: "slides", label: "演示文稿", text: "帮我制作一份 PowerPoint 演示文稿（.pptx）：" },
  { k: "flow", label: "流程图", text: "帮我画一个 SVG 流程图：" },
] as const;
/** 排列方式按钮的两个小图标：四宫格 = 卡片，三条横线 = 列表（同 Finder） */
const IGridView = () => (
  <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinejoin="round">
    <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
    <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
    <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
    <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
  </svg>
);
const IListView = () => (
  <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round">
    <path d="M5.5 4h8M5.5 8h8M5.5 12h8" />
    <circle cx="2.8" cy="4" r=".6" fill="currentColor" />
    <circle cx="2.8" cy="8" r=".6" fill="currentColor" />
    <circle cx="2.8" cy="12" r=".6" fill="currentColor" />
  </svg>
);

/** 产出物属于哪个色系：SVG 算“图表”（粉），其余按类型（网页蓝 / 文档黄 / 代码绿） */
function tone(a: ArtifactMeta): SavedCategory {
  return a.svg ? "chart" : a.kind;
}
function toneIcon(a: ArtifactMeta) {
  return a.svg ? <CatIcon k="chart" size={18} /> : KIND[a.kind].icon;
}

/** 新建卡片翻开后里面的小场景：纯 HTML/CSS 画的缩略图，不用图片 */
function BookScene({ k }: { k: CreationKey }) {
  if (k === "html")
    return (
      <span className="bk-browser">
        <span className="bk-bar">
          <i />
          <i />
          <i />
          <span className="bk-web-address" />
        </span>
        <span className="bk-web-body">
          <span className="bk-web-hero">
            <span className="bk-web-copy">
              <span className="bk-line w90" />
              <span className="bk-line w70" />
            </span>
          </span>
          <span className="bk-web-tiles">
            <span><span className="bk-line w70" /><span className="bk-line w90" /></span>
            <span><span className="bk-line w50" /><span className="bk-line w80" /></span>
          </span>
        </span>
      </span>
    );
  if (k === "markdown")
    return (
      <span className="bk-stack">
        <span className="bk-sheet back2" />
        <span className="bk-sheet back1" />
        <span className="bk-sheet front">
          <span className="bk-doc-rule" />
          <span className="bk-doc-title">产品方案</span>
          <span className="bk-doc-copy">
            <span className="bk-line w90" />
            <span className="bk-line w80" />
            <span className="bk-line w90" />
            <span className="bk-line w60" />
          </span>
        </span>
      </span>
    );
  if (k === "code")
    return (
      <span className="bk-term">
        <span className="bk-bar">
          <i />
          <i />
          <i />
        </span>
        <span className="bk-term-body">
          <span>
            <em>$</em> npm run dev
          </span>
          <span className="ok">✓ ready in 1.2s</span>
          <span>
            <em>$</em> <u />
          </span>
        </span>
      </span>
    );
  if (k === "spreadsheet")
    return (
      <span className="bk-minipage bk-spreadsheet">
        <span className="bk-cell-grid">
          {Array.from({ length: 16 }, (_, index) => <i key={index} />)}
        </span>
      </span>
    );
  if (k === "slides")
    return (
      <span className="bk-minipage bk-slides">
        <span className="bk-slide-rail"><i /><i /><i /></span>
        <span className="bk-slide">
          <span className="bk-mini-title">项目汇报</span>
          <span className="bk-line w70" />
          <span className="bk-slide-figure" />
        </span>
      </span>
    );
  if (k === "flow")
    return (
      <span className="bk-minipage bk-flow">
        <span className="bk-flow-steps">
          <i className="bk-flow-start" />
          <i className="bk-flow-branch" />
          <i className="bk-flow-end" />
          <i className="bk-flow-end" />
        </span>
      </span>
    );
  // 两组示例数据共用坐标轴，月份跟每组柱子对齐。
  return (
    <span className="bk-minipage bk-chart">
      <span className="bk-chart-heading">
        <span className="bk-mini-title">月度收入</span>
        <span className="bk-chart-key"><i /><i /></span>
      </span>
      <span className="bk-bars">
        {[[48, 30], [67, 44], [59, 52], [89, 62]].map(([current, previous], index) => (
          <span className="bk-bar-group" key={index}>
            <i style={{ height: `${current}%` }} />
            <i style={{ height: `${previous}%` }} />
          </span>
        ))}
      </span>
      <span className="bk-chart-scale"><i>01</i><i>02</i><i>03</i><i>04</i></span>
    </span>
  );
}

/** 封面底纹：几笔很淡的手绘线条（仿 Claude 的新建卡片），颜色跟图标一样，透明度很低 */
function Doodle() {
  return (
    <svg className="art-doodle" viewBox="0 0 160 110" preserveAspectRatio="none" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 84c10-26 22-40 30-34s-6 30 4 30 18-40 30-38" />
      <path d="M112 14c14 2 30 8 38 18M118 96h30v-24" />
      <path d="M96 100c4-8 12-12 20-10" />
    </svg>
  );
}

/** 分类复用项目图标库，图表使用和内页呼应的柱形图标。 */
const CAT_LIB: Record<Exclude<CreationKey, "chart">, string> = {
  html: "web",
  markdown: "document",
  code: "code",
  spreadsheet: "spreadsheet",
  slides: "slides",
  flow: "workflow",
};
function CatIcon({ k, size = 20, stroke = 1.7 }: { k: CreationKey; size?: number; stroke?: number }) {
  if (k !== "chart") return <AgentIcon name={CAT_LIB[k]} width={size} height={size} strokeWidth={stroke} />;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 4v16h18M7 16v-3h3v3m2 0v-5h3v5m2 0V8h3v8M7 9l5-4 3 1 4-3" />
    </svg>
  );
}

/** 网页、文档和代码沿用翻页预览，点击直接进入新对话。 */
function CreationCard({ k, label, onClick }: {
  k: ArtifactMeta["kind"];
  label: string;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className={`art-new c-${k}`}
      title={`新建${label}`}
      onClick={onClick}
    >
      <span className="art-book" aria-hidden>
        <span className="art-book-in">
          <span className="bk-scene"><BookScene k={k} /></span>
        </span>
        <span className="art-book-cover">
          <Doodle />
          <CatIcon k={k} size={34} stroke={2} />
        </span>
      </span>
      <span className="art-new-label">{label}</span>
    </button>
  );
}

/** 办公卡沿用翻页封面，内页轮播四种预览，聚焦时暂停以便选中。 */
function OfficeCreationCard({ onCreate }: { onCreate(text: string): void }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [focused, setFocused] = useState(false);
  const [touchOpen, setTouchOpen] = useState(false);
  const active = CREATE_OFFICE[activeIndex];

  useEffect(() => {
    if (focused) return;
    const timer = window.setTimeout(() => {
      setActiveIndex((activeIndex + 1) % CREATE_OFFICE.length);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [activeIndex, focused]);

  return (
    <div
      className="art-office"
      data-touch-open={touchOpen}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false);
          setTouchOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="art-new art-office-create"
        aria-label={`办公，创建${active.label}`}
        onClick={(event) => {
          // 触屏没有悬停，第一次轻点先翻开，第二次按当前预览创建。
          if (!touchOpen && event.nativeEvent instanceof PointerEvent && event.nativeEvent.pointerType === "touch") {
            setTouchOpen(true);
            return;
          }
          onCreate(active.text);
        }}
      >
        <span className="art-book" aria-hidden>
          <span className="art-book-in art-office-window">
            {CREATE_OFFICE.map((item, index) => (
              <span key={item.k} className={`art-office-slide c-${item.k}`} data-active={index === activeIndex}>
                <span className="art-office-type"><CatIcon k={item.k} size={12} />{item.label}</span>
                <span className="bk-scene"><BookScene k={item.k} /></span>
              </span>
            ))}
          </span>
          <span className="art-book-cover">
            <Doodle />
            <AgentIcon name="artifact" width={34} height={34} strokeWidth={2} />
          </span>
        </span>
        <span className="art-new-label">办公</span>
      </button>
      <div className="art-office-picks" role="group" aria-label="切换办公预览">
        {CREATE_OFFICE.map((item, index) => (
          <button
            key={item.k}
            type="button"
            aria-label={`预览${item.label}`}
            title={item.label}
            aria-pressed={index === activeIndex}
            onClick={() => setActiveIndex(index)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * “产出物”页面：所有对话里 create_artifact 生成过的网页、文档、代码，集中在一处。
 * 列表只拿概要（/api/artifacts），点卡片 = 打开它所在的对话，并在右侧直接显示这个产出物，
 * 预览、复制、下载都复用对话里已有的右侧视图，不用再写一套。
 */
export function ArtifactsPage(props: {
  projects: Project[];
  libraryVersion: number;
  leftOpen: boolean;
  modKey: string;
  onToggleLeft(): void;
  /** 打开产出物：artifactId 是面板里的产出物；file 是生成的文件（Word / Excel / PPT），按文件打开 */
  onOpen(sessionId: string, artifactId?: string, file?: string): void;
  onOpenApp(app: WorkspaceAppSummary): void;
  /** 顶部创建卡片：新开一个对话，输入框里预先填好 text */
  onCreate(text: string): void;
}) {
  const [list, setList] = useState<ArtifactMeta[] | null>(null);
  const [apps, setApps] = useState<WorkspaceAppSummary[]>([]);
  const [appsError, setAppsError] = useState("");
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  /** 按项目筛选："" = 全部，"any" = 在任意项目里，项目 id = 某个项目，"none" = 项目外（不在任何项目里） */
  const [proj, setProj] = useState("");
  /** 排列方式：grid = 卡片（像 Finder 的图标视图），list = 文件列表（像 Finder 的列表视图）。记在 localStorage 里 */
  const [view, setView] = useState<"grid" | "list">("grid");
  useEffect(() => {
    try {
      if (localStorage.getItem("a.artsView") === "list") setView("list");
    } catch {}
  }, []);
  const pickView = (v: "grid" | "list") => {
    setView(v);
    try {
      localStorage.setItem("a.artsView", v);
    } catch {}
  };
  /** 列表视图里哪一行的 ⋯ 菜单开着（产出物 id），点外面就关 */
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const rowMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!rowMenu) return;
    const close = (e: MouseEvent) => !rowMenuRef.current?.contains(e.target as Node) && setRowMenu(null);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [rowMenu]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    api.artifacts(signal).then((items) => {
      if (!signal.aborted) { setList(items); setErr(""); }
    }, (error) => {
      if (!signal.aborted) setErr(error instanceof Error ? error.message : "无法读取产出物");
    });
    api.workspaceApps(signal).then((items) => {
      if (!signal.aborted) { setApps(items); setAppsError(""); }
    }, (error) => {
      if (!signal.aborted) setAppsError(error instanceof Error ? error.message : "无法读取账号应用");
    });
    return () => controller.abort();
  }, [props.libraryVersion]);

  const inProj = (a: ArtifactMeta) => !proj || (proj === "none" ? !a.projectId : proj === "any" ? !!a.projectId : a.projectId === proj);
  const shown = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return (list ?? []).filter(
      (a) =>
        inProj(a) &&
        (!kw || a.title.toLowerCase().includes(kw) || a.sessionTitle.toLowerCase().includes(kw)),
    );
  }, [list, q, proj]); // eslint-disable-line react-hooks/exhaustive-deps

  // 三个标签后面的数量（不受搜索影响，表示这一类一共有多少）
  const counts = useMemo(() => {
    const l = list ?? [];
    const inProj = l.filter((a) => a.projectId).length;
    return { all: l.length, inProj, none: l.length - inProj };
  }, [list]);

  const projName = (id?: string) => props.projects.find((p) => p.id === id)?.name;
  const total = (list?.length ?? 0) + apps.length;

  return (
    <main className="chat arts">
      <header className="chat-head">
        {!props.leftOpen && (
          <button className="icon-btn" onClick={props.onToggleLeft} title={`展开左栏 ${props.modKey}B`}>
            <IPanelLeft />
          </button>
        )}
      </header>
      <div className="arts-scroll">
        <div className="arts-inner">
          {/* 标题（2026-10-29 重做）：大一号、加粗、字距收紧，右边灰色写总数；下面一行小字说明这页放的是什么 */}
          <div className="arts-top">
            <h1>产出物</h1>
            {total > 0 && <span className="arts-total">{total} 个</span>}
          </div>
          <p className="arts-desc">对话里生成的网页、文档、代码和图表都收在这里</p>

          {(apps.length > 0 || appsError) && (
            <section aria-label="已部署应用">
              <div className="arts-new-title">应用</div>
              {appsError ? <p className="arts-desc" role="status">{appsError}</p> : (
                <div className="arts-list">
                  {apps.map((app) => (
                    <button key={app.id} className="arts-row" onClick={() => props.onOpenApp(app)} type="button">
                      <span className="arts-row-ico c-html"><IGlobe /></span>
                      <span className="arts-row-title ellipsis">{app.title}</span>
                      <span className="arts-when">更新于 {ago(app.updatedAt)}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          <div className="arts-new-title">创建新内容</div>
          <div className="arts-cats">
            {CREATE.map((c) => (
              <CreationCard key={c.k} k={c.k} label={c.label} onClick={() => props.onCreate(c.text)} />
            ))}
            <OfficeCreationCard onCreate={props.onCreate} />
          </div>

          {/* 工具栏（2026-10-29 重做）：左边是三个下划线标签，意思直接写在字上，后面带数量：
              全部 / 在项目中 / 不在项目中。选“在项目中”时，下面再出一行项目名小标签，可以只看某一个项目。
              右边是搜索和排列方式。整行底下一条细线，选中的标签下面一道深色粗线压在这条线上 */}
          <div className="arts-bar">
            <div className="arts-tabs" role="tablist">
              {(
                [
                  ["", "全部", counts.all],
                  ["any", "在项目中", counts.inProj],
                  ["none", "不在项目中", counts.none],
                ] as const
              ).map(([k, label, n]) => {
                const on = k === "any" ? !!proj && proj !== "none" : proj === k;
                return (
                  <button key={k} role="tab" aria-selected={on} className={on ? "on" : ""} onClick={() => setProj(k)}>
                    {label}
                    <span className="arts-tab-n">{n}</span>
                  </button>
                );
              })}
            </div>
            <div className="arts-bar-right">
              {/* 搜索：平时只是一个放大镜图标，点一下向左展开成输入框；没输入内容时失焦就收回去，Esc 清空并收起 */}
              <div className={`arts-search ${searchOpen || q ? "open" : ""}`}>
                <input
                  ref={searchRef}
                  placeholder="搜索标题或对话"
                  value={q}
                  tabIndex={searchOpen || q ? 0 : -1}
                  onChange={(e) => setQ(e.target.value)}
                  onBlur={() => !q && setSearchOpen(false)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") (setQ(""), setSearchOpen(false), e.currentTarget.blur());
                  }}
                />
                {q ? (
                  <button className="icon-btn" onClick={() => (setQ(""), searchRef.current?.focus())} title="清空">
                    <IX width={12} height={12} />
                  </button>
                ) : (
                  <button
                    className="icon-btn"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setSearchOpen((o) => !o);
                      if (!searchOpen) setTimeout(() => searchRef.current?.focus(), 0);
                    }}
                    title="搜索"
                  >
                    <ISearch width={15} height={15} />
                  </button>
                )}
              </div>
              <div className="arts-view" role="group" aria-label="排列方式">
                <button className={view === "grid" ? "on" : ""} onClick={() => pickView("grid")} title="卡片">
                  <IGridView />
                </button>
                <button className={view === "list" ? "on" : ""} onClick={() => pickView("list")} title="列表">
                  <IListView />
                </button>
              </div>
            </div>
          </div>
          {proj && proj !== "none" && props.projects.length > 0 && (
            <div className="arts-chips">
              <button className={proj === "any" ? "on" : ""} onClick={() => setProj("any")}>
                所有项目
              </button>
              {props.projects.map((p) => (
                <button key={p.id} className={proj === p.id ? "on" : ""} onClick={() => setProj(p.id)}>
                  <IFolder width={12} height={12} />
                  <span className="ellipsis">{p.name}</span>
                </button>
              ))}
            </div>
          )}


          {err ? (
            <div className="arts-empty">读取失败：{err}</div>
          ) : !list ? (
            <div className="arts-empty">读取中…</div>
          ) : !shown.length ? (
            <div className="arts-empty">
              {list.length ? "没有符合条件的产出物。" : apps.length ? "还没有文件产出物。" : "还没有产出物。在对话里让 A.ai 做网页、写文档或代码，做好的成品会自动收集到这里。"}
            </div>
            ) : view === "list" ? (
            // 列表视图：像 Finder 的列表，一行一个文件；表头固定，列 = 名称 / 类型 / 来源 / 创建时间
            // 列表视图（2026-10-29 改成 Claude 产出物列表的样子）：没有表头和外框，每行 = 彩色小图标块 + 标题，
            // 右边是“创建于 X 前”和一个 ⋯ 按钮（打开 / 打开所在对话 / 复制标题）。来源对话放在鼠标悬停提示里
            <div className="arts-list">
              {shown.map((a) => (
                <div
                  key={a.id}
                  className={`arts-row ${rowMenu === a.id ? "menu-open" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => props.onOpen(a.sessionId, a.file ? undefined : a.id, a.file)}
                  onKeyDown={(e) => e.key === "Enter" && props.onOpen(a.sessionId, a.file ? undefined : a.id, a.file)}
                  title={`${a.title}\n来自：${projName(a.projectId) ? `${projName(a.projectId)} · ` : ""}${a.sessionTitle}`}
                >
                  <span className={`arts-row-ico c-${tone(a)}`}>{toneIcon(a)}</span>
                  <span className="arts-row-title ellipsis">{a.title}</span>
                  <span className="arts-when">创建于 {ago(a.createdAt)}</span>
                  <div className="arts-more-wrap" ref={rowMenu === a.id ? rowMenuRef : undefined} onClick={(e) => e.stopPropagation()}>
                    <button className="icon-btn arts-more" title="更多" onClick={() => setRowMenu((m) => (m === a.id ? null : a.id))}>
                      <IMore width={16} height={16} />
                    </button>
                    {rowMenu === a.id && (
                      <div className="row-menu">
                        <button className="pop-item" onClick={() => (setRowMenu(null), props.onOpen(a.sessionId, a.file ? undefined : a.id, a.file))}>打开</button>
                        <button className="pop-item" onClick={() => (setRowMenu(null), props.onOpen(a.sessionId))}>打开所在对话</button>
                        <button
                          className="pop-item"
                          onClick={() => {
                            setRowMenu(null);
                            void navigator.clipboard?.writeText(a.title).catch(() => {});
                          }}
                        >
                          复制标题
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="arts-grid">
              {shown.map((a) => (
                <button key={a.id} className="art-card" onClick={() => props.onOpen(a.sessionId, a.file ? undefined : a.id, a.file)} title={`打开：${a.title}\n来自：${projName(a.projectId) ? `${projName(a.projectId)} · ` : ""}${a.sessionTitle}`}>
                  {/* 仿 Claude 的产出物卡片：底板上“立着”一张小页面，只露出上半截。
                      2026-10-29：四种类型的小页面长得不一样，一眼能分开——
                      文档 = 白纸（衬线标题 + 正文）；代码 = 深色编辑器（文件名标签 + 行号 + 等宽字）；
                      网页 = 浏览器窗口（三个圆点 + 地址栏 + 色块横幅）；图表 = 白底直接显示图。
                      底板和下面的图标块都带上这一类的颜色（和顶部新建卡片同一套：网页蓝、文档黄、代码绿、图表粉） */}
                  <div className={`art-preview p-${tone(a)} c-${tone(a)}`}>
                    <div className="art-page">
                      {a.svg ? (
                        // SVG 用 <img> 画：图片里的脚本不会执行，比直接插进页面安全
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(a.svg)}`} alt="" />
                      ) : a.kind === "code" ? (
                        <>
                          <div className="art-bar">
                            <i />
                            <i />
                            <i />
                            <span>{a.language || "code"}</span>
                          </div>
                          <div className="art-code">
                            {(a.snippet || "").split("\n").slice(0, 9).map((l, i) => (
                              <span key={i}>
                                <em>{i + 1}</em>
                                {l || " "}
                              </span>
                            ))}
                          </div>
                        </>
                      ) : a.kind === "html" ? (
                        <>
                          <div className="art-bar">
                            <i />
                            <i />
                            <i />
                            <span />
                          </div>
                          <div className="art-web">
                            <b>{a.title}</b>
                            <span className="art-hero" />
                            <span>{a.snippet || "（空）"}</span>
                          </div>
                        </>
                      ) : (
                        <>
                          <b className="art-page-title">{a.title}</b>
                          <span>{a.snippet || "（空）"}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="art-meta">
                    <span className={`art-meta-ico c-${tone(a)}`}>{toneIcon(a)}</span>
                    <div className="art-meta-text">
                      <div className="art-title ellipsis">{a.title}</div>
                      <div className="art-sub ellipsis">
                        {a.svg ? "SVG" : a.file ? a.file.split(".").pop()!.toUpperCase() : a.kind === "code" && a.language ? a.language : KIND[a.kind].label} · 创建于 {ago(a.createdAt)}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function ago(ts: number) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return new Date(ts).toLocaleDateString();
}
