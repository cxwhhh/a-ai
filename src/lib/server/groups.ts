import "server-only";
import type { Groups } from "../shared";
import { db, tx } from "./db";

/**
 * 对话分组。分组存在 groups 表，对话属于哪个分组是 sessions.group_id 一列。
 * 对前端仍然是原来的 { groups, assign } 格式，所以界面代码不用改。
 */
export function getGroups(userId: string): Groups {
  const groups = db().prepare("SELECT id, name FROM groups WHERE user_id = ? ORDER BY sort")
    .all(userId)
    .map((r) => ({ id: r.id as string, name: r.name as string }));
  const assign: Record<string, string> = {};
  for (const r of db().prepare("SELECT id, group_id FROM sessions WHERE user_id = ? AND group_id IS NOT NULL").all(userId))
    assign[r.id as string] = r.group_id as string;
  const order = db().prepare("SELECT id FROM sessions WHERE user_id = ? AND group_sort IS NOT NULL ORDER BY group_sort").all(userId).map((r) => r.id as string);
  return { groups, assign, order };
}

/** 整份覆盖保存。每条 SQL 都带 user_id，前端传来别人的分组或会话 id 也改不到别人的数据 */
export function saveGroups(userId: string, g: Groups): Groups {
  const list = g.groups.filter((x) => typeof x?.id === "string" && /^[a-z0-9_-]{1,40}$/i.test(x.id)).slice(0, 100);
  tx(() => {
    const keep = new Set(list.map((x) => x.id));
    for (const r of db().prepare("SELECT id FROM groups WHERE user_id = ?").all(userId))
      if (!keep.has(r.id as string)) db().prepare("DELETE FROM groups WHERE id = ? AND user_id = ?").run(r.id as string, userId);
    // id 已被别的用户占用时 WHERE 不成立，什么都不改
    const upsert = db().prepare(
      "INSERT INTO groups (id, user_id, name, sort) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, sort = excluded.sort WHERE groups.user_id = excluded.user_id",
    );
    list.forEach((x, i) => upsert.run(x.id, userId, String(x.name ?? "").slice(0, 40) || "未命名", i));

    db().prepare("UPDATE sessions SET group_id = NULL WHERE user_id = ?").run(userId);
    const move = db().prepare(
      "UPDATE sessions SET group_id = ? WHERE id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM groups WHERE id = ? AND user_id = ?)",
    );
    for (const [sid, gid] of Object.entries(g.assign ?? {})) if (typeof gid === "string") move.run(gid, sid, userId, gid, userId);

    // 拖拽排序：order 里的第 i 个对话 group_sort = i，其余清空
    if (Array.isArray(g.order)) {
      db().prepare("UPDATE sessions SET group_sort = NULL WHERE user_id = ?").run(userId);
      const sort = db().prepare("UPDATE sessions SET group_sort = ? WHERE id = ? AND user_id = ?");
      g.order.slice(0, 5000).forEach((sid, i) => typeof sid === "string" && sort.run(i, sid, userId));
    }
  });
  return getGroups(userId);
}
