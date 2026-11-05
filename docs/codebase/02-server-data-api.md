# A.ai 服务端数据层与 API 层摘要

> 只读审计产物。范围：`src/lib/server/*`（11 个）、`src/lib/*`（10 个）、`src/app/api/**/route.ts`（16 个）、`src/app/auth/**/route.ts`（3 个）。
> 全部逐行读完；辅助核对（未计入统计）：`src/lib/agent/tools/files.ts`（224 行，全文，safePath 实现）、`src/lib/agent/run.ts`（读 242/302 行）、`src/lib/agent/reflect.ts`（读 45/114 行）、`src/lib/llm/index.ts`、`src/lib/llm/types.ts`、`src/lib/llm/providers/openai-compatible.ts`（部分）、`src/components/{LoginForm,FileDrawer,SandboxPane}.tsx`、`src/app/login/page.tsx`。

## 1. 概览

- **职责**：SQLite 持久化（会话/消息/产出物/设置/记忆/审计）、按用户隔离的数据访问、Cookie 会话鉴权、SSE 流式 agent 入口、命令沙箱与审批、以及若干纯前端共用的解析工具。
- **规模**：40 个文件 / 2588 行。其中 `sandbox.ts` 433 行、`src/lib/settings.ts` 194 行、`db.ts` 132 行、`auth.ts` 128 行。
- **无中间件**：仓库没有 `middleware.ts`。需鉴权的 13 个 route 文件共 20 个 handler 都必须在第一句自己调 `currentUser()`（漏写即等于无鉴权）；`/api/auth/*` 与 `src/app/auth/*` 共 6 个 handler 按设计不做校验。

请求链路：

```
浏览器（Next 客户端组件）
  └─ src/lib/client.ts  fetch(cache:no-store) ── 401 → location.replace("/login")
       ├─ /api/sessions, /api/settings, /api/groups, /api/memory, /api/usage,
       │  /api/info, /api/sandbox, /api/files, /api/approve, /api/models/test
       │      → currentUser()（auth.ts → auth_tokens 表）
       │      → store.ts / server/settings.ts / groups.ts / memory.ts / audit.ts
       │      → db.ts  db()  →  node:sqlite DatabaseSync  →  .data/a.db（WAL）
       └─ POST /api/chat（SSE，text/event-stream）
              → runAgent() 产出 AgentEvent → `data: {json}\n\n`
              → 工具：files.ts(safePath) / sandbox.ts(runInSandbox) / approvals.ts(等待确认)
```

## 2. 逐文件

### `src/lib/server/db.ts`（132 行）
**作用/导出**：SQLite 连接与 schema。`DATA_DIR`(14)、`db()`(115)、`newId(prefix?)`(117)、`tx<T>(fn)`(122)。
- 16-98 一次性 `CREATE TABLE IF NOT EXISTS` 建 9 张表；无版本化迁移机制。
- 100-102 `mkdirSync(DATA_DIR)` 后打开 `DATA_DIR/a.db`；模块级不打开，懒加载。
- 103-105 三个 PRAGMA：`busy_timeout=5000`、`journal_mode=WAL`、`foreign_keys=ON`（顺序有意义，注释称 busy_timeout 必须最先）。
- 114-115 连接挂 `globalThis.__aDb`，防止 dev 热更新重复开连接。
- 122-132 `tx()` 手写 BEGIN/COMMIT/ROLLBACK，**不支持嵌套**。
- 依赖/风险：`node:sqlite`(4) 需 Node ≥22.13；单连接同步 API，所有查询串行阻塞事件循环。

### `src/lib/server/auth.ts`（128 行）
**作用/导出**：注册/登录/Cookie 会话。`User`(20)、`USERNAME_RULE`(47)、`register`(50)、`login`(71)、`startLogin`(92)、`currentUser`(111)、`logout`(119)、`unauthorized`(127)、`notFound`(128)。
- 30-33 `hashPassword`：`scrypt$<16B hex salt>$<64B hex key>`；35-40 `verifyPassword` 用 `timingSafeEqual`。
- 43 常量 `DUMMY = hashPassword("dummy-password")`：用户不存在时也跑一次 scrypt，抵消时序差异。
- 53-62 首个用户判定 + `A_ALLOW_SIGNUP=0` 关闭注册 + `importLegacyData(user.id)` 一次性迁移。
- 68-85 登录锁：内存 `Map<小写用户名,{n,until}>`，连续 5 次失败锁 60s。
- 92-108 token：`randomBytes(32).toString("base64url")`，库里只存 `sha256(token)`；顺带删过期行。
- 依赖/风险：被全部 19 个 route + `src/app/login/page.tsx` 引用；锁定状态不跨进程、不跨重启，详见 §4。

