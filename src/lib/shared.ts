/** 前后端共用的数据结构（不要在这里引入任何 Node 专用模块） */

import type { ChatMessage, Usage } from "./llm/types";

export type ArtifactKind = "markdown" | "html" | "code";

export interface Artifact {
  id: string;
  title: string;
  kind: ArtifactKind;
  language?: string;
  content: string;
  createdAt: number;
  /** 同时保存到工作区的文件路径（例：output/周报模板.html）。2026-10-29 以前的产出物没有 */
  file?: string;
}

/** “产出物”页面用：一个产出物的概要（不带全文，全文太大），加上它来自哪个对话、哪个项目 */
export interface ArtifactMeta {
  id: string;
  title: string;
  kind: ArtifactKind;
  language?: string;
  createdAt: number;
  sessionId: string;
  sessionTitle: string;
  projectId?: string;
  /** 内容开头的一小段纯文字，卡片上当预览 */
  snippet: string;
  /** 内容字数 */
  size: number;
  /** SVG 图（kind=code 但内容是 svg）：卡片上直接画出来 */
  svg?: string;
  /** 不是 create_artifact 的产出物，而是生成的文件（Word / Excel / PPT）：工作区里的路径。打开时按文件打开 */
  file?: string;
}

export interface StoredMessage extends ChatMessage {
  id: string;
  /** 开始时间 */
  createdAt: number;
  /** assistant：整次模型调用耗时；tool：工具执行耗时 */
  durationMs?: number;
  /** assistant：思考阶段耗时 */
  reasoningMs?: number;
  /** assistant：本次模型调用的 token 用量 */
  usage?: Usage;
  /** role=tool 时，若该工具生成了产出物，记录其 id，便于中栏点击打开 */
  artifactId?: string;
  /**
   * role=tool 时：工具没能正常执行（参数不对、抛错、被拦截、被跳过）。
   * 发给模型的内容不变；CallGuard 靠它拦“同样的调用失败两次”。
   * 界面、统计、测评看结果好坏时不要只看它，用 toolStatus()：命令跑完但退出码 1 时 isError 是 false，status 是 "error"。
   */
  isError?: boolean;
  /** role=tool 时：统一的执行状态（第 M1-02 步）。老消息没有这个字段，toolStatus() 会从内容推断 */
  status?: ToolStatus;
  /** status 不是 ok 时：错误类别 + 给用户看的一句话说明 */
  errorKind?: ErrorKind;
  /** assistant：模型正在生成、参数还没拼完整的工具调用。只在前端流式显示用，不落盘 */
  drafts?: { name: string; arguments: string }[];
  /**
   * role=user 时：这不是用户打的字，而是 agent 自动发给模型的“检查反馈”（运行报错、没验证、步数用完）。
   * 发给模型时就是普通的 user 消息；界面上不算新的一轮，而是显示在过程里。见 src/lib/agent/verify.ts
   */
  feedback?: Feedback;
  /**
   * feedback.kind = "compact" 时：上下文压缩的信息。content 是摘要正文。
   * keepFrom 这条消息（含）之后的内容原样保留，之前的都由摘要代替。见 src/lib/agent/context.ts
   */
  compact?: { keepFrom: string; messages: number; tokensBefore: number; tokensAfter: number };
}

export interface Feedback {
  /**
   * retry：运行失败，要求修复；unverified：写了代码没运行；limit：步数用完，要求直接总结；
   * note：用户在 agent 运行中补充的想法（见 src/lib/server/notes.ts）
   * compact：上下文压缩生成的摘要（不发给模型当 user 消息，而是放进系统提示词，见 src/lib/agent/context.ts）
   * check：交付前要求对照用户要求自检；stall：连续几步没进展，要求重新规划（见 src/lib/agent/steer.ts）
   */
  kind: "retry" | "unverified" | "limit" | "note" | "compact" | "check" | "stall";
  /** 第几轮修复（从 1 开始）和上限 */
  round?: number;
  max?: number;
  /** 给界面显示的一句话 */
  summary: string;
}

/**
 * 长期记忆：每个用户一份，存在 SQLite 的 memories 表。
 * 每轮对话结束后由模型“反思”更新（src/lib/agent/reflect.ts），下次对话注入系统提示词。
 */
