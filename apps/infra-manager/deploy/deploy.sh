#!/usr/bin/env bash
# Deploy the streaming-infra-manager to a server via rsync + remote build.
#
#   ./deploy/deploy.sh [ssh-target]
#
# ssh-target defaults to `viewer` (configure in ~/.ssh/config). Example:
#   Host viewer
#     HostName <ip>
#     User solarpunk
#     LocalForward 8080 localhost:8080
#
# What it does:
#   1. Writes the stack pin into manager/.stack-commit: the last commit that
#      changed apps/hls-stream, the stack this manager bundles, which holds the
#      same stack tree as the commit being deployed. So a deploy that changes
#      only the manager finds the bundled build the host already has, keeps
#      its Tested mark and builds nothing. That file is the only thing about
#      the streaming stack a deploy carries. The host fetches that commit from
#      GitHub and builds its apps/hls-stream there if it has no complete build
#      of it, through the same path a version added in the UI takes.
#   2. rsyncs the repo to /home/solarpunk/streaming-infra-manager, without
#      manager/swarm-hls-stream: the tree the engines of existing deployments
#      mount is never written over again, so a container restart keeps the
#      files it was started with. Excludes node_modules, build caches and
#      .git. The manager's .env DOES ship, and --delete means this checkout
#      is the only source of truth for it.
#   3. Builds the images on the server, decides there whether this host has
#      ever run the manager, and then runs `manager:upgrade` in a one-off
#      container of the image just built. The first use question is answered
#      before that container exists, because preparing it can create the
#      project's volumes, and it stops the deploy when the data volume is gone
#      from under an installed manager. The command owns the rest:
#      it holds one directory for the whole run so a second upgrade cannot
#      start beside it, stops the old api, migrates, starts the project, waits
#      for the api to answer, and then waits for the api's own boot to finish
#      building the pinned stack commit. With MANAGER_DOMAIN set the upgrade is
#      asked for the public TLS edge, and without it the edge is removed by name
#      and the removal is checked, because dropping a profile does not stop a
#      container already running under it.
#
# The streaming stack's own settings live on the server, under the versions
# root, and no deploy reads or writes them. See deploy/README.md.

set -euo pipefail

SSH_TARGET="${1:-viewer}"
# It is handed to ssh as the destination, where a leading dash is an option.
if [[ "$SSH_TARGET" == -* ]]; then
    echo "ERROR: the ssh target must not start with a dash (got: $SSH_TARGET)" >&2
    exit 1
fi
REMOTE_PATH="/home/solarpunk/streaming-infra-manager"
# How long the upgrade waits for the host to fetch and build the pinned stack
# commit before it reports a failure. A first build on a cold host pulls the
# node image and installs the whole workspace.
BUNDLED_TIMEOUT="${BUNDLED_TIMEOUT:-1200}"
# It is interpolated into a single quoted word of the remote heredoc, so a
# value carrying a quote would close that quoting on the host.
if ! [[ "$BUNDLED_TIMEOUT" =~ ^[0-9]+$ ]]; then
    echo "ERROR: BUNDLED_TIMEOUT must be a whole number of seconds (got: $BUNDLED_TIMEOUT)" >&2
    exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Checking manager/.env"
ENV_FILE="manager/.env"
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE not found. Copy manager/.env.sample and fill in the required values." >&2
    exit 1
fi
if ! grep -q "POSTGRES_PASSWORD=.\+" "$ENV_FILE"; then
    echo "ERROR: POSTGRES_PASSWORD is missing or empty in $ENV_FILE." >&2
    exit 1
fi

