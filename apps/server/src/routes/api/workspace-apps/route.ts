import { currentUser, unauthorized } from "../../../../../../packages/application/users/src/auth";
import { getProject, projectAppReferences } from "../../../../../../packages/application/projects/src/projects";
import {
  APP_RECORD_BYTES, isWorkspaceAppId, type WorkspaceAppReply, type WorkspaceRecordCommand,
} from "../../../../../../packages/protocol/src/workspace-app";
import { workspaceOf } from "../../../../../../packages/tools/src/files";
import { workspaceAppRequest } from "../../../../../../packages/workspace/src/apps";

const maxBody = APP_RECORD_BYTES + 1024;
const notFound = { status: 404, error: "应用不存在" } as const;
const tooLarge = { status: 413, error: "应用记录请求过大" } as const;

function respond(reply: WorkspaceAppReply) {
  const status = "status" in reply ? reply.status : 200;
  const headers = new Headers({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
  // 提前拒绝时先返回 HTTP 状态，再关闭连接，避免从 Node 转来的请求流直接取消后断开套接字。
  if (reply === tooLarge) headers.set("Connection", "close");
  return Response.json(reply, { status, headers });
}

/** 只返回 JSON，任意生成的 HTML 都由隔离的应用 iframe 打开。 */
export async function GET(req: Request) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const query = new URL(req.url).searchParams;
  const appId = query.get("id");
  const projectId = query.get("projectId");
  if (appId !== null && !isWorkspaceAppId(appId)) return respond(notFound);
  if (projectId !== null && !getProject(projectId, user.id)) return respond({ status: 404, error: "项目不存在" });
  const reply = await workspaceAppRequest(workspaceOf(user.id), appId ? { type: "read-app", appId } : { type: "list-apps" }, req.signal);
  if (projectId !== null) {
    const refs = projectAppReferences(projectId, user.id);
    if ("apps" in reply) return respond({ apps: reply.apps.filter((app) => app.projectId === projectId || (!app.projectId && refs.has(app.id))) });
    if ("app" in reply && reply.app.projectId !== projectId && (reply.app.projectId || !refs.has(reply.app.id))) return respond(notFound);
  }
  if ("app" in reply && query.get("download") === "1") {
    const name = encodeURIComponent(reply.app.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") + ".html");
    // 以附件交付源码，阻止浏览器以账号域名执行生成的页面。
    return new Response(reply.app.html, { headers: {
      "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${name}`,
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    } });
  }
  return respond(reply);
}

/** 浏览器只能经自己的登录会话操作此 ID 下的数据，账号目录由服务端计算。 */
export async function POST(req: Request) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const appId = new URL(req.url).searchParams.get("id");
  if (!isWorkspaceAppId(appId)) return respond(notFound);
  if (!/^application\/json(?:;|$)/i.test(req.headers.get("content-type") ?? "")) {
    return respond({ status: 400, error: "需要 JSON 请求" });
  }
  if (Number(req.headers.get("content-length")) > maxBody) return respond(tooLarge);
  let command: WorkspaceRecordCommand | null;
  try {
    command = await readCommand(req);
  } catch {
    return respond({ status: 400, error: "无效的应用记录请求" });
  }
  if (!command) return respond(tooLarge);
  return respond(await workspaceAppRequest(workspaceOf(user.id), { type: "records", appId, command }, req.signal));
}

async function readCommand(req: Request): Promise<WorkspaceRecordCommand | null> {
  if (!req.body) throw new Error("空请求");
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBody) return null;
      body += decoder.decode(value, { stream: true });
    }
    const parsed: unknown = JSON.parse(body + decoder.decode());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("记录请求必须是 JSON 对象");
    return parsed as WorkspaceRecordCommand;
  } finally {
    reader.releaseLock();
  }
}