export interface UserMemory {
  /** 职业 / 背景，一两句话 */
  profile: string;
  /** 习惯与偏好（回答风格、常用技术栈、工作方式……） */
  habits: string[];
  /** 犯过的错误和反思出的规则：mistake = 发生了什么，lesson = 以后怎么做 */
  lessons: Lesson[];
  updatedAt: number;
}
export interface Lesson {
  mistake: string;
  lesson: string;
  /** 同类错误出现了几次：越多越重要，注入提示词时排在前面 */
  count: number;
  updatedAt: number;
}

/**
 * 技能（Skill）：A.ai 从用户的使用中自动总结出来的“做某一类任务的固定做法”。
 * 和长期记忆的区别：记忆是“关于你”（背景、偏好、错误），每次都整段带上；
 * 技能是“怎么做某件事”（步骤、用哪些工具、踩过的坑），提示词里只放名字和一句话，用到时才用 load_skill 读全文。
 * 存在 SQLite 的 skills 表，生成和改进见 src/lib/agent/learn.ts。
 */
export interface Skill {
  id: string;
  /** 名字，同一个用户下不重复，例：周报生成 */
  name: string;
  /** 什么时候用，一句话。会放进系统提示词的“技能目录”，模型靠它判断要不要加载 */
  description: string;
  /** 正文（Markdown）：适用场景、步骤、注意事项、怎么验证 */
  body: string;
  /** pending = 自动生成、等你确认；active = 启用；disabled = 停用（你停的，或成功率太低被自动停的） */
  status: "pending" | "active" | "disabled";
  /** auto = A.ai 自动总结的；user = 你自己新建的 */
  source: "auto" | "user";
  /** 每改进一次 +1 */
  version: number;
  /** 被加载了几次、其中几次顺利完成 / 出了问题 */
  uses: number;
  successes: number;
  failures: number;
  lastUsedAt: number;
  createdAt: number;
  updatedAt: number;
  /** 最近几次变化的记录（新建、改进、停用的原因），最新的在前 */
  history: { at: number; note: string }[];
  /** 上一版的内容：自动改进改坏了可以一键恢复 */
  previous?: { description: string; body: string; version: number };
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 这个对话里有没有生成过文件（产出物或 write_file），左栏用它在对话名右边显示文件图标 */
  hasFiles?: boolean;
  /** 属于哪个项目；不属于任何项目时没有这一项 */
  projectId?: string;
}

/**
 * 项目：一组相关的对话 + 这组对话共用的设置。
 * memory：global = 和平时一样用全局记忆；project = 这个项目单独一份记忆，不和别的项目、平时的对话混；off = 不用记忆
 * share：项目里的对话互相能看到（新对话开始时，agent 会拿到同项目其他对话的摘要）
 */
export type ProjectMemoryMode = "global" | "project" | "off";
export interface Project {
  id: string;
  name: string;
  /** 项目说明：每次对话都会告诉 agent（项目背景、要求、约定） */
  description: string;
  memory: ProjectMemoryMode;
  share: boolean;
  /** 项目图标：图标库（src/lib/agentIcons.ts）里的名字，比如 "code"。没设时显示文件夹 */
  icon?: string;
  createdAt: number;
}

/** 项目页下面的对话列表：一行一个对话，带最后一句回复和生成的文件数 */
export interface ProjectChat {
  id: string;
  title: string;
  updatedAt: number;
  /** 最后一条有文字的回复，开头一小段 */
  preview: string;
  /** 产出物 + 写过的文件（去重后的路径）个数 */
  files: number;
}

export interface Session extends SessionMeta {
  messages: StoredMessage[];
  artifacts: Artifact[];
}

/**
 * 左栏“项目”里的对话分组，存在 .data/groups.json。
 * assign：会话 id → 分组 id；不在 assign 里的会话都算“未分组”（新建的对话默认就在这里）。
 */
export interface Group {
  id: string;
  name: string;
}
export interface Groups {
  groups: Group[];
  assign: Record<string, string>;
  /** 手动拖过位置的对话 id，按先后排列（每个分组内部按它排；没拖过的新对话排在组的最上面） */
  order?: string[];
}