### `src/lib/server/store.ts`（97 行）
**作用/导出**：会话/消息/产出物 DAO。`newId`(5 再导出)、`listSessions`(22)、`getSession`(35)、`createSession`(47)、`renameSession`(54)、`deleteSession`(62)、`addMessage`(70)、`addArtifact`(82)、`allSessions`(88)。
- 契约：**每个函数都收 `userId`，每条 SQL 都带 `user_id`**；别人的会话一律返回 null → 接口回 404（防 IDOR）。
- 24-31 `has_files` 用 `m.data LIKE '%"name":"write_file"%'` 粗判（依赖 JSON 键序）。
- 71-79 `addMessage`：剥离 `drafts`（只给前端流式用）、`seq = s.messages.length - 1`、消息 INSERT 与会话 `updated_at` UPDATE 同事务。
- 88-96 `allSessions`：先 1 次查会话，再 2 次 JOIN 查出该用户全部消息与产出物。
- 风险：`messages` 表无 `(session_id, seq)` 唯一约束（db.ts:49-57），并发 run 可写出重复 seq；58 `get(id)!` 非空断言无 user 过滤（前一步已 UPDATE 校验属主）。

### `src/lib/server/settings.ts`（38 行）
**作用/导出**：用户设置读写。`getSettings`(6)、`maskSettings`(16)、`saveSettings`(21)。
- 6-13 读 `settings.data` JSON → `normalizeSettings`；parse 失败静默回默认。
- 16-18 出网前把每个连接的 `apiKey` 打码为 `••••abcd`。
- 23-31 回传打码值时保留库里的真 Key（`isMasked` 判断）。
- 33-36 `INSERT … ON CONFLICT(user_id) DO UPDATE`。
- 风险：API Key 明文存库（DB 泄露即 Key 泄露）；`normalizeSettings` 会静默丢弃未知字段。

### `src/lib/server/notes.ts`（43 行）
**作用/导出**：运行中「补充想法」内存队列。`NOTE_TAG`(14)、`openRun`(23)、`closeRun`(27)、`addNote`(32)、`takeNotes`(39)。
- 20-21 Map 挂 `globalThis.__aRuns`（dev 热更新不丢）。
- 32-37 `addNote` 校验 `r.userId !== userId` → false（防跨用户插话），单条截断 4000 字。
- 39-43 `takeNotes` 用 `splice(0)` 取走；**不校验 userId**（内部调用，靠调用点保证）。
- 风险：单飞假设未强制 —— 同会话并发两轮 run 时 `openRun` 覆盖、先结束者 `closeRun` 会删掉后者的队列。

### `src/lib/server/groups.ts`（39 行）
**作用/导出**：对话分组。`getGroups`(9)、`saveGroups`(20)。
- 21 白名单：id 需匹配 `^[a-z0-9_-]{1,40}$/i`，最多 100 个，name 截 40 字。
- 22-25 事务内先删掉不在新列表里的分组（带 user_id）。
- 27-30 upsert 带 `WHERE groups.user_id = excluded.user_id`：id 被别人占用时静默不写。
- 32-36 先把本用户所有会话 `group_id=NULL`，再用带 `EXISTS(…user_id=?)` 的 UPDATE 逐个归组。
- 风险：`groups` 表无 `user_id` 索引（全表扫）；同 id 冲突时前端看到分组「消失」而非报错。

### `src/lib/server/memory.ts`（85 行）
**作用/导出**：长期记忆。`EMPTY_MEMORY`(10)、`getMemory`(17)、`saveMemory`(27)、`clearMemory`(37)、`normalizeMemory`(42)、`isEmptyMemory`(68)、`memoryPrompt`(74)。
- 13-15 上限 habits 12 / lessons 20，`clip()` 压空白并截断。
- 45-63 lessons：去重、count 夹到 1..999、按 count+updatedAt 排序后截断。
- 74-85 渲染成「必须遵守，不要再犯」的提示词段。
- 风险：`EMPTY_MEMORY` 在无记录/解析失败时**按引用返回**共享常量（19、23）；无并发写保护（后写覆盖）。

### `src/lib/server/audit.ts`（81 行）
**作用/导出**：命令审计。`AuditDecision`(13)、`AuditEntry`(15)、`audit(e)`(32)、`listAudit(userId,limit=200)`(61)。
- 32-53 `audit_log` INSERT；`command` 截 4000 字（43）。
- 54-57 写失败只 `console.warn`，不影响命令本身。
- 64 limit 夹到 1..1000；`ORDER BY id DESC`。
- 风险：command 原样存储不做脱敏；表无 `created_at` 索引、无 `user_id` 外键（删用户留审计，属设计）。

