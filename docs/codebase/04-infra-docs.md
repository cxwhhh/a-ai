# 04 · 工程配置、部署文件与学习笔记（Infra & Docs）

> 只读调研产出。读取范围：根目录 12 个配置文件 + `docs/学习笔记.md` + `.data/` 3 个数据文件 + `.idea/` 8 个 xml（共 26 个文件 / 5082 行；其中逐行读完 2572 行）。
> 环境限制：本沙箱 shell 不可用，**无法取得字节大小**，所有"规模"均为 read 工具报告的行数。`package-lock.json` 只读头部 45 行 + 全量 `resolved` 来源统计，未逐行读完。
> 隐私：`.data/settings.json` 的 `apiKey` 字段一律写作 `••••`，只描述结构与字段名。

---

## 1. 概览

| 项 | 事实 | 证据 |
|---|---|---|
| 项目 | A.ai —— Next.js App Router 全栈 AI agent（对话 + 工作区 + 产物面板） | `README.md:3`、`docs/学习笔记.md:22-24` |
| src 规模 | `src/` 下 `.ts/.tsx` 共 **91 个**（glob 计数） | glob `src/**/*.ts*` |
| Next | **16.4.2** | `package.json:13` |
| React / DOM | **19.3.1 / 19.3.1** | `package.json:14-15` |
| TypeScript | **5.9.3**（strict、`noEmit`、`moduleResolution: bundler`） | `package.json:24`、`tsconfig.json:11-15` |
| Node 要求 | **>=22.13**（因为用内置 `node:sqlite`，22.13 起免 `--experimental-sqlite`） | `package.json:26-28`、`docs/学习笔记.md:444` |
| SQLite 驱动 | **无第三方驱动**，用 Node 内置 `node:sqlite` | `docs/学习笔记.md:1915`、`package.json:11-19` |
| 运行时形态 | 单机 Docker 容器（`node server.js`，standalone）+ 命名卷持久化，端口 3000 | `Dockerfile:59`、`docker-compose.yml:19`、`next.config.ts:2` |
| 数据形态 | SQLite 单文件 `.data/a.db` + 每用户工作区（**当前磁盘上的 `.data` 仍是迁移前的 JSON 布局**，见 §7） | `docs/学习笔记.md:405-407`、`.data/` 实况 |

---

## 2. 逐文件小节（根目录）

### `package.json` — 29 行
- 作用：依赖与脚本入口。`scripts` 仅 4 条：`dev`/`build`/`start`（均 `-p 3000`）与 `typecheck`（`tsc --noEmit`）。
- 关键项：全部依赖**精确版本**（无 `^`/`~`），利于镜像可复现；7 个生产依赖 + 4 个开发依赖，无 lint/test 脚本。
- 风险/TODO：无 `lint`/`test` 脚本，质量门禁只有 `tsc`（而 `.idea` 里 ESLint inspection 是开启的）；`start` 用 `next start` 而非 `node server.js`，与 Docker 路径不同（两套启动方式需各自验证）。

### `package-lock.json` — 2555 行
- 读法：`lockfileVersion: 3`（第 4 行）；统计 `"resolved"` 共 **163 条，全部指向 `https://registry.npmjs.org/`**，无 git/文件/私有源依赖 → **无可疑源**；顶层 `packages[""]` 与 `package.json` 完全一致（名称/版本/依赖 11 项/engines）。
- 包数量级：163 个 registry 包 + 根条目 ≈ 164 项；其中平台可选包占比高（`@img/sharp-*` 约 22 个、`@next/swc-*` 8 个、`@img/sharp-libvips-*` 等）。
- 风险/TODO：`sharp` 与 `@next/swc-*` 是**平台相关可选依赖**——这正是"Windows 上生成的 `node_modules` 不能在 Linux 镜像里用"的根因，与 `dockerignore` 失效叠加后会在镜像内 `next build` 失败（§7-1）。

### `tsconfig.json` — 41 行
- 作用：TS 编译/编辑器配置（`noEmit`，只做类型检查）。
- 关键项：`target/lib ES2022`、`strict: true`、`skipLibCheck: true`、`isolatedModules`、`jsx: react-jsx`、别名 `@/* → ./src/*`；`include` 含 `.next/types/**/*.ts` 与 `.next/dev/types/**/*.ts`（Next 16 生成物）。
- 风险/TODO：`include` 依赖 `.next/` 生成物，而 `.gitignore:2,7` 同时忽略 `.next` 与 `next-env.d.ts` → 干净 checkout 上先跑 `typecheck` 可能缺引用（需先 `next build`/`next dev`；未实测，标记 TODO）。

