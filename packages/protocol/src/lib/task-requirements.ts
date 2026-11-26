import { splitAttachments } from "./attachments";

export const MAX_TASK_REQUIREMENTS_CHARS = 4_000;

/** 只有显式的用户指令可以更新任务要求，普通对话和带附件的消息继续按原流程处理。 */
export function taskRequirementsUpdate(content: string): string | undefined {
  const { text, files } = splitAttachments(content);
  if (files.length) return;
  const input = text.trim();
  if (input === "/清除任务要求") return "";
  const match = /^\/任务要求\s+([\s\S]+)$/.exec(input);
  return match?.[1].trim();
}
