import { STATUS_LABEL, toolStatus, type StoredMessage } from "../../protocol/src/lib/shared";

export const SUMMARY_FORMAT = `只输出一个 JSON 对象：{"goal":"用户目标","constraints":["用户约束"],"confirmed":[{"sourceId":"消息ID","quote":"该消息的准确原文片段"}],"progress":[{"text":"已执行或待验证的事项","status":"ok|error|timeout|denied|cancelled|skipped|unknown|unverified","sourceId":"消息ID"}],"pending":["待办或缺口"]}。
confirmed 只引用支持已确认参数和结论的原文。progress 只记录任务进展，省略“A.ai 已回复”之类的对话动作。
progress 使用 ok、error 等状态时，sourceId 必须取对应的 [工具凭据 status=… sourceId=…]，并照抄状态值。用户或 A.ai 消息只可支持 unverified 的进展。合并一组相同结果时，只写该工具凭据本身能证明的事实。没有内容的列表用 []。`;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("摘要必须输出结构化对象");
  return value as Record<string, unknown>;
}

function summaryText(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 600) throw new Error("摘要字段缺失或超长");
  return value.trim();
}

function items<T>(value: unknown, parse: (item: unknown) => T) {
  if (!Array.isArray(value) || value.length > 24) throw new Error("摘要列表缺失或超长");
  return value.map(parse);
}

/** 原文引语和工具状态按保存的消息回检，再以固定 JSON 形状交给下一次模型请求。 */
export function validateSummary(text: string, sources: ReadonlyMap<string, StoredMessage>) {
  const state = object(JSON.parse(text.replace(/^\s*```(?:json)?\s*\r?\n([\s\S]*?)\r?\n?```\s*$/i, "$1")));
  function sourceOf(item: Record<string, unknown>) {
    const id = summaryText(item.sourceId);
    const source = sources.get(id);
    if (!source) throw new Error("摘要引用了不可回查的消息");
    return source;
  }
  return JSON.stringify({
    goal: summaryText(state.goal),
    constraints: items(state.constraints, summaryText),
    confirmed: items(state.confirmed, (value) => {
      const item = object(value);
      const source = sourceOf(item);
      const quote = summaryText(item.quote);
      if (!source.content.includes(quote)) throw new Error("摘要引语和来源原文不一致");
      return { sourceId: source.id, quote };
    }),
    progress: items(state.progress, (value) => {
      const item = object(value);
      const source = sourceOf(item);
      const status = summaryText(item.status);
      if (status !== "unverified" && (!Object.hasOwn(STATUS_LABEL, status) || source.role !== "tool" || toolStatus(source) !== status)) {
        throw new Error("摘要进展和工具执行状态不一致");
      }
      return { text: summaryText(item.text), status, sourceId: source.id };
    }),
    pending: items(state.pending, summaryText),
  });
}
