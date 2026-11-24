import { APP_WORKER_JSON_CHARS, type WorkspaceAppCommand } from "../../protocol/src/workspace-app.ts";
import { executeWorkspaceApp } from "./app-runtime.ts";

// 此程序在账号容器中启动，标准输入只接收主服务鉴权后的请求。
// 数据走管道，避免饮食记录等内容出现在进程参数和日志中。
try {
  let body = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    body += chunk;
    if (body.length > APP_WORKER_JSON_CHARS) throw new Error("请求太大");
  }
  const command = JSON.parse(body) as WorkspaceAppCommand;
  process.stdout.write(JSON.stringify(executeWorkspaceApp(process.cwd(), command)));
} catch {
  process.stdout.write(JSON.stringify({ status: 503, error: "账号应用存储暂不可用" }));
}
