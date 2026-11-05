import "server-only";
import { isMasked, maskKey, normalizeSettings, type Settings } from "../settings";
import { db } from "./db";

/** 每个用户一份设置：模型连接和 API Key 也是各用各的 */
export function getSettings(userId: string): Settings {
  const r = db().prepare("SELECT data FROM settings WHERE user_id = ?").get(userId);
  try {
    return normalizeSettings(r ? JSON.parse(r.data as string) : {});
  } catch {
    return normalizeSettings({});
  }
}

/** 发给浏览器的版本：API Key 打码，真正的 Key 永远不离开服务端 */
export function maskSettings(s: Settings): Settings {
  return { ...s, connections: s.connections.map((c) => ({ ...c, apiKey: maskKey(c.apiKey) })) };
}

/** 合并保存：只改传进来的字段。浏览器传回打码的 Key（••••abcd）时，保留原来的真实 Key */
export function saveSettings(userId: string, patch: Partial<Settings>): Settings {
  const prev = getSettings(userId);
  if (patch.connections) {
    patch = {
      ...patch,
      connections: patch.connections.map((c) => {
        const old = prev.connections.find((o) => o.id === c?.id);
        return c && (!c.apiKey || isMasked(c.apiKey)) ? { ...c, apiKey: old?.apiKey ?? "" } : c;
      }),
    };
  }
  const next = normalizeSettings({ ...prev, ...patch });
  db().prepare("INSERT INTO settings (user_id, data) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data").run(
    userId,
    JSON.stringify(next),
  );
  return next;
}
