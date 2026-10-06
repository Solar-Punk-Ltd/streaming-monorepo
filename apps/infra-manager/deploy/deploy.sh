#!/usr/bin/env bash
# Deploy the streaming-infra-manager to a server via rsync + remote build.
#
#   ./deploy/deploy.sh [--host=<ssh-target> | <ssh-target>] [--profile=<name>]
#
# Each flag also takes its value as the next word, as in --host <ssh-target>
# --profile <name>, the way web2-admin's deploy.sh does.
#
# ssh-target defaults to `viewer` (configure in ~/.ssh/config). Example:
#   Host viewer
#     HostName <ip>
#     User <deploy user>
#     LocalForward 8080 localhost:8080
#
# --profile=<name> deploys manager/.env.<name> in place of manager/.env, for a
# host with settings of its own, and only to a host named with it, because the
# default target would get that profile's settings. "default" is manager/.env.
# The file must exist: a profile never falls back to manager/.env. Whatever its
# name here, the host keeps it as manager/.env, so the host's folder, compose
# project and volumes are the same for every profile.
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
#   2. rsyncs the repo to the manager's folder on the host, MANAGER_ROOT in
#      the profile's env file or /opt/streaming/streaming-infra-manager,
#      without manager/swarm-hls-stream: the tree the engines of existing
#      deployments mount is never written over again, so a container restart
#      keeps the files it was started with. Excludes node_modules, build
#      caches, .git, and every env file in the tree, every name that starts
#      with .env, but the .env.sample files. The profile's env file follows on
#      its own, to manager/.env on the host, so no host gets another's
#      settings, and this checkout is the only source of truth for the one it
#      gets.
#   3. Names, on the host, the env files earlier deploys left in its manager/
#      folder, with the command that removes them, and removes none. Then
#      builds the images on the server, decides there whether this host has
#      ever run the manager, and then runs `manager:upgrade` in a one-off
#      container of the image just built. The first use question is answered
#      before that container exists, because preparing it can create the
#      project's volumes, and it stops the deploy when the data volume is gone
#      from under an installed manager. The command owns the rest:
#      it holds one directory for the whole run so a second upgrade cannot
#      start beside it, stops the old api, migrates, starts the project, waits
#      for the api to answer, and then waits for the api's own boot to finish
#      building the pinned stack commit.
#
# HTTPS is the host's edge, infra/edge/edge.sh, which serves the console
# published on the host's loopback. See deploy/README.md.
#
# The streaming stack's own settings live on the server, under the versions
# root, and no deploy reads or writes them. See deploy/README.md.

set -euo pipefail

# Each argument at most once, however it is written: the ssh target, as
# --host=<ssh-target>, --host <ssh-target> or on its own, and the profile, as
# --profile=<name> or --profile <name>. Any other word that starts with a dash
# is refused.
SSH_TARGET="viewer"
TARGET_GIVEN=false
PROFILE="default"
PROFILE_GIVEN=false
take_target() {
    if [ "$TARGET_GIVEN" = true ]; then
        echo "ERROR: the ssh target is given twice (the second: $1)" >&2
        exit 1
    fi
    SSH_TARGET="$1"
    TARGET_GIVEN=true
}
take_profile() {
    if [ "$PROFILE_GIVEN" = true ]; then
        echo "ERROR: --profile is given twice (the second: $1)" >&2
        exit 1
    fi
    PROFILE="$1"
    PROFILE_GIVEN=true
}
while [ $# -gt 0 ]; do
    case "$1" in
        --host=*) take_target "${1#--host=}" ;;
        --profile=*) take_profile "${1#--profile=}" ;;
        --host | --profile)
            # The value is the next word. One that starts with a dash is the
            # next flag, and taking it as the value would hide that this flag
            # has none.
            if [ $# -lt 2 ] || [[ "$2" == -* ]]; then
                echo "ERROR: $1 requires a value, as $1=<value> or $1 <value>" >&2
                exit 1
            fi
            if [ "$1" = --host ]; then take_target "$2"; else take_profile "$2"; fi
            shift
            ;;
        -*)
            echo "ERROR: unknown option $1. Usage: deploy.sh [--host=<ssh-target> | <ssh-target>] [--profile=<name>], each flag also with its value as the next word" >&2
            exit 1
            ;;
        # The target on its own. An empty one is taken here and refused below.
        *) take_target "$1" ;;
    esac
    shift
