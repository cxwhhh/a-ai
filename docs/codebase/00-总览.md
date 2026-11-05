# A.ai 代码库总览（全量通读结果）

> 本文件是"把整个仓库读完"的总索引与结论。四份分域详读摘要：
> [`01-core-agent-llm.md`](01-core-agent-llm.md) · [`02-server-data-api.md`](02-server-data-api.md) · [`03-ui-web.md`](03-ui-web.md) · [`04-infra-docs.md`](04-infra-docs.md)
>
> 读取方式：4 个读取员分域逐文件 `read` 到末行（大文件分页），Lead 另行通读契约层与关键实现并做交叉核对。
> **统计**：`src/` 100 个文件（91 个 `.ts/.tsx` + 8 个 `.css` + `icon.svg`）= 12,758 行；根配置 12 个；`docs/学习笔记.md` 2,056 行；`.data/*` 3 个；`.idea/*` 8 个。合计 **124 个文件 ≈ 17.8k 行**，其中逐行读完约 15.3k 行（`package-lock.json` 2,555 行只做了来源统计）。

---

## 1. 这是什么

**A.ai** 是一个自托管的 AI agent Web 应用：三栏界面（左栏会话/项目、中栏对话 + 完整思维链与工具链、右栏产出物面板），后端是手写的 ReAct 循环 + SSE 流式推送，多用户隔离，数据落 SQLite 单文件，Docker 单机部署，终端命令跑在沙箱里。

| 维度 | 事实 | 证据 |
|---|---|---|
| 框架 | Next.js **16.4.2** App Router + React **19.3.1**，TypeScript **5.9.3**（strict） | `package.json` |
| 运行时要求 | Node **>= 22.13**（用内置 `node:sqlite`，无第三方驱动） | `package.json`、`src/lib/server/db.ts:4` |
| 持久化 | SQLite `.data/a.db`（WAL），9 张表；产出物/消息以 JSON 存在列里 | `src/lib/server/db.ts:16-98` |
| 模型接入 | `LLMProvider` 单一契约；`mock`（离线剧本）+ `openai-compatible`（DeepSeek 等） | `src/lib/llm/types.ts:75-80`、`src/lib/llm/index.ts:14-31` |
| 工具 | **15 个**（注册表数组），受限并行（`parallelSafe`）+ 结束本轮（`endsTurn`） | `src/lib/agent/tools/index.ts:23-36` |
| 交互协议 | SSE，13 种事件，前后端共用 `AgentEvent` 类型 | `src/lib/shared.ts:110-123`、`src/app/api/chat/route.ts:41` |
| 安全 | Cookie + scrypt 口令 + sha256 token；命令三层防线（路径检查 → 用户确认 → docker/seatbelt 隔离）+ 审计表 | `src/lib/server/auth.ts`、`src/lib/server/sandbox.ts`、`src/lib/server/approvals.ts` |
| 部署 | 三阶段 Dockerfile → standalone `node server.js`，命名卷 `a-ai-data`，沙箱镜像 `a-ai-sandbox` | `Dockerfile`、`docker-compose.yml` |

---

## 2. 分层架构

```
浏览器（src/components/*，Workspace 是唯一业务状态容器）
   │  fetch + SSE 解析（src/lib/client.ts:82-108）
   ▼
API 层（src/app/api/**/route.ts，19 个 handler，第一句都自己鉴权 currentUser()）
   │  无 middleware.ts —— 漏写 currentUser 即无鉴权
   ├─ /api/chat  ──► runAgent()  AsyncGenerator<AgentEvent> ──► SSE `data: {json}\n\n`
   ├─ /api/approve、/api/chat/note  ──► 打断正在跑的循环（审批 / 补充想法）
   └─ 其余 CRUD ──► store / settings / groups / memory / audit / sandbox
   ▼
Agent 层（src/lib/agent/*，2050 行）
   ├─ run.ts        ReAct 主循环、工具批量执行、反馈闭环预算
   ├─ verify.ts     Verifier 护栏（跑不通就打回模型）
   ├─ reflect.ts    后台反思 → 长期记忆（Reflexion）
   ├─ prompt.ts     系统提示词；args.ts 宽容解析工具参数
   └─ tools/*       15 个工具，一个文件一个工具
   ▼
模型层（src/lib/llm/*，814 行）：types.ts 契约 → index.ts 工厂 → providers/{mock,openai-compatible,custom(死代码)}
   ▼
数据层（src/lib/server/*，含 store.ts / db.ts / settings.ts / auth.ts / sandbox.ts …）
   ▼
SQLite `.data/a.db` + 每用户工作区 `.data/users/<id>/workspace/`
```

