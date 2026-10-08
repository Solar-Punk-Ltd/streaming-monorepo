# Builds the console and serves it (plus reverse-proxies /api) via nginx.
# Build context is apps/web2-admin:
#   docker build -f frontend/Dockerfile -t web2-admin-frontend .

FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /repo
# pnpm comes from the root package.json's `packageManager` field via corepack;
# the prompt has to be off or the non-interactive build stalls on it.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Workspace manifests first so the install layer caches when sources change.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY common/package.json ./common/
COPY frontend/package.json ./frontend/
# The repository's shared packages the admin links, where the cut carries them. See tools/app-workspace.
COPY workspace-packages/contracts/package.json ./workspace-packages/contracts/
COPY workspace-packages/web-auth/package.json ./workspace-packages/web-auth/

RUN pnpm install --frozen-lockfile \
      --filter @streaming-monorepo/web2-admin-frontend... \
      --filter @streaming-monorepo/web2-admin-common...

COPY workspace-packages/contracts ./workspace-packages/contracts
COPY workspace-packages/web-auth ./workspace-packages/web-auth
COPY common ./common
COPY frontend ./frontend

RUN pnpm --filter @streaming-monorepo/web2-admin-frontend build

# --- runtime stage ----------------------------------------------------------
FROM nginx:1.30.4-alpine@sha256:dc5069ad14f19660b141b21236140b91656bf89bbc3e2417c70ae650cd66104c
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/frontend/dist /usr/share/nginx/html

EXPOSE 80

# The build this image is, as labels only: the console reads the version from the API, which carries it. Last in the
# image, so a new version changes no layer above. See backend/Dockerfile.
ARG WEB2_ADMIN_VERSION=""
ARG WEB2_ADMIN_COMMIT=""
LABEL org.opencontainers.image.version=$WEB2_ADMIN_VERSION \
      org.opencontainers.image.revision=$WEB2_ADMIN_COMMIT
