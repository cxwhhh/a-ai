import "server-only";
import type { Project, ProjectChat, ProjectMemoryMode, StoredMessage, UserMemory } from "../shared";
import { splitAttachments } from "../attachments";
import { AGENT_ICONS } from "../agentIcons";
import { db, newId } from "./db";
import { EMPTY_MEMORY, normalizeMemory } from "./memory";

/**
 * 项目的存取。和会话、分组一样：每个函数都带 userId，每条 SQL 都带 user_id 条件，
 * 拿别人的项目 id 来也只会当作“不存在”。
 */

type Row = Record<string, unknown>;
const MODES: ProjectMemoryMode[] = ["global", "project", "off"];

function toProject(r: Row): Project {
  let d: Record<string, unknown> = {};
  try {
    d = JSON.parse(r.data as string);
  } catch {}
  return {
    id: r.id as string,
    name: r.name as string,
    ...(typeof d.icon === "string" && AGENT_ICONS.some((i) => i.name === d.icon) ? { icon: d.icon } : {}),
    description: typeof d.description === "string" ? d.description : "",
    memory: MODES.includes(d.memory as ProjectMemoryMode) ? (d.memory as ProjectMemoryMode) : "global",
    share: d.share === true,
    createdAt: Number(r.created_at),
  };
}

/** 浏览器传来的设置都不可信：名字必填、限长，记忆方式只认三个值 */
export function cleanProject(input: unknown): Omit<Project, "id" | "createdAt"> | null {
  const p = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const name = typeof p.name === "string" ? p.name.replace(/\s+/g, " ").trim().slice(0, 40) : "";
  if (!name) return null;
  return {
    name,
    ...(typeof p.icon === "string" && AGENT_ICONS.some((i) => i.name === p.icon) ? { icon: p.icon } : {}),
    description: typeof p.description === "string" ? p.description.trim().slice(0, 4000) : "",
    memory: MODES.includes(p.memory as ProjectMemoryMode) ? (p.memory as ProjectMemoryMode) : "global",
    share: p.share === true,
  };
}

const dataOf = (p: Omit<Project, "id" | "createdAt" | "name">) => JSON.stringify({ description: p.description, memory: p.memory, share: p.share, ...(p.icon ? { icon: p.icon } : {}) });

export function listProjects(userId: string): Project[] {
  return db().prepare("SELECT id, name, data, created_at FROM projects WHERE user_id = ? ORDER BY created_at").all(userId).map(toProject);
}

export function getProject(id: string | undefined | null, userId: string): Project | null {
  if (!id) return null;
  const r = db().prepare("SELECT id, name, data, created_at FROM projects WHERE id = ? AND user_id = ?").get(id, userId);
  return r ? toProject(r) : null;
}

export function createProject(userId: string, p: Omit<Project, "id" | "createdAt">): Project {
  const id = newId("p");
  const now = Date.now();
  db().prepare("INSERT INTO projects (id, user_id, name, data, created_at) VALUES (?, ?, ?, ?, ?)").run(id, userId, p.name, dataOf(p), now);
  return { ...p, id, createdAt: now };
}

export function updateProject(id: string, userId: string, p: Omit<Project, "id" | "createdAt">): Project | null {
  const r = db().prepare("UPDATE projects SET name = ?, data = ? WHERE id = ? AND user_id = ?").run(p.name, dataOf(p), id, userId);
  return r.changes ? getProject(id, userId) : null;
}