### `next.config.ts` — 3 行
- 作用：唯一配置就是 `output: "standalone"`（一整行函数式写法，无其他项）。
- 取值理由：产出自带精简 `node_modules` + `server.js` 的目录，Docker 最终镜像可直接 `node server.js`，运行时不需要 `npm install`（`docs/学习笔记.md:519`）。
- 风险/TODO：standalone **不会**自动带上 `.next/static` 与 `public/`，Dockerfile 必须手工 COPY（已做，`Dockerfile:45-46`）；未配置 `basePath`，因为站点根路径直接由 `src/app/A.ai/` 目录提供（`docs/学习笔记.md:603`）。

### `next-env.d.ts` — 7 行
- 作用：Next 自动生成的类型引用（`/// <reference types="next" />` + `import "./.next/types/routes.d.ts"`）。
- 风险/TODO：文件头注明"should not be edited"，但它在 `.gitignore:7` 里被忽略 → 每位开发者/每次构建由 Next 重新生成；不要手动改。

### `.env.example` — 31 行
- 作用：可选的"高级配置"清单，全部注释掉；文件开头明确"模型和 API Key 现在在界面里设置"（`设计决策`：Key 存 `.data/settings.json` 而非环境变量）。
- 关键项：`A_DATA_DIR`/`A_WORKSPACE_DIR`/`A_PYTHON`、`TAVILY_API_KEY`/`BRAVE_SEARCH_API_KEY`、终端沙箱 8 项（`A_SANDBOX`/`A_SANDBOX_DIRS`/`A_SANDBOX_NETWORK`/`A_SANDBOX_IMAGE`/`A_SANDBOX_MEMORY`/`A_SANDBOX_CPUS`/`DOCKER_GID`）。
- 风险/TODO：**缺 3 类实际会被读取的变量**：`A_ALLOW_SIGNUP`（`src/lib/server/auth.ts:54`）、`A_SANDBOX_DATA_VOLUME`（`src/lib/server/sandbox.ts:323`）、`A_API_BASE/A_API_KEY/A_MODEL`（`src/lib/llm/providers/custom.ts:26-28`）；反之 `A_WORKSPACE_DIR` 在 `src/` 内**无任何读取点**（§7-5）。

### `.gitignore` — 8 行
- 作用：忽略 `node_modules`、`.next`、`out`、**`.data`**、`.env*.local`、`*.tsbuildinfo`、`next-env.d.ts`、`.DS_Store`。
- 取值理由：`.data` 里有 `settings.json`（含 API Key）与用户工作区，必须排除（`README.md:23` 也强调）。
- 风险/TODO：只忽略 `.env*.local`，若有人把 Key 写进 `.env`（compose 会读同目录 `.env`）仍可能被提交。

### `dockerignore` — 15 行（**文件名有坑**）
- 作用：本意是排除 `node_modules`、`.next`、`.data`、`.git`、`.env*`、`docs`、`Dockerfile*`、`docker-compose.yml`、`.idea` 等。
- 现状：文件名是 `dockerignore`（**没有前导点**），Docker 只认 `.dockerignore` → **该文件完全不生效**；文件第 11 行自身还写着 `.dockerignore`（说明作者以为它是点文件）。
- 风险/TODO：**高危**。`Dockerfile:15` 的 `COPY . .` 会把宿主机 `node_modules`（Windows 平台二进制）、`.data`（含 `settings.json`）、`.git` 一起送进构建上下文与镜像层 → 既可能让 `next build` 失败，也可能把隐私数据写进构建缓存。修法：改名为 `.dockerignore`。

### `Dockerfile` — 59 行
- 作用：三阶段构建主镜像（详见 §4）。
- 关键项：`PY_PACKAGES` 构建参数（第 30 行）让 `run_python` 能用第三方库；`A_DATA_DIR=/app/.data`（第 40 行）与 compose 卷一一对应；非 root `USER app`（uid 1000，第 34/52 行）。
- 风险/TODO：① 依赖 `docker:27-cli` 只拷 CLI（第 27 行），需宿主 Docker ≥25 才支持沙箱的 `volume-subpath`；② 最终镜像用 python 底座 + 拷 node 二进制，靠"两个基础镜像同为 bookworm"这一点成立，任一升级都可能断（无自动化验证）。

