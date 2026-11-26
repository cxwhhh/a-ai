import "./RingSpinner.css";

/** 对话没有可计算的完成比例，保留固定弧段，靠旋转表示任务仍在进行。 */
export function RingSpinner({ size = 12, label = "进行中" }: { size?: number; label?: string }) {
  return (
    <svg className="chat-run-ring" width={size} height={size} viewBox="0 0 18 18" role="img" aria-label={label}>
      <circle cx="9" cy="9" r="7.5" className="chat-run-ring-track" />
      <circle cx="9" cy="9" r="7.5" className="chat-run-ring-arc" pathLength="100" strokeDasharray="32 68" />
    </svg>
  );
}
