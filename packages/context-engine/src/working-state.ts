import { toolStatus, type Artifact, type StoredMessage, type ToolStatus } from "../../protocol/src/lib/shared";
import { splitAttachments } from "../../protocol/src/lib/attachments";
import { NOTE_TAG } from "../../protocol/src/lib/message-tags";

/**
 * 本次任务的结构化工作态（M2-01）：
 *
 * 与长期记忆（跨会话画像/习惯）和 /任务要求（显式最高优先指令）分开：
 * - 完全从当前会话活动分支的历史消息与产出确定性推导，不额外调用模型，不引入幻觉，也不需改数据库表；
 * - 简单纯文本问答返回 null，不向提示词注入无关噪音；
 * - 跨轮或触发压缩后，集中承载目标、最新补充约束、待办计划、已读/已改文件、已失败方法、产出引用与待解决项；
 * - 当出现新的 /任务要求 或运行中补充（feedback.kind === "note"）时，自动把更早生成的计划与代码验证标记为“可能过时”。
 */

export type WorkingFileAction = "read" | "write" | "edit" | "document";

export interface WorkingFileState {
  path: string;
  actions: WorkingFileAction[];
  verified: boolean;
  staleVerification: boolean;
}

export interface WorkingPlanItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface WorkingPlanState {
  items: WorkingPlanItem[];
  stale: boolean;
}

export interface WorkingFailure {
  tool: string;
  target?: string;
  status: ToolStatus;
  summary: string;
}

export interface WorkingOutput {
  label: string;
  kind: string;
  path?: string;
}

export interface WorkingState {
  goal: string;
  latestNotes: string[];
  plan?: WorkingPlanState;
  files: WorkingFileState[];
  failedApproaches: WorkingFailure[];
  outputs: WorkingOutput[];
  openIssues: string[];
}

const MAX_GOAL_CHARS = 200;
const MAX_NOTES = 5;
const MAX_NOTE_CHARS = 160;
const MAX_PLAN_ITEMS = 12;
const MAX_FILES = 12;
const MAX_FAILURES = 5;
const MAX_OUTPUTS = 8;
const MAX_OPEN_ISSUES = 8;
const MAX_PROMPT_CHARS = 1_600;

const READ_TOOLS = new Set(["read_file", "read_document"]);
const WRITE_TOOLS = new Set(["write_file", "edit_file", "write_document"]);
const CODE_RUN_TOOLS = new Set(["run_python", "run_command"]);
const CODE_EXT = /\.(?:py|ts|tsx|js|jsx|mjs|cjs|sh)$/i;
const FAILURE_STATUSES = new Set<ToolStatus>(["error", "timeout", "denied", "unknown"]);