# Compose trims the same value on the server and strips one pair of quotes, so
# a value like MANAGER_DOMAIN="manager.example.org" is a plain name to it. Trailing whitespace or a
# carriage return left the name looking set here, this script reporting success,
# and the edge restarting forever on an empty site address. Trim it the way
# Compose will, and refuse a name Caddy could not ask for a certificate for
# rather than finding out from the edge's logs.
MANAGER_DOMAIN="$(
    sed -n 's/^MANAGER_DOMAIN=//p' "$ENV_FILE" |
        tail -n 1 |
        tr -d '\r' |
        tr '[:upper:]' '[:lower:]' |
        sed 's/^[[:space:]]*//; s/[[:space:]]*$//' |
        sed -E 's/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
)"
HOSTNAME_PATTERN='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'

if [ -z "$MANAGER_DOMAIN" ]; then
    PUBLIC_EDGE_FLAG=""
    echo "==> MANAGER_DOMAIN is empty: no public edge, SSH tunnel only"
elif [[ "$MANAGER_DOMAIN" =~ $HOSTNAME_PATTERN ]]; then
    PUBLIC_EDGE_FLAG="--public-edge"
    echo "==> MANAGER_DOMAIN=${MANAGER_DOMAIN}: starting the public HTTPS edge too"
else
    echo "ERROR: MANAGER_DOMAIN in $ENV_FILE is not a host name: '${MANAGER_DOMAIN}'." >&2
    echo "Give it a dotted name with an A record on this host, such as" >&2
    echo "manager.example.org, or leave it empty for the SSH tunnel only." >&2
    exit 1
fi

echo "==> Recording the stack commit this manager pins"
# The commit being deployed is what the upgrade records as the manager it
# installed. The pin is the last commit that changed apps/hls-stream, the stack
# this manager bundles, which holds the same stack tree as the deployed commit.
# So a deploy that changes only the manager finds the bundled build the host
# already has, keeps its Tested mark and builds nothing. The host reads this file
# at boot and builds the pin if it has no complete build of it, which is why the
# file sits next to the tree the host keeps and is never committed.
MANAGER_COMMIT="$(git rev-parse HEAD)"
# The host fetches this commit from GitHub by its name, so one only this
# machine has would replace the manager and then fail its bundled build. A
# remote branch that holds it is the answer that needs no network. A commit
# pushed from elsewhere that this checkout has not fetched is refused too, and
# a git fetch settles that.
PUSHED_IN="$(git branch -r --contains "$MANAGER_COMMIT")"
if [ -z "$PUSHED_IN" ]; then
    echo "ERROR: no remote branch holds $MANAGER_COMMIT, the commit being deployed. The host fetches it from GitHub to build the stack it bundles, so push it first, or git fetch if it is pushed already." >&2
    exit 1
fi
# The host fetches the pin from the monorepo with no login at all. A repository it
# cannot read that way would let the upgrade stop the old api and migrate the
# database before the bundled build fails, so it is asked the same way here first:
# no credential helper, no prompt, and none of this machine's git configuration,
# which could hold a helper or rewrite the address. The address is the manager's
# MONOREPO_STACK_SOURCE, and a test holds the two to each other.
STACK_REPO_URL="https://github.com/Solar-Punk-Ltd/streaming-monorepo.git"
if ! GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    git -c credential.helper= ls-remote "$STACK_REPO_URL" HEAD > /dev/null 2>&1; then
    echo "ERROR: $STACK_REPO_URL does not answer without a login, and the host fetches the stack from it that way. Deploy once the repository can be read anonymously, which it can once it is public." >&2
    exit 1
fi
# An ancestor of the deployed commit, which a remote branch holds, so the host
# can fetch it too. :(top) reads the path from the repository root, wherever
# this script runs from.
STACK_COMMIT="$(git rev-list -1 HEAD -- ':(top)apps/hls-stream')"
printf '%s\n' "$STACK_COMMIT" > manager/.stack-commit
echo "[deploy] pinned stack commit: $(cat manager/.stack-commit)"

# A digest of the manager's tree at that commit, listed from this folder, so it
# covers the manager alone and none of the rest of the repository.
MANAGER_DIGEST="$(git ls-tree -r HEAD | shasum -a 256 | cut -c1-64)"

