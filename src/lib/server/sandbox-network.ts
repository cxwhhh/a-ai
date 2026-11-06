import "server-only";
import { db } from "./db";

/** 联网策略属于整台服务，不放进个人偏好；最早注册的账号作为部署管理账号。 */
export function canManageNetwork(userId: string): boolean {
  return db().prepare("SELECT id FROM users ORDER BY created_at, rowid LIMIT 1").get()?.id === userId;
}

/** 没有保存过时沿用环境变量；版本号使开关往返切换也不会重新使用旧的联网容器。 */
export function networkPolicy(): { enabled: boolean; revision: number } {
  const row = db().prepare("SELECT enabled, revision FROM sandbox_network WHERE id = 1").get();
  return row ? { enabled: !!row.enabled, revision: Number(row.revision) } : { enabled: process.env.A_SANDBOX_NETWORK === "1", revision: 0 };
}

/** 写入确认后才返回新策略，数据库错误不会被当作保存成功。 */
export function saveNetworkPolicy(userId: string, enabled: boolean) {
  if (!canManageNetwork(userId)) throw new Error("只有最早注册的管理账号可以修改全局联网设置");
  db().prepare(`INSERT INTO sandbox_network (id, enabled, revision) VALUES (1, ?, 1)
    ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, revision=sandbox_network.revision+1`).run(enabled ? 1 : 0);
  return networkPolicy();
}
