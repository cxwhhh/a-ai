/**
 * 3D 加载动画：纯 CSS 立方体（transform-style: preserve-3d + perspective）。
 * running=true 时翻滚；false 时静止并变成“完成”色。
 * 不依赖 three.js，零体积，GPU 合成，不卡主线程。
 */
export function Loader3D({ running, size = 14, state }: { running: boolean; size?: number; state?: "ok" | "err" }) {
  return (
    <span
      className={`cube-wrap ${running ? "on" : ""} ${state ?? ""}`}
      style={{ ["--s" as string]: `${size}px` }}
      aria-label={running ? "运行中" : "已完成"}
      role="img"
    >
      <span className="cube">
        <i className="f1" />
        <i className="f2" />
        <i className="f3" />
        <i className="f4" />
        <i className="f5" />
        <i className="f6" />
        <b className="core" />
      </span>
    </span>
  );
}
