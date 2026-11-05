/**
 * 毛玻璃 + 彩色光斑分类卡片（2026-10-29 产出物页上用过的一版，用户要求保存备用）。
 * 参考 Uiverse.io（adamgiebl）。效果：正方形卡片，4 个饱和、相邻色相的光斑模糊后透过白色毛玻璃，
 * 变成浅色渐变；中间一个小图标，下面“名称 + 数量”，图标和文字用本色系的深色。
 *
 * 用法：
 *   1. 把本目录两个文件复制到 src/components/
 *   2. <GlassCategoryCards items={[{ key: "all", label: "全部", count: 4, icon: <svg…/> }, …]} active="all" onPick={setKind} />
 *   key 决定色系：all = 紫粉、html = 蓝青、markdown = 橙黄、code = 绿（对应 CSS 里的 .gc-all / .gc-html …）。
 *   想加新色系：在 CSS 里照样加一行 .gc-xxx { --b1..--b4 光斑色; --glow 投影色; --c 图标文字色 }。
 *
 * 结构要点：button 的第 1 个子元素必须是玻璃层，后面紧跟 4 个 .blob——CSS 用 :nth-child(2)～(5) 给光斑定位。
 */
import type { ReactNode } from "react";
import "./GlassCategoryCards.css";

export interface GlassCategory {
  key: string;
  label: string;
  count?: number;
  icon: ReactNode;
}

export function GlassCategoryCards(props: { items: GlassCategory[]; active?: string; onPick?(key: string): void }) {
  return (
    <div className="glass-cats">
      {props.items.map((it) => (
        <button key={it.key} className={`glass-cat gc-${it.key} ${props.active === it.key ? "on" : ""}`} onClick={() => props.onPick?.(it.key)} aria-pressed={props.active === it.key}>
          <span className="glass-cat-glass">
            {it.icon}
            <span className="glass-cat-label">
              {it.label}
              {it.count !== undefined && <em>{it.count}</em>}
            </span>
          </span>
          <i className="blob" />
          <i className="blob" />
          <i className="blob" />
          <i className="blob" />
        </button>
      ))}
    </div>
  );
}