/** 删项目不删对话：对话的 project_id 由外键自动置空，回到左栏的“分组”里 */
export function deleteProject(id: string, userId: string): boolean {
  return db().prepare("DELETE FROM projects WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}

/** 把对话移进项目（projectId 为空 = 移出项目）。项目和对话都必须是这个用户的 */
export function moveSession(sessionId: string, projectId: string | null, userId: string): boolean {
  if (projectId && !getProject(projectId, userId)) return false;
  return db().prepare("UPDATE sessions SET project_id = ? WHERE id = ? AND user_id = ?").run(projectId, sessionId, userId).changes > 0;
}

/** 项目对话列表只展示当前有效回答和产出；历史版本仍在库里，但不参与预览与文件数。 */
export function projectChats(projectId: string, userId: string): ProjectChat[] | null {
  if (!getProject(projectId, userId)) return null;
  const sessions = db().prepare("SELECT id, title, updated_at FROM sessions WHERE project_id = ? AND user_id = ? ORDER BY updated_at DESC, id").all(projectId, userId);
  const messages = db().prepare("SELECT data FROM messages WHERE session_id = ? AND superseded_by IS NULL AND role = 'assistant' ORDER BY seq DESC");
  const artifacts = db().prepare("SELECT COUNT(*) AS n FROM artifacts WHERE session_id = ? AND superseded_by IS NULL");
  return sessions.map((s) => {
    const id = s.id as string;
    let preview = "";
    const paths = new Set<string>();
    for (const row of messages.all(id)) {
      const m = JSON.parse(row.data as string) as StoredMessage;
      if (!preview && m.content.trim() && !m.toolCalls?.length)
        preview = m.content.replace(/[#*`>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 140);
      for (const call of m.toolCalls ?? []) {
        if (call.name !== "write_file" && call.name !== "write_document") continue;
        // 老记录可能来自中断的参数流；忽略无效参数，不能让一条旧调用破坏整个列表。
        try {
          const args: unknown = JSON.parse(call.arguments);
          if (args && typeof args === "object" && "path" in args && typeof args.path === "string" && args.path.trim()) paths.add(args.path.trim());
        } catch { /* 未完成的调用没有可统计的路径。 */ }
      }
    }
    return { id, title: s.title as string, updatedAt: Number(s.updated_at), preview, files: Number(artifacts.get(id)!.n) + paths.size };
  });
}

/* ---------------- 项目独立记忆 ---------------- */

export function getProjectMemory(projectId: string): UserMemory {
  const r = db().prepare("SELECT data FROM project_memories WHERE project_id = ?").get(projectId);
  if (!r) return EMPTY_MEMORY;
  try {
    return normalizeMemory(JSON.parse(r.data as string));
  } catch {
    return EMPTY_MEMORY;
  }
}

export function saveProjectMemory(projectId: string, m: unknown): UserMemory {
  const next = { ...normalizeMemory(m), updatedAt: Date.now() };
  db().prepare(
    "INSERT INTO project_memories (project_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
  ).run(projectId, JSON.stringify(next), next.updatedAt);
  return next;
}

/* ---------------- 接在系统提示词后面的项目信息 ---------------- */

/** 最多带几个其他对话、每段摘录多长：共享内容每次都进上下文，太多会挤掉这次对话本身 */
const SHARE_SESSIONS = 8;
const SHARE_CHARS = 400;

/**
 * 项目名 + 说明，以及（开了共享时）同项目其他对话的摘要。
 * 摘要只取“用户一开始要做什么”和“最后的回答”，不带中间的工具调用：
 * 够 agent 知道之前做过什么、结论是什么，又不会把几十条工具结果都塞进来。
 */
export function projectPrompt(p: Project, userId: string, sessionId: string): string {
  const out = [`## 当前项目：${p.name}`];
  if (p.description) out.push("项目说明（用户写的，这个项目里的每次对话都要遵守）：", p.description);
  if (p.share) {
    const others = db()
      .prepare("SELECT id, title, updated_at FROM sessions WHERE project_id = ? AND user_id = ? AND id != ? ORDER BY updated_at DESC LIMIT ?")
      .all(p.id, userId, sessionId, SHARE_SESSIONS);
    if (others.length) {
      out.push("", "同一个项目里其他对话的摘要（项目开启了“对话之间共享内容”。需要时直接引用这些结论，不要让用户重复说明）：");
      for (const o of others) {
        const msgs = db()
          .prepare("SELECT data FROM messages WHERE session_id = ? ORDER BY seq")
          .all(o.id as string)
          .map((m) => JSON.parse(m.data as string) as StoredMessage);
        const ask = msgs.find((m) => m.role === "user" && !m.feedback);
        const answer = [...msgs].reverse().find((m) => m.role === "assistant" && !m.toolCalls?.length && m.content.trim());
        const day = new Date(Number(o.updated_at)).toISOString().slice(0, 10);
        out.push(`### ${o.title}（${day}）`);
        if (ask) out.push(`- 用户：${clip(splitAttachments(ask.content).text)}`);
        if (answer) out.push(`- 结果：${clip(answer.content)}`);
      }
    }
  }
  return out.join("\n");
}

const clip = (s: string) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > SHARE_CHARS ? one.slice(0, SHARE_CHARS) + "…" : one;
};
