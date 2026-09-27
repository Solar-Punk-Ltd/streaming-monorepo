# web2-admin backend image. Build context is apps/web2-admin:
#
#   docker build -f backend/Dockerfile .
#
# Two stages, as in streaming-infra-manager: install + build the workspace,
# then `pnpm deploy` a self-contained prod tree into the runtime image.
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /repo
# pnpm comes from the root package.json's `packageManager` field via corepack;
# the prompt has to be off or the non-interactive build stalls on it.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Workspace manifests first so the install layer caches when sources change.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY common/package.json ./common/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

RUN pnpm install --frozen-lockfile --filter @streaming-monorepo/web2-admin-backend...

COPY common ./common
COPY backend ./backend

RUN pnpm --filter @streaming-monorepo/web2-admin-backend... build

# Produces a self-contained tree at /out with prod node_modules + dist.
#
# --legacy because pnpm 10 refuses to deploy from a workspace that does not
# inject its workspace packages, and this image had never been built since the
# workspace moved to pnpm 10. The manager sets injectWorkspacePackages in its
# pnpm-workspace.yaml instead; doing that here would rewrite the lockfile and
# turn the dev-time link to common into a copy, for the sake of one image.
RUN pnpm deploy --legacy --filter=@streaming-monorepo/web2-admin-backend --prod /out

# --- runtime stage ----------------------------------------------------------
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app

COPY --from=build /out ./

ENV NODE_ENV=production
EXPOSE 9877
CMD ["node", "dist/index.js"]
