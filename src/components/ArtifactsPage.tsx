"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactMeta, Project } from "@/lib/shared";
import { api } from "@/lib/client";
import { AgentIcon, ICode, IDoc, IFolder, IGlobe, IMore, IPanelLeft, IPlus, ISearch, IX } from "./Icons";
import "./ArtifactsPage.css";

/** 每种产出物：名字、小图标（卡片底部）。颜色在 CSS 里按 c-html / c-markdown / c-code 区分 */
const KIND: Record<ArtifactMeta["kind"], { label: string; icon: React.ReactNode }> = {
  html: { label: "网页", icon: <IGlobe width={18} height={18} /> },
  markdown: { label: "文档", icon: <IDoc width={18} height={18} /> },
  code: { label: "代码", icon: <ICode width={18} height={18} /> },
};

/**
 * 分类卡片专用的大图标：24×24 画布、1.7 线宽，比 Icons.tsx 里 16×16 的小图标细节多，放大也精致。
 * 只在这里用，所以不放进 Icons.tsx。
 */
/** 顶部 4 张“新建”卡片：类型、名字、点击后预填到输入框里的开头 */
const CREATE: { k: CatKey; label: string; text: string }[] = [
  { k: "html", label: "网页", text: "帮我做一个网页：" },
  { k: "markdown", label: "文档", text: "帮我写一份文档：" },
  { k: "code", label: "代码", text: "帮我写一段代码：" },
  { k: "chart", label: "图表", text: "帮我做一个图表：" },
];
type CatKey = "all" | "chart" | ArtifactMeta["kind"];

const CAT_PATHS: Record<CatKey, React.ReactNode> = {
  chart: (
    <>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </>
  ),
  all: (
    <>
      <path d="M12 3 3 8l9 5 9-5-9-5Z" />
      <path d="m3 13 9 5 9-5" />
      <path d="m3 17.5 9 5 9-5" opacity={0.5} />
    </>
  ),
  html: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" />
    </>
  ),
  markdown: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  code: <path d="m8 7-5 5 5 5M16 7l5 5-5 5M13.5 5l-3 14" />,
};
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
function tone(a: ArtifactMeta): CatKey {
  return a.svg ? "chart" : a.kind;
}
function toneIcon(a: ArtifactMeta) {
  return a.svg ? <CatIcon k="chart" size={18} /> : KIND[a.kind].icon;
}

/** 新建卡片翻开后里面的小场景：纯 HTML/CSS 画的缩略图，不用图片 */
function BookScene({ k }: { k: CatKey }) {
  // 网页：一个全白的 Mac 浏览器窗口，只有左上角红黄绿三个按钮（关闭 / 最小化 / 全屏）
  if (k === "html")
    return (
      <span className="bk-browser">
        <span className="bk-bar">
          <i />
          <i />
          <i />
        </span>
      </span>
    );
  if (k === "markdown")
    return (
      <span className="bk-stack">
        <span className="bk-sheet back2" />
        <span className="bk-sheet back1" />
        <span className="bk-sheet front">
          <span className="bk-doc-title">产品方案</span>
          <span className="bk-doc-date">Oct 29 · 文档</span>
          <span className="bk-line w90" />
          <span className="bk-line w80" />
          <span className="bk-line w60" />
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
  // 图表：和文档一样是一张白纸，上面一行小标题，下面五根柱子 + 底线
  return (
    <span className="bk-chart">
      <span className="bk-doc-title">月度数据</span>
      <span className="bk-bars">
        {[42, 68, 52, 86, 64].map((h, i) => (
          <span key={i} style={{ height: `${h}%` }} />
        ))}
      </span>
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

/** 分类图标：网页/文档/代码/全部用图标库里的，图表库里没有，用自己画的柱状图 */
const CAT_LIB: Partial<Record<CatKey, string>> = { all: "artifact", html: "web", markdown: "document", code: "code" };
function CatIcon({ k, size = 20, stroke = 1.7 }: { k: CatKey; size?: number; stroke?: number }) {
  if (CAT_LIB[k]) return <AgentIcon name={CAT_LIB[k]!} width={size} height={size} strokeWidth={stroke} />;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      {CAT_PATHS[k]}
    </svg>
  );
}

/**
 * “产出物”页面：所有对话里 create_artifact 生成过的网页、文档、代码，集中在一处。
 * 列表只拿概要（/api/artifacts），点卡片 = 打开它所在的对话，并在右侧直接显示这个产出物，
 * 预览、复制、下载都复用对话里已有的右侧视图，不用再写一套。
 */
export function ArtifactsPage(props: {
  projects: Project[];
  leftOpen: boolean;
  modKey: string;
  onToggleLeft(): void;
  /** 打开产出物：artifactId 是面板里的产出物；file 是生成的文件（Word / Excel / PPT），按文件打开 */
  onOpen(sessionId: string, artifactId?: string, file?: string): void;
  /** 顶部 4 张卡片：新开一个对话，输入框里预先填好 text */
  onCreate(text: string): void;
}) {
  const [list, setList] = useState<ArtifactMeta[] | null>(null);
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
    api.artifacts().then(setList, (e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

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
            {list && list.length > 0 && <span className="arts-total">{list.length} 个</span>}
          </div>
          <p className="arts-desc">对话里生成的网页、文档、代码和图表都收在这里</p>

          {/* 新建卡片（2026-10-29 改成“翻书”样式，参考 Uiverse eslam-hany 的 book）：
              封面 = 彩色图标 + 名称；鼠标移上去封面像书一样向左翻开，露出里面的小场景
              （网页 = Mac 浏览器、文档 = 一叠纸、代码 = 终端、图表 = 柱状图）。
              点一下 = 新开一个对话，输入框里预先填好开头（如“帮我做一个网页：”）。不是筛选按钮 */}
          <div className="arts-new-title">创建新内容</div>
          <div className="arts-cats">
            {CREATE.map((c) => (
              <button key={c.k} className={`art-new c-${c.k}`} onClick={() => props.onCreate(c.text)} title={`新建${c.label}`}>
                <span className="art-book">
                  <span className="art-book-in" aria-hidden>
                    <span className="bk-scene">
                      <BookScene k={c.k} />
                    </span>
                  </span>
                  <span className="art-book-cover">
                    <Doodle />
                    <CatIcon k={c.k} size={34} stroke={2.1} />
                  </span>
                </span>
                <span className="art-new-label">{c.label}</span>
              </button>
            ))}
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
              {list.length ? "没有符合条件的产出物。" : "还没有产出物。在对话里让 A.ai 做网页、写文档或代码，做好的成品会自动收集到这里。"}
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
