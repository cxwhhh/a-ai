import type { SVGProps } from "react";
import { AGENT_ICONS } from "../lib/agentIcons";

/** 只渲染项目内置的 SVG 图形；未知名称回退到文件夹，不接受外部 SVG 正文。 */
export function AgentIcon({ name, ...props }: SVGProps<SVGSVGElement> & { name: string }) {
  const icon = AGENT_ICONS.find((i) => i.name === name) ?? AGENT_ICONS.find((i) => i.name === "folder")!;
  return <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props} dangerouslySetInnerHTML={{ __html: icon.body }} />;
}

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
export const IPencil = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M10.5 3.5l2 2L6 12H4v-2z" /></svg>
);
export const IPlus = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M8 3v10M3 8h10" /></svg>
);
export const IPanelLeft = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M6 3v10" /></svg>
);
export const IPanelRight = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M10 3v10" /></svg>
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
export const IDownload = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M8 3v7M5 7l3 3 3-3M3 13h10" /></svg>
);
export const IDoc = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M4 2.5h5l3 3v8H4z" /><path d="M9 2.5v3h3M6 9h4M6 11h4" /></svg>
);
/** 放大镜：左栏“搜索” */
export const ISearch = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="7" cy="7" r="4.25" /><path d="m10.2 10.2 3.3 3.3" /></svg>
);
export const IGlobe = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.8 2 1.8 9 0 11M8 2.5c-1.8 2-1.8 9 0 11" /></svg>
);
export const ICode = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M6 4.5L2.5 8 6 11.5M10 4.5L13.5 8 10 11.5" /></svg>
);
export const ITable = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="M2.5 6.5h11M2.5 9.75h11M6.5 6.5V13" /></svg>
);
export const ILayers = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M8 2.5l5.5 3L8 8.5l-5.5-3z" /><path d="M2.5 8.5L8 11.5l5.5-3" /></svg>
);
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

/** 阅读：展开的书页，与文件夹（查看目录）和铅笔（修改内容）区分。 */
export const IBook = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M8 4C6.5 2.8 4.5 2.5 2 3v9c2.5-.5 4.5-.2 6 1 1.5-1.2 3.5-1.5 6-1V3c-2.5-.5-4.5-.2-6 1zM8 4v9" /></svg>
);

/** 思考：灯泡表示操作类型，Trace 中的运行状态另用加载动画表示，结束后仍保留灯泡。 */
export const IThink = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M6 11.5h4M6.5 13.5h3" />
    <path d="M5.2 9.6A3.6 3.6 0 1 1 10.8 9.6c-.5.5-.8 1-.8 1.9H6c0-.9-.3-1.4-.8-1.9z" />
    <g className="rays">
      <path d="M8 .9v.9M2.6 3.1l.6.6M13.4 3.1l-.6.6M1.2 7h.8M14 7h.8" />
    </g>
  </svg>
);
export const IClock = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.2l2 1.3" /></svg>
);
export const ICalc = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="3.5" y="2" width="9" height="12" rx="1.5" /><path d="M5.5 4.5h5M5.5 8h.01M8 8h.01M10.5 8h.01M5.5 10.5h.01M8 10.5h.01M10.5 10.5h.01" /></svg>
);
export const IFolder = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M2 4.5A1 1 0 0 1 3 3.5h3l1.3 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" /></svg>
);
/** 新建项目：文件夹 + 加号 */
export const IFolderPlus = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M2 4.5A1 1 0 0 1 3 3.5h3l1.3 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" /><path d="M8 7.2v3.6M6.2 9h3.6" /></svg>
);
export const IFile = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M4 2.5h5l3 3v8H4z" /><path d="M9 2.5v3h3" /></svg>
);
/** 收件托盘：右上角“任务与文件”按钮用（agent 的产出都收在这里），和单个文件的 IFile 区分开 */
export const IFiles = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="2.5" y="2.75" width="11" height="10.5" rx="2" /><path d="M2.5 9h2.8l.9 1.5h3.6l.9-1.5h2.8" /></svg>
);
/** 回形针：输入框左下角的“上传附件” */
export const IClip = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M12.6 7.6 8.2 12a2.9 2.9 0 0 1-4.1-4.1l4.7-4.7a1.9 1.9 0 0 1 2.7 2.7L6.9 10.5a.95.95 0 0 1-1.35-1.35L9.8 4.9" /></svg>
);
/** 图片：附件卡片里区分图片和其他文件 */
export const IImage = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="2.5" y="3" width="11" height="10" rx="1.75" /><circle cx="6" cy="6.5" r="1.1" /><path d="m3 11.5 3-3 2.5 2.5 1.5-1.5 3 3" /></svg>
);
/** 重新生成：一个带箭头的圆环 */
export const IRetry = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M13 8a5 5 0 1 1-1.6-3.7" /><path d="M13 2.8v2.6h-2.6" /></svg>
);
export const IFileEdit = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M9 13.5H4v-11h5l3 3v2" /><path d="M9 2.5v3h3M9.5 13.5l.4-1.8 3.3-3.3 1.4 1.4-3.3 3.3z" /></svg>
);
export const ITerminal = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M4.5 6.5L6.5 8l-2 1.5M8 10h3" /></svg>
);
export const IWrench = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M10.5 2.5a3 3 0 0 0-2.8 4L3 11.2a1.2 1.2 0 0 0 1.8 1.8l4.7-4.7a3 3 0 0 0 4-2.8l-1.8 1.8-1.7-.3-.3-1.7z" /></svg>
);

/* ---------- 用户菜单 / 设置用的图标 ---------- */
export const IGear = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1.8v1.5M8 12.7v1.5M14.2 8h-1.5M3.3 8H1.8M12.4 3.6l-1 1M4.6 11.4l-1 1M12.4 12.4l-1-1M4.6 4.6l-1-1" />
    <circle cx="8" cy="8" r="4.6" />
  </svg>
);
export const IChart = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5" /></svg>
);
export const IKeyboard = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="1.5" y="4" width="13" height="8" rx="1.5" /><path d="M4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M5 9.5h6" /></svg>
);
export const IInfo = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="8" cy="8" r="5.8" /><path d="M8 7.3v3.7M8 5h.01" /></svg>
);
export const IChip = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="4" y="4" width="8" height="8" rx="1.5" /><path d="M6.5 1.8V4M9.5 1.8V4M6.5 12v2.2M9.5 12v2.2M1.8 6.5H4M1.8 9.5H4M12 6.5h2.2M12 9.5h2.2" /></svg>
);
export const IUpDown = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M5 6l3-3 3 3M5 10l3 3 3-3" /></svg>
);

/** 技能：一大一小两颗星（设置 → 技能、“学会了新技能”的提示） */
export const ISpark = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M6.5 2.5l1.1 3.4 3.4 1.1-3.4 1.1-1.1 3.4-1.1-3.4L2 7l3.4-1.1z" />
    <path d="M12 9.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z" />
  </svg>
);
