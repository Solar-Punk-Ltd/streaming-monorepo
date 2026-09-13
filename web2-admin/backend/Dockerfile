# web2-admin backend image. Build context is the repository root:
#
#   docker build -f web2-admin/backend/Dockerfile .
#
# Two stages, as in streaming-infra-manager: install + build the workspace,
# then `pnpm deploy` a self-contained prod tree into the runtime image.
FROM node:22-alpine AS build
WORKDIR /repo
# pnpm comes from the root package.json's `packageManager` field via corepack;
# the prompt has to be off or the non-interactive build stalls on it.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Workspace manifests first so the install layer caches when sources change.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY web2-admin/common/package.json ./web2-admin/common/
COPY web2-admin/backend/package.json ./web2-admin/backend/
COPY web2-admin/frontend/package.json ./web2-admin/frontend/

RUN pnpm install --frozen-lockfile --filter @streaming-monorepo/web2-admin-backend...

COPY web2-admin/common ./web2-admin/common
COPY web2-admin/backend ./web2-admin/backend

RUN pnpm --filter @streaming-monorepo/web2-admin-backend... build

# Produces a self-contained tree at /out with prod node_modules + dist.
RUN pnpm deploy --filter=@streaming-monorepo/web2-admin-backend --prod /out

# --- runtime stage ----------------------------------------------------------
FROM node:22-alpine
WORKDIR /app

COPY --from=build /out ./

ENV NODE_ENV=production
EXPOSE 9877
CMD ["node", "dist/index.js"]
