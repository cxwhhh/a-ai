import { fetchPublic, httpUrl, PrivateAddressError } from "../../../sandbox/src/public-fetch";
import { db } from "../../../storage/src/db";

/**
 * 读取最早注册的管理账号（与沙箱全局联网同源）在模型设置中已保存的 origin 列表。
 * 这样管理账号在页面新增内网模型服务后立即放行，删除后立即收回，无需每次改环境变量并重启；
 * 普通账号在自己设置中填写未授权内网地址仍会被拦截，不削弱 SSRF 防护。
 */
function adminConfiguredOrigin(targetOrigin: string): boolean {
  try {
    const row = db()
      .prepare("SELECT s.data FROM settings s WHERE s.user_id = (SELECT id FROM users ORDER BY created_at, rowid LIMIT 1)")
      .get() as { data?: unknown } | undefined;
    if (!row || typeof row.data !== "string") return false;
    const parsed = JSON.parse(row.data) as { connections?: unknown };
    if (!Array.isArray(parsed.connections)) return false;
    return parsed.connections.some((conn) => {
      if (!conn || typeof conn !== "object") return false;
      const baseUrl = (conn as { baseUrl?: unknown }).baseUrl;
      if (typeof baseUrl !== "string" || !baseUrl.trim()) return false;
      try { return httpUrl(baseUrl.trim()).origin === targetOrigin; } catch { return false; }
    });
  } catch {
    // 数据库未初始化或设置内容异常时按失败关闭处理，不放行私有地址。
    return false;
  }
}

/**
 * 构造模型出站 fetch：
 * 放行条件（任一满足即可，仍强制禁止自动重定向）：
 * 1. 调用方明确标记 allowPrivate（仅限已鉴权的管理账号测试尚未保存的新连接）；
 * 2. 桌面端本机回环服务；
 * 3. 部署者通过 A_PRIVATE_MODEL_ORIGINS 指定的完整 origin；
 * 4. 最早注册的管理账号在模型设置中已保存的连接 origin。
 */
export function createModelFetch(options: { allowPrivate?: boolean } = {}): typeof fetch {
  return async (input, init) => {
    const url = httpUrl(input instanceof Request ? input.url : input);
    const localDesktop = process.env.A_DESKTOP === "1" && process.env.HOSTNAME === "127.0.0.1" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const explicitOrigin = (process.env.A_PRIVATE_MODEL_ORIGINS ?? "").split(",").some((entry) => {
      try { return httpUrl(entry.trim()).origin === url.origin; } catch { return false; }
    });
    // 模型请求带密钥和对话正文，直接要求配置最终接口地址。
    const request: RequestInit = { ...init, redirect: "error" };
    if (options.allowPrivate || localDesktop || explicitOrigin || adminConfiguredOrigin(url.origin)) {
      return fetch(input, request);
    }
    try {
      return await fetchPublic(url, request, input instanceof Request ? input : undefined);
    } catch (error) {
      if (error instanceof PrivateAddressError || (error instanceof Error && error.cause instanceof PrivateAddressError)) {
        throw new PrivateAddressError("不允许访问本机或内网地址。请由最早注册的管理账号在模型设置中保存该服务，或由部署者通过 A_PRIVATE_MODEL_ORIGINS 授权");
      }
      throw error;
    }
  };
}

/** 内网模型默认放行桌面回环、环境变量白名单与管理账号已保存的连接 origin。 */
export const fetchModel: typeof fetch = createModelFetch();
