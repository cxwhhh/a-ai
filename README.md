# A.ai

极简、高效的 AI agent。左栏对话与功能，中栏工作区（含完整思维链 / 工具链），右栏产出。

## 运行

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev            # 打开 http://127.0.0.1:3000
```

需要 Node.js 22.13+ 和项目锁定的 pnpm。默认使用 **Mock 模型**，不需要 API 就能跑通全部流程。
输入 `演示全部工具` 可以看到 6 个工具依次调用的完整链路。

## 接入模型（DeepSeek 等）

1. 左下角头像 → 设置 → 模型 → **添加 DeepSeek**
2. 填 API Key → 测试连接 → 添加
3. 输入框左下角切换模型；右下角环形图看上下文占用

任何 OpenAI 兼容接口（OpenAI、Kimi、通义、Ollama、vLLM…）都可以用“添加 OpenAI 兼容接口”接入。
连接配置保存在当前用户的 SQLite 数据中，界面继续按原方式显示连接设置。

## 目录

| 目录 | 职责 |
|---|---|
| `apps/web`、`apps/server` | Vite 浏览器入口和 Node.js HTTP/SSE 服务 |
| `apps/desktop`、`apps/cli` | Electron 启动本地服务，CLI 调用同一接口 |
| `packages/ui`、`packages/protocol` | 界面样式与浏览器可共享的协议 |
| `packages/application` | 登录、对话、项目和其他产品用例 |
| `packages/agent`、`packages/agent-registry`、`packages/agent-loop` | Agent 工厂、实例登记与执行循环 |
| `packages/session`、`packages/scheduler` | 历史恢复、任务执行权和实时事件订阅 |
| `packages/runtime`、`vendor/cordis` | Cordis 服务装配与本地维护的插件核心 |

## 构建与测试

`pnpm typecheck` 检查类型，`pnpm test` 构建并运行行为测试。生产环境执行 `pnpm build` 后用 `pnpm start` 启动，默认只监听本机。Docker 仍使用 `docker compose up -d --build`，账号和工作区继续使用 `a-ai-data` 数据卷。桌面开发用 `pnpm electron:dev`，安装包用 `pnpm dist:win` 或 `pnpm dist:mac`。

CLI 构建后可用 `pnpm cli help` 查看命令。登录已有服务可通过环境变量 `A_AI_USERNAME` 和 `A_AI_PASSWORD`，或通过 `A_AI_SESSION` 传入已有会话凭据。

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `A_DATA_DIR` | 会话存储目录 | `.data` |
| `A_WORKSPACE_DIR` | 文件工具与 Python 的工作区 | `.data/workspace` |
| `A_PYTHON` | Python 解释器 | `python3` |

## 快捷键

`Enter` 发送 · `Shift+Enter` 换行 · `⌘K` 新对话 · `⌘B` 左栏 · `⌘\` 右栏 · `Esc` 停止 · `/` 聚焦输入

学习笔记见 [`docs/学习笔记.md`](docs/学习笔记.md)。