**设计主线（三处最值得记住的取舍）**
1. **历史即状态**：没有额外状态机，工具清单、todo、verifier 判据都从 `Session.messages` 推出（`01` §3）。
2. **契约优先**：`AgentEvent`（13 种）与 `LLMProvider.stream` 是唯一跨层接口，换模型只改模型层，加工具只改 `tools/`。
3. **护栏而非提示词**：可行性检查放在代码里（`verify.ts`），因为提示词只是建议。

---

## 3. 一轮对话的端到端时序

1. `POST /api/chat` 鉴权 → 取/建会话 → 写用户消息（`src/app/api/chat/route.ts:25-34`）。
2. 回 `session` + `message` 事件后进入 `runAgent()`（同文件 `44-45`、`48-61`）。
3. 系统提示 = 自定义或内置 + 长期记忆 + 授权目录说明（`src/lib/agent/run.ts:65`）。
4. 每步：注入"用户补充"notes（`run.ts:98,202-219`）→ 调模型流式（`114`）→ 边收边推 `reasoning/text/tool_input`。
5. assistant 消息**先落库再推** `assistant_end`（`run.ts:147-149`），中途停止不丢。
6. 无工具调用 → `verifier.check()`（`run.ts:154-167`）：运行失败/未验证则把报错作为 user 反馈写回历史，预算 +2 步，继续改。
7. 有工具调用 → `toBatches()` 把相邻 `parallelSafe` 合成一批（`run.ts:246-255`）→ 批内并发、批间串行；`Promise.race` 先完成先推，工具运行中的实时输出走 `live` 队列（`run.ts:172-193`）。
8. `ask_user` 命中 `endsTurn` → 本轮结束，等用户下一条消息（`run.ts:196`）。
9. 收尾 `done` → `route.ts:64-68` 后台 `reflect()` 更新记忆（不 await，90s 超时）。

---

## 4. 15 个工具

| 工具 | 文件 | 并行 | 说明 |
|---|---|---|---|
| `todo_write` | `tools/todo.ts` | ✗ | 待办清单，最多 30 条，提示多个进行中/全部完成 |
| `list_files` | `tools/files.ts:26` | ✓ | 列目录，隐藏项不返回 |
| `read_file` | `tools/files.ts:58` | ✓ | 默认 400 行、上限 2000 行 / 2 万字符，二进制拒绝 |
| `glob` | `tools/search.ts:95` | ✓ | 文件名匹配（`* ** ? {a,b} [abc]`），mtime 倒序、上限 200 |
| `grep` | `tools/search.ts:131` | ✓ | 内容正则，`context≤5`、`max_results≤500`，>2MB/二进制跳过 |
| `edit_file` | `tools/files.ts:116` | ✗ | 精确替换，要求唯一，CRLF 对齐，返回预览 |
| `write_file` | `tools/files.ts:203` | ✗ | 新建/覆盖，自动建父目录 |
| `run_command` | `tools/run-command.ts` | ✗ | 沙箱 bash，30s 默认/120s 上限，`cd` 会话内保持，头 2000 + 尾 6000 截断 |
| `run_python` | `tools/run-python.ts` | ✗ | 沙箱 Python 20s，stdout/stderr 各 8000 字 |
| `calculator` | `tools/calculator.ts` | ✓ | 手写递归下降解析器（不 `eval`） |
| `current_time` | `tools/current-time.ts` | ✓ | IANA 时区 |
| `web_search` | `tools/web-search.ts` | ✓ | Tavily → Brave → DuckDuckGo HTML 三级回退 |
| `web_fetch` | `tools/web-fetch.ts` | ✓ | HTML→文本，SSRF 黑名单（仅字面量，见 §8-11） |
| `create_artifact` | `tools/create-artifact.ts` | ✓ | 右栏成品；**标了 parallelSafe 但会写库**（违约，见 §8-16） |
| `ask_user` | `tools/ask-user.ts` | ✗ | 唯一 `endsTurn`，选项 ≤6 |

---

## 5. 数据模型（9 张表，`src/lib/server/db.ts:16-98`）