### `Dockerfile.sandbox` — 20 行
- 作用：`run_command`/`run_python` 的**隔离执行镜像**（只在 `A_SANDBOX=docker` 时用）：`python:3.12-slim-bookworm` + `ripgrep fd-find jq poppler-utils file unzip zip git curl tree procps` + `pandas openpyxl python-docx pypdf`；`USER sandbox`（uid 1000）、`WORKDIR /workspace`、`CMD sleep infinity`。
- 关系：主镜像**不依赖**它，二者只通过"同一个 compose 项目里的 `sandbox-image` 服务 + 同名镜像 tag `a-ai-sandbox:latest`"耦合（`docker-compose.yml:53-61` → `A_SANDBOX_IMAGE`）；运行参数（`--read-only`、`--network none`、`--cap-drop ALL`…）不在 Dockerfile 里，而由 `src/lib/server/sandbox.ts` 在 `docker run` 时给（`docs/学习笔记.md:1337-1340`）。
- 风险/TODO：镜像内无 `gcc`、无 `node`；`PY_PACKAGES` 在**两个 Dockerfile 里都要分别传**（compose 里两处都是 `""`，改一处容易漏另一处）。

### `docker-compose.yml` — 65 行
- 作用：单机部署编排：`name: a-ai` 固定项目名、`a-ai` 服务（`restart: always`、`3000:3000`、`group_add: ${DOCKER_GID:-0}`、卷 `a-ai-data:/app/.data` + `/var/run/docker.sock`、日志 `10m×3`）、`sandbox-image` 服务（只用 `entrypoint: ["true"]` 建镜像）、具名卷 `a-ai-data`。
- 取值理由：固定卷名 `a-ai-data` 让备份命令可写死（第 5、64-65 行）；`A_SANDBOX_DATA_VOLUME: a-ai-data`（第 32 行）让沙箱容器从宿主卷 path 挂子目录，绕过"A.ai 自己也在容器里看不到宿主路径"的限制。
- 风险/TODO：① 挂 `docker.sock` ≈ 宿主机 root（笔记第 1380 行也承认），未加任何前置代理；② 无 `depends_on`，`a-ai` 可能与 `sandbox-image` 并行启动，首批 docker 沙箱命令会失败（笔记第 1530 行明确"不降级，直接报错"）；③ `A_ALLOW_SIGNUP: "1"` 硬编码，忘改就长期开放注册；④ 默认 `group_add` 为 `0`（root 组）。

### `README.md` — 69 行
- 作用：快速上手（`npm install` + `npm run dev`）、接模型步骤、目录树、环境变量表、快捷键。
- 风险/TODO：**明显滞后于代码**（多项，见 §7-2/3/4）：Node 要求写 20+、运行路径写成 `~/cxw/python/A/a-ai`、工具数写 6、"环境变量"只有 3 个、目录树缺 20+ 文件、完全没有 Docker/登录/沙箱章节。

### `docs/学习笔记.md` — **2056 行**（任务书预计约 870 行，实际是它的 2.4 倍）
- 作用：按搭建顺序记录每一步"做了什么/为什么/怎么实现/涉及哪些文件"，兼作面试资料；包含 9 个大步骤 + 30 余条按日期的改动记录 + 3 个专题研究。
- 读法说明：文件名在工具里显示为乱码（`瀛︿範绗旇.md`），read 无法直接打开；本次用 grep `^` 把全文写入 spill 文件后分 6 页读完（spill 共 2059 行 = 1 行统计 + 1 行文件名 + 2056 行正文 + 1 空行）。
- 价值：**它是本项目最准确的"设计理由"来源**——Dockerfile 三个阶段的取舍、SQLite 选型、沙箱三层限制、反馈闭环等都能在此找到成段论证。

---

## 3. 依赖清单

| 包 | 版本 | 用途 | 生产依赖 |
|---|---|---|---|
| `next` | 16.4.2 | 全栈框架（App Router、API route、standalone 输出） | ✅ |
| `react` | 19.3.1 | UI | ✅ |
| `react-dom` | 19.3.1 | UI 渲染 | ✅ |
| `react-markdown` | 10.1.0 | 回答/文档的 Markdown 渲染（配 `remark-gfm`） | ✅ |
| `remark-gfm` | 4.0.1 | GFM 扩展（表格、任务列表、删除线） | ✅ |
| `highlight.js` | 11.11.1 | 代码高亮（只引 `lib/common`，GitHub 配色；笔记行 1683-1692） | ✅ |
| `server-only` | 0.0.1 | 编译期守卫，防止服务端模块被打进客户端包 | ✅ |
| `typescript` | 5.9.3 | 类型检查（`npm run typecheck`） | ❌ dev |
| `@types/node` | 22.20.5 | Node 类型（含 `node:sqlite`） | ❌ dev |
| `@types/react` | 19.3.0 | React 类型 | ❌ dev |
| `@types/react-dom` | 19.3.0 | React DOM 类型 | ❌ dev |

