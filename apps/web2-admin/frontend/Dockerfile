# Builds the console and serves it (plus reverse-proxies /api) via nginx.
# Build context is apps/web2-admin:
#   docker build -f frontend/Dockerfile -t web2-admin-frontend .

FROM node:22-alpine AS build
WORKDIR /repo
# pnpm comes from the root package.json's `packageManager` field via corepack;
# the prompt has to be off or the non-interactive build stalls on it.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Workspace manifests first so the install layer caches when sources change.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY common/package.json ./common/
COPY frontend/package.json ./frontend/

RUN pnpm install --frozen-lockfile \
      --filter @streaming-monorepo/web2-admin-frontend... \
      --filter @streaming-monorepo/web2-admin-common...

COPY common ./common
COPY frontend ./frontend

RUN pnpm --filter @streaming-monorepo/web2-admin-frontend build

# --- runtime stage ----------------------------------------------------------
FROM nginx:1.27-alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/frontend/dist /usr/share/nginx/html

EXPOSE 80
