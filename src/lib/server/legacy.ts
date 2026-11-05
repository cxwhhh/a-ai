import "server-only";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";
import type { Groups, Session } from "../shared";
import { workspaceOf } from "../agent/tools/files";
import { DATA_DIR, db, tx } from "./db";
import { saveSettings } from "./settings";

/**
 * 一次性迁移：把升级前的 JSON 数据导入数据库，归到第一个注册的用户名下。
 *   .data/sessions/*.json → sessions / messages / artifacts 表
 *   .data/groups.json     → groups 表 + sessions.group_id
 *   .data/settings.json   → settings 表
 *   .data/workspace/      → .data/users/<用户id>/workspace/
 * 导入后旧文件改名为 *.imported 留作备份，不会重复导入。
 */
export function importLegacyData(userId: string) {
  const p = (n: string) => path.join(/*turbopackIgnore: true*/ DATA_DIR, n);
  const read = <T>(f: string): T | null => {
    try {
      return JSON.parse(readFileSync(f, "utf8")) as T;
    } catch {
      return null;
    }
  };

  const sdir = p("sessions");
  const sessions = existsSync(sdir)
    ? readdirSync(sdir)
        .filter((n) => n.endsWith(".json"))
        .map((n) => read<Session>(path.join(sdir, n)))
        .filter((s): s is Session => !!s?.id)
    : [];
  const groups = read<Groups>(p("groups.json"));

  tx(() => {
    for (const [i, g] of (groups?.groups ?? []).entries())
      db().prepare("INSERT OR IGNORE INTO groups (id, user_id, name, sort) VALUES (?, ?, ?, ?)").run(g.id, userId, g.name, i);
    for (const s of sessions) {
      const gid = groups?.assign?.[s.id] ?? null;
      db().prepare("INSERT OR IGNORE INTO sessions (id, user_id, title, group_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        s.id, userId, s.title ?? "新对话", gid && groups?.groups.some((g) => g.id === gid) ? gid : null, s.createdAt, s.updatedAt,
      );
      (s.messages ?? []).forEach((m, seq) =>
        db().prepare("INSERT OR IGNORE INTO messages (id, session_id, seq, role, created_at, data) VALUES (?, ?, ?, ?, ?, ?)").run(
          m.id, s.id, seq, m.role, m.createdAt, JSON.stringify(m),
        ),
      );
      for (const a of s.artifacts ?? [])
        db().prepare("INSERT OR IGNORE INTO artifacts (id, session_id, created_at, data) VALUES (?, ?, ?, ?)").run(a.id, s.id, a.createdAt, JSON.stringify(a));
    }
  });

  const settings = read<object>(p("settings.json"));
  if (settings) saveSettings(userId, settings);

  // 导入成功后再改名，避免中途出错丢数据
  for (const n of ["sessions", "groups.json", "settings.json"]) if (existsSync(p(n))) renameSync(p(n), p(n + ".imported"));
  const oldWs = p("workspace");
  const newWs = workspaceOf(userId);
  if (existsSync(oldWs) && !existsSync(newWs)) {
    mkdirSync(path.dirname(newWs), { recursive: true });
    renameSync(oldWs, newWs);
  }
}
