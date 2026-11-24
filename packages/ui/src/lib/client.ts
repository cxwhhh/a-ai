"use client";
import type { AgentEvent, AgentQueueSnapshot, ArtifactMeta, Groups, Project, ProjectChat, Session, SessionMeta, Skill, StoredMessage, ToolInfo, UserMemory } from "../../../protocol/src/lib/shared";
import type { WorkspaceAppSummary } from "../../../protocol/src/workspace-app";
import type { Settings, UsageStats } from "../../../protocol/src/lib/settings";
import type { AgentLogEntry, AgentModelSelection } from "../../../protocol/src/agent-events";
import type { SessionTrace, TraceRecordDetail } from "../../../conversation-trace/src/types";
import type { RunningDelegation, SubagentThread, TaskRecord } from "../../../subagent/src/ownership-claim";
import type { TaskContract } from "../../../subagent/src/task-contract";

/**
 * 所有接口请求都走这里：收到 401（没登录或登录过期）就跳到登录页。
 * 这样每个调用的地方都不用自己处理“没登录”的情况。
 */
async function call(url: string, init?: RequestInit) {
  const r = await fetch(url, { cache: "no-store", ...init });
  if (r.status === 401) {
    location.replace("/login");
    throw new Error("请先登录");
  }
  return r;
}
const json = { "Content-Type": "application/json" };
const subagentUrl = (id: string) => `/api/sessions/${encodeURIComponent(id)}/agent/subagents`;

