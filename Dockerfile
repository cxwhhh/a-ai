# A.ai 的 Docker 镜像：多阶段构建
#   第 1 阶段 deps    ：只装 npm 依赖（package.json 不变时这一层走缓存，重建很快）
#   第 2 阶段 builder ：next build，产出 .next/standalone（自带精简 node_modules 的服务器）
#   第 3 阶段 runner  ：最终镜像 = Python 镜像 + node 可执行文件 + standalone 产物
# node:sqlite 需要 Node 22.13+，node:22 系列镜像已满足。

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# npm 镜像站：服务器在国内时官方 registry.npmjs.org 很慢，npm ci 会卡住。默认值在 docker-compose.yml（npmmirror），
# 可以在 .env 里用 NPM_REGISTRY=… 换掉；不传或传空 = 官方源。
# package-lock.json 里记的下载地址是 registry.npmjs.org，npm 10 会自动换成这里设置的源（replace-registry-host 默认行为），不用改 lock 文件
ARG NPM_REGISTRY=""
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
 && npm ci --no-audit --no-fund

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# 项目可能没有 public/ 目录，先建一个，后面 COPY 才不会报错
RUN mkdir -p public && npm run build

# 最终镜像以官方 Python 镜像为底，再把 Node 可执行文件拷进来：
#   - run_python 直接有 Python 3.12 和 pip，不用 apt
#   - 两个镜像都是 Debian bookworm，node 依赖的系统库（libstdc++ 等）都有
FROM python:3.12-slim-bookworm AS runner
WORKDIR /app
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
# docker 命令行：run_command / run_python 的 docker 沙箱模式要用它去开“会话容器”（只拷可执行文件，不装 Docker 引擎）
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker

# 想让 agent 的 run_python 能用第三方库，构建时传入包名（docker-compose.yml 里的 PY_PACKAGES）
# pip 镜像站同上：PIP_INDEX_URL 默认在 docker-compose.yml 里设成清华源
ARG PY_PACKAGES=""
ARG PIP_INDEX_URL=""
RUN if [ -n "$PY_PACKAGES" ]; then pip install --no-cache-dir ${PIP_INDEX_URL:+-i $PIP_INDEX_URL} $PY_PACKAGES; fi

# 不用 root 跑：建一个 uid 1000 的普通用户 app
RUN useradd --uid 1000 --create-home app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    A_DATA_DIR=/app/.data \
    PYTHONIOENCODING=utf-8

# standalone 目录里有 server.js 和它真正用到的 node_modules；静态文件要另外拷
COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static
COPY --from=builder --chown=app:app /app/public ./public

# 数据目录先建好并交给 app 用户，挂载数据卷时会沿用这个权限
RUN mkdir -p /app/.data && chown app:app /app/.data
VOLUME ["/app/.data"]

USER app
EXPOSE 3000

# 每 30 秒看一次服务还活着没（/login 不需要登录就能打开）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
