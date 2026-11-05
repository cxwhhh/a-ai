/**
 * A.ai 图标库（用户提供的 agent-icons，50 个）：24×24 网格、圆角端点、颜色跟随 currentColor。
 * 由 scripts 从 agent-icons/svg/*.svg 生成：body 是 <svg> 里面的图形元素（只有 path / circle / rect 等，没有脚本）。
 * 前后端共用：前端画图标，后端校验项目图标名是否合法。
 */
export const AGENT_ICONS = [
  { name: "chat", label: "对话", body: "<path d=\"M6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5v-7A2.5 2.5 0 0 1 6.5 4z\"/>" },
  { name: "messages", label: "消息", body: "<path d=\"M6.5 3.5h6A2.5 2.5 0 0 1 15 6v4a2.5 2.5 0 0 1-2.5 2.5H8.5L6 14.5v-2A2.5 2.5 0 0 1 4 10V6a2.5 2.5 0 0 1 2.5-2.5z\"/><path d=\"M15 8.5h2.5A2.5 2.5 0 0 1 20 11v4a2.5 2.5 0 0 1-2 2.45V20l-2.8-2.5H12A2.5 2.5 0 0 1 9.5 15v-.5\"/>" },
  { name: "chat-new", label: "新对话", body: "<path d=\"M6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5v-7A2.5 2.5 0 0 1 6.5 4z\"/><path d=\"M12 7.5v5M9.5 10h5\"/>" },
  { name: "history", label: "历史记录", body: "<path d=\"M4 12a8 8 0 1 0 2.3-5.6\"/><path d=\"M4 4.5V8h3.5\"/><path d=\"M12 8v4l2.5 2\"/>" },
  { name: "prompt", label: "提示词", body: "<rect x=\"3\" y=\"7\" width=\"18\" height=\"10\" rx=\"3\"/><path d=\"M7 12h6M16 10v4\"/>" },
  { name: "thinking", label: "思考", body: "<path d=\"M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z\"/><path d=\"M9.5 18.5h5M10.5 21h3\"/>" },
  { name: "voice", label: "语音", body: "<rect x=\"9\" y=\"3\" width=\"6\" height=\"11\" rx=\"3\"/><path d=\"M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21\"/>" },
  { name: "document", label: "文档", body: "<path d=\"M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z\"/><path d=\"M14 3v5h5M8.5 13h7M8.5 16.5h5\"/>" },
  { name: "note", label: "笔记", body: "<path d=\"M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5V14l-6 6H6.5A2.5 2.5 0 0 1 4 17.5z\"/><path d=\"M14 20v-4a2 2 0 0 1 2-2h4M8 9h8M8 12.5h5\"/>" },
  { name: "spreadsheet", label: "表格", body: "<rect x=\"3.5\" y=\"4.5\" width=\"17\" height=\"15\" rx=\"2.5\"/><path d=\"M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10\"/>" },
  { name: "slides", label: "演示文稿", body: "<rect x=\"3\" y=\"4\" width=\"18\" height=\"12\" rx=\"2\"/><path d=\"M12 16v4M8.5 20h7M7.5 12.5l3-3 2 2 3.5-3.5\"/>" },
  { name: "pdf", label: "PDF", body: "<path d=\"M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z\"/><path d=\"M14 3v5h5\"/><rect x=\"7.5\" y=\"12\" width=\"9\" height=\"5.5\" rx=\"1.2\"/>" },
  { name: "template", label: "模板", body: "<rect x=\"3.5\" y=\"3.5\" width=\"17\" height=\"17\" rx=\"2.5\" stroke-dasharray=\"2.6 2.6\"/><path d=\"M3.5 9h17M9 9v11.5\"/>" },
  { name: "edit", label: "编辑", body: "<path d=\"M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16z\"/><path d=\"M13.5 6.5l4 4\"/>" },
  { name: "artifact", label: "产物", body: "<path d=\"M12 3l8 4.5v9L12 21l-8-4.5v-9z\"/><path d=\"M4 7.5l8 4.5 8-4.5M12 12v9\"/>" },
  { name: "file", label: "文件", body: "<path d=\"M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z\"/><path d=\"M14 3v5h5\"/>" },
  { name: "folder", label: "文件夹", body: "<path d=\"M3.5 7A2.5 2.5 0 0 1 6 4.5h3.5l2 2.5H18a2.5 2.5 0 0 1 2.5 2.5v8A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5z\"/>" },
  { name: "image", label: "图片", body: "<rect x=\"3.5\" y=\"4.5\" width=\"17\" height=\"15\" rx=\"2.5\"/><circle cx=\"9\" cy=\"9.5\" r=\"1.5\"/><path d=\"M20.5 15L16 10.5 6 19.5\"/>" },
  { name: "video", label: "视频", body: "<rect x=\"3\" y=\"5.5\" width=\"13\" height=\"13\" rx=\"2.5\"/><path d=\"M16 10.5l5-3v9l-5-3\"/>" },
  { name: "audio", label: "音频", body: "<path d=\"M9 18V5.5l10-2V16\"/><circle cx=\"6.5\" cy=\"18\" r=\"2.5\"/><circle cx=\"16.5\" cy=\"16\" r=\"2.5\"/>" },
  { name: "archive", label: "压缩包", body: "<rect x=\"3\" y=\"4\" width=\"18\" height=\"4\" rx=\"1.5\"/><path d=\"M4.5 8v10.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8M10 12h4\"/>" },
  { name: "attachment", label: "附件", body: "<path d=\"M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8\"/>" },
  { name: "upload", label: "上传", body: "<path d=\"M12 15V4M7.5 8.5L12 4l4.5 4.5\"/><path d=\"M4 15v3.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V15\"/>" },
  { name: "download", label: "下载", body: "<path d=\"M12 4v11M7.5 10.5L12 15l4.5-4.5\"/><path d=\"M4 15v3.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V15\"/>" },
  { name: "knowledge-base", label: "知识库", body: "<path d=\"M5 18.5v-14A1.5 1.5 0 0 1 6.5 3H19v14H6.5A1.5 1.5 0 0 0 5 18.5 1.5 1.5 0 0 0 6.5 20H19\"/><path d=\"M9 7.5h6\"/>" },
  { name: "memory", label: "记忆", body: "<rect x=\"6\" y=\"6\" width=\"12\" height=\"12\" rx=\"2\"/><path d=\"M9.5 9.5h5v5h-5z\"/><path d=\"M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3\"/>" },
  { name: "context", label: "上下文", body: "<path d=\"M12 3l9 4.5-9 4.5-9-4.5z\"/><path d=\"M3 12l9 4.5 9-4.5M3 16.5l9 4.5 9-4.5\"/>" },
  { name: "search", label: "搜索", body: "<circle cx=\"11\" cy=\"11\" r=\"6.5\"/><path d=\"M20 20l-4.4-4.4\"/>" },
  { name: "web", label: "网页", body: "<circle cx=\"12\" cy=\"12\" r=\"9\"/><ellipse cx=\"12\" cy=\"12\" rx=\"4\" ry=\"9\"/><path d=\"M3 12h18\"/>" },
  { name: "link", label: "链接", body: "<path d=\"M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1\"/><path d=\"M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1\"/>" },
  { name: "citation", label: "引用来源", body: "<path d=\"M5 17c2.5-1 3.5-3 3.5-6V7.5H5V11h3.5\"/><path d=\"M14 17c2.5-1 3.5-3 3.5-6V7.5H14V11h3.5\"/>" },
  { name: "database", label: "数据库", body: "<ellipse cx=\"12\" cy=\"5.5\" rx=\"7.5\" ry=\"2.5\"/><path d=\"M4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13\"/><path d=\"M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5\"/>" },
  { name: "agent", label: "智能体", body: "<rect x=\"4.5\" y=\"7.5\" width=\"15\" height=\"12\" rx=\"3\"/><path d=\"M12 4.5v3M2.5 12.5v3M21.5 12.5v3\"/><circle cx=\"12\" cy=\"3.5\" r=\"1\"/><circle cx=\"9.5\" cy=\"13\" r=\"0.9\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"14.5\" cy=\"13\" r=\"0.9\" fill=\"currentColor\" stroke=\"none\"/><path d=\"M10 16.5h4\"/>" },
  { name: "tool", label: "工具调用", body: "<path d=\"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z\"/>" },
  { name: "skill", label: "技能", body: "<path d=\"M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z\"/><path d=\"M19 17v4M17 19h4\"/>" },
  { name: "plugin", label: "插件", body: "<path d=\"M9 3v5M15 3v5\"/><path d=\"M6 8h12v3a6 6 0 0 1-12 0z\"/><path d=\"M12 17v4\"/>" },
  { name: "api", label: "连接器 API", body: "<path d=\"M7 4c-2 0-3 1-3 3v2.5C4 11 3 12 2 12c1 0 2 1 2 2.5V17c0 2 1 3 3 3\"/><path d=\"M17 4c2 0 3 1 3 3v2.5c0 1.5 1 2.5 2 2.5-1 0-2 1-2 2.5V17c0 2-1 3-3 3\"/><path d=\"M9.5 12h5\"/>" },
  { name: "code", label: "代码", body: "<path d=\"M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 4.5l-3 15\"/>" },
  { name: "terminal", label: "终端", body: "<rect x=\"3\" y=\"4.5\" width=\"18\" height=\"15\" rx=\"2.5\"/><path d=\"M7 10l3 2.5L7 15M12.5 15H17\"/>" },
  { name: "workflow", label: "工作流", body: "<rect x=\"3\" y=\"3.5\" width=\"6\" height=\"6\" rx=\"1.5\"/><rect x=\"15\" y=\"14.5\" width=\"6\" height=\"6\" rx=\"1.5\"/><path d=\"M9 6.5h5.5A2.5 2.5 0 0 1 17 9v5.5\"/><path d=\"M6 9.5V15a2.5 2.5 0 0 0 2.5 2.5H15\"/>" },
  { name: "task", label: "任务", body: "<rect x=\"3.5\" y=\"3.5\" width=\"17\" height=\"17\" rx=\"3\"/><path d=\"M8 12l3 3 5-6\"/>" },
  { name: "plan", label: "计划", body: "<path d=\"M4 6.5L5.5 8 8.5 5M11 6.5h9M11 12h9M11 17.5h9\"/><rect x=\"4.5\" y=\"10.5\" width=\"3\" height=\"3\" rx=\"0.6\"/><rect x=\"4.5\" y=\"16\" width=\"3\" height=\"3\" rx=\"0.6\"/>" },
  { name: "calendar", label: "日程", body: "<rect x=\"3.5\" y=\"5\" width=\"17\" height=\"15.5\" rx=\"2.5\"/><path d=\"M3.5 10h17M8 3v4M16 3v4M8 14h2\"/>" },
  { name: "reminder", label: "提醒", body: "<path d=\"M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z\"/><path d=\"M10 21h4\"/>" },
  { name: "mail", label: "邮件", body: "<rect x=\"3\" y=\"5\" width=\"18\" height=\"14\" rx=\"2.5\"/><path d=\"M3.5 6.5l8.5 6.5 8.5-6.5\"/>" },
  { name: "user", label: "用户", body: "<circle cx=\"12\" cy=\"8\" r=\"4\"/><path d=\"M4.5 20.5a7.5 7.5 0 0 1 15 0\"/>" },
  { name: "team", label: "团队", body: "<circle cx=\"9\" cy=\"8.5\" r=\"3.5\"/><path d=\"M3 20a6 6 0 0 1 12 0M15.5 5.2a3.5 3.5 0 0 1 0 6.6M17.5 14.3A6 6 0 0 1 21 20\"/>" },
  { name: "share", label: "分享", body: "<circle cx=\"18\" cy=\"5.5\" r=\"2.5\"/><circle cx=\"6\" cy=\"12\" r=\"2.5\"/><circle cx=\"18\" cy=\"18.5\" r=\"2.5\"/><path d=\"M8.2 10.8l7.6-4.1M8.2 13.2l7.6 4.1\"/>" },
  { name: "project", label: "项目", body: "<rect x=\"3\" y=\"7\" width=\"18\" height=\"13\" rx=\"2.5\"/><path d=\"M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3 12.5h18\"/>" },
  { name: "settings", label: "设置", body: "<path d=\"M4 7h9M17 7h3M4 17h3M11 17h9\"/><circle cx=\"15\" cy=\"7\" r=\"2\"/><circle cx=\"9\" cy=\"17\" r=\"2\"/>" },
] as const;

export type AgentIconName = (typeof AGENT_ICONS)[number]["name"];
export const AGENT_ICON_NAMES = new Set<string>(AGENT_ICONS.map((i) => i.name));
export const isAgentIcon = (s: unknown): s is AgentIconName => typeof s === "string" && AGENT_ICON_NAMES.has(s);
export const agentIconBody = (name: string) => AGENT_ICONS.find((i) => i.name === name)?.body ?? "";