直接依赖仅 11 个；间接（lock 中 163 个）几乎全部来自 `next` + `react-markdown`/`remark` 生态 + 平台可选包。**没有** 数据库驱动、ORM、UI 框架、CSS 框架、测试框架、lint 工具。

---

## 4. 专题：Docker 多阶段构建

### 4.1 三个 stage

| stage | base 镜像 | 关键步骤 | 产物 |
|---|---|---|---|
| `deps` | `node:22-bookworm-slim` | `COPY package.json package-lock.json ./` → `npm ci` | `/app/node_modules` |
| `builder` | `node:22-bookworm-slim` | 先 `COPY --from=deps node_modules`，再 `COPY . .`；`ENV NEXT_TELEMETRY_DISABLED=1`；`mkdir -p public && npm run build` | `.next/standalone`、`.next/static`、`public` |
| `runner` | `python:3.12-slim-bookworm` | 拷 `node` 二进制 + `docker` CLI + `pip install $PY_PACKAGES` + `useradd --uid 1000 app` + 拷 standalone/static/public | 运行镜像 |

### 4.2 缓存与 COPY 顺序（为什么这样排）
- 只 COPY 两个清单文件再 `npm ci` → 改业务代码时该层命中缓存，**不重跑安装**（`docs/学习笔记.md:518`）。
- `package.json`/`package-lock.json` 必须同时更新，否则 `npm ci` 直接失败——笔记里踩过一次（行 1769-1774，"Missing: highlight.js from lock file"）。
- `RUN mkdir -p public` 是为了让后面的 `COPY /app/public` 不因缺目录报错（第 17-18 行注释）。

### 4.3 最终镜像组成与运行
- 入口：`CMD ["node", "server.js"]`（standalone 自带 server）。
- 环境：`NODE_ENV=production`、`PORT=3000`、`HOSTNAME=0.0.0.0`、`A_DATA_DIR=/app/.data`、`PYTHONIOENCODING=utf-8`、`NEXT_TELEMETRY_DISABLED=1`（第 36-41 行）。`HOSTNAME` 必须改成 `0.0.0.0`，否则只监听容器内 localhost（笔记行 526）。
- 用户：`useradd --uid 1000 --create-home app` → `USER app`；`/app/.data` 建好并 `chown app:app`，挂卷时沿用该权限。
- 数据卷：`VOLUME ["/app/.data"]`（第 50 行）；compose 里对应具名卷 `a-ai-data`，容器重建不丢数据。
- 健康检查：`HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3` 用 `node -e "fetch('http://127.0.0.1:3000/login')"`（第 56-57 行）——选 `/login` 是因为它不需要登录态。
- 端口：`EXPOSE 3000`，compose 映射 `3000:3000`（想只给反向代理访问可改 `127.0.0.1:3000:3000`）。

### 4.4 与 `Dockerfile.sandbox` 的关系
- 主镜像给"网站 + agent 循环 + 原生 Python 回退"用；沙箱镜像给"每个会话一条命令"用；两者**共享 uid 1000 约定**与同一个 compose 项目，靠镜像 tag `a-ai-sandbox:latest` 连接。
- 主镜像**只拷 docker CLI**（`COPY --from=docker:27-cli`），不装引擎，通过宿主 `docker.sock` 开"会话容器"。
- 沙箱容器的工作区来自**宿主数据卷的子目录**（`A_SANDBOX_DATA_VOLUME=a-ai-data` + `volume-subpath`，需 Docker 25+）。
- 体积/权限风险：`docker` CLI 单文件就占几十 MB，是最终镜像体积与攻击面的主要来源；`--read-only` + `--cap-drop ALL` 等约束在代码里而非 Dockerfile 里，**改 Dockerfile 不会体现安全边界**。

---

## 5. 专题：环境变量表