`users`（username UNIQUE NOCASE / password_hash）、`auth_tokens`（PK=token 的 sha256，30 天 TTL）、`groups`（user_id 外键，**无索引**）、`sessions`（`sessions_user(user_id, updated_at DESC)`，`group_id` ON DELETE SET NULL）、`messages`（`messages_session(session_id, seq)`，JSON 存整条）、`artifacts`（JSON）、`settings`（每用户一行，**apiKey 明文**）、`memories`（每用户一行 UserMemory）、`audit_log`（命令审计，无外键、不随对话删除）。

PRAGMA：`busy_timeout=5000` → `journal_mode=WAL` → `foreign_keys=ON`（顺序有意义）。连接挂 `globalThis.__aDb` 防热更新重开。`tx()` 是手写 BEGIN/COMMIT/ROLLBACK，**不支持嵌套**。

目录布局：`<A_DATA_DIR>/a.db`、`users/<userId>/workspace/`、迁移前的 `sessions/*.json`·`groups.json`·`settings.json`（迁移后改名 `*.imported`）。

---

## 6. 鉴权与安全边界

- **登录**：`scrypt$salt$hash`（16B 盐 / 64B key，`timingSafeEqual` 比对）；用户不存在也跑一次 dummy 哈希以抹平时序；连续 5 次错锁 60s（按小写用户名，**内存态**）；token 32 字节 → 浏览器拿原文、库里只存 sha256；Cookie `a_session`（httpOnly、SameSite=Lax、https 才加 Secure、30 天）。
- **隔离**：所有 DAO 强制 `user_id`，别人的会话一律当"不存在"返回 404（防 IDOR）；工作区 = `DATA_DIR/users/<id>/workspace`，`safePath()` 用 resolve + 前缀比较（**不解析软链**）。
- **命令三层防线**：① `checkCommand()` 字符串路径检查 → ② 用户确认（`ask` / `readonly` / `auto`，可 `allow_session`）→ ③ 系统级隔离（docker 每会话常驻容器：`--network none`、`--read-only`、`--cap-drop ALL`、非 root、内存/CPU/pids 限额；macOS seatbelt SBPL；`local` 无隔离）。每台命令进 `audit_log`。
- **审批通道**：SSE 单向，所以用 `waiting: Map<"userId:callId", resolve>` 挂起 Promise，浏览器另发 `POST /api/approve` 唤醒；5 分钟超时或 abort 视为拒绝。

---

## 7. 前端结构

- **Workspace 是唯一业务状态容器**（608 行）：sessions / cur / streaming / draft / view / listOpen / viewW / groups / settings / running…，其余组件都是受控展示。
- **SSE 归约 `apply()`（`Workspace.tsx:215-308`）覆盖 13 种事件**，但**没有 default 分支**；`text/reasoning/tool_input/tool_output` 先经 rAF 批处理 + `coalesce` 合并再入 state，`tool_output/approval` 则完全绕开 React，走 `src/lib/live.ts` 的 `useSyncExternalStore` 小 store（长终端输出不炸整棵树）。
- **布局**：`.app` flex 三栏，`--side-w=252`、`--thread-w`（680/780/980）、`--canvas-w=clamp(400px,46vw,940px)`（可拖拽，存 `localStorage`）；断点只有 900px（右栏全屏、左栏浮层）与 640px（介绍页）。
- **交互细节**：`overflow-anchor:none` 关掉滚动锚定（否则展开代码块页面自己往下跑）、折叠态提升到父组件（防止 Draft→Tool 换组件丢状态）、宽度/面板状态按会话记忆（`a.panels`，上限 200 条）、问候语与 localStorage 全部放 effect（防水合不匹配）。

---

## 8. 通读后的问题清单（已交叉核对）

### P0 · 安全 / 会导致严重错误
1. **Windows 上命令沙箱第 1 层等于 fail-open**（`src/lib/server/sandbox.ts:44,47,100,116`）：token 正则只认 `/` 与 `~`，敏感路径正则按 `/` 分界，`PRIVATE_ROOTS` 全是 `/Users /home /root` 这类 POSIX 根。`C:\Users\x\.ssh\id_rsa` 既不产生 token 也不被判越界 → 直接放行。叠加 `sandboxEnv():128` 用 `:` 拼 PATH、`sandboxExec():168` `spawn("bash")`，**本机 Windows 上 `run_command/run_python` 实际只有"用户确认"一层，甚至可能因缺 bash 直接失败**。
2. **SSRF**（`src/app/api/models/test/route.ts:21,26-29`）：只校验 `^https?://` 就由服务端带 `Authorization` 去请求，任意登录用户可打 `127.0.0.1`、内网与云元数据地址。
3. **镜像会打进隐私与平台二进制**：仓库里是 `dockerignore`（**没有前导点**），Docker 根本不读；`Dockerfile:15` 的 `COPY . .` 会带上宿主的 `node_modules`（Windows 二进制）、`.data/settings.json`（含 API Key）、`.git`。改名一行即可修。
4. **SSE 在审批等待期零字节**（`chat/route.ts:84-88` + `approvals.ts:18`）：没有 `X-Accel-Buffering: no`、没有心跳注释帧，审批最长静默 5 分钟，nginx 默认 60s 就断流。
5. **断开后仍写已关闭的流**（`chat/route.ts:70-71`）：`send({type:"done"})` 不在 abort 保护内，异常会逃出 `ReadableStream.start()`。

