import type { ChatMessage, ToolSpec } from "../../llm/src/types";
import type { Session } from "../../protocol/src/lib/shared";
import { estimateRequest } from "../../context-engine/src/context";
import type { CapabilityScope } from "./capability-scope";
import type { Evidence } from "./result-contract";
import { SubagentRequestError, type TaskContract } from "./task-contract";

const EXCERPT_CHARS = 1_500;

/** 只从当前会话的有效记录取明确引用。文件引用只传规范路径，内容仍经只读工具和权限分发。 */
export function selectContext(task: TaskContract, session: Pick<Session, "messages" | "artifacts"> | undefined, scope: CapabilityScope) {
  const sections: string[] = [];
  const evidence: Evidence[] = [];
  const excerpts = new Map<string, string>();
  function select(kind: "message" | "artifact", source: string, text: string) {
    const id = `C${evidence.length + 1}`;
    evidence.push({ id, kind, source });
    const excerpt = text.slice(0, EXCERPT_CHARS);
    excerpts.set(id, excerpt);
    sections.push(`[${id}] ${kind} ${source}\n${excerpt}`);
  }
  function filePath(file: string) {
    try { return scope.readPath(file).shown; }
    catch { throw new SubagentRequestError("引用的文件超出子任务允许范围", 403); }
  }
  for (const id of task.contextMessages ?? []) {
    const message = session?.messages.find((item) => item.id === id);
    if (!message) throw new SubagentRequestError("引用的消息不在当前会话的有效记录中", 404);
    select("message", id, message.content);
  }
  for (const id of task.contextArtifacts ?? []) {
    const artifact = session?.artifacts.find((item) => item.id === id);
    if (!artifact) throw new SubagentRequestError("引用的产物不在当前会话的有效记录中", 404);
    // 文件型产物通过文件工具读取，避免用产物引用绕过任务路径范围。
    if (artifact.file) sections.push(`文件产物路径：${filePath(artifact.file)}`);
    else select("artifact", id, artifact.content);
  }
  for (const file of task.contextFiles ?? []) sections.push(`文件路径：${filePath(file)}`);
  return { evidence, excerpts, text: sections.join("\n\n") };
}

/** 压缩请求副本时留下调用和结果的配对及证据编号。轨迹仍保留工具实际返回的内容。 */
export function boundedContext(messages: ChatMessage[], tools: ToolSpec[] | undefined, limit: number) {
  let tokens = estimateRequest(messages, tools);
  if (tokens <= limit) return { messages: [...messages], tokens };
  const copy = [...messages];
  for (let i = 0; i < copy.length && tokens > limit; i++) {
    const message = messages[i];
    if (message.role === "tool" && message.content.length > 256) {
      const shortened = { ...message, content: message.content.slice(0, 256) + "\n（较早结果已缩短，按编号引用。）" };
      copy[i] = shortened;
      tokens += estimateRequest([shortened]) - estimateRequest([message]);
    }
  }
  return { messages: copy, tokens };
}