| 变量 | 说明 | 默认 | 读取位置 |
|---|---|---|---|
| `A_DATA_DIR` | 数据根目录（`a.db` + 每用户工作区） | `./.data`（`process.cwd()` 下） | `src/lib/server/db.ts:14` |
| `A_WORKSPACE_DIR` | 声称"文件工具与 Python 的工作区" | `./.data/workspace` | **无读取点**（README:62 与 `.env.example:8` 均列，代码不用） |
| `A_PYTHON` | 非沙箱模式下 python 解释器 | `python3` | `src/lib/agent/tools/run-python.ts:45` |
| `A_API_BASE` / `A_API_KEY` / `A_MODEL` | `custom` provider 的直连配置（绕开界面设置） | 空 | `src/lib/llm/providers/custom.ts:26-28` |
| `TAVILY_API_KEY` | web_search 后端优先级 1 | 空 → 退到 Brave | `src/lib/agent/tools/web-search.ts:45,69` |
| `BRAVE_SEARCH_API_KEY` | web_search 后端优先级 2 | 空 → 退到 DuckDuckGo HTML | `src/lib/agent/tools/web-search.ts:47,79` |
| `A_SANDBOX` | 隔离方式：`auto`/`docker`/`seatbelt`/`local` | `auto`（darwin 有 sandbox-exec → seatbelt，否则有镜像 → docker，否则 local） | `src/lib/server/sandbox.ts:76,79` |
| `A_SANDBOX_DIRS` | 授权目录，`;`/换行分隔，`:ro`（默认）/`:rw` | 空 | `src/lib/server/sandbox.ts:57` |
| `A_SANDBOX_NETWORK` | `1` = 沙箱容器可联网 | `0`（断网） | `src/lib/server/sandbox.ts:86` |
| `A_SANDBOX_IMAGE` | 沙箱镜像名 | `a-ai-sandbox:latest` | `src/lib/server/sandbox.ts:79,241` |
| `A_SANDBOX_MEMORY` / `A_SANDBOX_CPUS` | 沙箱容器资源上限 | `1g` / `1` | `src/lib/server/sandbox.ts:340` |
| `A_SANDBOX_DATA_VOLUME` | 数据卷名，供 `volume-subpath` 挂工作区 | 空 | `src/lib/server/sandbox.ts:323` |
| `A_ALLOW_SIGNUP` | `0` = 关闭注册（第一个账号除外） | 允许 | `src/lib/server/auth.ts:54` |
| `TZ` | 沙箱容器时区（compose 设 `Asia/Tokyo`） | 继承 | `src/lib/server/sandbox.ts:131` |
| `DOCKER_GID` | 宿主机 docker 组 GID，透传给 compose `group_add` | `0` | `docker-compose.yml:40` |
| `PY_PACKAGES` | 构建参数：额外 pip 包 | `""` | `Dockerfile:30`、`Dockerfile.sandbox:13`、`docker-compose.yml:13,58` |
| `NODE_ENV`/`PORT`/`HOSTNAME`/`NEXT_TELEMETRY_DISABLED`/`PYTHONIOENCODING` | 容器运行时环境 | 见左 | `Dockerfile:36-41` |

---

## 6. 专题：`docs/学习笔记.md` 分章导读

结构：总纲 → 第 1~7 步（概念与核心代码）→ 7.5~7.32（按日期迭代的功能记录）→ 10 月 24 日杂项记录 → 专题研究 → 练习/面试/术语。

