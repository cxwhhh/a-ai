import { existsSync, promises as fs } from "node:fs";
import { runInSandbox, sandboxInfo } from "../../sandbox/src/sandbox";
import { APP_WORKER_JSON_CHARS, type WorkspaceAppCommand, type WorkspaceAppReply } from "../../protocol/src/workspace-app";
import { executeWorkspaceApp, workspaceAppsPath } from "./app-runtime";

/**
 * 部署后，所有页面和记录操作都交给账号容器。无 Docker 的本机开发使用相同存储逻辑，
 * 便于启动隔离测试库验证页面。线上 Docker 故障时直接返回失败。
 */
export async function workspaceAppRequest(workspace: string, command: WorkspaceAppCommand, signal?: AbortSignal): Promise<WorkspaceAppReply> {
  try {
    signal?.throwIfAborted();
    if (command.type === "list-apps" && !existsSync(workspaceAppsPath(workspace))) return { apps: [] };
    if (sandboxInfo().mode !== "docker") return executeWorkspaceApp(workspace, command);
    await fs.mkdir(workspace, { recursive: true });
    let output = "";
    let truncated = false;
    const run = await runInSandbox({
      sessionId: "workspace-app",
      workspace,
      cwd: "/workspace",
      script: "/usr/local/bin/node --experimental-strip-types /opt/a-ai/packages/workspace/src/app-worker.ts",
      input: JSON.stringify(command),
      env: {},
      timeoutMs: 12_000,
      signal,
      onData: (stream, text) => {
        if (stream !== "out" || truncated) return;
        if (output.length + text.length > APP_WORKER_JSON_CHARS) truncated = true;
        else output += text;
      },
    });
    if (run.code === 0 && !run.timedOut && !truncated) return JSON.parse(output) as WorkspaceAppReply;
  } catch {
    // 运行错误由调用方展示。表单正文以及工作区的主机路径不写入错误日志。
  }
  return { status: 503, error: "账号运行环境暂不可用，请稍后重试" };
}