function cleanLine(text: string, max: number) {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max) + "…" : one;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function normalizePath(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function baseName(filePath: string) {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

function failureTarget(tool: string, args: Record<string, unknown>): string | undefined {
  const raw = args.path ?? args.file ?? args.url ?? args.command ?? args.pattern ?? args.query;
  return typeof raw === "string" && raw.trim() ? cleanLine(raw, 80) : undefined;
}

function failureSummary(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) {
    try {
      const data = JSON.parse(trimmed) as Record<string, unknown>;
      const msg = data.error ?? data.stderr ?? data.output ?? data.note;
      if (typeof msg === "string" && msg.trim()) return cleanLine(msg, 120);
      if (typeof data.exitCode === "number" && data.exitCode !== 0) return `exitCode=${data.exitCode}`;
      if (data.timedOut) return "执行超时";
      if (data.denied) return "用户拒绝或被策略拦截";
    } catch {
      // 非法 JSON 退回首行摘要
    }
  }
  const firstLine = trimmed.split(/\r?\n/).find((line) => line.trim()) ?? trimmed;
  return cleanLine(firstLine || "执行失败", 120);
}

/**
 * 从活动分支的消息切片和产出列表推导当前任务工作态。
 * `constraintTail` 用于传入 cutoff 之后的本轮消息：当本轮中途发生 /任务要求 或补充约束时，
 * 及时把 cutoff 之前生成的旧计划与旧验证标记为过期，同时不把本轮普通工具步骤混入系统前缀。
 */
export function deriveWorkingState(
  messages: readonly StoredMessage[],
  artifacts: readonly Artifact[] = [],
  constraintTail: readonly StoredMessage[] = [],
): WorkingState | null {
  let goal = "";
  let lastConstraintSeq = -1;
  const latestNotes: string[] = [];
  let planItems: WorkingPlanItem[] | undefined;
  let planSeq = -1;

  interface FileTrack {
    path: string;
    actions: Set<WorkingFileAction>;
    modifiedSeq: number;
    verified: boolean;
    verifiedSeq: number;
  }
  const filesMap = new Map<string, FileTrack>();
  const ensureFile = (p: string): FileTrack => {
    let track = filesMap.get(p);
    if (!track) {
      track = { path: p, actions: new Set(), modifiedSeq: -1, verified: false, verifiedSeq: -1 };
      filesMap.set(p, track);
    }
    return track;
  };

  const failuresMap = new Map<string, WorkingFailure & { seq: number }>();
  const resolvedKeys = new Set<string>();
  const outputsMap = new Map<string, WorkingOutput>();
  let toolInteractions = 0;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.feedback?.kind === "compact") continue;

    if (m.taskRequirements !== undefined) {
      lastConstraintSeq = i;
      continue;
    }

    if (m.role === "user") {
      if (m.feedback?.kind === "note") {
        lastConstraintSeq = i;
        const rawNote = m.feedback.summary || (m.content.startsWith(NOTE_TAG) ? m.content.slice(NOTE_TAG.length) : m.content);
        const note = cleanLine(rawNote, MAX_NOTE_CHARS);
        if (note) latestNotes.push(note);
      } else if (!m.feedback && !goal) {
        const { text } = splitAttachments(m.content);
        goal = cleanLine(text || m.content, MAX_GOAL_CHARS);
      }
      continue;
    }

    if (m.role !== "assistant" || !m.toolCalls?.length) continue;

    // 收集紧跟在当前 assistant 之后的 tool 结果，避免跨步 callId 复用串结果。
    const results = new Map<string, StoredMessage>();
    let j = i + 1;
    while (j < messages.length && messages[j].role === "tool") {
      const tr = messages[j];
      if (tr.toolCallId) results.set(tr.toolCallId, tr);
      j++;
    }

    for (const call of m.toolCalls) {
      const result = results.get(call.id);
      if (!result) continue;
      toolInteractions++;
      const status = toolStatus(result);
      const args = parseArgs(call.arguments);
      const target = failureTarget(call.name, args);
      const key = `${call.name}|${target ?? ""}`;

      if (status === "ok") {
        resolvedKeys.add(key);
        failuresMap.delete(key);

        if (call.name === "todo_write") {
          try {
            const parsed = JSON.parse(result.content) as { todos?: unknown[] };
            if (Array.isArray(parsed.todos)) {
              const items: WorkingPlanItem[] = [];
              for (const item of parsed.todos) {
                if (!item || typeof item !== "object") continue;
                const rec = item as Record<string, unknown>;
                const content = typeof rec.content === "string" ? cleanLine(rec.content, 120) : "";
                const st = rec.status === "completed" || rec.status === "in_progress" ? rec.status : "pending";
                if (content) items.push({ content, status: st });
              }
              if (items.length) {
                planItems = items.slice(0, MAX_PLAN_ITEMS);
                planSeq = i;
              }
            }
          } catch {
            // 忽略非标准 todo_write 返回
          }
        } else if (READ_TOOLS.has(call.name)) {
          const p = normalizePath(args.path);
          if (p) ensureFile(p).actions.add("read");
        } else if (WRITE_TOOLS.has(call.name)) {
          let p = normalizePath(args.path);
          if (call.name === "write_document") {
            try {
              const parsed = JSON.parse(result.content) as { path?: unknown };
              if (typeof parsed.path === "string") p = normalizePath(parsed.path) || p;
            } catch {}
          }
          if (p) {
            const track = ensureFile(p);
            const act: WorkingFileAction = call.name === "write_file" ? "write" : call.name === "edit_file" ? "edit" : "document";
            track.actions.add(act);
            track.modifiedSeq = i;
            track.verified = false;
            if (call.name === "write_document") {
              outputsMap.set(`file:${p}`, { label: baseName(p), kind: "document", path: p });
            }
          }
        } else if (CODE_RUN_TOOLS.has(call.name)) {
          const codeOrCmd = typeof args.code === "string" ? args.code : typeof args.command === "string" ? args.command : "";
          for (const track of filesMap.values()) {
            if (track.modifiedSeq < 0) continue;
            if (codeOrCmd.includes(track.path) || codeOrCmd.includes(baseName(track.path))) {
              track.verified = true;
              track.verifiedSeq = i;
            }
          }
        }
      } else if (FAILURE_STATUSES.has(status)) {
        resolvedKeys.delete(key);
        failuresMap.set(key, {
          tool: call.name,
          target,
          status,
          summary: failureSummary(result.content),
          seq: i,
        });
      }
    }
    i = j - 1;
  }

  // 检查 cutoff 之后的本轮约束变动，及时把更早生成的计划与验证标为过时。
  for (let k = 0; k < constraintTail.length; k++) {
    const m = constraintTail[k];
    if (m.taskRequirements !== undefined || m.feedback?.kind === "note") {
      lastConstraintSeq = messages.length + k;
    }
  }

  for (const art of artifacts) {
    const label = cleanLine(art.title || art.file || art.id, 80);
    const key = art.workspaceApp ? `app:${art.workspaceApp.id}` : art.file ? `file:${normalizePath(art.file)}` : `art:${art.id}`;
    outputsMap.set(key, { label, kind: art.workspaceApp ? "app" : art.kind, ...(art.file ? { path: normalizePath(art.file) } : {}) });
  }

  // 简单纯文本问答（无工具交互、无待办、无补充约束、无产出）不生成工作态，避免污染上下文。
  if (!toolInteractions && !planItems?.length && !latestNotes.length && !outputsMap.size && !filesMap.size) {
    return null;
  }

  const plan: WorkingPlanState | undefined = planItems?.length
    ? { items: planItems, stale: lastConstraintSeq > planSeq }
    : undefined;

  const files: WorkingFileState[] = [...filesMap.values()]
    .slice(-MAX_FILES)
    .map((track) => {
      const staleVerification = track.verified && (lastConstraintSeq > track.verifiedSeq || track.modifiedSeq > track.verifiedSeq);
      return {
        path: track.path,
        actions: [...track.actions],
        verified: track.verified && !staleVerification,
        staleVerification,
      };
    });

  const failedApproaches: WorkingFailure[] = [...failuresMap.values()]
    .sort((a, b) => a.seq - b.seq)
    .slice(-MAX_FAILURES)
    .map(({ seq: _seq, ...rest }) => rest);

  const outputs = [...outputsMap.values()].slice(-MAX_OUTPUTS);

  const openIssues: string[] = [];
  if (plan) {
    if (plan.stale) openIssues.push("当前计划生成于最新约束之前，需核对是否调整");
    for (const item of plan.items) {
      if (item.status !== "completed" && openIssues.length < MAX_OPEN_ISSUES) {
        openIssues.push(`待办(${item.status === "in_progress" ? "进行中" : "未开始"}): ${item.content}`);
      }
    }
  }
  for (const file of files) {
    if (openIssues.length >= MAX_OPEN_ISSUES) break;
    const modified = file.actions.includes("write") || file.actions.includes("edit");
    if (file.staleVerification) openIssues.push(`${file.path} 的验证已因约束或文件变更过时，需重新验证`);
    else if (modified && CODE_EXT.test(file.path) && !file.verified) openIssues.push(`${file.path} 已修改但尚未运行验证`);
  }
  for (const failure of failedApproaches) {
    if (openIssues.length >= MAX_OPEN_ISSUES) break;
    openIssues.push(`此前 ${failure.tool}${failure.target ? `(${failure.target})` : ""} 失败(${failure.status})：${failure.summary}`);
  }

  return {
    goal,
    latestNotes: latestNotes.slice(-MAX_NOTES),
    plan,
    files,
    failedApproaches,
    outputs,
    openIssues: openIssues.slice(0, MAX_OPEN_ISSUES),
  };
}

