/**
 * 附件：用户在输入框里上传的文件。
 * 文件先上传到工作区的 uploads/ 目录，发消息时把路径附在消息末尾：
 *
 *   帮我总结一下
 *
 *   <附件>
 *   uploads/报告.pdf
 *   uploads/截图.png
 *   </附件>
 *
 * 为什么直接写进消息文字：模型本来就只看文字，看到路径就会用 read_document / read_file 去读；
 * 数据库也不用加字段，刷新、编辑重发都不会丢。界面上用 splitAttachments 拆开，正文照常显示，路径变成文件卡片。
 */
const RE = /\n*<附件>\n([\s\S]*?)\n<\/附件>\s*$/;

export function joinAttachments(text: string, paths: string[]) {
  if (!paths.length) return text;
  return `${text}\n\n<附件>\n${paths.join("\n")}\n</附件>`.replace(/^\n+/, "");
}

export function splitAttachments(content: string): { text: string; files: string[] } {
  const m = content.match(RE);
  if (!m) return { text: content, files: [] };
  return { text: content.slice(0, m.index).trimEnd(), files: m[1].split("\n").map((s) => s.trim()).filter(Boolean) };
}

/** 选文件对话框里默认显示的类型：PDF、图片、Office 文档、常见文本。其他类型也能选（“所有文件”） */
export const ACCEPT =
  ".pdf,image/*,.docx,.xlsx,.pptx,.csv,.txt,.md,.json,.py,.js,.ts,.html,.css,.xml,.yaml,.yml,.log,.zip";

export const MAX_UPLOAD = 50 * 1024 * 1024;

export const isImage = (p: string) => /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(p);

/** 输入框里还没发出去的附件：选完文件马上开始上传，上传完才有 path */
export type PendingAttachment = { key: string; name: string; size: number; path?: string; error?: string };
