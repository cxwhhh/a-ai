import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap } from "../../../packages/runtime/src/bootstrap";
import { httpServer } from "./http";
import { servePage } from "./pages";
import { routes } from "./routes";

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
