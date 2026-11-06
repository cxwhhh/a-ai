import "server-only";
import type { Project, ProjectChat, ProjectMemoryMode, StoredMessage, UserMemory } from "../shared";
import { splitAttachments } from "../attachments";
import { db, newId } from "./db";
import { isAgentIcon } from "../agentIcons";
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
    description: typeof d.description === "string" ? d.description : "",
    memory: MODES.includes(d.memory as ProjectMemoryMode) ? (d.memory as ProjectMemoryMode) : "global",
    share: d.share === true,
    icon: isAgentIcon(d.icon) ? d.icon : undefined,
    createdAt: Number(r.created_at),
  };
}

/** 浏览器传来的设置都不可信：名字必填、限长，记忆方式只认三个值，图标只认图标库里有的名字（没传 = 不改） */
export function cleanProject(input: unknown): Omit<Project, "id" | "createdAt"> | null {
  const p = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const name = typeof p.name === "string" ? p.name.replace(/\s+/g, " ").trim().slice(0, 40) : "";
  if (!name) return null;
  return {
    name,
    description: typeof p.description === "string" ? p.description.trim().slice(0, 4000) : "",
    memory: MODES.includes(p.memory as ProjectMemoryMode) ? (p.memory as ProjectMemoryMode) : "global",
    share: p.share === true,
    icon: isAgentIcon(p.icon) ? p.icon : undefined,
  };
}

const dataOf = (p: Omit<Project, "id" | "createdAt" | "name">) => JSON.stringify({ description: p.description, memory: p.memory, share: p.share, icon: p.icon });

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
  // 项目设置弹窗不管图标：没传图标时沿用原来的，免得改个名字图标就没了
  if (!p.icon) p = { ...p, icon: getProject(id, userId)?.icon };
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

/**
 * 项目页下面的对话列表（最近的在前）。项目不是这个用户的就返回 null。
 * 每个对话取最后一条有文字的 assistant 回复当预览；文件数 = 产出物个数 + write_file / write_document 写过的不同路径数
 */
export function projectChats(projectId: string, userId: string): ProjectChat[] | null {
  if (!getProject(projectId, userId)) return null;
  const sessions = db().prepare("SELECT id, title, updated_at FROM sessions WHERE project_id = ? AND user_id = ? ORDER BY updated_at DESC").all(projectId, userId);
  const msgs = db().prepare("SELECT data FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY seq DESC");
  const arts = db().prepare("SELECT COUNT(*) AS n FROM artifacts WHERE session_id = ?");
  return sessions.map((r) => {
    const id = r.id as string;
    let preview = "";
    const paths = new Set<string>();
    for (const row of msgs.all(id)) {
      const m = JSON.parse(row.data as string) as StoredMessage;
      if (!preview && m.content?.trim()) preview = m.content.replace(/[#*`>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 140);
      for (const c of m.toolCalls ?? []) {
        if (c.name !== "write_file" && c.name !== "write_document") continue;
        try {
          const p = JSON.parse(c.arguments || "{}").path;
          if (p) paths.add(String(p));
        } catch {}
      }
    }
    return { id, title: r.title as string, updatedAt: Number(r.updated_at), preview, files: Number((arts.get(id) as Row).n) + paths.size };
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