### P1 · 功能缺陷（都有明确复现路径）
6. `send()` 可能吞消息：先清空草稿再分派，若 `streaming` 为真但 `curIdRef` 仍空，两个分支都不进（`src/components/Workspace.tsx:335-353`）。
7. 设置保存互相踩踏：所有防抖保存共用一个 `timer` ref，连改两个文本框只保存最后一个（`SettingsModal.tsx:38,61-73`）。
8. 左栏"项目"必然丢失：`projects` 是组件内 state，收起左栏时 Sidebar 卸载重挂（`Sidebar.tsx:59` + `Workspace.tsx:492-500`）。
9. `run_python` 临时文件泄漏：`fs.rm` 不在 `finally` 里，且 `.runs/` 被隐藏目录规则跳过，用户与模型都看不见（`tools/run-python.ts:59`）。
10. 验证匹配过宽：`code.includes(baseName(key))` 让 `data.py` 被判成"跑过 `a.py`"（`verify.ts:63,77`）。
11. 单飞假设未强制：同会话并发两轮时 `openRun/closeRun` 互相覆盖，补充想法静默丢失（`server/notes.ts:23-29`）。
12. `messages` 缺 `(session_id, seq)` 唯一约束，seq 由内存数组长度推导，并发可写出重复序号（`db.ts:49-57` + `store.ts:76`）。
13. 右侧宽度 clamp 在窄窗口反转：上界 `innerWidth-side-380-20` 可小于下界 320，视图被压到不可用且双击恢复仍是同一上界（`Workspace.tsx:453,544`）。
14. 文件大视图每个消息都闪回"读取中…"（`FileDrawer.tsx:19-33` + `Workspace.tsx:550` 用 `messages.length` 作 refreshKey）。
15. `pendingNotes` 靠服务端原样回传 `summary` 做匹配，一旦被截断就会重发，产生重复用户消息（`Workspace.tsx:222-225,380-384`）。
16. `create_artifact` 标了 `parallelSafe: true` 却通过 `emitArtifact` 写库，违反 `tools/types.ts:48-51` 自己的约定（`tools/create-artifact.ts:8`）。
17. 预算可越界 / 边界缺陷：notes 分支 `budget = max(budget, step+2)` 没有上限钳制（`run.ts:159`）；`maxSteps=1` 时 `lastStep` 恒假——工具会执行，但本轮**没有最终回答**也收不到 `limitFeedback`（`run.ts:101`，已按读取员复查结论修正）。
18. SSE 解析的容错盲区（**已修正原误报**）：`sseData()` 尾部残留行用 `trim()` 已正确去掉 `\r`（`llm/providers/openai-compatible.ts:169`）；真正的缺口是 `JSON.parse` 失败的 `data:` 行被 `continue` 静默丢弃（同文件 `63-67`），若上游最后一个带 `usage` 的块恰好不完整会无声丢用量。

### P2 · 一致性与死代码（读代码时会误导人）
19. `src/lib/llm/providers/custom.ts` 是永远抛错的桩且无任何 import；`custom.ts:19` 与 `mock.ts:230` 还教用户设 `A_PROVIDER=custom`，全仓无此读取点。
20. 两套鉴权路由并存：`/auth/{login,register,logout}` 与 `/api/auth/*` 逐字符重复，前端只用后者（`src/app/auth/**` 死代码）。
21. `POST /api/sessions` 无调用方（`src/app/api/sessions/route.ts:14-18`）。
22. 契约注释与实现相反：`llm/types.ts:21` 说"reasoning 不再发回模型"，但 `run.ts:237` 保留、`openai-compatible.ts:116` 在 `sendReasoning` 时回传（DeepSeek 工具调用必须回传）。
23. `run.ts:92` 的注释挂错了函数（讲预算是 `run.ts:165` 的事）。
24. `glob` 正则固定带 `i` → 永远大小写不敏感，spec 未说明（`tools/search.ts:84`）。
25. `memory.ts:19,23` 在无记录时按引用返回共享 `EMPTY_MEMORY` 常量。
26. 死 CSS：`.login-*`（globals 1000-1085，仅 `.login-submit` 仍用）、`.approve-*`（1444-1462）、`.hint`、`.prog`、`.side-day` 零引用；`.term` 在 globals 是深色、`ChatPane.css:21` 又改浅灰，意图相反。

