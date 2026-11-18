import type { AgentLogEntry, AgentLogEvent } from "../../protocol/src/agent-events";

const toolResult = {
  kind: "tool-result",
  runId: "run-1",
  inputId: "input-1",
  detail: { step: 1, callId: "call-1", status: "ok", durationMs: null, errorKind: null, artifactId: null },
} satisfies AgentLogEvent<"tool-result">;

// @ts-expect-error 工具结果必须绑定一条输入。
const missingInput: AgentLogEvent = { ...toolResult, inputId: undefined };
// @ts-expect-error 工具结果必须绑定一次运行。
const missingRun: AgentLogEvent = { ...toolResult, runId: undefined };
// @ts-expect-error kind 不能配其他事件的 detail。
const wrongDetail: AgentLogEvent = { ...toolResult, detail: { outcome: "completed" } };
// @ts-expect-error 调用 ID 是工具结果的必要字段。
const missingCall: AgentLogEvent = { ...toolResult, detail: { ...toolResult.detail, callId: undefined } };
// @ts-expect-error 归档归属于会话。
const archiveWithRun: AgentLogEvent = { kind: "archived", runId: "run-1", detail: { target: "session", targetId: "s" } };

/** 确认按 kind 缩小类型后，读取方可以直接得到工具结果的字段。 */
export function checkToolResult(entry: AgentLogEntry) {
  if (entry.kind === "tool-result") {
    const ids: string[] = [entry.runId, entry.inputId, entry.detail.callId];
    return ids;
  }
}
