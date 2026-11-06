/**
 * 用户设置（前后端共用的类型和默认值）。
 * 保存在服务端 .data/settings.json，所以换浏览器、刷新都不会丢。
 * 其中 systemPrompt、maxSteps、maxFixRounds、memory、skills 会被 agent 循环实际使用（见 src/lib/agent/run.ts）。
 */
/* ---------------- 模型连接 ---------------- */

export interface ModelEntry {
  id: string; // 发给 API 的模型名，例如 deepseek-flash
  contextWindow: number; // 上下文长度（token），用于计算占用百分比
}

/** 一个“连接” = 一个 OpenAI 兼容的 API 地址 + Key + 它下面可用的若干模型 */
export interface Connection {
  id: string;
  name: string;
  preset: "deepseek" | "anthropic" | "custom";
  baseUrl: string;
  /** 只保存在服务端 .data/settings.json；发给浏览器时会被打码成 ••••abcd */
  apiKey: string;
  models: ModelEntry[];
  /** 回传思考内容（DeepSeek 思考模式 + 工具调用时必须开启） */
  sendReasoning: boolean;
  /** DeepSeek 思考开关：default = 不传参数，用模型默认 */
  thinking: "default" | "enabled" | "disabled";
}

/** 预设：DeepSeek 的地址、模型名、上下文长度来自官方文档（2026-10） */
export const PRESETS: Record<Connection["preset"], Omit<Connection, "id" | "apiKey">> = {
  deepseek: {
    name: "DeepSeek",
    preset: "deepseek",
    baseUrl: "https://api.deepseek.com",
    models: [
      { id: "deepseek-flash", contextWindow: 1_000_000 },
      { id: "deepseek-v4-pro", contextWindow: 1_000_000 },
    ],
    sendReasoning: true,
    thinking: "default",
  },
  // Claude：Anthropic 原生接口（不是 OpenAI 兼容），模型名和上下文长度来自官方文档（2026-10）
  anthropic: {
    name: "Claude",
    preset: "anthropic",
    baseUrl: "https://api.anthropic.com",
    models: [
      { id: "claude-opus-5-5", contextWindow: 1_000_000 },
      { id: "claude-sonnet-5-5", contextWindow: 1_000_000 },
      { id: "claude-haiku-5-5", contextWindow: 1_000_000 },
    ],
    sendReasoning: false,
    thinking: "default",
  },
  custom: { name: "自定义", preset: "custom", baseUrl: "", models: [], sendReasoning: false, thinking: "default" },
};

export const MOCK_MODEL = { value: "mock", label: "Mock（演示）", contextWindow: 128_000 };

export interface ModelOption {
  value: string; // "mock" 或 "连接id/模型名"
  label: string;
  group: string;
  contextWindow: number;
}

/** 下拉框里可选的全部模型 */
export function modelOptions(s: Pick<Settings, "connections">): ModelOption[] {
  return [
    { ...MOCK_MODEL, group: "内置" },
    ...s.connections.flatMap((c) => c.models.map((m) => ({ value: `${c.id}/${m.id}`, label: m.id, group: c.name, contextWindow: m.contextWindow }))),
  ];
}

export function currentOption(s: Pick<Settings, "connections" | "currentModel">): ModelOption {
  const all = modelOptions(s);
  return all.find((o) => o.value === s.currentModel) ?? all[0];
}

export const MASK = "••••";
export const isMasked = (k: string) => k.startsWith(MASK);
export const maskKey = (k: string) => (k ? MASK + k.slice(-4) : "");

/* ---------------- 设置 ---------------- */

