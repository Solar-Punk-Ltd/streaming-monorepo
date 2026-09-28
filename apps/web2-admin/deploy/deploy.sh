#!/usr/bin/env bash
# Deploy the web2 admin layer (postgres, API, console) to a host with Docker.
#
#   ./deploy/deploy.sh --host=<ssh-target> [--profile=<name>] [--portSlot=<N>]
#                      [--remote-path=<dir>] [service...]
#
# The grammar is swarm-hls-stream's, because streaming-infra-manager already
# runs that stack's deploy.sh as `deploy.sh --profile=<name> --portSlot=<N>
# --host=<target> [service...]` with standard input closed, and it is meant to
# run this one the same way. See deploy/README.md for what each flag does.
#
# What it does:
#   1. Checks the arguments and the profile's env file before anything leaves
#      this machine. The backend refuses to start without a handful of keys,
#      and a deploy that fails here is better than an API restarting forever
#      on the host with nobody watching its logs.
#   2. Writes the commit this checkout is at into deploy/.deployed-commit,
#      with -dirty appended when the tree has changes, since this repository
#      is often deployed before its work is committed.
#   3. rsyncs apps/web2-admin to <remote-path> on the host, leaving out .git,
#      node_modules, build output, deploy/edge/ (the host's edge, which
#      infra/edge/edge.sh maintains) and every env file but the one this profile
#      uses. --delete keeps the host's tree identical to this one. The other
#      env files are left out rather than shipped because the host keeps one
#      checkout for every profile: a laptop that has only .env.brand-a must not
#      delete the .env.brand-b that someone else deployed from theirs.
#   4. Over one ssh session, builds the images and starts the compose project
#      web2-admin-<profile> on the host, then waits for the API and the
#      console to report healthy and for /api/health to answer through nginx.
#      The API applies its migrations at boot, before it listens, so there is
#      no separate migration step and healthy means migrated.
#
# With --host=localhost there is no rsync and no ssh: the same steps run in
# this checkout against the local Docker daemon, which is what the manager
# passes for a profile that lives on its own host.
#
# Nothing here ever prompts. Standard input may be closed, and a question
# nobody can answer is worse than a refusal that says why.

set -euo pipefail

readonly DEFAULT_REMOTE_PATH="/opt/streaming/streaming-monorepo"
readonly ENV_DIR="backend"
# Where a profile's env file was before the admin moved into apps/web2-admin:
# from the repository root in a checkout, and from the remote path on a host,
# since every deploy sent the repository root then. Git leaves an ignored file
# where it is, so a checkout that deployed before the move can still hold it
# there, and rsync leaves the host's copy, being excluded from --delete.
readonly OLD_ENV_DIR="web2-admin/backend"
readonly COMPOSE_FILE="deploy/docker-compose.yml"
readonly KNOWN_SERVICES="postgres api web"
# The loopback port the console gets without a port slot. The manager's own
# console is on 8080, and both are often tunnelled from one laptop.
readonly DEFAULT_WEB_PORT=9090
# The public keys a fresh copy of .env.sample carries. They make a checkout
# start, and they must never sign a real catalogue or guard a real internal API.
readonly SAMPLE_FEED_PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
readonly SAMPLE_INTERNAL_API_TOKEN="change-me-to-32-or-more-random-characters"

