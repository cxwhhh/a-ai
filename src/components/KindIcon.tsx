import { IChart, ICode, IDoc, IFile, IFolder, IGlobe } from "./Icons";
import type { OutputItem } from "@/lib/outputs";

export type Kind = OutputItem["icon"];
const GLYPH = { code: ICode, doc: IDoc, web: IGlobe, chart: IChart, file: IFile, folder: IFolder };

/**
 * 产出物 / 文件的类型图标，带颜色（和产出物页“创建新内容”卡片同一套色）：
 * 网页蓝、文档橙、代码绿、图表粉，普通文件和文件夹保持灰色。颜色定义在 globals.css 的 .k-* 里。
 * tile = 放进同色浅底的圆角小方块里（查看器标题前用）；不加 tile 只给图标上色（列表里用）。
 */
export function KindIcon({ kind, size = 16, tile, className = "" }: { kind: Kind; size?: number; tile?: boolean; className?: string }) {
  const G = GLYPH[kind] ?? IFile;
  return (
    <span className={`kind-ico k-${kind} ${tile ? "kind-tile" : ""} ${className}`}>
      <G width={size} height={size} />
    </span>
  );
}
