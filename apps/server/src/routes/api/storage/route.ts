import path from "node:path";
import { readdir } from "node:fs/promises";
import type { RouteContext } from "../../../router";
import { currentUser, unauthorized } from "../../../../../../packages/application/users/src/auth";
import { canManageNetwork } from "../../../../../../packages/sandbox/src/sandbox-network";
import { clearDockerCache, dockerCacheUsage, sandboxInfo } from "../../../../../../packages/sandbox/src/sandbox";
import { storageBytes, validRunLimit } from "../../../../../../packages/storage-manager/src/index";
import { workspaceOf } from "../../../../../../packages/tools/src/files";
import { sessionWorkspacesOf } from "../../../../../../packages/workspace/src/session-workspace";

export async function GET(req: Request, { runtime }: RouteContext) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const admin = canManageNetwork(user.id);
  const workspace = workspaceOf(user.id);
  const sessions = sessionWorkspacesOf(user.id);
  const storage = runtime.storageManager;
  const mode = sandboxInfo().mode;
  const entries = await readdir(sessions, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const workspaces = [workspace, ...entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(sessions, entry.name))];
  const [sizes, managed, dockerCache] = await Promise.all([
    Promise.all(workspaces.map((root) => Promise.all([storageBytes(root), storageBytes(path.join(root, "uploads")), storageBytes(path.join(root, "output"))]))),
    storage.usage(user.id, admin), dockerCacheUsage([workspace, sessions]),
  ]);
  const totals = { uploads: 0, output: 0, other: 0 };
  for (const [total, uploads, output] of sizes) {
    totals.uploads += uploads;
    totals.output += output;
    totals.other += Math.max(0, total - uploads - output);
  }
  return Response.json({ admin, mode, limitMiB: storage.runLimit(), workspace: totals, managed, dockerCache });
}

export async function PUT(req: Request, { runtime }: RouteContext) {
  const user = await currentUser(req);
  if (!user) return unauthorized();
  const body = await req.json().catch(() => null);
  const storage = runtime.storageManager;
  if (body?.action === "clear-cache") {
    const disk = storage.clear("cache", user.id);
    const docker = await clearDockerCache([workspaceOf(user.id), sessionWorkspacesOf(user.id)]);
    return Response.json({ removed: disk + docker.removed, failed: docker.failed });
  }
  if (!canManageNetwork(user.id)) return Response.json({ error: "需要管理账号" }, { status: 403 });
  if (body?.action === "clear-tests") return Response.json({ removed: storage.clear("test") + storage.clear("evaluation") });
  if (body?.action === "set-quota" && typeof body.mib === "number" && validRunLimit(body.mib)) {
    if (sandboxInfo().mode !== "docker") return Response.json({ error: "运行配额用于 Docker 沙箱" }, { status: 409 });
    storage.setRunLimit(body.mib);
    return Response.json({ limitMiB: storage.runLimit() });
  }
  return Response.json({ error: "无效的存储操作或配额" }, { status: 400 });
}