### `src/lib/server/approvals.ts`（49 行）
**作用/导出**：工具确认的等待队列。`ApprovalDecision`(16)、`waitApproval`(24)、`answerApproval`(42)、`allowSession`(48)、`isSessionAllowed`(49)。
- 18 `WAIT_MS = 5 * 60_000`；19 `waiting: Map<`${userId}:${callId}`, resolve>`。
- 24-39 Promise + `setTimeout`；`signal` 已 aborted 或触发 abort 立即 `deny`。
- 42-46 `answerApproval` 取不到 resolver 返回 false（超时/重复/别人的 callId）。
- 风险：`allowedSessions` 只按 sessionId、永不清理且无 userId；纯内存 → 多实例/重启失效（14 行注释自认）。

### `src/lib/server/sandbox.ts`（433 行）
**作用/导出**：命令沙箱三层防线。`sandboxInfo`(53)、`checkCommand`(96)、`sandboxEnv`(125)、`sandboxRoot`(161)、`sandboxExec`(163)、`seatbeltProfile`(204)、`explainDocker`(255)、`dockerProblem`(269)、`sandboxPrompt`(368)、`runInSandbox`(394) 及 3 个类型。
- 53-88 解析 `A_SANDBOX*` 环境变量：授权目录去重、拒绝 `/` 与 `$HOME`、`realpath` 修正、模式回落（非 macOS 的 seatbelt → local）。
- 96-114 第 1 层：从命令文本抽「像路径」的 token，逐条 `path.resolve` 后判 `within(allowed)`；另有一条针对相对 `.env`/私钥的正则。
- 163-183 本机/seatbelt 执行：`spawn(bash, ["-c",script], {detached:true})`，kill 用 `process.kill(-pid)` 杀整组。
- 204-237 seatbelt SBPL：`(deny file-write*)` → 只放行工作区/tmp/rw 目录 → 禁读个人目录与 `DATA_DIR` → 最后统一禁读密钥正则。
- 280-310 docker：每会话常驻容器名 `a-ai-sbx-<sessionId>`、`setsid` 包裹、按 pid 文件杀进程组。
- 321-346 建容器：`--network none|bridge`、`--memory/--cpus/--pids-limit`、`--cap-drop ALL`、`no-new-privileges`、`--user 1000:1000`、`--read-only` + tmpfs、敏感目录用空 tmpfs 覆盖。
- 394-433 `runInSandbox`：超时/abort → kill；`exit` 后 300ms 宽限再杀整组（防 `&` 后台进程占管道）；过滤 setsid 噪音。
- 风险：**整套路径逻辑是 POSIX 语义**（47、100、116、128、168），在 Windows 上基本失效，见 §6。

### `src/lib/server/legacy.ts`（65 行）
**作用/导出**：一次性 JSON→SQLite 迁移。`importLegacyData(userId)`(17)。
- 27-34 读 `.data/sessions/*.json`、`groups.json`；54 读 `settings.json`。
- 36-52 事务内 `INSERT OR IGNORE` 分组/会话/消息/产出物（消息 seq 用数组下标）。
- 55 走 `saveSettings` 合并设置；58 成功后把旧路径改名为 `*.imported`；59-64 迁移 `workspace/`。
- 风险：58 的 `renameSync` 若目标已存在会抛（Windows 必抛），此时用户已创建（auth.ts:58-62）→ 注册 500 且用户名被占；46 存的 JSON 含 `drafts`，与 `addMessage` 剥离口径不一致。

### `src/lib/shared.ts`（123 行）
**作用/导出**：前后端共享类型。`Artifact`(7)、`StoredMessage`(16)、`Feedback`(39)、`UserMemory`/`Lesson`(56/65)、`SessionMeta`/`Session`(73/82)、`Group`/`Groups`(91/95)、`ToolInfo`(101)、`AgentEvent`(110-123)。
- 1 行声明禁止引入 Node 专用模块。
- 110-123 SSE 事件联合类型共 13 种，是 `chat` 路由与 `client.ts` 的唯一契约。
- 风险：无运行时校验，前后端各自 evolve 时容易静默漂移（如 `feedback.kind` 新增值）。

