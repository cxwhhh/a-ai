import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import type { ResourceScope } from "./index.ts";

/** 测评实例只接收本机请求，数据库、工作区和沙箱命名空间随本次测评隔离。 */
export async function startEvaluationServer(entry: string, scope: ResourceScope, baseData: string) {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, HOSTNAME: "127.0.0.1", PORT: "0", A_DATA_DIR: scope.directory, A_UPDATES_DIR: scope.directory,
      A_STORAGE_MANAGER_DIR: path.join(scope.directory, "storage-manager"), A_ALLOW_SIGNUP: "1", A_DESKTOP: "0",
      A_SANDBOX_VOLUME_ROOT: baseData, A_SANDBOX_NAMESPACE: `eval-${scope.id.slice(0, 12)}`, A_SANDBOX_CLEANUP_ON_CLOSE: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const closed = once(child, "close");
  // 先监听关闭，避免在收到 ready 与安排回收之间错过进程事件。
  void closed.catch(() => {});
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    const hardStop = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try { await closed; } finally { clearTimeout(hardStop); }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const origin = await Promise.race([
      new Promise<string>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("隔离测评服务启动超时")), 15_000);
        let output = "";
        child.stdout.on("data", (chunk) => {
          output = (output + String(chunk)).slice(-4096);
          const url = /\[a-ai\] (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
          if (url) resolve(url);
        });
      }),
      closed.then(([code]) => { throw new Error(`隔离测评服务提前退出，退出码 ${code}`); }),
    ]);
    return { origin, stop };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  } finally { clearTimeout(timer); }
}