| 行号 | 章节 | 一句话 |
|---|---|---|
| 1 | `# A.ai 学习笔记` | 按搭建顺序讲"做了什么、为什么、对应哪个 agent 概念"。 |
| 8 | `## 0. 先建立全局图` | agent 的三层（模型层/Agent 层/界面层）与"循环调工具"的本质。 |
| 30 | `## 第 1 步：技术选型` | 六条选型理由：Next 全栈、TS、SSE、JSON→SQLite、standalone。 |
| 42 | `## 第 2 步：定义模型接口` | OpenAI 消息格式、`StreamChunk` 四类块、`LLMProvider` 适配器、Mock 的意义。 |
| 98 | `## 第 3 步：工具系统` | 工具 = spec + run；注册表；工具错误回喂模型实现自我纠错。 |
| 133 | `## 第 4 步：Agent 主循环` | ReAct 五步循环、`MAX_STEPS`、`AbortSignal`、每步落库。 |
| 161 | `## 第 5 步：把循环变成 HTTP 接口` | `ReadableStream` 手写 SSE，前后端共用 `AgentEvent` 类型。 |
| 175 | `## 第 6 步：前端如何实时显示链路` | SSE 读取、事件→状态 `apply()`、`Trace` 折叠交互、右侧输出卡片、3D 动画、三栏分层。 |
| 263 | `## 第 7 步：会话持久化` | 早期"一会话一 JSON + 原子写 + id 正则校验"，并注明已被 SQLite 取代。 |
| 272 | `## 第 7.5 步：接入真实模型（DeepSeek）` | OpenAI 兼容 provider、Key 只存服务端/回显打码、流式工具调用拼装、上下文占用算法。 |
| 298 | `## 第 7.6 步：怎么加强 agent 的工具调用` | 10 条改进按性价比排序；已完成"说明书写好/提示词/受限并行（`parallelSafe`+`toBatches`）"。 |
| 333 | `## 第 7.7 步：界面打磨记录` | 参数流式显示（`tool_call_delta` + `parsePartial`）、左栏重做、拖拽分组、悬浮左栏。 |
| 396 | `## 第 7.8 步：登录 + SQLite + 按用户隔离` | 迁移到 `a.db`、Cookie+sha256 token、每个查询带 `user_id`、404 代替 403、升级时旧数据继承。 |
| 490 | `## 第 7.9 步：用 Docker 部署到 Linux 服务器` | 三阶段构建的理由、数据卷、`HOSTNAME=0.0.0.0`、HEALTHCHECK、备份命令。 |
| 570 | `## 第 7.10 步：介绍页和新的地址结构` | `/A.ai`、`/A.ai/chat/[user]/[[...id]]` 路由设计与"地址里的用户名不是凭证"。 |
| 608 | `## 第 7.11 步：黑白粒子 logo 和重做的介绍页` | 斐波那契球面撒点、深度提示、噪声突变；`:has()` 滚动修复。 |
| 666 | `## 第 7.12 步：透明玻璃球 logo、输入框和按钮、写代码时可折叠` | 稀疏粒子球变体、`@property` 做角度动画、展开状态提升到父组件。 |
| 690 | `## 第 7.13 步：新对话的欢迎页（输入框居中）` | 用 `is-empty` 类改 flex 比例而非搬 DOM；问候语必须 `useEffect` 里算防 hydration mismatch。 |
| 712 | `## 第 7.14 步：写代码时页面不再往下跑；右侧任务面板` | `overflow-anchor: none` 关滚动锚定；任务面板三段式；拖动调宽存 localStorage。 |
| 745 | `## 第 7.15 步：反馈闭环和长期记忆` | `Verifier` 护栏（跑不通就打回模型）、步数预算、`memories` 表 + 后台反思（Reflexion）。 |
| 883 | `## 第 7.16 步（界面细节）：思维链字号调小` | 只改 CSS：整体压到 12px，唯独代码引用放大加粗形成对比。 |
| 902 | `## 第 7.17 步：任务面板改成悬浮卡片` | 悬停 peek、点外面关闭、`Sec` 组件必须定义在组件外、`hasFiles` 用 `EXISTS` 子查询。 |
| 930 | `## 第 7.18 步：欢迎页 logo 换稀疏粒子球` | `morph={false}` 只自转；favicon 不能用 `currentColor` 的原因。 |
| 946 | `## 第 7.19 步：设置弹窗重做` | 弹窗 1040×760、对话宽度/字号写 `<html data-*>`、系统提示词移到记忆页。 |
| 976 | `## 第 7.20 步：介绍页重做、粒子球"碎裂—融合"` | Voronoi 分片、罗德里格斯旋转、`mulberry32` 可复现随机、逐字变清楚的宣言。 |
| 1010 | `## 第 7.21 步：粒子球"流散—融合"` | 性能优化：绘制调用从上千降到 10 次、`sin²(πx)` 缓动、成缕飘散。 |
| 1043 | `## 第 7.22 步：终端工具 run_command` | 命令分级、进程组 kill、HeadTail 截断、cd 保留（fd 3）、`live` 队列实时输出、确认卡片的 Promise 挂起。 |
| 1110 | `## 第 7.23 步：新对话输入框大而宽` | `useLayoutEffect` + 把 `isEmpty` 加入依赖修高度残留。 |
| 1127 | `## 第 7.24 步：工具扩充（glob/grep/edit_file/todo_write/web_search）` | 9→14 工具、默认步数 8→25、设置 `version` 字段做最小迁移、`edit_file` 唯一性校验、多后端搜索。 |
| 1241 | `## 第 7.25 步：欢迎页粒子球再放大` | 只改 `size`，点半径按比例缩放。 |
| 1247 | `## 第 7.26 步：介绍页科技感 + 登录页重做` | 单一时间轴 `t` 驱动的连贯动画、边框追光 `mask-composite`、逐字标题。 |
| 1308 | `## 第 7.27 步：终端沙箱——授权目录、限制与审计` | 三层限制（路径检查/用户确认/系统隔离）、docker 与 seatbelt 规则、`audit_log`。 |
| 1383 | `## 第 7.28 步：ask_user 与运行中补充想法` | 两种交互与两种等待方式（结束本轮 vs 同步 await）的取舍；`endsTurn`。 |
| 1489 | `## 第 7.29 步：行内代码统一蓝色、思维链 Markdown` | 设计令牌 `--code-fg`、`0.88em` 相对字号。 |
| 1505 | `## 第 7.30 步：命令确认改成输入框上方弹窗` | `ApprovalDock` 订阅 `live` store；`explainDocker` 把英文报错翻成人话；**Docker 坏了不偷偷降级**。 |
| 1549 | `## 第 7.31 步（修 bug）：参数不是合法 JSON` | 流式 `index` 重复导致两个调用被拼成一个；新增 `args.ts` 宽容解析 + 规范化后再落库。 |
| 1579 | `## 第 7.32 步：停止按钮描边款、去掉回答里横线` | 组件级 CSS（`ChatPane.css`）叠层覆盖 `globals.css`。 |
| 1585-1820 | `## 2026-10-24 …` 共 10 节 | 登录页改回居中卡片、SVG 动画用沙箱 iframe、左栏"分组/项目"拆分、代码高亮与 diff、整体对比、文件名可点、面板状态记忆、两次 Docker 构建修复、任务面板钉住、logo 换 Manrope。 |
| 1839 | `## 专题研究` | 三个专题的引言。 |
| 1843 | `### 专题 1：本地模型输出太快时过程显示出问题` | 按帧合并/节流/`ThinkSplitter`/收起不渲染；渲染频率才是瓶颈。 |
| 1879 | `### 专题 2：过程显示的交互方式` | 默认收起、代码完整展开、页面不跟随、"回到底部"按钮。 |
| 1896 | `### 专题 3：对话应该怎么存储` | 多租户隔离、表结构、SQLite vs PostgreSQL、主流产品对比（含 OpenAI 公开资料）。 |
| 2014 | `## 第 8 步：建议你亲手做的练习` | 8 个从 provider 到评测的练习。 |
| 2027 | `## 第 9 步：面试常见问题` | 8 个高频问题 → 指向具体代码。 |
| 2042 | `## 附：常用术语（中/英）` | 11 组术语对照。 |