### `src/lib/client.ts`（114 行）
**作用/导出**：客户端 API 封装。`api`(19-79)、`streamChat`(82)、`isMac`(113)、`mod`(114)。
- 9-16 统一 `call()`：`cache:"no-store"`，401 → `location.replace("/login")` 并抛错。
- 100-108 SSE 解析：按 `\n\n` 切帧，取所有 `data:` 行拼接后 `JSON.parse`。
- 风险：108 `JSON.parse` 无 try/catch；流结束时未 flush 残余 `buf`；77 登出硬跳 `/A.ai`。

### `src/lib/settings.ts`（194 行）
**作用/导出**：设置类型与归一化。`PRESETS`(29)、`MOCK_MODEL`(44)、`modelOptions`(54)、`currentOption`(61)、`isMasked`(67)、`maskKey`(68)、`Settings`(72)、`DEFAULT_SETTINGS`(106)、`normalizeSettings`(124)、`normalizeConnection`(150)、`UsageStats`(180)。
- 124-148 全字段白名单校验 + 截断；137-140 `maxSteps` 的 v1→v2 迁移特例（旧值 8 视为未改过）。
- 66-68 打码协议：`••••` 前缀 + 末 4 位。
- 风险：`currentOption` 找不到时回落 `all[0]`（mock），用户会静默用回演示模型。

### `src/lib/tokens.ts`（9 行）
**作用/导出**：`estimateTokens(s)`(6)。CJK 记 1 token、其余 4 字符 1 token；仅用于 UI 估算，注释明示真实用量以 API usage 为准。

### `src/lib/diff.ts`（105 行）
**作用/导出**：纯前端 diff。`diffLines`(11)、`countDiff`(32)、`fileChanges`(52)、`originalOf`(96)。
- 15-17 `n*m > 4e6` 退化为「全删+全加」，防页面卡死。
- 76-84 从消息里的 `edit_file`/`write_file` 调用与结果重建改动序列。
- 风险：100 `originalOf` 用 `String.replace` 回滚首次匹配，重复片段时还原不精确。

### `src/lib/outputs.ts`（110 行）
**作用/导出**：右栏「输出/已使用」列表。`collectOutputs`(56)、`artifactExt`(41)、`extOf`(36)。
- 65-68 产出物直接进 outputs（不按 path 去重）；82-87 同一路径多次写入只留最新。
- 88-104 读文件/列目录/抓网页归入 `used`，按 key 去重。

### `src/lib/live.ts`（67 行）
**作用/导出**：工具实时输出与待确认请求的小 store。`liveStore.apply/reset`(25-57)、`useLiveOutput`(60)、`useApprovals`(65)。
- 16 `MAX_CHARS = 200_000`，超出从头裁剪（34-38）。
- 用 `useSyncExternalStore` + 快照对象，避免整棵树重渲染。
- 风险：`outputs` 里的条目只在 `reset()` 或新事件时清理，长会话内可能累积多个 callId。

### `src/lib/file-chips.ts`（88 行）
**作用/导出**：把回答里的文件名变成 chip。`FILE_RE`(17)、`isFileName`(22)、`rehypeFileChips`(32)、`resolveFileName`(72)。
- 30 跳过 `code/pre/a/script/style` 子树，避免改代码块。
- 19-20 排除 `next.js`、`react.js` 等框架名误判。
- 风险：模块级全局正则，`isFileName` 必须先手动重置 `lastIndex`（24），调用方漏改易出间歇性 bug。

### `src/lib/highlight.ts`（62 行）
**作用/导出**：hljs 高亮。`langOf`(19)、`highlight`(28)、`highlightLines`(46)。
- 29 超过 80k 字符不高亮直接转义；35 自动识别限定在 12 种常用语言内。
- 46-59 整段高亮后按行切，跨行 `<span>` 行尾补闭合、下一行重开。
- 风险：8 行注释明确「hljs 已转义，可直接 dangerouslySetInnerHTML」——一旦换实现即为 XSS 入口。

### `src/lib/svg.ts`（2 行）
**作用/导出**：`isSvg(text)`(2)，兼容 `<?xml?>`/注释/DOCTYPE 前缀；前后端共用。

### `src/app/api/chat/route.ts`（95 行）
**作用/导出**：`POST`(17)，SSE 入口。详见 §5。
- 25-30 只认自己的会话；`sessionId` 属于别人时按「不存在」新建会话。
- 39-41 `ReadableStream` + `data: ${JSON.stringify(e)}\n\n` 编码。
- 64-68 后台反思不 await，单独 90s 超时。
- 风险：见 §5 末尾 3 条。

### `src/app/api/chat/note/route.ts`（20 行）
**作用**：运行中补充想法。`POST`(12)：401 → 400（缺参）→ 18 `addNote` 失败回 `{queued:false}` + 409。