usage() {
    cat <<'USAGE'
Usage: deploy.sh --host=<ssh-target> [--profile=<name>] [--portSlot=<N>] [--remote-path=<dir>] [service...]

  deploy.sh --host=admin-host                          Deploy the default profile (apps/web2-admin/backend/.env)
  deploy.sh --host=admin-host --profile=brand-a        Deploy profile brand-a (apps/web2-admin/backend/.env.brand-a)
  deploy.sh --host=admin-host --profile=brand-a --portSlot=3
                                                       Same, console on 127.0.0.1:11039 on the host
  deploy.sh --host=admin-host --profile=brand-a api    Rebuild and restart the API only
  deploy.sh --host=localhost --profile=brand-a         Deploy on this machine, no rsync and no ssh

Flags (each also accepts a separate value, as in --host admin-host):
  --host=<target>       Required. An ssh alias from ~/.ssh/config, user@host, or
                        "localhost" for this machine. There is no default host.
  --profile=<name>      Profile name, ^[a-z0-9][a-z0-9-]{0,30}$. Default: "default".
                        Selects apps/web2-admin/backend/.env.<name> (plain
                        .env for "default"), which must exist, and the
                        compose project web2-admin-<name>.
  --portSlot=<N> (1-99) Publishes the console on 11009 + N*10 on the host's
                        loopback. When set, the slot is authoritative:
                        WEB2_ADMIN_WEB_PORT in the env file is ignored.
                        Without it: WEB2_ADMIN_WEB_PORT, else 9090.
  --remote-path=<dir>   Absolute checkout path on the host. Default:
                        /opt/streaming/streaming-monorepo, shared by every
                        profile. Not accepted with --host=localhost.
  -h, --help            Show this help.

Services: postgres api web. None named means all three.

Environment:
  HEALTH_TIMEOUT        Seconds to wait for the stack to report healthy after
                        it starts. Default: 120.
USAGE
}

log() { echo "[deploy] $*"; }
warn() { echo "[deploy] WARNING: $*" >&2; }
die() {
    echo "[deploy] ERROR: $*" >&2
    exit 1
}

# --- Arguments ----------------------------------------------------------------

HOST=""
PROFILE="default"
PORT_SLOT=""
REMOTE_PATH=""
SERVICES=()
# The flags that appeared, so an empty value can be told from an absent flag.
GIVEN=""

while [ $# -gt 0 ]; do
    case "$1" in
        -h | --help)
            usage
            exit 0
            ;;
        --host=*)
            HOST="${1#*=}"
            shift
            ;;
        --profile=*)
            PROFILE="${1#*=}"
            GIVEN="$GIVEN --profile"
            shift
            ;;
        --portSlot=*)
            PORT_SLOT="${1#*=}"
            GIVEN="$GIVEN --portSlot"
            shift
            ;;
        --remote-path=*)
            REMOTE_PATH="${1#*=}"
            GIVEN="$GIVEN --remote-path"
            shift
            ;;
        --host | --profile | --portSlot | --remote-path)
            [ $# -ge 2 ] || die "$1 requires a value"
            GIVEN="$GIVEN $1"
            case "$1" in
                --host) HOST="$2" ;;
                --profile) PROFILE="$2" ;;
                --portSlot) PORT_SLOT="$2" ;;
                --remote-path) REMOTE_PATH="$2" ;;
            esac
            shift 2
            ;;
        -*)
            die "unknown option: $1 (see --help)"
            ;;
        *)
            SERVICES+=("$1")
            shift
            ;;
    esac
done

# An empty value is a mistake, not a request for the default: --portSlot= from
# a caller whose slot variable came out empty must not quietly publish on the
# env file's port instead.
for flag in $GIVEN; do
    case "$flag" in
        --profile) [ -n "$PROFILE" ] || die "--profile= has no value" ;;
        --portSlot) [ -n "$PORT_SLOT" ] || die "--portSlot= has no value" ;;
        --remote-path) [ -n "$REMOTE_PATH" ] || die "--remote-path= has no value" ;;
    esac
done

# The target reaches ssh and rsync as the destination, where a leading dash is
# read as an option, so `--host=-oProxyCommand=...` would run a command. The
# pattern is the one the manager's targetAlias applies before it hands a
# profile's host to a deploy script, so both halves refuse the same names; it
# also keeps out the colon rsync would read as a path separator.
[ -n "$HOST" ] || die "--host=<ssh-target> is required: an ssh alias, user@host, or localhost for this machine. See --help."
if [[ "$HOST" == -* ]]; then
    die "the ssh target must not start with a dash (got: $HOST)"
fi
if ! [[ "$HOST" =~ ^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$ ]]; then
    die "--host must be an ssh alias, user@host or localhost: letters, digits, dot, underscore, @ and hyphen (got: $HOST)"
fi
LOCAL=false
[ "$HOST" = "localhost" ] && LOCAL=true

# The manager's own profile rule, so any profile it can create is one this
# script accepts. The name becomes part of a file name and a compose project.
if ! [[ "$PROFILE" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]]; then
    die "invalid profile name: $PROFILE (must match ^[a-z0-9][a-z0-9-]{0,30}\$)"