### 6.1 笔记里明确写的"已知限制 / 未完成事项"
1. **`run_python`/`run_command` 在非 docker 模式下不是真隔离**：多用户服务器上 Python 用绝对路径仍能读到 `a.db` 和别人的工作区（行 483、1096、2003）。
2. **敏感文件只靠第 1 层字符串检查**：docker 模式下若授权目录里放了 `.env`，换写法仍可能读到——"别把放密钥的目录授权出去"（行 1379）。
3. **能访问 `docker.sock` ≈ 宿主机 root**，A.ai 不能不加防护放公网（行 1380、compose:44）。
4. **seatbelt 规则未在 Mac 上实测**（只在 Linux 上写的，行 1381）。
5. **Docker 挂了不自动降级**，直接失败并提示原因（行 1529-1536）。
6. **命令结束后的输出不再区分 stderr 颜色**；cd 与"本会话都允许"只在内存里，重启即失效（行 1097-1098）。
7. **反思（长期记忆）的 token 未计入用量页**（行 878）。
8. **`web_search` 默认走 DuckDuckGo HTML，可能被限流**（行 1227）。
9. **未做**：后台常驻命令、上下文压缩、消息树结构（`parent_id`）、改密码/管理员/找回密码、OAuth 登录（行 485-487、1228）。
10. **工具数变化要手工同步**介绍页状态行/跑马灯/数字条（行 1307）。
11. 介绍页"项目"区只做输入名字，**刷新即丢**（行 1653）。

---

## 7. 不一致清单（README / 笔记 / 配置 vs 现实代码）