### `src/app/api/approve/route.ts`（18 行）
**作用**：回答确认请求。`DECISIONS`(7) 白名单(14)、400(15)、16 无等待者回 404（超时/重复/别人的 callId）。

### `src/app/api/files/route.ts`（47 行）
**作用**：右栏文件预览。`GET`(16)。
- 21 `safePath(workspaceOf(user.id), p)` —— 与 agent 工具同一套边界。
- 23-29 目录列表过滤点文件、目录优先排序；31-42 文件读 200KB 上限、二进制探测(`subarray(0,8000)` 含 0)。
- 风险：不 `realpath`，工作区内软链可越界；`buf.toString("utf8",0,MAX)` 可能切断多字节字符。

### `src/app/api/sessions/route.ts`（18 行）
**作用**：`GET`(8) 列表 / `POST`(14) 新建。均带 `user.id`。**`POST` 无任何调用方（死接口）**。

### `src/app/api/sessions/[id]/route.ts`（33 行）
**作用**：`GET`(13)/`PATCH`(20)/`DELETE`(29)。
- 16、25、32 三处都把 `user.id` 传进 DAO；不属于自己统一 404（10-12 注释解释：不用 403 以免泄露 id 存在性）。
- 25 标题 `trim().slice(0,80)`。

### `src/app/api/settings/route.ts`（21 行）
**作用**：`GET`(9) 返回打码设置 + `SYSTEM_PROMPT`；`PUT`(16) 部分更新。20 出网前再次 `maskSettings`。

### `src/app/api/models/test/route.ts`（36 行）
**作用**：测试 OpenAI 兼容连接。`POST`(14)。
- 17-19 收到打码 Key 时回退用服务端保存的真 Key。
- 21-22 只校验 `^https?://`；26-29 服务端 `fetch(base + /models)`，15s 超时，带 `Authorization: Bearer`。
- 风险：**SSRF** —— 任意登录用户可让服务端请求任意 http(s) 地址（含内网/本机）。

### `src/app/api/groups/route.ts`（21 行）
**作用**：`GET`(8) / `PUT`(15)。19 形校验（`groups` 数组 + `assign` 对象）后整份覆盖。

### `src/app/api/info/route.ts`（31 行）
**作用**：`GET`(18) 返回用户名、当前模型 label、工具清单、`systemTokens`/`toolsTokens`（28-29 把记忆也算进固定占用）。

### `src/app/api/memory/route.ts`（27 行）
**作用**：`GET`(8)/`PUT`(15)/`DELETE`(22)，写操作全走 `normalizeMemory` 清洗。

### `src/app/api/sandbox/route.ts`（16 行）
**作用**：`GET`(9) 返回沙箱状态 + 当前用户最近 200 条审计；13-15 docker 模式下实检一次 Docker 并把问题塞进 `warnings`。
- 风险：`info.dirs` 是部署机绝对路径，对**所有**登录用户可见。

### `src/app/api/usage/route.ts`（71 行）
**作用**：`GET`(13) 用量统计。
- 16 `allSessions(user.id)` 全量载入；17-25 固定 14 天窗口并按本地时区归日。
- 33-64 单次遍历累加 tokens/时长/工具错误；66-69 输出 byTool/byDay。
- 风险：全量消息进内存，随数据增长线性变慢。

### `src/app/api/auth/login/route.ts`（13 行）
**作用**：`POST`(7) → `login()`；失败 401，成功 `startLogin` 写 Cookie 并回 `{user}`。

### `src/app/api/auth/register/route.ts`（13 行）
**作用**：`POST`(7) → `register()`；失败 400，成功直接登录。

### `src/app/api/auth/logout/route.ts`（9 行）
**作用**：`POST`(6) → `logout()` 删 token 行 + 删 Cookie，204。

### `src/app/auth/{login,register,logout}/route.ts`（13/13/9 行）
**作用**：与 `/api/auth/*` **逐字符相同**的重复实现（POST `/auth/login`、`/auth/register`、`/auth/logout`）。
- 证据：全仓 grep `/auth/(login|logout|register)` 只命中 `src/lib/client.ts:76` 的 `/api/auth/logout`；`LoginForm.tsx:25` 用 `` `/api/auth/${mode}` ``。
- 结论：三个文件均为死代码，且构成两套可登录入口（维护时容易只改一边）。

## 3. 专题：SQLite 表结构

全部定义在 `db.ts:16-98`（`CREATE TABLE IF NOT EXISTS`）。连接级 PRAGMA：`busy_timeout=5000`(103)、`journal_mode=WAL`(104)、`foreign_keys=ON`(105)。

