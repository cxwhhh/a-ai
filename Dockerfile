# Web 和桌面使用同一服务与 Vite 产物。依赖采用可移植的生产目录。
FROM node:22-bookworm-slim AS builder
WORKDIR /app
ARG NPM_REGISTRY=""
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN corepack enable
COPY . .
RUN if [ -n "$NPM_REGISTRY" ]; then export pnpm_config_registry="$NPM_REGISTRY"; fi \
 && pnpm install --frozen-lockfile \
 && pnpm build \
 && pnpm --config.node-linker=hoisted --filter @a-ai/server deploy --prod --legacy /runtime \
 && cp -a dist/server/. /runtime/

FROM python:3.12-slim-bookworm AS runner
WORKDIR /app
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker

ARG PY_PACKAGES=""
ARG PIP_INDEX_URL=""
RUN if [ -n "$PY_PACKAGES" ]; then pip install --no-cache-dir ${PIP_INDEX_URL:+-i $PIP_INDEX_URL} $PY_PACKAGES; fi
RUN useradd --uid 1000 --create-home app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    A_DATA_DIR=/app/.data \
    PYTHONIOENCODING=utf-8
COPY --from=builder --chown=app:app /runtime ./
RUN mkdir -p /app/.data && chown app:app /app/.data
VOLUME ["/app/.data"]
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
