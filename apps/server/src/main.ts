import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap } from "../../../packages/runtime/src/bootstrap";
import { httpServer } from "./http";
import { servePage } from "./pages";
import { routes } from "./routes";
import { login, register } from "../../../packages/application/users/src/auth";
import { db } from "../../../packages/storage/src/db";
import { workspaceOf } from "../../../packages/tools/src/files";
import { prepareAccountApps } from "../../../packages/workspace/src/apps";

// 桌面端已核验云端登录后，在独立的本地数据目录准备本机身份。凭据只供启动使用。
const desktopAccount = process.env.A_DESKTOP_PROFILE_CREDENTIAL;
delete process.env.A_DESKTOP_PROFILE_CREDENTIAL;
if (desktopAccount && process.env.A_DESKTOP === "1" && process.env.HOSTNAME === "127.0.0.1") {
  const { username, password } = JSON.parse(desktopAccount);
  const exists = db().prepare("SELECT 1 FROM users WHERE username=?").get(username);
  const account = exists ? login(username, password) : register(username, password);
  if (typeof account === "string") throw new Error("无法打开与当前账号关联的本地工作区");
}
prepareAccountApps(workspaceOf);
const runtime = await bootstrap();
const webRoot = process.env.A_WEB_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "web");
const server = httpServer(async (request) => await routes.dispatch(request, runtime.root) ?? await servePage(request, webRoot));
server.listen(Number(process.env.PORT ?? 3000), process.env.HOSTNAME ?? "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") console.log(`[a-ai] http://${address.address}:${address.port}`);
});

async function shutdown() {
  server.close();
  await runtime.close();
}
process.once("SIGINT", () => void shutdown().catch(console.error));
process.once("SIGTERM", () => void shutdown().catch(console.error));