/** 将结构化工作态格式化为简洁紧凑的系统提示词块（上限约 1,600 字）。 */
export function formatWorkingState(state: WorkingState): string {
  const lines: string[] = ["## 当前任务工作态（由历史执行自动归纳，若与最新用户消息或任务要求冲突以后者为准）"];
  if (state.goal) lines.push(`- 目标：${state.goal}`);
  if (state.latestNotes.length) {
    lines.push(`- 历史补充约束：${state.latestNotes.map((n, idx) => `${idx + 1}) ${n}`).join("；")}`);
  }
  if (state.plan) {
    const done = state.plan.items.filter((x) => x.status === "completed").length;
    const staleTag = state.plan.stale ? "（已过时：生成于最新约束之前，需先核对）" : "";
    lines.push(`- 当前计划（${done}/${state.plan.items.length} 完成）${staleTag}：`);
    for (const item of state.plan.items) {
      const mark = item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[~]" : "[ ]";
      lines.push(`  - ${mark} ${item.content}`);
    }
  }
  if (state.files.length) {
    const labels: Record<WorkingFileAction, string> = { read: "读", write: "写", edit: "改", document: "文档" };
    const summary = state.files.map((f) => {
      const acts = f.actions.map((a) => labels[a]).join("/");
      const ver = f.staleVerification ? "·验证已过时" : f.verified ? "·已验证" : "";
      return `${f.path}(${acts}${ver})`;
    });
    lines.push(`- 文件状态：${summary.join("，")}`);
  }
  if (state.failedApproaches.length) {
    lines.push("- 已失败尝试（避免原样重复）：");
    for (const f of state.failedApproaches) {
      lines.push(`  - ${f.tool}${f.target ? `(${f.target})` : ""} [${f.status}]：${f.summary}`);
    }
  }
  if (state.outputs.length) {
    lines.push(`- 已登记产出：${state.outputs.map((o) => (o.path ? `${o.label}(${o.path})` : `${o.label}[${o.kind}]`)).join("，")}`);
  }
  if (state.openIssues.length) {
    lines.push(`- 待跟进事项：${state.openIssues.join("；")}`);
  }
  const text = lines.join("\n");
  return text.length > MAX_PROMPT_CHARS ? text.slice(0, MAX_PROMPT_CHARS) + "\n…（工作态已截断）" : text;
}