# The images build on the host from this folder and read pnpm-lock.yaml and
# pnpm-workspace.yaml at its root. A checkout of the one workspace holds them
# only at the repository root, so the manager's own pair is cut out of the
# root's by tools/app-workspace into a folder under TMPDIR, removed when this
# script exits however it exits, and given to the one rsync as a second source:
# the pair lands where the manager's own went, and --delete keeps it. A checkout
# whose manager keeps its own pair ships it as it always did. The empty second
# source expands to nothing under set -u in bash 3.2 through the + form.
CUT_SOURCE=()
WORKSPACE_ROOT="$(git rev-parse --show-toplevel)"
if [ ! -f pnpm-lock.yaml ] && [ -f "$WORKSPACE_ROOT/pnpm-lock.yaml" ]; then
    CUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/manager-cut.XXXXXX")"
    trap 'rm -rf "$CUT_DIR"' EXIT
    MANAGER_FOLDER="$(git rev-parse --show-prefix)"
    node "$WORKSPACE_ROOT/tools/app-workspace/cut.mjs" --root "$WORKSPACE_ROOT" --app "${MANAGER_FOLDER%/}" --out "$CUT_DIR/manager"
    CUT_SOURCE=("$CUT_DIR/manager/")
fi

echo "==> rsync → ${SSH_TARGET}:${REMOTE_PATH} (manager/swarm-hls-stream left as it is)"
rsync -avz --delete \
    --exclude '.git/' \
    --exclude 'node_modules/' \
    --exclude '.scratch/' \
    --exclude 'manager/swarm-hls-stream/' \
    --exclude '**/dist/.tsbuildinfo' \
    --exclude '*.tsbuildinfo' \
    --exclude '.DS_Store' \
    ./ ${CUT_SOURCE[@]+"${CUT_SOURCE[@]}"} "${SSH_TARGET}:${REMOTE_PATH}/"

echo "==> Remote build + upgrade"
# Detect the server's primary IP on the host (the manager runs in a container,
# so it can't see the host's real address itself) and pass it through as
# PUBLIC_HOST for building component URLs.
ssh "$SSH_TARGET" bash -s <<REMOTE
set -euo pipefail
cd ${REMOTE_PATH}/manager

# The || true is what keeps this line from ending the whole remote block: it runs
# under pipefail, so a host without ip, or a route that cannot be read, would
# fail the substitution and none of the lines below would run.
PUBLIC_HOST="\$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if(\$i=="src"){print \$(i+1); exit}}' || true)"
echo "[deploy] resolved PUBLIC_HOST='\${PUBLIC_HOST}' (default-route src IP)"
if [ -z "\${PUBLIC_HOST}" ]; then
    echo "[deploy] WARNING: PUBLIC_HOST is empty, so component URLs will fall back to localhost" >&2
fi

export PUBLIC_HOST
export BEE_DATA_ROOT="\${HOME}/streaming-infra-manager-data"

# Added stack versions live here, a sibling of the data root and outside the
# tree the rsync above deletes into, so a manager deploy cannot wipe them. The
# bundled version's own build and its settings live here too.
export STACK_VERSIONS_ROOT="\${HOME}/streaming-infra-manager-versions"
mkdir -p "\${STACK_VERSIONS_ROOT}"
echo "[deploy] stack versions root: \${STACK_VERSIONS_ROOT}"

# The ssh identity the api container mounts for deployments on other hosts,
# empty on a manager that deploys only to itself. Made here, as this user, with
# the path manager/.env names or the compose default under this home, because a
# bind mount whose source is missing is created by Docker as a root-owned
# directory that nobody can put a key or a config into afterwards.
# Read the way compose reads the env file: the last assignment wins, a carriage
# return and surrounding quotes are not part of the value.
export MANAGER_SSH_DIR="\$(sed -n 's/^MANAGER_SSH_DIR=//p' .env | tail -n 1 | tr -d '\r"' | tr -d "'")"
export MANAGER_SSH_DIR="\${MANAGER_SSH_DIR:-\${HOME}/manager-ssh}"
mkdir -p -m 700 "\${MANAGER_SSH_DIR}"
echo "[deploy] ssh identity for other hosts: \${MANAGER_SSH_DIR}"

