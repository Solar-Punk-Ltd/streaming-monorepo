# Builds the React SPA and serves it (plus reverse-proxies API calls) via nginx.
# Used on the deploy server — devs reach it through an SSH tunnel to port 8080.

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /repo
# The pnpm the root package.json names in packageManager, as manager/Dockerfile
# takes it. A pnpm of another major reads the lockfile's settings from another
# place: pnpm 9 never sees the overrides in pnpm-workspace.yaml and refuses the
# frozen install.
RUN corepack enable

# Workspace manifests first so the install layer caches when sources change.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY common/package.json ./common/
COPY frontend/package.json ./frontend/
COPY manager/package.json ./manager/
# The repository's shared packages the manager links, where the cut carries them. See tools/app-workspace.
COPY workspace-packages/contracts/package.json ./workspace-packages/contracts/
COPY workspace-packages/web-auth/package.json ./workspace-packages/web-auth/

RUN pnpm install --frozen-lockfile \
      --filter @streaming-infra-manager/frontend-prototype... \
      --filter @streaming-infra-manager/common...

COPY workspace-packages/contracts ./workspace-packages/contracts
COPY workspace-packages/web-auth ./workspace-packages/web-auth
COPY common ./common
COPY frontend ./frontend

RUN pnpm --filter @streaming-infra-manager/frontend-prototype build

# --- runtime stage ----------------------------------------------------------
FROM nginx:1.30.6-alpine@sha256:47928bf67eb62a1863cb08d9ecb52d3e704304ba614eaee17884204677702951
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/frontend/dist /usr/share/nginx/html

EXPOSE 80