/**
 * 为 buildContext 生成“轮内稳定”的任务工作态提示词：
 * 仅归纳 cutoffIndex 之前的历史（多轮时为本轮起点之前，单轮压缩时为保留起点之前），
 * 确保同一轮常规工具步骤之间系统提示词字节完全一致，不破坏服务端 Prompt Cache；
 * 同时扫描 cutoffIndex 之后的约束变更以即时将旧计划与旧验证标为过时。
 */
export function workingStatePrompt(
  messages: readonly StoredMessage[],
  cutoffIndex: number,
  artifacts: readonly Artifact[] = [],
): string {
  if (cutoffIndex <= 0) return "";
  const prefix = messages.slice(0, cutoffIndex);
  const tail = messages.slice(cutoffIndex);
  // 仅纳入 cutoff 之前已产生的产出物，避免当前轮中途新建产出物反过来改写系统提示词、击穿当轮 Prompt Cache。
  const prefixCallIds = new Set<string>();
  const prefixArtifactIds = new Set<string>();
  for (const m of prefix) {
    if (m.artifactId) prefixArtifactIds.add(m.artifactId);
    for (const call of m.toolCalls ?? []) prefixCallIds.add(call.id);
  }
  const cutoffTs = prefix[prefix.length - 1]?.createdAt ?? 0;
  const scopedArtifacts = artifacts.filter((art) =>
    prefixArtifactIds.has(art.id) ||
    (art.sourceToolCallId ? prefixCallIds.has(art.sourceToolCallId) : art.createdAt <= cutoffTs),
  );
  const state = deriveWorkingState(prefix, scopedArtifacts, tail);
  return state ? formatWorkingState(state) : "";
}