docker compose build
IMAGE_ID="\$(docker image inspect --format '{{.Id}}' manager-api)"
echo "[deploy] built api image \${IMAGE_ID}"

# Whether this host has ever run the manager is decided here, before the one-off
# container below exists. Preparing that container can create the project's
# volumes, so the same question asked from inside it would find a data volume
# nothing has ever written to and call an old database a new one.
POSTGRES_VOLUME="manager_manager-pg"
service_containers() {
    docker ps -aq \
        --filter "label=com.docker.compose.project=manager" \
        --filter "label=com.docker.compose.service=\$1" \
        --filter "label=com.docker.compose.oneoff=False"
}
# Each answer is read into a variable of its own before it is looked at. A
# substitution inside a [ ... ] condition reports what it printed rather than
# that it failed, so a daemon that could not be asked would read as a host with
# nothing on it and this deploy would call an old database new.
DATA_VOLUME="\$(docker volume ls -q --filter name=^\${POSTGRES_VOLUME}\$)"
API_CONTAINERS="\$(service_containers api)"
POSTGRES_CONTAINERS="\$(service_containers postgres)"
FIRST_USE_FLAG=""
if [ -z "\${DATA_VOLUME}" ]; then
    if [ -n "\${API_CONTAINERS}" ]; then
        echo "[deploy] ERROR: this host has an api container but no \${POSTGRES_VOLUME} volume, so its database was removed under a manager that is still installed. Look at the host before deploying again." >&2
        exit 1
    fi
    if [ -z "\${POSTGRES_CONTAINERS}" ]; then
        FIRST_USE_FLAG="--first-use"
        echo "[deploy] no data volume and no containers of this project: this host has never run the manager"
    fi
fi

# --no-deps is deliberate. This one-off container decides for itself whether
# Postgres may be started, because a host that has never run the manager and a
# host whose database was removed are different situations and only one of them
# may be treated as an empty database. The container joins the project network,
# so postgres and api resolve by name inside it.
# The status is taken rather than left to end the block, because the receipt
# is the one line the upgrade prints and a failed bundled build is in it.
UPGRADE_STATUS=0
RECEIPT="\$(docker compose run --rm --no-deps -T api node dist/cli.js manager:upgrade \
    --manager-commit '${MANAGER_COMMIT}' \
    --manager-digest '${MANAGER_DIGEST}' \
    --image-id "\${IMAGE_ID}" \
    --project manager \
    --compose-file ${REMOTE_PATH}/manager/docker-compose.yml \
    --mutable-root ${REMOTE_PATH} \
    --bundled-timeout '${BUNDLED_TIMEOUT}' \
    \${FIRST_USE_FLAG} ${PUBLIC_EDGE_FLAG} < /dev/null)" || UPGRADE_STATUS=\$?
echo "[deploy] upgrade receipt: \${RECEIPT}"
if [ "\${UPGRADE_STATUS}" -ne 0 ]; then
    echo "[deploy] the upgrade exited with \${UPGRADE_STATUS}" >&2
    exit "\${UPGRADE_STATUS}"
fi

echo "[deploy] PUBLIC_HOST seen inside api container:"
docker compose exec -T api sh -c 'echo "  PUBLIC_HOST=\${PUBLIC_HOST}"' < /dev/null || \
    echo "[deploy] (could not exec into api container to verify)"
REMOTE


echo "==> Done."
if [ -n "$MANAGER_DOMAIN" ]; then
    echo "Public: https://${MANAGER_DOMAIN}"
    echo "First certificate: ssh ${SSH_TARGET}, then in ${REMOTE_PATH}/manager run docker compose logs -f edge"
fi
echo "Tunnel: ssh -L 8080:localhost:8080 ${SSH_TARGET}"
echo "Then open: http://localhost:8080"