| 表 | 字段（PK/FK 标注） | 索引 |
|---|---|---|
| `users` (17-22) | `id` PK、`username` UNIQUE COLLATE NOCASE、`password_hash`、`created_at` | username 唯一索引（隐式） |
| `auth_tokens` (25-29) | `token_hash` PK、`user_id` → users(id) ON DELETE CASCADE、`expires_at` | PK 即索引 |
| `groups` (31-36) | `id` PK、`user_id` → users CASCADE、`name`、`sort` | **无 user_id 索引** |
| `sessions` (38-46) | `id` PK、`user_id` → users CASCADE、`title`、`group_id` → groups(id) ON DELETE SET NULL、`created_at`、`updated_at` | `sessions_user(user_id, updated_at DESC)`(46) |
| `messages` (49-57) | `id` PK、`session_id` → sessions CASCADE、`seq`、`role`、`created_at`、`data`(StoredMessage JSON) | `messages_session(session_id, seq)`(57)，**非唯一** |
| `artifacts` (59-65) | `id` PK、`session_id` → sessions CASCADE、`created_at`、`data`(Artifact JSON) | `artifacts_session(session_id, created_at)`(65) |
| `settings` (68-71) | `user_id` PK → users CASCADE、`data`(Settings JSON，含明文 apiKey) | PK |
| `memories` (74-78) | `user_id` PK → users CASCADE、`data`(UserMemory JSON)、`updated_at` | PK |
| `audit_log` (81-97) | `id` INTEGER PK AUTOINCREMENT、`user_id`（**无外键**）、`session_id`、`tool`、`command`、`cwd`、`sandbox`、`decision`、`reason`、`exit_code`、`timed_out`、`duration_ms`、`output_chars`、`created_at` | `audit_user(user_id, id DESC)`(97) |

**数据目录布局**（`db.ts:14`，`A_DATA_DIR` 可覆盖，默认 `<cwd>/.data`）：

```
<DATA_DIR>/a.db            (+ a.db-wal / a.db-shm，WAL 模式)
<DATA_DIR>/users/<userId>/workspace/     每个用户独立工作区（files.ts:15-18，userId 需匹配 ^[a-z0-9_-]+$）
<DATA_DIR>/sessions/*.json               仅升级前旧格式，迁移后改名 *.imported
<DATA_DIR>/groups.json / settings.json   同上
```

产出物**不入文件系统**，以 JSON 存 `artifacts.data`；对话文件（agent 写的文件）才落 `workspace/`。

## 4. 专题：鉴权全流程

1. **注册** `auth.ts:50-66`：用户名 `^[a-zA-Z0-9_.-]{2,32}$`(47) → 密码 8..200(52) → 首个用户判定(53) → `A_ALLOW_SIGNUP=0` 时禁止新增(54) → 唯一性(55) → 插行(58-60) → 首个用户迁移旧数据(62) → 默认显示名(64)。
2. **密码哈希** `auth.ts:30-33`：`scryptSync(pw, 16字节随机盐, 64)`，格式 `scrypt$<salt hex>$<hash hex>`；校验用 `timingSafeEqual`(39)。
3. **防枚举** `auth.ts:43,77`：用户不存在时对 `DUMMY` 哈希做一次同代价校验。
4. **失败锁定** `auth.ts:69-85`：按小写用户名计数，`n>=5` 时 `until=now+60s`；锁定期内直接 401「错误次数太多」；成功即 `fails.delete(key)`。**内存态，重启清零；无全局/IP 维度限制。**
5. **token 生成与存储** `auth.ts:89-96`：`randomBytes(32)` → base64url 给浏览器，DB 只存 `sha256(token)`；登录时顺带 `DELETE FROM auth_tokens WHERE expires_at < now`。
6. **Cookie 属性** `auth.ts:101-107`：名 `a_session`(25)、`httpOnly`、`sameSite:"lax"`、`secure` 仅当 `x-forwarded-proto` 首值为 https(100)、`path:"/"`、`maxAge=TTL_MS/1000`（30 天，26）。
7. **校验** `auth.ts:111-117`：读 Cookie → sha256 → `JOIN users … WHERE token_hash=? AND expires_at > now`；返回 `{id,username}` 或 null。
8. **登出** `auth.ts:119-124`：按 token 哈希删行 + 删 Cookie。
9. **统一出口** `auth.ts:127-128`：`unauthorized()`=401 JSON，`notFound()`=404 JSON；所有 route 第一句 `const user = await currentUser(); if (!user) return unauthorized();`（20 个需鉴权的 handler 全部遵守，计数见 §1）。

