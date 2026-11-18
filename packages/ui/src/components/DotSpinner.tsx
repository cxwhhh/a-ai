import "./DotSpinner.css";

/**
 * 点阵加载动画（2026-10-29，参考 Uiverse.io · abrahamcalsin 的 dot-spinner）。
 * 8 个点围成一圈，每个点依次放大、变亮再缩小，看起来像一圈光在转。
 * size 是整个圆的直径：思维链里用 12px（和原来的环形动画一样大），输出回答时用 18px。
 */
export function DotSpinner({ size = 12, label = "进行中" }: { size?: number; label?: string }) {
  return (
    <span className="dot-spinner" style={{ ["--uib-size" as string]: `${size}px` }} role="img" aria-label={label}>
      {Array.from({ length: 8 }, (_, i) => (
        <i key={i} className="dot-spinner__dot" />
      ))}
    </span>
  );
}