| # | 不一致或风险 | 证据 | 影响 / 建议 |
|---|---|---|---|
| 1 | `dockerignore` **缺前导点**，Docker 不读；`COPY . .` 会带进 `node_modules`、`.data`（含 settings）、`.git` | 根目录文件列表只有 `dockerignore`；其第 11 行写的是 `.dockerignore`；`Dockerfile:15` | **高危**：镜像构建可能因 Windows 平台二进制失败，且隐私数据进构建缓存。改名即可 |
| 2 | README 说 Node 20+ | `README.md:13` vs `package.json:27`（`>=22.13`）、`Dockerfile:7`（node:22） | 按 README 装 Node 20 会因 `node:sqlite` 缺失/需 flag 而崩 |
| 3 | README 运行路径 `~/cxw/python/A/a-ai` | `README.md:8`；实际 `E:\cxw\projects\A\a-ai` | 复制粘贴即失败 |
| 4 | 工具数量三种说法 | `README.md:14`（6 个）、笔记 `:109`（8 个标题）、笔记 `:1141`（14 个） | 文档互斥；代码侧以 `src/lib/agent/tools/index.ts` 为准 |
| 5 | README 目录树严重滞后 | `README.md:27-55`：缺 `openai-compatible.ts`、`CoreLogo/Intro/SvgFrame/ApprovalDock/AskCard/SandboxPane/Code` 等；缺 15 个 API 路由；无 Docker/登录/沙箱章节 | 与"接手者先读 README"的预期冲突 |
| 6 | 环境变量文档缺项 | `.env.example` 未含 `A_ALLOW_SIGNUP`（`auth.ts:54`）、`A_SANDBOX_DATA_VOLUME`（`sandbox.ts:323`）、`A_API_BASE/A_API_KEY/A_MODEL`（`custom.ts:26-28`）；README 只列 3 个 | 部署者无法从文档得知这些开关 |
| 7 | `A_WORKSPACE_DIR` 是死配置 | `.env.example:8`、`README.md:62` 有；`src/` 内无 `process.env.A_WORKSPACE_DIR` | 设了不生效（工作区实际在 `DATA_DIR/users/<id>/workspace/`） |
| 8 | 磁盘上的 `.data` 仍是迁移前布局 | 有 `settings.json`/`groups.json`/`sessions/*.json`，**无 `a.db`**；笔记 `:405-407` 说已切 SQLite 并把旧文件改名 `*.imported` | 当前代码若首次启动会发生一次 legacy 迁移；排查数据问题须先弄清是哪个版本的数据 |
| 9 | `settings.json` 字段落后于代码 | `.data/settings.json:1-30` 有 `maxSteps: 30`、`connections[]`，**无 `version`/`chatWidth`/`fontSize`/`memory`/`maxFixRounds`/`commandApproval`** | 属 7.15/7.19/7.22/7.24 之前的结构；`maxSteps` 已是用户自选值，别被"迁移到 25"的规则误改 |
| 10 | `groups.json` 有悬空映射 | `assign` 指向 `smvidejcj7jxyex`，但 `.data/sessions/` 只有 `smviciirh9014qe.json` | 症状轻微（`lib/server/groups.ts` 有清理逻辑），但可作为"数据已过期"的旁证 |
| 11 | 存在两套 auth 路由 | `src/app/auth/{login,register,logout}/route.ts`（挂在 `/auth/...`）与 `src/app/api/auth/...` 并存；客户端只调 `/api/auth/*`（`src/lib/client.ts:76`） | 疑似遗留/重复路由，增加维护面 |
| 12 | compose 无 `depends_on` | `docker-compose.yml:8-61` | 首次 `up -d --build` 时 `a-ai` 可能先于沙箱镜像可用，docker 沙箱首条命令失败（且按设计不降级） |
| 13 | 安全默认值偏松 | `A_ALLOW_SIGNUP: "1"`（compose:22）、`group_add: ${DOCKER_GID:-0}`（compose:40）、docker.sock 直挂（compose:45） | 公网部署前必须显式收紧 |
| 14 | 镜像体积/版本耦合 | `Dockerfile:25,27` 从两个镜像拷 `node` 与 `docker` 二进制，靠"同为 bookworm + Docker ≥25"成立 | 基础镜像或宿主 Docker 升级即可能断；`docker` CLI 是体积大头 |
| 15 | 笔记自身有陈旧章节 | `docs/学习笔记.md:109` 的"已注册的 8 个工具"标题、`:497` 提到的 `.dockerignore`、任务书预计 870 行而实际 2056 行 | 读笔记时要按时间线判断哪一节已过时 |
| 16 | 无 lint/test 门禁 | `package.json:5-10` 只有 dev/build/start/typecheck | 回归风险靠 `tsc` + 人工；`.idea` 里 ESLint inspection 开着但 CI 没有 |