import type { ToolSpec } from "../../llm/types";
import type { Artifact } from "../../shared";

/** 工具运行时能拿到的上下文 */
export interface ToolContext {
  sessionId: string;
  /** 当前用户 id：审计日志按用户记录（run_command / run_python） */
  userId?: string;
  /** 当前用户的工作区目录（绝对路径）。文件工具和 run_python 只能在这里面读写 */
  workspace: string;
  /** 把内容推到右栏，并返回保存后的产出物 */
  emitArtifact(a: Omit<Artifact, "id" | "createdAt">): Artifact;
  /** 用户点“停止”时会被触发，耗时工具应当监听它 */
  signal?: AbortSignal;
  /** 把一段实时输出推给前端（只用于显示，不发给模型）。run_command 跑命令时一边跑一边推 */
  onOutput?(delta: string, stream: "out" | "err"): void;
  /**
   * 请用户确认一个有风险的操作，返回是否允许。
   * 要不要真的弹确认由 agent 循环按设置决定（见 run.ts 的 confirm）：readonly=true 的只读命令在默认模式下直接放行。
   * 没有这个函数（例如单独测试工具时）= 不需要确认
   */
  confirm?(req: ApprovalRequest): Promise<boolean>;
}

/** 工具请求用户确认时给出的信息 */
export interface ApprovalRequest {
  /** 要执行的命令原文 */
  command: string;
  /** 为什么要做 / 为什么需要确认，显示在确认卡片上 */
  reason: string;
  /** 只读命令（ls、cat、grep…）：默认的“只读自动允许”模式下不用问 */
  readonly: boolean;
}

/** 工具返回给模型的结果。content 会作为 role=tool 的消息发回模型 */
export interface ToolResult {
  content: string;
  artifactId?: string;
  /**
   * 可选：工具自己判断的状态。不填时执行层按内容推断（见 shared.ts inferStatus）：
   * 抛错 = error；返回 JSON 里 denied / timedOut / exitCode≠0 = 拒绝 / 超时 / 失败；其他 = 成功。
   * 所以普通工具照旧“成功就返回 content，失败就 throw”即可。
   */
  status?: import("../../shared").ToolStatus;
  errorKind?: import("../../shared").ErrorKind;
}

/**
 * 一个工具 = 一份给模型看的说明书(spec) + 一个真正执行的函数(run)
 * spec 决定模型“知不知道、会不会用”这个工具；run 决定“实际做了什么”。
 */
export interface Tool<A = Record<string, unknown>> {
  spec: ToolSpec;
  /**
   * 只读、互不影响：同一轮里可以和其他 parallelSafe 工具并行执行。
   * 写文件、运行代码这类有副作用的工具不要设，它们会按顺序单独执行。
   */
  parallelSafe?: boolean;
  /**
   * 调用后本轮对话结束，等用户回答（ask_user）。
   * 结果照常写进历史，然后 agent 循环停下；用户的下一条消息就是回答。
   */
  endsTurn?: boolean;
  run(args: A, ctx: ToolContext): Promise<ToolResult>;
}
