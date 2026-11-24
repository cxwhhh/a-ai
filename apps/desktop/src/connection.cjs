/** 内网部署兼容 HTTP。自定义外部服务器和更新源使用 HTTPS。 */
function serviceUrl(value) {
  try {
    const url = new URL(String(value ?? "").trim());
    const local = /^(localhost|\[::1\]|127(?:\.\d+){3}|10(?:\.\d+){3}|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(url.hostname);
    if (url.username || url.password || url.search || url.hash) return null;
    return url.protocol === "https:" || (url.protocol === "http:" && local) ? url : null;
  } catch {
    return null;
  }
}

/** 已发布客户端用内置更新源确定默认业务服务器。换镜像时，账号来源保持不变。 */
function desktopConnection(env, bundledFeed, savedMode) {
  const override = serviceUrl(env.A_UPDATE_URL);
  const fallback = bundledFeed ?? override;
  const target = serviceUrl(env.A_SERVER_URL) ?? (fallback?.pathname === "/updates/" ? fallback : null);
  const serverUrl = target?.origin ?? "";
  // 老版本的 local 选择随默认值切换。新版明确打开旧版工作区时保留该选择。
  return { override, feed: override ?? bundledFeed, serverUrl, remoteMode: Boolean(serverUrl) && savedMode !== "legacy-local" };
}

module.exports = { desktopConnection, serviceUrl };