export interface Settings {
  /** 左下角显示的名字 */
  name: string;
  /** 主题：跟随系统 / 浅色 / 深色 */
  theme: "system" | "light" | "dark";
  /** 对话区宽度：窄 / 标准 / 宽 */
  chatWidth: "narrow" | "normal" | "wide";
  /** 对话字号：小 / 标准 / 大 */
  fontSize: "small" | "normal" | "large";
  /** 左栏字号：小 / 标准 / 大 / 特大（只影响左栏文字，logo 的 “A.ai” 不变） */
  sideFontSize: "small" | "normal" | "large" | "xlarge";
  /** 代码字体（代码块、思维链里的代码、行内代码）。前 6 款打包在仓库里；cascadia / consolas 用电脑自带的，没装就退回 JetBrains Mono */
  codeFont: CodeFont;
  /** 发送方式：Enter 发送，或 ⌘/Ctrl+Enter 发送（Enter 换行） */
  sendKey: "enter" | "mod-enter";
  /** 生成新产出时自动在右侧大视图打开 */
  autoOpen: boolean;
  /** 自定义系统提示词；留空用内置的 */
  systemPrompt: string;
  /** 一轮对话最多调用模型几次（防止无限循环） */
  maxSteps: number;
  /** 反馈闭环：代码运行失败时，最多让模型自动修复几轮（0 = 关闭）。见 src/lib/agent/verify.ts */
  maxFixRounds: number;
  /** 长期记忆：每轮结束后总结用户画像和犯过的错，下次对话注入提示词 */
  memory: boolean;
  /** 技能：把反复做的事、做成功的复杂任务自动总结成技能，下次同类任务按技能做（见 src/lib/agent/learn.ts） */
  skills: boolean;
  /** 新总结出的技能直接启用；关闭时（默认）先放进“待确认”，你点了启用才会用 */
  skillAutoEnable: boolean;
  /**
   * 终端命令（run_command）什么时候要用户确认：
   * ask = 每条都问；readonly = 只读命令（ls、cat、grep…）直接跑，其余问；auto = 都不问（危险命令仍然拒绝）
   */
  commandApproval: "ask" | "readonly" | "auto";
  /** 模型连接 */
  connections: Connection[];
  /** 当前使用的模型："mock" 或 "连接id/模型名" */
  currentModel: string;
  /** 设置格式的版本号，用来升级旧数据（见 normalizeSettings 里的 maxSteps） */
  version: number;
}

export const CODE_FONTS = ["jetbrains", "fira", "plex", "source", "geist", "roboto", "cascadia", "consolas"] as const;
export type CodeFont = (typeof CODE_FONTS)[number];

export const DEFAULT_SETTINGS: Settings = {
  name: "用户",
  theme: "system",
  chatWidth: "normal",
  fontSize: "normal",
  sideFontSize: "normal",
  codeFont: "jetbrains",
  sendKey: "enter",
  autoOpen: true,
  systemPrompt: "",
  maxSteps: 25,
  maxFixRounds: 3,
  memory: true,
  skills: true,
  skillAutoEnable: false,
  commandApproval: "readonly",
  connections: [],
  currentModel: "mock",
  version: 2,
};