done
# A profile is one host's settings, its database password among them, and the
# default target would get them, so a profile goes only to a host named with it.
if [ "$PROFILE_GIVEN" = true ] && [ "$TARGET_GIVEN" = false ]; then
    echo "ERROR: --profile=$PROFILE needs the host named, as --host=<ssh-target> or <ssh-target>. Without one the deploy would give that profile's settings to $SSH_TARGET, the default target." >&2
    exit 1
fi
# It is handed to ssh as the destination, where a leading dash is an option.
if [[ "$SSH_TARGET" == -* ]]; then
    echo "ERROR: the ssh target must not start with a dash (got: $SSH_TARGET)" >&2
    exit 1
fi
# It is written into the script the host runs too, in the command the warning
# about leftover env files prints, so it is held to the manager's own rule for
# a deploy target (targetAlias): an ssh alias, a host name or an address, with
# or without user@ in front.
if ! [[ "$SSH_TARGET" =~ ^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$ ]]; then
    echo "ERROR: the ssh target must be an ssh alias, a host name or address, or user@host: letters, digits, dot, underscore, @ and hyphen (got: $SSH_TARGET)" >&2
    exit 1
fi
# The name becomes part of a file name, and the manager's own rule for a
# profile name keeps that file inside manager/.
if ! [[ "$PROFILE" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]]; then
    echo "ERROR: invalid profile name: $PROFILE (must match ^[a-z0-9][a-z0-9-]{0,30}\$)" >&2
    exit 1
fi
# manager/.env.sample is the file every profile is copied from, and its
# values are public.
if [ "$PROFILE" = "sample" ]; then
    echo "ERROR: sample is not a profile: manager/.env.sample is the file each profile's env file is copied from." >&2
    exit 1
fi
# Where the manager lives on the host when the profile's env file names no
# MANAGER_ROOT. The data, the stack versions and the ssh identity sit beside it,
# in the same parent folder, unless that file names them too.
readonly DEFAULT_REMOTE_PATH="/opt/streaming/streaming-infra-manager"
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

# The profile's env file, the only one this deploy sends, and the one every
# check below reads. A profile always means its own file: falling back to
# manager/.env would give this host another host's settings.
if [ "$PROFILE" = "default" ]; then
    ENV_FILE="manager/.env"
else
    ENV_FILE="manager/.env.$PROFILE"
fi
echo "==> Deploying profile ${PROFILE} to ${SSH_TARGET}"
echo "==> Checking ${ENV_FILE}"
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE not found. Copy manager/.env.sample to $ENV_FILE and fill in the required values." >&2
    exit 1
fi
if ! grep -q "POSTGRES_PASSWORD=.\+" "$ENV_FILE"; then
    echo "ERROR: POSTGRES_PASSWORD is missing or empty in $ENV_FILE." >&2
    exit 1
