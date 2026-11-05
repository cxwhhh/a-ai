import "server-only";
import { BUILTIN_SKILLS } from "../agent/builtin-skills";
import type { Skill } from "../shared";
import { db, newId } from "./db";

/**
 * 技能的存取（skills 表，每个技能一行）。
 * 和记忆一样：每个函数都要传 userId，A 用户永远读不到 B 用户的技能。
 *
 * 状态：
 *   pending  自动总结出来、等用户确认（默认）。不进提示词，模型用不了
 *   active   启用：名字和一句话说明进“技能目录”，模型用 load_skill 读全文
 *   disabled 停用：用户停的，或者用了几次成功率太低被自动停的
 */

/** 上限：技能目录每次都进系统提示词；技能太多模型也挑不准 */
export const MAX_SKILLS = 60;
/** 技能目录最多列多少个（按好用程度排序，后面的仍然能按名字加载） */
const INDEX_LIMIT = 15;
const MAX_HISTORY = 8;
/** 用了至少这么多次、成功率低于这个值：自动停用，免得一个坏技能反复把任务带偏 */
const DEMOTE_USES = 4;
const DEMOTE_RATE = 0.34;

const clip = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const oneLine = (v: unknown, n: number) => clip(typeof v === "string" ? v.replace(/\s+/g, " ") : v, n);
const num = (v: unknown, d = 0) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : d);

/** 校验并裁剪：数据可能来自模型输出或浏览器，都不可信 */
export function normalizeSkill(input: unknown, base?: Skill): Skill {
  const x = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const now = Date.now();
  const b = base ?? EMPTY;
  const pick = <K extends keyof Skill>(k: K, f: (v: unknown) => Skill[K]): Skill[K] => (x[k] === undefined ? b[k] : f(x[k]));
  const history = pick("history", (v) =>
    Array.isArray(v)
      ? v
          .map((h) => ({ at: num((h as Record<string, unknown>)?.at, now), note: oneLine((h as Record<string, unknown>)?.note, 160) }))
          .filter((h) => h.note)
          .slice(0, MAX_HISTORY)
      : [],
  );
  const prev = pick("previous", (v) => {
    const p = (v && typeof v === "object" ? v : null) as Record<string, unknown> | null;
    return p ? { description: oneLine(p.description, 200), body: clip(p.body, 6000), version: num(p.version, 1) } : undefined;
  });
  return {
    id: b.id || newId("sk"),
    name: pick("name", (v) => oneLine(v, 40)) || b.name,
    description: pick("description", (v) => oneLine(v, 200)),
    body: pick("body", (v) => clip(v, 6000)),
    status: pick("status", (v) => (v === "active" || v === "disabled" ? v : "pending")),
    source: pick("source", (v) => (v === "user" ? "user" : "auto")),
    version: Math.max(1, pick("version", (v) => num(v, 1))),
    uses: pick("uses", (v) => num(v)),
    successes: pick("successes", (v) => num(v)),
    failures: pick("failures", (v) => num(v)),
    lastUsedAt: pick("lastUsedAt", (v) => num(v)),
    createdAt: b.createdAt || now,
    updatedAt: b.updatedAt || now,
    history,
    previous: prev,
  };
}

const EMPTY: Skill = {
  id: "",
  name: "",
  description: "",
  body: "",
  status: "pending",
  source: "auto",
  version: 1,
  uses: 0,
  successes: 0,
  failures: 0,
  lastUsedAt: 0,
  createdAt: 0,
  updatedAt: 0,
  history: [],
};

function parse(data: unknown): Skill | null {
  try {
    const s = JSON.parse(String(data)) as Skill;
    return normalizeSkill(s, { ...EMPTY, id: s.id, name: s.name, createdAt: s.createdAt, updatedAt: s.updatedAt });
  } catch {
    return null;
  }
}

/** 全部技能：待确认的在前，其余按最近更新排 */
export function listSkills(userId: string): Skill[] {
  const rows = db().prepare("SELECT data FROM skills WHERE user_id = ? ORDER BY updated_at DESC").all(userId);
  const order = { pending: 0, active: 1, disabled: 2 };
  return rows
    .map((r) => parse(r.data))
    .filter((s): s is Skill => !!s)
    .sort((a, b) => order[a.status] - order[b.status]);
}

export function getSkill(userId: string, id: string): Skill | null {
  const r = db().prepare("SELECT data FROM skills WHERE user_id = ? AND id = ?").get(userId, id);
  return r ? parse(r.data) : null;
}

export function getSkillByName(userId: string, name: string): Skill | null {
  const r = db().prepare("SELECT data FROM skills WHERE user_id = ? AND name = ? COLLATE NOCASE").get(userId, name.trim());
  return r ? parse(r.data) : null;
}