fi

# The slot ceiling is 99, not the manager's 999, for the same reason
# swarm-hls-stream stops there. That stack owns every last digit of the
# 10000-10999 block (10009 + N*10 is its SRS HTTP API), and its per-rung Bee
# nodes take digits 1 to 6 of 11000-11999 on the same arithmetic. The console
# takes digit 9 of that second block, 11009 + N*10, which no stack service
# uses at any slot. Slot 100 would move the stack's first block onto the
# second, which is why that stack refuses it and says "(1-99)" in its usage
# text, where the manager reads a stack's ceiling from.
WEB_PORT=""
if [ -n "$PORT_SLOT" ]; then
    if ! [[ "$PORT_SLOT" =~ ^[0-9]+$ ]]; then
        die "--portSlot must be a whole number, got: $PORT_SLOT"
    fi
    # Base 10 on purpose: bash reads a leading zero as octal, so "08" would be
    # an error and "010" slot 8.
    PORT_SLOT=$((10#$PORT_SLOT))
    if [ "$PORT_SLOT" -lt 1 ] || [ "$PORT_SLOT" -gt 99 ]; then
        die "--portSlot must be 1-99 (got: $PORT_SLOT). Leave it out to use WEB2_ADMIN_WEB_PORT from the env file."
    fi
    WEB_PORT=$((11009 + PORT_SLOT * 10))
fi

# Interpolated into commands on the host, so it is held to a plain absolute
# path: no spaces, quotes, globs or parent references.
if [ -n "$REMOTE_PATH" ]; then
    if [ "$LOCAL" = true ]; then
        die "--remote-path has no meaning with --host=localhost, which deploys this checkout where it is"
    fi
    if ! [[ "$REMOTE_PATH" =~ ^/[A-Za-z0-9._/-]+$ ]] || [[ "$REMOTE_PATH" =~ (^|/)\.\.?(/|$) ]] || [[ "$REMOTE_PATH" == *//* ]]; then
        die "--remote-path must be an absolute path of letters, digits, dot, underscore, slash and hyphen, without empty, . or .. segments (got: $REMOTE_PATH)"
    fi
    REMOTE_PATH="${REMOTE_PATH%/}"
else
    REMOTE_PATH="$DEFAULT_REMOTE_PATH"
fi

SERVICES_ARGS=""
for service in ${SERVICES[@]+"${SERVICES[@]}"}; do
    case " $KNOWN_SERVICES " in
        *" $service "*) SERVICES_ARGS="${SERVICES_ARGS:+$SERVICES_ARGS }$service" ;;
        *) die "unknown service: $service (known: $KNOWN_SERVICES)" ;;
    esac
done

# How long the host waits for the stack to report healthy once it has started.
# It is interpolated into the script the host runs, so it must be a number.
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
if ! [[ "$HEALTH_TIMEOUT" =~ ^[0-9]+$ ]] || [ "$((10#$HEALTH_TIMEOUT))" -lt 1 ]; then
    die "HEALTH_TIMEOUT must be a whole number of seconds (got: $HEALTH_TIMEOUT)"
fi
HEALTH_TIMEOUT=$((10#$HEALTH_TIMEOUT))

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
# apps/web2-admin, the start of every path printed for the operator, so each
# one works from the repository root.
APP_DIR_FROM_ROOT="${APP_DIR#"$REPO_ROOT"/}"
cd "$APP_DIR"

# The images read the admin's pnpm-lock.yaml and pnpm-workspace.yaml at the root
# of apps/web2-admin. A checkout of the one workspace holds them only at the
# repository root: a remote deploy then sends the admin's own pair cut out of the
# root's, and a local one builds from a copy with that pair in it, as the two
# places below say. A checkout whose admin keeps its own pair deploys as it did.
ONE_WORKSPACE=false
if [ ! -f pnpm-lock.yaml ] && [ -f "$REPO_ROOT/pnpm-lock.yaml" ]; then
    ONE_WORKSPACE=true
fi

PROJECT="web2-admin-$PROFILE"
if [ "$PROFILE" = "default" ]; then
    ENV_FILE="$ENV_DIR/.env"
else
    ENV_FILE="$ENV_DIR/.env.$PROFILE"
fi
ENV_FILE_FROM_ROOT="$APP_DIR_FROM_ROOT/$ENV_FILE"
ENV_SAMPLE_FROM_ROOT="$APP_DIR_FROM_ROOT/$ENV_DIR/.env.sample"
OLD_ENV_FILE="$OLD_ENV_DIR/${ENV_FILE##*/}"

# --- The env file -------------------------------------------------------------

log "profile $PROFILE, compose project $PROJECT, env file $ENV_FILE_FROM_ROOT"

# A profile always means its own file. Falling back to .env would bring up a
# second stack with the first one's signing key and database password.
if [ ! -f "$ENV_FILE" ]; then
    # Only whether the old file is there is asked, never what it holds, and
    # moving it is left to the operator.
    if [ -f "$REPO_ROOT/$OLD_ENV_FILE" ]; then
        echo "[deploy] ERROR: $ENV_FILE_FROM_ROOT not found, but $OLD_ENV_FILE is there. It is this profile's env file from before the admin moved into $APP_DIR_FROM_ROOT, and git left it at its old path. Move it, from the repository root:" >&2
        echo "[deploy]   mv $OLD_ENV_FILE $ENV_FILE_FROM_ROOT" >&2
        echo "[deploy] Do not make a new one from the sample instead. A new POSTGRES_PASSWORD locks the API out of the profile's existing database, and a new FEED_PRIVATE_KEY makes every publish fail. Nothing was deployed." >&2
        exit 1
    fi
    die "$ENV_FILE_FROM_ROOT not found. Copy $ENV_SAMPLE_FROM_ROOT to $ENV_FILE_FROM_ROOT and fill in the required values."
fi

# The value compose will see for KEY: the last assignment wins, a carriage
# return and surrounding whitespace are not part of it, one pair of quotes is
# stripped, and an unquoted value ends at a " #" comment.
env_value() {
    local line value
    line="$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -n 1 || true)"
    value="${line#*=}"
    value="${value//$'\r'/}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    case "$value" in
        \"*\" | \'*\')
            value="${value:1:${#value}-2}"
            ;;
        *)
            value="${value%%[[:space:]]#*}"
            value="${value%"${value##*[![:space:]]}"}"
            ;;
    esac
    printf '%s' "$value"
}

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# Every problem is reported before stopping, so one run lists all of them.
PROBLEMS=0
problem() {
    echo "[deploy] ERROR: $ENV_FILE_FROM_ROOT: $*" >&2
    PROBLEMS=$((PROBLEMS + 1))
}

# The password goes into DATABASE_URL unescaped (see docker-compose.yml), and
# compose interpolates a dollar sign, so anything outside the URL-safe set
# would reach the API as a different password or a broken URL.
POSTGRES_PASSWORD="$(env_value POSTGRES_PASSWORD)"
if [ -z "$POSTGRES_PASSWORD" ]; then
    problem "POSTGRES_PASSWORD is missing or empty."
elif ! [[ "$POSTGRES_PASSWORD" =~ ^[A-Za-z0-9._~-]+$ ]]; then
    problem "POSTGRES_PASSWORD may only hold letters, digits and . _ ~ -, because it is written into DATABASE_URL as it is."
fi

FEED_GATEWAY="$(lower "$(env_value FEED_GATEWAY)")"
case "${FEED_GATEWAY:-bee}" in
    bee | fake) ;;
    *) problem "FEED_GATEWAY must be bee or fake (got: $FEED_GATEWAY)." ;;
esac
FEED_GATEWAY="${FEED_GATEWAY:-bee}"

# The API also derives the address from the key and refuses one that is not a
# usable secp256k1 key. Bash cannot, so only the shape and the all-zero key,
# the one invalid value somebody is likely to type, are checked here.
FEED_PRIVATE_KEY="$(env_value FEED_PRIVATE_KEY)"
if [ -z "$FEED_PRIVATE_KEY" ]; then
    problem "FEED_PRIVATE_KEY is missing or empty."
elif ! [[ "$FEED_PRIVATE_KEY" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
    problem "FEED_PRIVATE_KEY must be 0x followed by 64 hex characters."
elif [[ "$FEED_PRIVATE_KEY" =~ ^0x0{64}$ ]]; then
    problem "FEED_PRIVATE_KEY is all zeroes, which is not a private key."
elif [ "$(lower "$FEED_PRIVATE_KEY")" = "$SAMPLE_FEED_PRIVATE_KEY" ]; then
    warn "FEED_PRIVATE_KEY is the public Hardhat test key from .env.sample. Anyone can write this catalogue's feed. Generate a key of your own for anything real."
fi

INTERNAL_API_TOKEN="$(env_value INTERNAL_API_TOKEN)"
if [ "${#INTERNAL_API_TOKEN}" -lt 32 ]; then
    problem "INTERNAL_API_TOKEN must be at least 32 characters (got ${#INTERNAL_API_TOKEN})."
elif [ "$INTERNAL_API_TOKEN" = "$SAMPLE_INTERNAL_API_TOKEN" ]; then
    warn "INTERNAL_API_TOKEN is the placeholder from .env.sample. It can flip streams live, so generate a real one."
fi

BEE_URL="$(env_value BEE_URL)"
if [ -z "$BEE_URL" ]; then
    problem "BEE_URL is missing or empty."
elif ! [[ "$BEE_URL" =~ ^https?://[^[:space:]]+$ ]]; then
    problem "BEE_URL must be an http:// or https:// URL (got: $BEE_URL)."
elif [ "$FEED_GATEWAY" = "bee" ] && [[ "$BEE_URL" =~ ^https?://(localhost|127\.0\.0\.1|\[::1\])(:|/|$) ]]; then
    warn "BEE_URL is $BEE_URL, but inside the api container that is the container itself. A Bee node on the host is http://host.docker.internal:<port>."
fi

POSTAGE_BATCH_ID="$(env_value POSTAGE_BATCH_ID)"
if [ -z "$POSTAGE_BATCH_ID" ]; then
    problem "POSTAGE_BATCH_ID is missing or empty."
elif ! [[ "$POSTAGE_BATCH_ID" =~ ^(0x)?[0-9a-fA-F]{64}$ ]]; then
    problem "POSTAGE_BATCH_ID must be 64 hex characters, 0x optional."
elif [ "$FEED_GATEWAY" = "bee" ] && [[ "$POSTAGE_BATCH_ID" =~ ^(0x)?0{64}$ ]]; then
    warn "POSTAGE_BATCH_ID is the all-zero placeholder from .env.sample. No node has it, so every publish will fail."
fi

# The INGEST_* keys are no longer read: each stream's OBS details come from its
# stage, as the manager pushes it. An env file that still sets them deploys as
# it did, and the API's boot log names them.
for key in INGEST_HOST INGEST_SRT_PORT INGEST_RTMP_PORT INGEST_RTMP_PUBLIC INGEST_SRT_PASSPHRASE INGEST_KEY_VERIFIED; do
    if [ -n "$(env_value "$key")" ]; then
        warn "$key is no longer read: each stream's OBS details come from its stage. Remove it from $ENV_FILE_FROM_ROOT."
    fi
done

ENV_WEB_PORT="$(env_value WEB2_ADMIN_WEB_PORT)"
if [ -n "$ENV_WEB_PORT" ]; then
    if ! [[ "$ENV_WEB_PORT" =~ ^[0-9]{1,5}$ ]] || [ "$((10#$ENV_WEB_PORT))" -lt 1 ] || [ "$((10#$ENV_WEB_PORT))" -gt 65535 ]; then
        problem "WEB2_ADMIN_WEB_PORT must be a port number 1-65535 (got: $ENV_WEB_PORT)."
    else
        ENV_WEB_PORT=$((10#$ENV_WEB_PORT))
    fi
fi

if [ "$PROBLEMS" -gt 0 ]; then
    die "$PROBLEMS problem(s) in $ENV_FILE_FROM_ROOT. Nothing was deployed. See $ENV_SAMPLE_FROM_ROOT for what each key means."
fi

if [ -n "$WEB_PORT" ]; then
    if [ -n "$ENV_WEB_PORT" ] && [ "$ENV_WEB_PORT" != "$WEB_PORT" ]; then
        log "WEB2_ADMIN_WEB_PORT=$ENV_WEB_PORT in $ENV_FILE_FROM_ROOT is ignored: port slot $PORT_SLOT decides the port"
    fi
    log "console port $WEB_PORT (port slot $PORT_SLOT)"
else
    if [ -n "$ENV_WEB_PORT" ]; then
        WEB_PORT="$ENV_WEB_PORT"
        log "console port $WEB_PORT (WEB2_ADMIN_WEB_PORT in $ENV_FILE_FROM_ROOT)"
    else
        WEB_PORT="$DEFAULT_WEB_PORT"
        log "console port $WEB_PORT (the default: no port slot and no WEB2_ADMIN_WEB_PORT)"
    fi
fi

# --- Prerequisites ------------------------------------------------------------

# ConnectTimeout keeps an unreachable host from holding a deploy the manager is
# streaming. BatchMode only without a terminal: ssh would otherwise ask for a
# passphrase or a host key on input that is closed, where a person at a
# terminal can answer.
SSH_OPTS=(-o ConnectTimeout=15)
if [ ! -t 0 ]; then
    SSH_OPTS+=(-o BatchMode=yes)
fi

if [ "$LOCAL" = true ]; then
    command -v docker >/dev/null 2>&1 || die "docker is not installed on this machine"
    docker compose version >/dev/null 2>&1 || die "docker compose is not available on this machine"
else
    command -v ssh >/dev/null 2>&1 || die "ssh is not installed on this machine"
    command -v rsync >/dev/null 2>&1 || die "rsync is not installed on this machine"
fi

# --- The commit ---------------------------------------------------------------

COMMIT="unknown"
if git rev-parse --verify -q HEAD >/dev/null 2>&1; then
    COMMIT="$(git rev-parse HEAD)"
    # Only this folder's changes count: the repository holds other projects,
    # and a change in one of them is not a change to what this deploy ships.
    if [ -n "$(git status --porcelain -- . 2>/dev/null)" ]; then
        COMMIT="$COMMIT-dirty"
    fi
fi
printf '%s\n' "$COMMIT" >deploy/.deployed-commit
log "commit $COMMIT (written to $APP_DIR_FROM_ROOT/deploy/.deployed-commit)"

# --- What runs on the host ----------------------------------------------------

# The host's last step: say when this profile's env file from before the move
# is still there. It is no longer read, but it keeps a second copy of the
# signing key and token. Removing a file from a host is the owner's call, so
# the step prints the command rather than running it. --host=localhost has no
# host checkout to look in. The path, profile and host it names were held to
# patterns above, as everything host_script interpolates is.
old_env_file_check() {
    [ "$LOCAL" = false ] || return 0
    cat <<OLD_ENV_FILE_CHECK
if [ -f '$OLD_ENV_FILE' ]; then
    echo "[deploy] WARNING: this host still has $REMOTE_PATH/$OLD_ENV_FILE, the env file of profile $PROFILE from a deploy made before the admin moved into apps/web2-admin. The profile now runs on $REMOTE_PATH/$ENV_FILE and the old file is no longer read, but it keeps a second copy of the profile's signing key and token. Remove it when you are ready:" >&2
    echo "[deploy]   ssh $HOST 'rm $REMOTE_PATH/$OLD_ENV_FILE'" >&2
fi
OLD_ENV_FILE_CHECK
}

# Every value interpolated below has been held to a pattern above (the path,
# profile, port, services and commit), so none of them can end the single
# quotes it sits in. The script is written to ssh's standard input rather than
# passed as an argument, which keeps it out of the host's process list.
#
# The body is one function, called with its input from /dev/null. bash -s reads
# its script from standard input as it goes, so any command in a bare script
# that reads standard input would swallow the lines after it. A function is
# read whole before it runs.
host_script() {
    local cd_line=""
    if [ "$LOCAL" = false ]; then
        cd_line="cd '$REMOTE_PATH'"
    fi
    # A local deploy from a checkout of the one workspace builds the images from
    # a copy of apps/web2-admin that tools/app-workspace/in-copy.mjs makes
    # outside the checkout with the admin's own pair cut into it, and names to
    # deploy/docker-compose.copy.yml in APP_WORKSPACE_COPY. Compose still runs
    # from here, so the project, the env file and the data stay put, and the copy
    # goes when compose returns. The checkout's own paths in it are this
    # machine's, and only a local deploy reaches this line.
    local up_command="compose up -d --build $SERVICES_ARGS"
    if [ "$LOCAL" = true ] && [ "$ONE_WORKSPACE" = true ]; then
        up_command="node '$REPO_ROOT/tools/app-workspace/in-copy.mjs' --root '$REPO_ROOT' --app '$APP_DIR_FROM_ROOT' -- docker compose --project-directory '$APP_DIR/deploy' -p '$PROJECT' -f '$APP_DIR/$COMPOSE_FILE' -f '$APP_DIR/deploy/docker-compose.copy.yml' --env-file '$APP_DIR/$ENV_FILE' up -d --build $SERVICES_ARGS"
    fi
    cat <<HOST_SCRIPT
deploy_on_host() {
set -euo pipefail
$cd_line

docker compose version >/dev/null 2>&1 || {
    echo "[deploy] ERROR: docker compose is not available on this host" >&2
    exit 1
}

# It holds the feed signing key and the internal API token.
chmod 600 '$ENV_FILE'

# Compose takes a variable from the shell over the env file, so a
# POSTGRES_PASSWORD exported for the development stack would otherwise become
# this project's password. The env file is the only source of it.
unset POSTGRES_PASSWORD
# Relative to deploy/, where the compose file is.
export WEB2_ADMIN_ENV_FILE='../$ENV_FILE'
export WEB2_ADMIN_WEB_PORT='$WEB_PORT'
export WEB2_ADMIN_COMMIT='$COMMIT'

compose() {
    docker compose -p '$PROJECT' -f '$COMPOSE_FILE' --env-file '$ENV_FILE' "\$@"
}

echo "[deploy] building and starting $PROJECT (${SERVICES_ARGS:-all services})"
$up_command

# What a service's container reports: its health when it has a healthcheck,
# otherwise its state, and "missing" when compose has no container for it.
service_status() {
    local id
    id="\$(compose ps -q "\$1" 2>/dev/null || true)"
    if [ -z "\$id" ]; then
        echo missing
        return
    fi
    docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "\$id" 2>/dev/null || echo unknown
}

report_failure() {
    echo "[deploy] ERROR: \$1" >&2
    compose ps -a >&2 || true
    echo "[deploy] last log lines:" >&2
    compose logs --no-color --tail=40 $SERVICES_ARGS >&2 || true
    exit 1
}

SCOPE='${SERVICES_ARGS:-$KNOWN_SERVICES}'
echo "[deploy] waiting up to ${HEALTH_TIMEOUT}s for \$SCOPE to report healthy"
DEADLINE=\$((SECONDS + $HEALTH_TIMEOUT))
while :; do
    WAITING=""
    for service in \$SCOPE; do
        status="\$(service_status "\$service")"
        if [ "\$status" != healthy ]; then
            WAITING="\${WAITING:+\$WAITING, }\$service \$status"
        fi
    done
    [ -z "\$WAITING" ] && break
    if [ "\$SECONDS" -ge "\$DEADLINE" ]; then
        report_failure "not healthy after ${HEALTH_TIMEOUT}s: \$WAITING"
    fi
    sleep 3
done

# The healthchecks prove each service on its own. This proves the path an
# operator takes: nginx, its proxy to the API, and the API's query.
case " \$SCOPE " in
    *" web "*)
        if ! HEALTH="\$(compose exec -T web wget -q -O - http://127.0.0.1/api/health)"; then
            report_failure "the console is up but /api/health does not answer through nginx"
        fi
        echo "[deploy] /api/health through nginx: \$HEALTH"
        ;;
esac

echo "[deploy] $PROJECT is up, console on 127.0.0.1:$WEB_PORT of this host"
$(old_env_file_check)
}
deploy_on_host </dev/null
HOST_SCRIPT
}

if [ "$LOCAL" = true ]; then
    log "deploying on this machine, in $APP_DIR"
    host_script | bash -s
else
    log "rsync to $HOST:$REMOTE_PATH"
    # rsync --delete empties whatever directory it is pointed at of everything
    # this checkout does not have. A mistyped --remote-path naming a home
    # directory would be wiped, so the target must be new, empty, or already a
    # checkout of this repository, which includes one infra/edge/edge.sh has
    # so far only put the host's edge into. A checkout is known by what sits
    # beside deploy/deploy.sh: web2-admin/ in one sent from the repository
    # root, as every deploy was before the admin moved into apps/web2-admin,
    # and backend/Dockerfile in one sent from apps/web2-admin. The manager's
    # checkout has a deploy/deploy.sh of its own and neither of the two, and a
    # --remote-path mistyped onto it must not pass.
    if ! ssh "${SSH_OPTS[@]}" "$HOST" "mkdir -p '$REMOTE_PATH' && { { [ -f '$REMOTE_PATH/deploy/deploy.sh' ] && { [ -d '$REMOTE_PATH/web2-admin' ] || [ -f '$REMOTE_PATH/backend/Dockerfile' ]; }; } || [ -f '$REMOTE_PATH/deploy/edge/docker-compose.yml' ] || [ -z \"\$(ls -A '$REMOTE_PATH')\" ]; }" </dev/null; then
        die "$HOST:$REMOTE_PATH could not be created, or it is a non-empty directory that is not a checkout of this repository. rsync --delete would empty it, so nothing was sent."
    fi
    # Filter order matters: the first rule that matches a path wins. The
    # profile's env file and the sample are sent, every other .env is neither
    # sent nor, being excluded, deleted on the host.
    #
    # deploy/edge/ on the host belongs to infra/edge/edge.sh, which puts the
    # edge's compose file and the Caddyfile it renders there. apps/web2-admin
    # has no deploy/edge/ of its own, so --delete would remove the one the
    # host's edge runs on. Excluded, the whole directory is neither sent nor
    # deleted, so a web2-admin deploy never touches the edge.
    #
    # From a checkout of the one workspace, the admin's own pair is cut out of
    # the root's by tools/app-workspace into a folder under TMPDIR, removed when
    # this script exits however it exits, and given to the one rsync as a second
    # source: the pair lands where the admin's own went, and --delete keeps it.
    # The empty second source expands to nothing under set -u in bash 3.2
    # through the + form.
    CUT_SOURCE=()
    if [ "$ONE_WORKSPACE" = true ]; then
        CUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/web2-admin-cut.XXXXXX")"
        trap 'rm -rf "$CUT_DIR"' EXIT
        node "$REPO_ROOT/tools/app-workspace/cut.mjs" --root "$REPO_ROOT" --app "$APP_DIR_FROM_ROOT" --out "$CUT_DIR/web2-admin"
        CUT_SOURCE=("$CUT_DIR/web2-admin/")
    fi
    rsync -az --delete \
        -e "ssh ${SSH_OPTS[*]}" \
        --exclude '/deploy/edge/' \
        --exclude '.git/' \
        --exclude 'node_modules/' \
        --exclude 'dist/' \
        --exclude '*.tsbuildinfo' \
        --exclude '.DS_Store' \
        --exclude '.scratch/' \
        --exclude '.claude/' \
        --include "/$ENV_FILE" \
        --include '.env.sample' \
        --exclude '.env' \
        --exclude '.env.*' \
        ./ ${CUT_SOURCE[@]+"${CUT_SOURCE[@]}"} "$HOST:$REMOTE_PATH/"

    log "building and starting on $HOST"
    host_script | ssh "${SSH_OPTS[@]}" "$HOST" bash -s
fi

# A new database has no users and refuses every sign-in until one is made,
# hence the command for the first one, printed on every deploy.
USER_ADD="WEB2_ADMIN_ENV_FILE=../$ENV_FILE docker compose -p $PROJECT -f $COMPOSE_FILE --env-file $ENV_FILE exec api node dist/cli.js user:add <username>"
log "done: $PROJECT at commit $COMMIT"
if [ "$LOCAL" = true ]; then
    log "open: http://127.0.0.1:$WEB_PORT"
    log "first user, once per profile, from the repository root (prompts for the password):"
    log "  cd $APP_DIR_FROM_ROOT && $USER_ADD"
else
    log "tunnel: ssh -L $WEB_PORT:localhost:$WEB_PORT $HOST"
    log "then open: http://localhost:$WEB_PORT"
    log "first user, once per profile (prompts for the password):"
    log "  ssh -t $HOST 'cd $REMOTE_PATH && $USER_ADD'"
fi