## 5. 专题：`/api/chat` 的 SSE 实现

- **固定声明**：`runtime="nodejs"`、`dynamic="force-dynamic"`（13-14）。
- **请求体**：`{ sessionId?, message }`，`message` 必填(20-22)；`sessionId` 越权/不存在 → 直接新建(25-26)；空会话首条消息即标题(27-30, 92-95 截 28 字)。
- **headers**（84-88）：`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache, no-transform`、`Connection: keep-alive`。**无 `X-Accel-Buffering: no`、无心跳注释帧。**
- **编码格式**（41）：`data: ${JSON.stringify(e)}\n\n` —— 单 `data:` 行 + 空行，无 `event:`/`id:`/`retry:`；客户端按 `\n\n` 切帧并拼 `data:` 行（client.ts:100-108），两端一致。
- **事件序列**：`session`(44) → `message`(45，用户消息) → agent 循环产出的 `reasoning`/`text`/`tool_input` → `assistant_end` → `tool_start` → `tool_output`* → 可能 `approval`/`approval_end` → `artifact` → `message`(工具结果) … 循环 → `done`（`run.ts:199` 统一在生成器末尾 yield）。类型全集见 `shared.ts:110-123`。
- **中断/abort**：`req.signal` 透传 `runAgent`(54) → provider 流与 `waitApproval`(approvals.ts:24) 都受其控；`run.ts:95,134,151` 三处检查 aborted 并 break，随后仍会 yield `done`。
- **后台反思**（64-68）：回答发完后 `if (settings.memory) reflect({...})`，**不 await**，用 `AbortSignal.timeout(90_000)` 而非 `req.signal`（浏览器断开不该中断记忆写入），失败只 `console.warn`。
- **错误处理**（69-79）：`catch` 时仅在未 abort 时发 `error` 帧，然后**无条件** `send({type:"done"})`；`finally` 里 `closeRun` + `try{controller.close()}catch{}`。
- 风险：① 71 行在客户端已断开（controller 已 cancel）时仍 enqueue，会抛 `Invalid state` 并逃出 `start()`；② 长时间等待确认（最长 5 分钟）期间零字节输出，反代易判超时断流；③ `titleFrom` 只在新会话/空会话时生效，改名后不会覆盖。

## 6. 专题：审批模型 与 路径边界

**审批（approvals）**
- 队列：`waiting: Map<"<userId>:<callId>", resolve>`（approvals.ts:19,25），天然按用户隔离 —— 别人知道 callId 也 `answerApproval` 不到（42-46 返回 false → `approve` 路由 404）。
- 超时：`WAIT_MS=5min`(18) 或 `signal` abort → 一律 `deny`(27-35)；超时后 map 项被 `done()` 清除(31)。
- 触发点 `run.ts:84-91`：`commandApproval==="auto"` 或 `readonly && req.readonly` 或 `isSessionAllowed(session.id)` → 直接放行；否则 emit `approval` → `await waitApproval` → `allow_session` 则 `allowSession(session.id)` → emit `approval_end`。
- `allow_session` 语义：进程内 `Set<sessionId>`，对本会话后续所有命令永久放行（48-49），**不落库、不区分用户、永不清理**。

**路径边界**
- `files.ts:15-18` `workspaceOf(userId)`：`DATA_DIR/users/<id>/workspace`，id 需过 `^[a-z0-9_-]+$`。
- `files.ts:20-24` `safePath(root,p)`：`path.resolve` 后要求 `full===root || full.startsWith(root+sep)`，否则抛「路径超出工作区」。**不做 `realpath`**。
- `/api/files`(21) 与全部文件工具(40、78、136、219)共用它；根永远是当前用户工作区 → 不存在跨用户读。
- 越界风险：工作区内若已存在指向外部的 symlink（agent 用 `run_python` 建的、或解压产物），`fs.stat/readFile` 会跟随 → 绕过 `safePath`。属纵深防御缺口（第 1 层字符串检查本应拦住创建动作）。
- `sandbox.ts:96-114` 第 1 层：只抽取「以 `/` 或 `~` 开头」或「含 `..`」的 token(100)，然后 `SENSITIVE_RE`(44)、`within(allowed)`(105)、`PRIVATE_ROOTS`/`DATA_DIR`(106-107)。
- **Windows 实测性结论**：`PRIVATE_ROOTS` 全是 `/Users /home /root …`(47)、`within` 用 `"/"` 拼前缀(116)、`SENSITIVE_RE` 以 `/` 分界(44) —— `C:\Users\me\.ssh\id_rsa` 既不匹配 token 正则也不会被判越界，**第 1 层在 Windows 上等于 fail-open**；叠加 `sandboxEnv` 用 `:` 拼 PATH(128)、`spawn("bash")`(168)、本机模式无隔离(79-84)，当前 Windows 开发环境只剩「用户确认」一层。

