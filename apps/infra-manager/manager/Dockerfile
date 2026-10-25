# Manager API image.
#
# The stack is not in this image. The api builds each version, the bundled one
# included, under the versions root on the host, which docker-compose.yml
# mounts at the same absolute path on both sides. The api shells out to
# `docker compose ... up` against compose files in that tree, and the daemon on
# the host resolves their relative volumes against the host filesystem, so the
# paths must match.
#
# The stack is not built here, and deploy/deploy.sh does not build it either.
# The deploy writes the pinned commit into manager/.stack-commit, and the api
# builds that commit on the host under the versions root at boot
# (StackVersionService.ensureBundledBuild).

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /repo
RUN corepack enable

# Workspace manifests first so the install layer caches when sources change.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY common/package.json ./common/
COPY manager/package.json ./manager/
COPY frontend/package.json ./frontend/
# The repository's shared packages the manager links, where the cut carries them. See tools/app-workspace.
COPY workspace-packages/contracts/package.json ./workspace-packages/contracts/
COPY workspace-packages/db-migrate/package.json ./workspace-packages/db-migrate/
COPY workspace-packages/web-auth/package.json ./workspace-packages/web-auth/

RUN pnpm install --frozen-lockfile --filter @streaming-infra-manager/api...

COPY workspace-packages/contracts ./workspace-packages/contracts
COPY workspace-packages/db-migrate ./workspace-packages/db-migrate
COPY workspace-packages/web-auth ./workspace-packages/web-auth
COPY common ./common
COPY manager ./manager

RUN pnpm --filter @streaming-infra-manager/api... build

# Produces a self-contained tree at /out with prod node_modules + dist.
RUN pnpm deploy --filter=@streaming-infra-manager/api --prod /out

# --- runtime stage ----------------------------------------------------------
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
WORKDIR /app

# git is for manager/scripts/stack-version-build.sh, which clones and updates
# the checkout of every added stack version.
#
# The Compose plugin is pinned. The deploy scripts run docker compose from
# inside this container, so this is the Compose that decides how a container
# is created from an image tag, and the shared image race the deploy guard
# closes was verified against exactly this version (the host's api container
# was read at Compose v5.1.4 on 2026-09-07). An Alpine revision bump of the
# same version is a deliberate edit here, never a silent move.
RUN apk add --no-cache \
      bash jq git \
      docker-cli docker-cli-compose=5.1.4-r2 \
      rsync openssh-client \
      ca-certificates

# The ssh identity for deployments on other hosts is a directory the host mounts
# at /root/.ssh, and the ssh_config in it is read through this link as the
# system-wide config, because ssh refuses a per-user config file another uid
# owns. A host with no such file leaves the link pointing at nothing, which ssh
# treats as no config, so a manager that deploys only to itself prepares nothing.
RUN ln -sf /root/.ssh/ssh_config /etc/ssh/ssh_config

COPY --from=build /out ./
# Copied explicitly rather than left to what `pnpm deploy` decides to pack: a
# missing build script is a Versions page that fails on its first Add, at
# runtime, on the host.
COPY manager/scripts ./scripts

ENV NODE_ENV=production
# A shared package's default entry is its TypeScript source, which node does not load from node_modules. This
# condition points every node process here, the CLI included, at the compiled copy.
ENV NODE_OPTIONS=--conditions=compiled
EXPOSE 9876

# The build this image is: the label tools/release/version.mjs named the deployed commit with, and that commit.
# deploy/deploy.sh hands both in through docker-compose.yml's build arguments, and the api answers them to a
# signed-in console from its environment, so a container keeps reporting the build it was started from until it
# is replaced. Empty without them, which the api reports as a development build. Last in the file, so a new
# version reuses every layer above.
ARG MANAGER_VERSION=
ARG MANAGER_COMMIT=
LABEL org.opencontainers.image.version="${MANAGER_VERSION}" \
      org.opencontainers.image.revision="${MANAGER_COMMIT}"
ENV MANAGER_VERSION=${MANAGER_VERSION} \
    MANAGER_COMMIT=${MANAGER_COMMIT}
CMD ["node", "dist/index.js"]