fi
# Read the way compose reads the env file, which interpolates the same key into
# the compose file on the host: the last assignment wins, and a carriage return
# and surrounding quotes are not part of the value.
MANAGER_ROOT_SETTING="$(sed -n 's/^MANAGER_ROOT=//p' "$ENV_FILE" | tail -n 1 | tr -d '\r"' | tr -d "'")"
REMOTE_PATH="${MANAGER_ROOT_SETTING:-$DEFAULT_REMOTE_PATH}"
# It is interpolated into the remote heredoc, so it is held to an absolute path
# of plain characters. It names the folder the host's cd, the upgrade's
# --compose-file and --mutable-root and the printed rm all work in, so it is
# also held, as web2-admin holds its remote path, to no . or .. segment and no
# empty one: a profile's file must not be able to point the deploy anywhere
# but the folder it names.
if ! [[ "$REMOTE_PATH" =~ ^/[A-Za-z0-9._/-]+$ ]] || [[ "$REMOTE_PATH" =~ (^|/)\.\.?(/|$) ]] || [[ "$REMOTE_PATH" == *//* ]] || [[ "$REMOTE_PATH" == */ ]]; then
    echo "ERROR: MANAGER_ROOT must be an absolute path of letters, digits, dots, dashes, underscores and slashes, without empty, . or .. segments and with no trailing slash (got: $REMOTE_PATH)" >&2
    exit 1
fi
HOST_ROOT="$(dirname "$REMOTE_PATH")"

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
# which could hold a helper or rewrite the address. The address is the first
# repository STACK_SOURCES in the profile's env file lists, read the way the
# manager reads it, or the manager's MONOREPO_STACK_SOURCE when it lists none,
# and a test holds the two to each other.
STACK_SOURCES_SETTING="$(sed -n 's/^STACK_SOURCES=//p' "$ENV_FILE" | tail -n 1 | tr -d '\r"' | tr -d "'")"
STACK_REPO_URL="${STACK_SOURCES_SETTING%%,*}"
STACK_REPO_URL="${STACK_REPO_URL%%#*}"
STACK_REPO_URL="${STACK_REPO_URL//[[:space:]]/}"
STACK_REPO_URL="${STACK_REPO_URL:-https://github.com/Solar-Punk-Ltd/streaming-monorepo.git}"
if ! [[ "$STACK_REPO_URL" =~ ^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\.git$ ]]; then
    echo "ERROR: STACK_SOURCES in $ENV_FILE must start with an https://github.com/<owner>/<repo>.git address (got: $STACK_REPO_URL)" >&2
    exit 1
fi
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
# script exits however it exits, and given to the repository's rsync as a
# second source: the pair lands where the manager's own went, and --delete
# keeps it. A checkout whose manager keeps its own pair ships it as it always
# did. The empty second source expands to nothing under set -u in bash 3.2
# through the + form.
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
# The first rule that matches a path wins: every .env.sample is sent, wherever
# it is, manager/'s and the test fixtures' alike, and every other name in the
# tree that starts with .env is neither sent nor, being excluded, deleted on
# the host. That is manager/.env and each manager/.env.<profile>, this
# folder's own .env, the credentials a session is handed for the running
# instance, the frontend's such as Vite's .env.local, and the copies an editor
# or a hand leaves beside any of them, .envrc, .env~ or .env-old, which can
# hold the same secrets. Until 2026-10-06 all of them were sent, which gave
# every host the settings of every other, database passwords and all.
rsync -avz --delete \
    --exclude '.git/' \
    --exclude 'node_modules/' \
    --exclude '.scratch/' \
    --exclude 'manager/swarm-hls-stream/' \
    --exclude '**/dist/.tsbuildinfo' \
    --exclude '*.tsbuildinfo' \
    --exclude '.DS_Store' \
    --include '.env.sample' \
    --exclude '.env*' \
    ./ ${CUT_SOURCE[@]+"${CUT_SOURCE[@]}"} "${SSH_TARGET}:${REMOTE_PATH}/"

echo "==> ${ENV_FILE} → ${SSH_TARGET}:${REMOTE_PATH}/manager/.env"
# The profile's env file, on its own, becomes the host's manager/.env, the file
# compose and the block below read. The rsync above excludes that path, so it
# neither writes nor deletes it, and this transfer is what replaces it. It runs
# second because the first one makes manager/ on a new host. --copy-links sends
# what a link points at, which is what the checks above read.
rsync -avz --copy-links "$ENV_FILE" "${SSH_TARGET}:${REMOTE_PATH}/manager/.env"

echo "==> Remote build + upgrade"
# Detect the server's primary IP on the host (the manager runs in a container,
# so it can't see the host's real address itself) and pass it through as
# PUBLIC_HOST for building component URLs.
ssh "$SSH_TARGET" bash -s <<REMOTE
set -euo pipefail
cd ${REMOTE_PATH}/manager

# Until 2026-10-06 a deploy sent every file in manager/ whose name starts with
# .env, so this folder can still hold other profiles' files, and copies such as
# .envrc or .env~, beside the .env it runs on. Every one of them but .env and
# .env.sample is named here: this folder is where the profiles' files were.
# Nothing reads them: compose reads .env alone. But each keeps the settings it
# was sent with, a database password among them, and .dockerignore leaves out
# only .env and .env.*, so the api image build is handed the rest. rsync never
# deletes a file it excludes, and removing them is the operator's call, so they
# are named here with the command that removes them. printf %q escapes each
# name, so one with a space or a glob in it is still removed as itself.
LEFTOVER_ENV_FILES=""
for leftover in .env*; do
    if [ -f "\${leftover}" ] && [ "\${leftover}" != .env ] && [ "\${leftover}" != .env.sample ]; then
        LEFTOVER_ENV_FILES="\${LEFTOVER_ENV_FILES} \$(printf '%q' "\${leftover}")"
    fi
done
if [ -n "\${LEFTOVER_ENV_FILES}" ]; then
    echo "[deploy] WARNING: ${REMOTE_PATH}/manager on this host still has env files that earlier deploys copied there, and nothing reads them:\${LEFTOVER_ENV_FILES}. The manager runs on .env alone, but each of these keeps the settings it was copied with, a database password among them. Remove them when you are ready:" >&2
    echo "[deploy]   ssh ${SSH_TARGET} 'cd ${REMOTE_PATH}/manager && rm\${LEFTOVER_ENV_FILES}'" >&2
fi

# The || true is what keeps this line from ending the whole remote block: it runs
# under pipefail, so a host without ip, or a route that cannot be read, would
# fail the substitution and none of the lines below would run.
PUBLIC_HOST="\$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if(\$i=="src"){print \$(i+1); exit}}' || true)"
echo "[deploy] resolved PUBLIC_HOST='\${PUBLIC_HOST}' (default-route src IP)"
if [ -z "\${PUBLIC_HOST}" ]; then
    echo "[deploy] WARNING: PUBLIC_HOST is empty, so component URLs will fall back to localhost" >&2
fi

export PUBLIC_HOST
export MANAGER_ROOT="${REMOTE_PATH}"
# Each root is read from manager/.env the way compose reads it, and otherwise
# sits beside the manager's folder.
env_setting() {
    sed -n "s/^\$1=//p" .env | tail -n 1 | tr -d '\r"' | tr -d "'"
}
export BEE_DATA_ROOT="\$(env_setting BEE_DATA_ROOT)"
export BEE_DATA_ROOT="\${BEE_DATA_ROOT:-${HOST_ROOT}/streaming-infra-manager-data}"

# Added stack versions live here, a sibling of the data root and outside the
# tree the rsync above deletes into, so a manager deploy cannot wipe them. The
# bundled version's own build and its settings live here too.
export STACK_VERSIONS_ROOT="\$(env_setting STACK_VERSIONS_ROOT)"
export STACK_VERSIONS_ROOT="\${STACK_VERSIONS_ROOT:-${HOST_ROOT}/streaming-infra-manager-versions}"
mkdir -p "\${STACK_VERSIONS_ROOT}"
echo "[deploy] stack versions root: \${STACK_VERSIONS_ROOT}"

# The ssh identity the api container mounts for deployments on other hosts,
# empty on a manager that deploys only to itself. Made here, as this user, with
# the path manager/.env names or the folder beside the manager's, because a
# bind mount whose source is missing is created by Docker as a root-owned
# directory that nobody can put a key or a config into afterwards.
export MANAGER_SSH_DIR="\$(env_setting MANAGER_SSH_DIR)"
export MANAGER_SSH_DIR="\${MANAGER_SSH_DIR:-${HOST_ROOT}/manager-ssh}"
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
    \${FIRST_USE_FLAG} < /dev/null)" || UPGRADE_STATUS=\$?
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
echo "Tunnel: ssh -L 8080:localhost:8080 ${SSH_TARGET}"
echo "Then open: http://localhost:8080"