/** 校验并补全：只接受已知字段和合法取值，防止前端传来脏数据写坏文件 */
export function normalizeSettings(input: unknown): Settings {
  const s = (input && typeof input === "object" ? input : {}) as Partial<Record<keyof Settings, unknown>>;
  const d = DEFAULT_SETTINGS;
  return {
    name: typeof s.name === "string" && s.name.trim() ? s.name.trim().slice(0, 32) : d.name,
    theme: s.theme === "light" || s.theme === "dark" || s.theme === "system" ? s.theme : d.theme,
    chatWidth: s.chatWidth === "narrow" || s.chatWidth === "wide" ? s.chatWidth : "normal",
    fontSize: s.fontSize === "small" || s.fontSize === "large" ? s.fontSize : "normal",
    sideFontSize: s.sideFontSize === "small" || s.sideFontSize === "large" || s.sideFontSize === "xlarge" ? s.sideFontSize : "normal",
    codeFont: CODE_FONTS.includes(s.codeFont as CodeFont) ? (s.codeFont as CodeFont) : d.codeFont,
    sendKey: s.sendKey === "mod-enter" ? "mod-enter" : "enter",
    autoOpen: typeof s.autoOpen === "boolean" ? s.autoOpen : d.autoOpen,
    systemPrompt: typeof s.systemPrompt === "string" ? s.systemPrompt.slice(0, 8000) : d.systemPrompt,
    // 版本 1（没有 version 字段）的默认步数是 8：工具变多以后 8 步太少，复杂任务做一半就被截断。
    // 旧设置里存的 8 当作“没改过”，升级成新的默认值；升级后存进去的是 version 2，之后用户自己选 8 也不会再被改
    maxSteps:
      Number.isFinite(Number(s.maxSteps)) && !(s.version !== 2 && Number(s.maxSteps) === 8)
        ? Math.min(100, Math.max(1, Math.round(Number(s.maxSteps))))
        : d.maxSteps,
    maxFixRounds: Number.isFinite(Number(s.maxFixRounds)) ? Math.min(10, Math.max(0, Math.round(Number(s.maxFixRounds)))) : d.maxFixRounds,
    memory: typeof s.memory === "boolean" ? s.memory : d.memory,
    skills: typeof s.skills === "boolean" ? s.skills : d.skills,
    skillAutoEnable: typeof s.skillAutoEnable === "boolean" ? s.skillAutoEnable : d.skillAutoEnable,
    commandApproval: s.commandApproval === "ask" || s.commandApproval === "auto" ? s.commandApproval : "readonly",
    connections: Array.isArray(s.connections) ? s.connections.slice(0, 20).map(normalizeConnection).filter((c): c is Connection => !!c) : [],
    currentModel: typeof s.currentModel === "string" && s.currentModel ? s.currentModel : d.currentModel,
    version: d.version,
  };
}

function normalizeConnection(x: unknown): Connection | null {
  if (!x || typeof x !== "object") return null;
  const c = x as Record<string, unknown>;
  const id = typeof c.id === "string" && /^[a-z0-9_-]{1,40}$/i.test(c.id) ? c.id : null;
  if (!id) return null;
  const preset = c.preset === "deepseek" || c.preset === "anthropic" ? c.preset : "custom";
  const models = Array.isArray(c.models)
    ? c.models
        .map((m) => {
          const e = (m ?? {}) as Record<string, unknown>;
          const mid = typeof e.id === "string" ? e.id.trim().slice(0, 120) : "";
          const cw = Number(e.contextWindow);
          return mid ? { id: mid, contextWindow: Number.isFinite(cw) && cw > 0 ? Math.round(cw) : 128_000 } : null;
        })
        .filter((m): m is ModelEntry => !!m)
        .slice(0, 50)
    : [];
  return {
    id,
    name: typeof c.name === "string" && c.name.trim() ? c.name.trim().slice(0, 40) : PRESETS[preset].name,
    preset,
    baseUrl: typeof c.baseUrl === "string" ? c.baseUrl.trim().slice(0, 300) : "",
    apiKey: typeof c.apiKey === "string" ? c.apiKey.trim().slice(0, 400) : "",
    models,
    sendReasoning: typeof c.sendReasoning === "boolean" ? c.sendReasoning : preset === "deepseek",
    thinking: c.thinking === "enabled" || c.thinking === "disabled" ? c.thinking : "default",
  };
}

/** 用量统计（/api/usage 返回） */
export interface UsageStats {
  sessions: number;
  cacheHitTokens: number;
  turns: number; // 用户发了几次消息
  modelCalls: number; // 模型被调用几次（一轮可能多次）
  toolCalls: number;
  toolErrors: number;
  /** 没有执行的工具调用：用户拒绝、点了停止、被系统跳过（不算出错） */
  toolSkipped?: number;
  artifacts: number;
  inputTokens: number;
  outputTokens: number;
  modelMs: number;
  toolMs: number;
  byTool: { name: string; count: number; errors: number; avgMs: number }[];
  byDay: { date: string; turns: number; tokens: number }[]; // 最近 14 天
  /** 按用途分：对话 / 上下文压缩 / 记忆整理 / 技能学习 */
  byKind: { kind: "chat" | "compact" | "reflect" | "learn"; calls: number; tokens: number }[];
  /** 其中按字数估算的 token（API 没返回用量的调用） */
  estimatedTokens: number;
}