export const api = {
  async archive(target: "session" | "project", id: string, archived: boolean) {
    const resource = target === "session" ? "sessions" : "projects";
    const r = await call(`/api/${resource}/${encodeURIComponent(id)}`, { method: "PATCH", headers: json, body: JSON.stringify({ archived }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || "无法更新归档状态");
  },
  async selectAgentModel(id: string, modelSelection: AgentModelSelection): Promise<AgentModelSelection> {
    const r = await call(`/api/sessions/${encodeURIComponent(id)}`, { method: "PATCH", headers: json, body: JSON.stringify({ modelSelection }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || "无法保存对话模型");
    return r.json();
  },
  async setMultiAgent(id: string, multiAgent: boolean) {
    const r = await call(`/api/sessions/${encodeURIComponent(id)}`, { method: "PATCH", headers: json, body: JSON.stringify({ multiAgent }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || "无法保存多agent智能体模式");
  },
  async agentLog(sessionId?: string, before?: number, inputId?: string): Promise<AgentLogEntry[]> {
    const query = new URLSearchParams();
    if (sessionId) query.set("sessionId", sessionId);
    if (before) query.set("before", String(before));
    if (inputId) query.set("inputId", inputId);
    const r = await call(`/api/chat/log?${query}`);
    if (!r.ok) throw new Error("无法读取运行日志");
    return r.json();
  },
  async sessionTrace(id: string, signal: AbortSignal, stats = false): Promise<SessionTrace> {
    const r = await call(`/api/sessions/${encodeURIComponent(id)}/agent/trace${stats ? "?stats=1" : ""}`, { signal });
    if (!r.ok) throw new Error(r.status === 404 ? "对话不存在" : "无法读取对话轨迹");
    return r.json();
  },
  async traceRecord(id: string, recordId: string, signal: AbortSignal, compare = false): Promise<TraceRecordDetail> {
    const r = await call(`/api/sessions/${encodeURIComponent(id)}/agent/trace/${encodeURIComponent(recordId)}${compare ? "?compare=1" : ""}`, { signal });
    if (!r.ok) throw new Error(r.status === 404 ? "轨迹记录不存在" : "无法读取轨迹详情");
    return r.json();
  },
  async subagentTasks(id: string, signal: AbortSignal, before?: string): Promise<{ tasks: TaskRecord[]; nextBefore?: string }> {
    const r = await call(subagentUrl(id) + (before ? `?before=${encodeURIComponent(before)}` : ""), { signal });
    if (!r.ok) throw new Error("无法读取子任务");
    return r.json();
  },
  async runningSubagents(id: string, runId: string, signal: AbortSignal): Promise<{ tasks: RunningDelegation[] }> {
    const r = await call(`${subagentUrl(id)}?${new URLSearchParams({ runId })}`, { signal });
    if (!r.ok) throw new Error("无法读取运行中的子 Agent");
    return r.json();
  },
  async subagentThreads(id: string, signal: AbortSignal, before?: string, currentOnly = false): Promise<{ tasks: SubagentThread[]; nextBefore?: string }> {
    const query = new URLSearchParams({ threads: currentOnly ? "active" : "1" });
    if (before) query.set("before", before);
    const r = await call(`${subagentUrl(id)}?${query}`, { signal });
    if (!r.ok) throw new Error("无法读取子 Agent 线程");
    return r.json();
  },
  async subagentConversation(id: string, taskId: string, signal: AbortSignal): Promise<{ task: TaskRecord }> {
    const r = await call(`${subagentUrl(id)}?${new URLSearchParams({ taskId })}`, { signal });
    if (!r.ok) throw new Error("无法读取子 Agent 对话");
    return r.json();
  },
  async sendSubagentMessage(id: string, taskId: string, message: string): Promise<{ message: StoredMessage }> {
    const r = await call(`${subagentUrl(id)}?${new URLSearchParams({ taskId })}`, { method: "POST", headers: json, body: JSON.stringify({ message }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "无法发送消息");
    return data;
  },
  async submitSubagentTask(id: string, input: TaskContract | { retryTaskId: string }) {
    const r = await call(subagentUrl(id), { method: "POST", headers: json, body: JSON.stringify(input) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "无法提交子任务");
    return data.task as TaskRecord;
  },
  async stopSubagentTask(id: string, taskId: string) {
    const r = await call(`${subagentUrl(id)}?taskId=${encodeURIComponent(taskId)}`, { method: "DELETE" });
    if (!r.ok) throw new Error("无法停止子任务");
  },
  async list(): Promise<SessionMeta[]> {
    return (await call("/api/sessions")).json();
  },
  async get(id: string): Promise<Session | null> {
    const r = await call(`/api/sessions/${id}`);
    return r.ok ? r.json() : null;
  },
  async rename(id: string, title: string) {
    await call(`/api/sessions/${id}`, { method: "PATCH", headers: json, body: JSON.stringify({ title }) });
  },
  async remove(id: string) {
    await call(`/api/sessions/${id}`, { method: "DELETE" });
  },
  async testConnection(c: { id?: string; baseUrl: string; apiKey: string; preset?: string }): Promise<{ ok: boolean; error?: string; ms?: number; models?: string[]; note?: string }> {
    const r = await call("/api/models/test", { method: "POST", headers: json, body: JSON.stringify(c) });
    return r.json();
  },
  /** 上传附件到工作区 uploads/，返回每个文件在工作区里的路径 */
  async upload(files: File[]): Promise<{ name: string; path: string; size: number }[]> {
    const fd = new FormData();
    for (const f of files) fd.append("file", f);
    const r = await call("/api/upload", { method: "POST", body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `上传失败（${r.status}）`);
    return d.files;
  },
  async queue(sessionId: string): Promise<AgentQueueSnapshot> {
    const r = await call(`/api/chat/queue?sessionId=${encodeURIComponent(sessionId)}`);
    if (!r.ok) throw new Error("无法读取排队消息");
    return r.json();
  },
  async activeRun(sessionId: string): Promise<{ sessionId: string; runId: string } | null> {
    const r = await call(`/api/runs?sessionId=${encodeURIComponent(sessionId)}`);
    return r.ok ? r.json() : null;
  },
  async stopRun(runId: string) {
    const r = await call(`/api/runs/${encodeURIComponent(runId)}`, { method: "DELETE" });
    if (!r.ok && r.status !== 404) throw new Error("无法停止这次运行");
  },
  async updateQueue(sessionId: string, input: { action: "enqueue"; runId: string; message: string } | { action: "steer"; runId: string; id: string } | { action: "remove"; id: string }): Promise<AgentQueueSnapshot> {
    const r = await call("/api/chat/queue", { method: "POST", headers: json, body: JSON.stringify({ sessionId, ...input }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "无法更新排队消息");
    return data;
  },
  async info(): Promise<{ username: string; model: string; tools: ToolInfo[]; systemTokens: number; toolsTokens: number }> {
    return (await call("/api/info")).json();
  },
  async settings(): Promise<{ settings: Settings; defaultSystemPrompt: string }> {
    return (await call("/api/settings")).json();
  },
  async saveSettings(patch: Partial<Settings>): Promise<Settings> {
    const r = await call("/api/settings", { method: "PUT", headers: json, body: JSON.stringify(patch) });
    return (await r.json()).settings;
  },
  async groups(): Promise<Groups> {
    return (await call("/api/groups")).json();
  },
  async saveGroups(g: Groups) {
    await call("/api/groups", { method: "PUT", headers: json, body: JSON.stringify(g) });
  },
  /** 全部产出物的概要（“产出物”页面） */
  async artifacts(signal?: AbortSignal, projectId?: string): Promise<ArtifactMeta[]> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const response = await call(`/api/artifacts${query}`, { signal });
    if (!response.ok) throw new Error("无法读取产出物");
    return response.json();
  },
  async workspaceApps(signal?: AbortSignal, projectId?: string): Promise<WorkspaceAppSummary[]> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const response = await call(`/api/workspace-apps${query}`, { signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "无法读取账号应用");
    return result.apps;
  },
  /* ---------- 项目 ---------- */
  /** 项目页下面的对话列表 */
  async projectChats(id: string): Promise<ProjectChat[]> {
    const r = await call(`/api/projects/${id}/chats`);
    return r.ok ? r.json() : [];
  },
  async projects(): Promise<Project[]> {
    return (await call("/api/projects")).json();
  },
  /** 新建（不传 id）或修改项目设置；失败时抛出服务端给的原因 */
  async saveProject(p: Omit<Project, "id" | "createdAt">, id?: string): Promise<Project> {
    const r = await call(id ? `/api/projects/${id}` : "/api/projects", { method: id ? "PATCH" : "POST", headers: json, body: JSON.stringify(p) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `保存失败（${r.status}）`);
    return d;
  },
  async deleteProject(id: string) {
    await call(`/api/projects/${id}`, { method: "DELETE" });
  },
  /** 把对话移进项目；projectId 为 null = 移出项目 */
  async moveSession(id: string, projectId: string | null) {
    const r = await call(`/api/sessions/${id}`, { method: "PATCH", headers: json, body: JSON.stringify({ projectId }) });
    if (!r.ok) throw new Error("无法移动对话，项目可能已归档或删除");
  },
  async usage(): Promise<UsageStats> {
    return (await call("/api/usage")).json();
  },
  async memory(): Promise<UserMemory> {
    return (await call("/api/memory")).json();
  },
  async saveMemory(m: UserMemory): Promise<UserMemory> {
    return (await call("/api/memory", { method: "PUT", headers: json, body: JSON.stringify(m) })).json();
  },
  async clearMemory(): Promise<UserMemory> {
    return (await call("/api/memory", { method: "DELETE" })).json();
  },
  /** 技能：since 给了就只返回这之后自动新建 / 改进的（对话结束后提示“学会了新技能”用） */
  async skills(since?: number): Promise<Skill[]> {
    return (await call(`/api/skills${since ? `?since=${since}` : ""}`)).json();
  },
  async createSkill(s: Pick<Skill, "name" | "description" | "body">): Promise<Skill> {
    const r = await call("/api/skills", { method: "POST", headers: json, body: JSON.stringify(s) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `请求失败 ${r.status}`);
    return d;
  },
  async updateSkill(id: string, patch: Partial<Pick<Skill, "name" | "description" | "body" | "status">> | { restore: true }): Promise<Skill> {
    const r = await call(`/api/skills/${id}`, { method: "PATCH", headers: json, body: JSON.stringify(patch) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d?.error || `请求失败 ${r.status}`);
    return d;
  },
  async deleteSkill(id: string) {
    await call(`/api/skills/${id}`, { method: "DELETE" });
  },
  /** 回答工具的确认请求（终端命令的“允许 / 本会话都允许 / 拒绝”） */
  async approve(approvalId: string, decision: "allow" | "allow_session" | "deny") {
    const r = await call("/api/approve", { method: "POST", headers: json, body: JSON.stringify({ approvalId, decision }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `请求失败 ${r.status}`);
  },
  async logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    location.replace("/A.ai");
  },
};

/** 发送消息并逐个回调 AgentEvent；返回在 signal 中止或流结束时 resolve */
export async function streamChat(
  body: { sessionId?: string; message?: string; truncateFrom?: string; projectId?: string; revision?: number; queuedId?: string; modelSelection?: AgentModelSelection; multiAgent?: boolean },
  onEvent: (e: AgentEvent) => void,
  signal: AbortSignal,
) {
  const res = await call("/api/chat", { method: "POST", headers: json, body: JSON.stringify(body), signal });
  await followEvents(res, onEvent, signal);
}

/** 页面重新打开时订阅同一运行。断网重试只重新订阅，避免重复提交用户输入。 */
export async function subscribeRun(runId: string, onEvent: (e: AgentEvent) => void, signal: AbortSignal) {
  await followEvents(await readRunStream(runId, 0, signal), onEvent, signal, runId);
}

function readRunStream(runId: string, after: number, signal: AbortSignal) {
  return call(`/api/runs/${encodeURIComponent(runId)}?after=${after}`, { signal });
}

async function followEvents(initial: Response, onEvent: (e: AgentEvent) => void, signal: AbortSignal, runId?: string) {
  let after = 0;
  const emit = (event: AgentEvent, sequence?: number) => {
    if (sequence !== undefined && sequence <= after) return;
    onEvent(event);
    runId ??= event.scope?.runId;
    if (sequence !== undefined) after = sequence;
  };
  if (!initial.ok || !initial.body) return readEvents(initial, emit);
  try { await readEvents(initial, emit); }
  catch (error) {
    if (signal.aborted || !runId) throw error;
    let last: unknown = error;
    for (const delay of [250, 800, 2_000]) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      signal.throwIfAborted();
      try { return await readEvents(await readRunStream(runId, after, signal), emit); }
      catch (failure) { last = failure; }
    }
    throw last;
  }
}

async function readEvents(res: Response, onEvent: (event: AgentEvent, sequence?: number) => void) {
  if (!res.ok || !res.body) {
    const msg = await res.text().catch(() => "");
    // 接口报错一般是 {"error":"…"}，只显示里面的话
    let text = msg;
    try {
      text = (JSON.parse(msg) as { error?: string }).error ?? msg;
    } catch {
      /* 不是 JSON，原样显示 */
    }
    throw new Error(text || `请求失败 ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try { for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      const sequence = /^id:\s*(\d+)$/m.exec(frame);
      if (data) onEvent(JSON.parse(data) as AgentEvent, sequence ? Number(sequence[1]) : undefined);
    }
  } } finally { reader.releaseLock(); }
}

export const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const mod = () => (isMac() ? "⌘" : "Ctrl+");
