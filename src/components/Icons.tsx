import type { SVGProps } from "react";
import { agentIconBody } from "@/lib/agentIcons";

/** 极简线性图标，16px，统一 1.5 线宽，颜色跟随 currentColor */
const base = (p: SVGProps<SVGSVGElement>) => ({
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  ...p,
});

/**
 * 图标库（docs/icons/agent-icons，用户提供的 50 个）里的图标：24 网格，颜色跟随 currentColor。
 * 默认 16px；线宽 1.9（显示成约 1.27px），和下面 16 网格的 1.5 线宽看起来差不多粗。
 */
export const AgentIcon = ({ name, ...p }: SVGProps<SVGSVGElement> & { name: string }) => (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.9}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    {...p}
    dangerouslySetInnerHTML={{ __html: agentIconBody(name) }}
  />
);
/** 把图标库里的某个图标做成和旧图标一样用法的组件（导出名不变，各处自动换成新图标） */
const lib = (name: string) => {
  const C = (p: SVGProps<SVGSVGElement>) => <AgentIcon name={name} {...p} />;
  C.displayName = name;
  return C;
};

/** A.ai 的 logo：圆角方块里一个 A，横杠换成一个点（A + “.”） */
export const ILogo = (p: SVGProps<SVGSVGElement>) => (
  <svg width={22} height={22} viewBox="0 0 24 24" aria-hidden {...p}>
    <rect width="24" height="24" rx="6.5" fill="currentColor" />
    <path d="M7 17.5 12 6.5l5 11" fill="none" stroke="var(--accent-fg)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="12" cy="14.2" r="1.5" fill="var(--accent-fg)" />
  </svg>
);
export const ILogout = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M6.5 13.5h-3v-11h3M10 5l3 3-3 3M13 8H6.5" /></svg>
);
export const IPencil = lib("edit");
export const IPlus = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M8 3v10M3 8h10" /></svg>
);
export const IPanelLeft = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="2" y="2.5" width="12" height="11" rx="2.2" /><path d="M6.5 2.5v11" /></svg>
);
export const IPanelRight = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="2" y="2.5" width="12" height="11" rx="2.2" /><path d="M9.5 2.5v11" /></svg>
);
export const IArrowUp = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M8 13V3M4 7l4-4 4 4" /></svg>
);
export const IStop = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="4.75" y="4.75" width="6.5" height="6.5" rx="1.25" /></svg>
);
export const IX = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M4 4l8 8M12 4l-8 8" /></svg>
);
export const ICopy = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="5" y="5" width="8" height="8" rx="1.5" /><path d="M3 10V4.5A1.5 1.5 0 0 1 4.5 3H10" /></svg>
);
export const ICheck = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M3.5 8.5l3 3 6-7" /></svg>
);
export const IDownload = lib("download");
export const IDoc = lib("document");
export const ISearch = lib("search");
export const IGlobe = lib("web");
export const ICode = lib("code");
export const ITable = lib("spreadsheet");
export const ILayers = lib("artifact");
export const IEye = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></svg>
);
export const IMore = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="3.5" cy="8" r="0.6" /><circle cx="8" cy="8" r="0.6" /><circle cx="12.5" cy="8" r="0.6" /></svg>
);
export const IChevron = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M6 4l4 4-4 4" /></svg>
);

/* ---------- 思维链 / 工具链用的图标 ---------- */

export const IThink = lib("thinking");
export const IClock = lib("history");
export const ICalc = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="3.5" y="2" width="9" height="12" rx="1.5" /><path d="M5.5 4.5h5M5.5 8h.01M8 8h.01M10.5 8h.01M5.5 10.5h.01M8 10.5h.01M10.5 10.5h.01" /></svg>
);
export const IFolder = lib("folder");
export const IFolderPlus = lib("project");
export const IFile = lib("file");
/** 收件托盘：右上角“任务与文件”按钮用（agent 的产出都收在这里），和单个文件的 IFile 区分开 */
export const IFiles = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="2.5" y="2.75" width="11" height="10.5" rx="2" /><path d="M2.5 9h2.8l.9 1.5h3.6l.9-1.5h2.8" /></svg>
);
export const IClip = lib("attachment");
export const IImage = lib("image");
/** 重新生成：一个带箭头的圆环 */
export const IRetry = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M13 8a5 5 0 1 1-1.6-3.7" /><path d="M13 2.8v2.6h-2.6" /></svg>
);
export const IFileEdit = lib("edit");
export const ITerminal = lib("terminal");
export const IWrench = lib("tool");

/* ---------- 用户菜单 / 设置用的图标 ---------- */
export const IGear = lib("settings");
export const IChart = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5" /></svg>
);
export const IKeyboard = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="1.5" y="4" width="13" height="8" rx="1.5" /><path d="M4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M5 9.5h6" /></svg>
);
export const IInfo = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="8" cy="8" r="5.8" /><path d="M8 7.3v3.7M8 5h.01" /></svg>
);
export const IChip = lib("agent");
export const IUpDown = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M5 6l3-3 3 3M5 10l3 3 3-3" /></svg>
);

export const ISpark = lib("skill");

/* ---------- 图标库里新增用到的 ---------- */
export const IChatNew = lib("chat-new");
export const IMemory = lib("memory");

/* ---------- 左栏顶部 新建 / 搜索 / 新建项目 / 产出物：用户要求保留原来的线条图标（2026-10-29） ---------- */
export const ISearchLine = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="7" cy="7" r="4.25" /><path d="m10.2 10.2 3.3 3.3" /></svg>
);
export const IFolderPlusLine = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M2 4.5A1 1 0 0 1 3 3.5h3l1.3 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" /><path d="M8 7.2v3.6M6.2 9h3.6" /></svg>
);
export const ILayersLine = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M8 2.5l5.5 3L8 8.5l-5.5-3z" /><path d="M2.5 8.5L8 11.5l5.5-3" /></svg>
);
