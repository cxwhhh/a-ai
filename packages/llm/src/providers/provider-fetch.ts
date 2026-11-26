import { fetchPublic, httpUrl, PrivateAddressError } from "../../../sandbox/src/public-fetch";

/** 内网模型只使用部署者配置的完整 origin。桌面端的回环服务仍可直接连接。 */
export const fetchModel: typeof fetch = async (input, init) => {
  const url = httpUrl(input instanceof Request ? input.url : input);
  const localDesktop = process.env.A_DESKTOP === "1" && process.env.HOSTNAME === "127.0.0.1" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const explicitOrigin = (process.env.A_PRIVATE_MODEL_ORIGINS ?? "").split(",").some((entry) => {
    try { return httpUrl(entry.trim()).origin === url.origin; } catch { return false; }
  });
  // 模型请求带密钥和对话正文，直接要求配置最终接口地址。
  const request: RequestInit = { ...init, redirect: "error" };
  if (localDesktop || explicitOrigin) return fetch(input, request);
  try {
    return await fetchPublic(url, request, input instanceof Request ? input : undefined);
  } catch (error) {
    if (error instanceof PrivateAddressError || (error instanceof Error && error.cause instanceof PrivateAddressError)) {
      throw new PrivateAddressError("不允许访问本机或内网地址。部署者可通过 A_PRIVATE_MODEL_ORIGINS 授权指定模型服务");
    }
    throw error;
  }
};
