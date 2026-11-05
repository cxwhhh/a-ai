# A.ai

极简、高效的 AI agent。左栏对话与功能，中栏工作区（含完整思维链 / 工具链），右栏产出。

## 运行

```bash
cd ~/cxw/python/A/a-ai
npm install
npm run dev          # 打开 http://localhost:3000
```

需要 Node.js 20+（推荐 22）。默认使用 **Mock 模型**，不需要 API 就能跑通全部流程。
输入 `演示全部工具` 可以看到 6 个工具依次调用的完整链路。

## 接入模型（DeepSeek 等）

1. 左下角头像 → 设置 → 模型 → **添加 DeepSeek**
2. 填 API Key → 测试连接 → 添加
3. 输入框左下角切换模型；右下角环形图看上下文占用

任何 OpenAI 兼容接口（OpenAI、Kimi、通义、Ollama、vLLM…）都可以用“添加 OpenAI 兼容接口”接入。
Key 保存在本机 `.data/settings.json`（已在 .gitignore 中），浏览器里只显示打码后的值。

## 目录

```
src/
├── app/
│   ├── page.tsx                  入口页面
│   ├── globals.css               全部样式（主题、三栏、3D 动画、时间线）
│   └── api/
│       ├── chat/route.ts         POST：运行 agent，SSE 流式返回事件
│       ├── sessions/…            会话增删查
│       └── info/route.ts         当前模型 + 工具列表
├── lib/
│   ├── llm/                      ★ 模型层：接口定义 + 各家实现
│   │   ├── types.ts              LLMProvider 接口（唯一契约）
│   │   ├── index.ts              provider 注册表
│   │   └── providers/            mock.ts / custom.ts
│   ├── agent/                    ★ agent 层
│   │   ├── run.ts                ReAct 主循环
│   │   ├── prompt.ts             系统提示词
│   │   └── tools/                工具：一个文件一个工具 + index.ts 注册表
│   ├── server/store.ts           会话持久化（.data/sessions/*.json）
│   ├── shared.ts                 前后端共用类型、SSE 事件定义
│   └── client.ts                 前端调用 API、解析 SSE
└── components/                   ★ 界面层
    ├── Workspace.tsx             总状态 + 事件处理 + 快捷键
    ├── Sidebar.tsx               左栏
    ├── ChatPane.tsx              中栏
    ├── Trace.tsx                 思维链 / 工具链时间线
    ├── Loader3D.tsx              3D 立方体加载动画
    └── Canvas.tsx                右栏产出
```

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `A_DATA_DIR` | 会话存储目录 | `.data` |
| `A_WORKSPACE_DIR` | 文件工具与 Python 的工作区 | `.data/workspace` |
| `A_PYTHON` | Python 解释器 | `python3` |

## 快捷键

`Enter` 发送 · `Shift+Enter` 换行 · `⌘K` 新对话 · `⌘B` 左栏 · `⌘\` 右栏 · `Esc` 停止 · `/` 聚焦输入

学习笔记见 [`docs/学习笔记.md`](docs/学习笔记.md)。
