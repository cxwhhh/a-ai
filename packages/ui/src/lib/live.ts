"use client";
import { createContext, useContext, useSyncExternalStore } from "react";
import type { AgentEvent } from "../../../protocol/src/lib/shared";

/**
 * 工具运行中的“临时状态”：终端实时输出、等待确认的请求。
 *
 * 为什么不放进 Workspace 的 state：它们只有 Trace 里的某一行用得到，又更新得很频繁（每 100ms 一段输出）。
 * 放在这个小 store 里，只有订阅了某个 callId 的那一行会重新渲染，不用把数据一层层传过 ChatPane。
 * 不存数据库：工具结束后以 tool 消息里的结果为准，刷新页面看到的也是那份。
 */
export type OutputChunk = { s: "out" | "err"; t: string };
export type PendingApproval = { approvalId: string; command: string; reason: string };

/** 每个调用最多在浏览器里留这么多字，太长时丢掉最早的 */
const MAX_CHARS = 200_000;

/** 每条聊天流有自己的工具输出和审批。不同会话可同时出现相同的模型 callId。 */
export function createLiveStore() {
  const outputs = new Map<string, OutputChunk[]>();
  const approvals = new Map<string, PendingApproval>();
  let approvalsSnap: Record<string, PendingApproval> = {};
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getOutput: (callId: string) => outputs.get(callId),
    getApprovals: () => approvalsSnap,
    /** Workspace 收到此运行的 SSE 事件后转给这里。 */
    apply(e: AgentEvent) {
      if (e.type === "tool_output") {
        const prev = outputs.get(e.callId) ?? [];
        const last = prev[prev.length - 1];
        // 同一来源相邻的输出拼成一段，渲染的 <span> 少很多。
        let next = last && last.s === e.stream ? [...prev.slice(0, -1), { s: last.s, t: last.t + e.delta }] : [...prev, { s: e.stream, t: e.delta }];
        let total = next.reduce((n, c) => n + c.t.length, 0);
        while (total > MAX_CHARS && next.length) {
          const cut = Math.min(next[0].t.length, total - MAX_CHARS);
          total -= cut;
          next = cut === next[0].t.length ? next.slice(1) : [{ ...next[0], t: next[0].t.slice(cut) }, ...next.slice(1)];
        }
        outputs.set(e.callId, next);
      } else if (e.type === "approval") {
        approvals.set(e.callId, { approvalId: e.approvalId, command: e.command, reason: e.reason });
        approvalsSnap = Object.fromEntries(approvals);
      } else if (e.type === "approval_end") {
        approvals.delete(e.callId);
        approvalsSnap = Object.fromEntries(approvals);
      } else return;
      notify();
    },
    /** 这一轮结束或用户主动停止时清理。切换视图仅更换订阅。 */
    reset() {
      if (!outputs.size && !approvals.size) return;
      outputs.clear();
      approvals.clear();
      approvalsSnap = {};
      notify();
    },
  };
}

export const emptyLiveStore = createLiveStore();
export const LiveStoreContext = createContext(emptyLiveStore);

/** 某个工具调用到目前为止的实时输出 */
export function useLiveOutput(callId: string): OutputChunk[] | undefined {
  const store = useContext(LiveStoreContext);
  return useSyncExternalStore(store.subscribe, () => store.getOutput(callId), () => undefined);
}

/** 所有等待确认的请求：callId → 命令和原因 */
export function useApprovals(): Record<string, PendingApproval> {
  const store = useContext(LiveStoreContext);
  return useSyncExternalStore(store.subscribe, store.getApprovals, store.getApprovals);
}