## 7. 问题清单

1. **[高] Windows 下路径检查失效（fail-open）** `sandbox.ts:100,116,44,47`：token 正则只认 `/`/`~`，`within` 与敏感正则按 `/` 分界。证据：`C:\Users\x\.ssh\id_rsa` 不产生 token；`within("…\workspace\a","…\workspace")===false` 但也不在 `PRIVATE_ROOTS` 内 → 不返回拒绝。同因 `sandboxEnv:128` 的 `:` PATH 在 Windows 上使命令不可用。
2. **[中] SSRF** `models/test/route.ts:21,26-29`：仅校验 `^https?://`，服务端随即带 `Authorization` 请求该地址（可打 `127.0.0.1`/内网元数据服务）。
3. **[中] 客户端断开后仍向已关闭 controller 写帧** `chat/route.ts:70-71`：`send({type:"done"})` 不在 `if (!req.signal.aborted)` 保护内，异常会逃出 `ReadableStream.start()`。
4. **[中] SSE 无心跳/禁缓冲头** `chat/route.ts:84-88` + `approvals.ts:18`：审批最长静默 5 分钟，nginx 等默认 60s 断流。
5. **[中] notes 单飞假设未强制** `notes.ts:23-29` + `chat/route.ts:42,73`：同会话并发两轮 run 时 `openRun` 互相覆盖、先结束者 `closeRun` 删掉后者队列 → 补充想法静默丢失。
6. **[中] `messages` 无 `(session_id,seq)` 唯一约束** `db.ts:49-57` + `store.ts:76`：seq 由内存数组长度推导，并发/重试会写重复 seq，`ORDER BY seq` 顺序不确定。
7. **[中] `safePath` 不解析软链** `files.ts:20-24`、`api/files/route.ts:21`：工作区内指向外部的 symlink 可越界读文本。
8. **[低] `has_files` 靠 JSON 子串猜测** `store.ts:27`：依赖键序 `"name":"write_file"`，legacy 导入数据（`legacy.ts:46` 存原始 JSON，含 `drafts`）与 `addMessage`（`store.ts:71` 剥离）序列化口径不一致，可能漏判。
9. **[低] 死代码：重复鉴权路由** `src/app/auth/{login,register,logout}/route.ts` 与 `/api/auth/*` 完全一致且无引用（仅 `client.ts:76` 用 `/api/auth/logout`，`LoginForm.tsx:25` 用 `/api/auth/${mode}`）。
10. **[低] 死接口** `sessions/route.ts:14-18`：`POST /api/sessions` 全仓无调用方（新建会话只发生在 `/api/chat`）。
11. **[低] 迁移改名失败会留下半成品用户** `legacy.ts:58` + `auth.ts:58-62`：`*.imported` 已存在时 `renameSync` 抛错，用户行已提交 → 注册 500 且用户名被占用。
12. **[低] 登录锁定不随时间复位** `auth.ts:74,79-80`：`n` 只增不减，解锁后每次失败立即再锁 60s；且按用户名（非 IP）计数、进程内存储。
13. **[低] Cookie/CSRF 依赖单点假设** `auth.ts:100-107`：`secure` 仅看 `x-forwarded-proto`；所有写接口无 Origin/Sec-Fetch-Site 校验，纯靠 `SameSite=Lax`。
14. **[低] 进程内状态不可横向扩展** `approvals.ts:14,21,48`、`notes.ts:20-21`、`sandbox.ts:243`：审批队列、allow_session、补充想法、容器缓存都是单进程内存；重启即丢，多实例互不可见。
15. **[低] 信息泄露/缓存** `api/sandbox/route.ts:15` + `sandbox.ts:51-54,86`：向所有登录用户暴露授权目录绝对路径与部署告警；`cached` 永不刷新，改环境变量须重启。
16. **[低] 小缺陷**：`memory.ts:19,23` 返回共享 `EMPTY_MEMORY` 常量引用；`client.ts:108` `JSON.parse` 无保护且流末尾丢弃残余 `buf`；`api/files/route.ts:39` 按字节硬切可能截断多字节字符；`audit.ts:43` 命令原样入库不脱敏。
17. **[提示，跨层] `src/lib/llm/providers/custom.ts` 是 `throw new Error("CustomProvider 尚未实现")` 的桩**（37 行）且未被 `llm/index.ts:2-3` 引入 → 死文件。