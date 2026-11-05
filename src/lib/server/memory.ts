import "server-only";
import type { Lesson, UserMemory } from "../shared";
import { db } from "./db";

/**
 * 长期记忆的存取（每个用户一行，memories 表）。
 * 和会话一样：每个函数都要传 userId，A 用户永远读不到 B 用户的记忆。
 */

export const EMPTY_MEMORY: UserMemory = { profile: "", habits: [], lessons: [], updatedAt: 0 };

/** 上限：记忆每次都会进系统提示词，太长既费 token 又会稀释重点 */
const MAX_HABITS = 12;
const MAX_LESSONS = 20;
const clip = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");

export function getMemory(userId: string): UserMemory {
  const r = db().prepare("SELECT data FROM memories WHERE user_id = ?").get(userId);
  if (!r) return EMPTY_MEMORY;
  try {
    return normalizeMemory(JSON.parse(r.data as string));
  } catch {
    return EMPTY_MEMORY;
  }
}

export function saveMemory(userId: string, m: unknown): UserMemory {
  const next = { ...normalizeMemory(m), updatedAt: Date.now() };
  db().prepare("INSERT INTO memories (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at").run(
    userId,
    JSON.stringify(next),
    next.updatedAt,
  );
  return next;
}

export function clearMemory(userId: string) {
  db().prepare("DELETE FROM memories WHERE user_id = ?").run(userId);
}

/** 校验并裁剪：数据可能来自模型输出或浏览器，都不可信 */
export function normalizeMemory(input: unknown): UserMemory {
  const m = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const now = Date.now();
  const habits = Array.isArray(m.habits) ? [...new Set(m.habits.map((h) => clip(h, 100)).filter(Boolean))].slice(0, MAX_HABITS) : [];
  const lessons: Lesson[] = Array.isArray(m.lessons)
    ? m.lessons
        .map((x) => {
          const l = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
          const count = Number(l.count);
          const at = Number(l.updatedAt);
          return {
            mistake: clip(l.mistake, 160),
            lesson: clip(l.lesson, 200),
            count: Number.isFinite(count) && count > 0 ? Math.min(999, Math.round(count)) : 1,
            updatedAt: Number.isFinite(at) && at > 0 ? at : now,
          };
        })
        .filter((l) => l.lesson)
        // 出现次数多的、最近发生的排前面；超出上限时丢掉最不重要的
        .sort((a, b) => b.count - a.count || b.updatedAt - a.updatedAt)
        .slice(0, MAX_LESSONS)
    : [];
  const at = Number(m.updatedAt);
  return { profile: clip(m.profile, 240), habits, lessons, updatedAt: Number.isFinite(at) ? at : 0 };
}

export const isEmptyMemory = (m: UserMemory) => !m.profile && !m.habits.length && !m.lessons.length;

/**
 * 排版成一段文字，接在系统提示词后面。
 * 错误教训写成“规则”，并要求模型遵守 —— 这就是“防止第二次犯同样的错”的关键。
 */
export function memoryPrompt(m: UserMemory): string {
  if (isEmptyMemory(m)) return "";
  const lines = ["## 关于这位用户（长期记忆，来自以往的对话）"];
  if (m.profile) lines.push(`职业 / 背景：${m.profile}`);
  if (m.habits.length) lines.push("习惯与偏好：", ...m.habits.map((h) => `- ${h}`));
  if (m.lessons.length) {
    lines.push("以往犯过的错误和教训（必须遵守，不要再犯）：");
    lines.push(...m.lessons.map((l) => `- ${l.lesson}${l.mistake ? `（曾经：${l.mistake}${l.count > 1 ? `，${l.count} 次` : ""}）` : ""}`));
  }
  lines.push("这些信息只用来更好地帮助用户，不要在回答里复述。如果和用户这次说的冲突，以这次为准。");
  return lines.join("\n");
}