/** 左栏展示用：当前注册了哪些工具 */
export interface ToolInfo {
  name: string;
  description: string;
}

/**
 * /api/chat 通过 SSE 推给前端的事件。
 * 一轮对话 = 若干 step；每个 step = 一次模型调用（思考 → 文字 → 工具调用），然后执行这些工具。
 */
export type AgentEvent =
  | { type: "session"; session: SessionMeta }
  | { type: "message"; message: StoredMessage } // 一条完整消息落库（用户消息、工具结果）
  | { type: "reasoning"; messageId: string; createdAt: number; delta: string } // 思考增量
  | { type: "text"; messageId: string; createdAt: number; delta: string } // 回答增量
  | { type: "tool_input"; messageId: string; createdAt: number; index: number; name: string; delta: string } // 工具参数增量
  | { type: "assistant_end"; message: StoredMessage } // assistant 消息定稿（含 toolCalls、耗时）
  | { type: "tool_start"; callId: string; name: string; startedAt: number }
  | { type: "tool_output"; callId: string; stream: "out" | "err"; delta: string } // 工具运行中的实时输出（run_command），只用于显示
  | { type: "approval"; callId: string; command: string; reason: string } // 工具在等用户确认，前端显示确认卡片
  | { type: "approval_end"; callId: string; allowed: boolean } // 确认结束（用户点了、超时或停止），收起卡片
  | { type: "artifact"; artifact: Artifact }
  | { type: "error"; message: string }
  | { type: "done" };

/**
 * 工具调用的最终状态（见 src/lib/agent/status.ts）：
 *   ok 成功 · error 失败（抛错，或命令 / 代码退出码不是 0）· timeout 超时 · denied 用户拒绝
 *   cancelled 用户点了停止、还没开始或只读操作被中止 · skipped 系统没有执行（前面的操作失败了、和提问混在一起）
 *   unknown 写文件、跑命令这类有副作用的操作执行到一半被停止：可能已经改了东西，要先检查
 */
export type ToolStatus = "ok" | "error" | "timeout" | "denied" | "cancelled" | "skipped" | "unknown";
/** 错误类别：args 参数不对 · exit 命令或代码退出码非 0 · blocked 被规则拦截 · unavailable 工具不可用 · tool 工具内部报错 · dependency 依赖的上一步失败 · protocol 调用方式不对（提问和别的操作混在一起） */
export type ErrorKind = "args" | "exit" | "blocked" | "unavailable" | "tool" | "dependency" | "protocol" | "network";

export const STATUS_LABEL: Record<ToolStatus, string> = {
  ok: "成功", error: "失败", timeout: "超时", denied: "已拒绝", cancelled: "已取消", skipped: "已跳过", unknown: "结果不确定",
};

/** 这条工具结果的状态。新消息直接读 status；老消息（没有 status）按内容推断，和执行层用同一套规则 */
export function toolStatus(m: Pick<StoredMessage, "status" | "isError" | "content">): ToolStatus {
  if (m.status) return m.status;
  if (m.isError) return "error";
  return inferStatus(m.content).status;
}

/**
 * 工具正常返回（没抛错）时，按结果内容判断状态：
 * run_command / run_python 返回 JSON：denied → 拒绝；timedOut → 超时；exitCode 不是 0（或被信号结束）→ 失败。
 * 其他工具（包括 grep 没有匹配、搜索没有结果）都算成功：没找到也是一个有效的结果。
 */
export function inferStatus(content: string): { status: ToolStatus; errorKind?: ErrorKind } {
  if (!content.startsWith("{") || !/"(exitCode|denied|timedOut)"/.test(content)) return { status: "ok" };
  try {
    const r = JSON.parse(content) as { exitCode?: number | null; denied?: boolean; timedOut?: boolean; signal?: string };
    if (r.denied) return { status: "denied" };
    if (r.timedOut) return { status: "timeout", errorKind: "exit" };
    if (r.exitCode !== undefined && r.exitCode !== 0) return { status: "error", errorKind: "exit" };
    return { status: "ok" };
  } catch {
    return { status: "ok" };
  }
}