---

## 9. 文档与现实的偏差

| 项 | 文档说法 | 实际 |
|---|---|---|
| Node 版本 | README「Node 20+」 | `package.json` **>=22.13**（`node:sqlite`） |
| 运行路径 | README `~/cxw/python/A/a-ai` | 本机 `E:\cxw\projects\A\a-ai` |
| 工具数量 | README「6 个」/ 笔记`:109`「8 个」/ 笔记`:1141`「14 个」/ 介绍页文案 | 代码 **15 个**；`Trace.tsx` 的 `TOOLS` 表也是 **15 条**（已 grep 核实，与注册表一致）——文档口径比代码落后 |
| 目录树 | README 27-55 行 | 缺 `openai-compatible.ts`、`CoreLogo/Intro/SvgFrame/ApprovalDock/AskCard/SandboxPane/Code`、15 个 API 路由、Docker/登录/沙箱整章 |
| 环境变量 | README 3 个；`.env.example` 未含 `A_ALLOW_SIGNUP`、`A_SANDBOX_DATA_VOLUME`、`A_API_BASE/A_API_KEY/A_MODEL` | 这些都被代码读取；反过来 `A_WORKSPACE_DIR` **全仓 0 个读取点**（死配置，我已 grep 核实） |
| 数据形态 | 笔记称已切 SQLite 并改名 `*.imported` | 磁盘 `.data/` 仍是迁移前的 JSON 布局（`settings.json`/`groups.json`/`sessions/*.json`，**无 `a.db`**） |
| 学习笔记篇幅 | README 未提 | 实际 **2,056 行**（含 9 大步骤 + 30 余条按日期迭代 + 3 个专题），是本项目最准确的"设计理由"来源 |
| 迁移守卫 | `legacy.ts:58` 用 `renameSync` | Windows 上目标已存在会抛错，导致"用户已建、注册 500、用户名被占" |

---

## 10. 本次通读遇到的两个环境问题（与代码无关）

1. **`pwsh` / 任何 shell 命令在本会话不可用**：每次调用都在沙箱准备阶段失败 —— `SetNamedSecurityInfoW failed (Win32 5): grantWrite(E:\cxw\projects\A\a-ai)`。`read/glob/grep/write` 全部正常，所以本次通读不受影响，但**无法执行 `npm run typecheck` / `npm run build` / `git status`，也拿不到文件字节大小**（摘要里的"规模"一律是行数）。
2. **`docs/学习笔记.md` 的文件名在磁盘上是乱码**（工具显示为 `瀛︿範绗旇.md`）：`read` 用「学习笔记.md」和乱码名都打不开，只能用 `grep` 把全文落成 spill 文件后再读。这是历史遗留的编码问题，建议改名修复（需要 shell，正好被问题 1 挡住）。

> 另：`E:\cxw\projects\A\a-ai\.dsh-selftest.txt` 是本次验证写入权限时建的 1 行文件，因 shell 不可用无法删除，可随手删掉。

---

## 11. 如果要继续推进，建议的优先级

1. **一行可修的**：`dockerignore` → `.dockerignore`；删除 `/auth/*` 三个死路由与 `custom.ts`；`create-artifact` 去掉 `parallelSafe`；`run-python` 加 `try/finally`。
2. **安全面**：`/api/models/test` 加内网/回环地址拒绝（和 `web-fetch.ts:77-89` 共用黑名单）；SSE 补 `X-Accel-Buffering: no` 与心跳；`safePath` 加 `realpath`。
3. **平台**：`sandbox.ts` 的路径判断改成 `path.parse().root` / `path.sep` 无关的写法，或在 Windows 上显式只允许 `local` 并禁用 `run_command`，避免"看起来有沙箱"。
4. **前端三处小 bug**：`send()` 吞消息、`SettingsModal` 共用 timer、FileDrawer 闪回。
5. **文档**：README 按实际结构重写（工具 15 个、Node 22.13+、目录树、Docker/登录/沙箱章节），随手修掉学习笔记的文件名。