/** 写入（新建或整份覆盖）。名字和别的技能重复时报错 */
export function putSkill(userId: string, s: Skill): Skill {
  if (!s.name) throw new Error("技能名字不能为空");
  const dup = getSkillByName(userId, s.name);
  if (dup && dup.id !== s.id) throw new Error(`已经有叫「${s.name}」的技能了，换个名字`);
  if (!dup && !getSkill(userId, s.id)) {
    const n = Number(db().prepare("SELECT COUNT(*) AS n FROM skills WHERE user_id = ?").get(userId)?.n ?? 0);
    if (n >= MAX_SKILLS) throw new Error(`技能最多 ${MAX_SKILLS} 个，先删掉一些不用的`);
  }
  db()
    .prepare(
      `INSERT INTO skills (id, user_id, name, status, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = excluded.status, updated_at = excluded.updated_at, data = excluded.data`,
    )
    .run(s.id, userId, s.name, s.status, s.updatedAt, JSON.stringify(s));
  return s;
}

/**
 * 按 patch 修改一个技能（设置页的编辑 / 启用 / 停用，或者自动学习的改进）。
 * 改了正文或说明时，把改之前的内容存进 previous，可以一键恢复；history 记一笔原因。
 */
export function updateSkill(userId: string, id: string, patch: Partial<Skill>, note?: string): Skill | null {
  const old = getSkill(userId, id);
  if (!old) return null;
  const next = normalizeSkill(patch, old);
  const contentChanged = next.body !== old.body || next.description !== old.description;
  if (contentChanged && patch.previous === undefined) {
    next.previous = { description: old.description, body: old.body, version: old.version };
    if (patch.version === undefined) next.version = old.version + 1;
  }
  if (note) next.history = [{ at: Date.now(), note }, ...old.history].slice(0, MAX_HISTORY);
  next.updatedAt = Date.now();
  return putSkill(userId, next);
}

/** 恢复上一版（自动改进改坏了的时候） */
export function restoreSkill(userId: string, id: string): Skill | null {
  const old = getSkill(userId, id);
  if (!old?.previous) return old;
  const { description, body, version } = old.previous;
  return updateSkill(userId, id, { description, body, version, previous: { description: old.description, body: old.body, version: old.version } }, `恢复到 v${version}`);
}

export function deleteSkill(userId: string, id: string) {
  db().prepare("DELETE FROM skills WHERE user_id = ? AND id = ?").run(userId, id);
}

/**
 * 记一次使用结果。ok = 这一轮顺利完成；undo = 上一轮记成了成功，但用户这轮说“不对”，改记成失败。
 * 用了几次成功率还很低：自动停用并在 history 里写明原因（设置页能看到，可以手动再启用）。
 */
export function recordUse(userId: string, id: string, ok: boolean, undo = false): Skill | null {
  const s = getSkill(userId, id);
  if (!s) return null;
  if (undo) {
    s.successes = Math.max(0, s.successes - 1);
    s.failures++;
  } else {
    s.uses++;
    if (ok) s.successes++;
    else s.failures++;
    s.lastUsedAt = Date.now();
  }
  let note: string | undefined;
  if (s.status === "active" && s.uses >= DEMOTE_USES && successRate(s) < DEMOTE_RATE) {
    s.status = "disabled";
    note = `用了 ${s.uses} 次只成功 ${s.successes} 次，自动停用`;
  }
  return updateSkill(userId, id, s, note);
}

export const successRate = (s: Skill) => (s.uses ? s.successes / s.uses : 0);

/**
 * 排序用的“好用程度”：成功率（用拉普拉斯平滑，新技能不会因为 0 次而垫底）× 最近有没有在用。
 * 60 天没用过的技能分数减半，排到后面去，慢慢被更常用的挤出目录。
 */
function score(s: Skill) {
  const rate = (s.successes + 1) / (s.uses + 2);
  const idle = Date.now() - (s.lastUsedAt || s.updatedAt);
  return rate * (idle > 60 * 86400_000 ? 0.5 : 1) + Math.min(s.uses, 20) * 0.01;
}

export const activeSkills = (userId: string) => listSkills(userId).filter((s) => s.status === "active");

/**
 * 技能目录：接在系统提示词后面。只放名字和一句话说明（几十个 token），
 * 全文要模型自己用 load_skill 读 —— 这样技能再多，每次请求的固定开销也很小。
 */
export function skillsPrompt(skills: Skill[]): string {
  const list = skills.filter((s) => s.status === "active").sort((a, b) => score(b) - score(a));
  // 内置技能（agent/builtin-skills.ts）排在后面；用户学会了同名技能就只列用户的
  const builtin = BUILTIN_SKILLS.filter((b) => !list.some((s) => s.name === b.name));
  if (!list.length && !builtin.length) return "";
  const shown = list.slice(0, INDEX_LIMIT);
  const lines = ["## 你学会的技能（从这位用户以往的任务里总结的做法，以及内置的规范）"];
  for (const s of shown) lines.push(`- ${s.name}：${s.description}${s.uses ? `（用过 ${s.uses} 次）` : ""}`);
  for (const b of builtin) lines.push(`- ${b.name}：${b.description}`);
  if (list.length > shown.length) lines.push(`- 另外还有 ${list.length - shown.length} 个不常用的技能，按名字也能加载`);
  lines.push(
    "任务和某个技能对得上时，先调用 load_skill 读取它的完整步骤，再按步骤做（不用跟用户说你在用技能）。步骤里有不适用的地方，按这次的实际情况调整。对不上的任务照常做，不要硬套。",
  );
  return lines.join("\n");
}
