#!/usr/bin/env bash
# Put the host's HTTPS edge in front of the consoles it runs.
#
#   ./infra/edge/edge.sh --host=<ssh-target> [--remote-path=<dir>]
#
# One Caddy per host, as its own compose project (`edge`) on the host's
# network, serving each console the host publishes on its loopback under its
# own name: web2-admin's (apps/web2-admin/deploy/deploy.sh, 9090 by default)
# and streaming-infra-manager's (8080). The names are in infra/edge/.env,
# which is gitignored because they belong to one deployment. Copy
# infra/edge/.env.sample to make it. See "Public HTTPS: the host's edge" in
# apps/web2-admin/deploy/README.md.
#
# What it does:
#   1. Checks the arguments and infra/edge/.env before anything leaves this
#      machine.
#   2. Renders infra/edge/Caddyfile from that file, one site per domain set,
#      and has the pinned Caddy image validate it when Docker runs on this
#      machine.
#   3. Sends the Caddyfile and the compose file to <remote-path>/deploy/edge/
#      on the host: the checkout apps/web2-admin/deploy/deploy.sh maintains,
#      whose rsync leaves that directory alone.
#   4. Over one ssh session, refuses when something else holds port 80 or 443,
#      recreates the edge so Caddy reads the new Caddyfile, waits for it to
#      stay running, and asks each console behind it for an answer on the
#      host's loopback.
#   5. From this machine, asks https://<domain>/ for each name for a while and
#      says whether the certificate is there, still coming, or cannot come
#      because the name does not resolve. A certificate that is not there yet
#      does not fail the run: Caddy keeps asking in the background.
#
# With --host=localhost there is no rsync and no ssh: the host's steps run in
# this checkout against the local Docker daemon, for running this on the
# server itself. Not on a laptop: Docker Desktop's host network is its VM's,
# not the laptop's, so the consoles on the laptop's loopback are out of reach.
#
# Nothing here ever prompts. Standard input may be closed, and a question
# nobody can answer is worse than a refusal that says why.

set -euo pipefail

readonly DEFAULT_REMOTE_PATH="/opt/streaming/streaming-monorepo"
readonly EDGE_DIR="infra/edge"
readonly ENV_FILE="$EDGE_DIR/.env"
# Where the env file was before the edge moved to infra/edge, from the
# repository root. Git leaves an ignored file where it is, so a checkout that
# ran the edge before the move can still hold it there.
readonly OLD_ENV_FILE="deploy/edge/.env"
readonly CADDYFILE="$EDGE_DIR/Caddyfile"
readonly COMPOSE_FILE="$EDGE_DIR/docker-compose.yml"
# Where the edge lives on the host, under <remote-path>: the directory of the
# checkout deploy.sh maintains that its rsync leaves alone. It kept its place
# when this script moved to infra/edge.
readonly HOST_EDGE_DIR="deploy/edge"
readonly PROJECT="edge"
readonly SERVICE="caddy"
readonly DEFAULT_ADMIN_PORT=9090
readonly DEFAULT_MANAGER_PORT=8080
# The manager's rule for MANAGER_DOMAIN: dotted labels of lower-case letters,
# digits and inner hyphens. It keeps out a scheme, a port, a path, spaces and
# anything that could end the quotes a name is written into on the host.
readonly HOSTNAME_PATTERN='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
# Loose on purpose, since only Let's Encrypt can say whether an address works,
# but tight enough that the value cannot break the Caddyfile line it goes on.
readonly EMAIL_PATTERN='^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$'
# The host script's exit status when the edge is up but a console behind it
# does not answer. The public probe still runs then, since the other site and
# the certificates are worth reporting on, and the run fails at the end.
readonly UPSTREAM_EXIT=10

usage() {
    cat <<'USAGE'
Usage: edge.sh --host=<ssh-target> [--remote-path=<dir>]

  edge.sh --host=admin-host        Serve the consoles named in infra/edge/.env on admin-host
  edge.sh --host=localhost         The same on this machine, which must be the server itself

Flags (each also accepts a separate value, as in --host admin-host):
  --host=<target>       Required. An ssh alias from ~/.ssh/config, user@host, or
                        "localhost" for this machine. There is no default host.
  --remote-path=<dir>   Absolute checkout path on the host. Default:
                        /opt/streaming/streaming-monorepo, the one deploy.sh
                        uses. Not accepted with --host=localhost.
  -h, --help            Show this help.

infra/edge/.env (copy infra/edge/.env.sample):
  ADMIN_DOMAIN, ADMIN_PORT      the web2-admin console, port default 9090
  MANAGER_DOMAIN, MANAGER_PORT  the streaming-infra-manager console, port default 8080
  ACME_EMAIL                    optional Let's Encrypt contact address
  An empty domain is not served. At least one must be set.

Environment:
  PROBE_TIMEOUT         Seconds to keep asking https://<domain>/ from this
                        machine while the certificate is on its way.
                        Default: 90. 0 skips the probe.
USAGE
}

log() { echo "[edge] $*"; }
warn() { echo "[edge] WARNING: $*" >&2; }
die() {
    echo "[edge] ERROR: $*" >&2
    exit 1
}

# --- Arguments ----------------------------------------------------------------

HOST=""
REMOTE_PATH=""
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
        --remote-path=*)
            REMOTE_PATH="${1#*=}"
            GIVEN="$GIVEN --remote-path"
            shift
            ;;
        --host | --remote-path)
            [ $# -ge 2 ] || die "$1 requires a value"
            GIVEN="$GIVEN $1"
            case "$1" in
                --host) HOST="$2" ;;
                --remote-path) REMOTE_PATH="$2" ;;
            esac
            shift 2
            ;;
        -*)
            die "unknown option: $1 (see --help)"
            ;;
        *)
            die "unexpected argument: $1. The edge has no services to name; see --help."
            ;;
    esac
done

# An empty value is a mistake, not a request for the default.
for flag in $GIVEN; do
    case "$flag" in
        --remote-path) [ -n "$REMOTE_PATH" ] || die "--remote-path= has no value" ;;
    esac
done

# The same rule as deploy.sh, for the same reason: the target reaches ssh and
# rsync as the destination, where a leading dash is read as an option and a
# colon as a path separator.
[ -n "$HOST" ] || die "--host=<ssh-target> is required: an ssh alias, user@host, or localhost for this machine. See --help."
if [[ "$HOST" == -* ]]; then
    die "the ssh target must not start with a dash (got: $HOST)"
fi
if ! [[ "$HOST" =~ ^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$ ]]; then
    die "--host must be an ssh alias, user@host or localhost: letters, digits, dot, underscore, @ and hyphen (got: $HOST)"
fi
LOCAL=false
[ "$HOST" = "localhost" ] && LOCAL=true

# Interpolated into commands on the host, so it is held to a plain absolute
# path, as in deploy.sh.
if [ -n "$REMOTE_PATH" ]; then
    if [ "$LOCAL" = true ]; then
        die "--remote-path has no meaning with --host=localhost, which runs the edge from this checkout where it is"
    fi
    if ! [[ "$REMOTE_PATH" =~ ^/[A-Za-z0-9._/-]+$ ]] || [[ "$REMOTE_PATH" =~ (^|/)\.\.?(/|$) ]] || [[ "$REMOTE_PATH" == *//* ]]; then
        die "--remote-path must be an absolute path of letters, digits, dot, underscore, slash and hyphen, without empty, . or .. segments (got: $REMOTE_PATH)"
    fi
    REMOTE_PATH="${REMOTE_PATH%/}"
else
    REMOTE_PATH="$DEFAULT_REMOTE_PATH"
fi

PROBE_TIMEOUT="${PROBE_TIMEOUT:-90}"
if ! [[ "$PROBE_TIMEOUT" =~ ^[0-9]+$ ]]; then
    die "PROBE_TIMEOUT must be a whole number of seconds (got: $PROBE_TIMEOUT)"
fi
PROBE_TIMEOUT=$((10#$PROBE_TIMEOUT))

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# The image the host will run, read from the compose file so the Caddyfile is
# validated by exactly that build and the two cannot drift apart.
CADDY_IMAGE="$(sed -n 's/^[[:space:]]*image:[[:space:]]*//p' "$COMPOSE_FILE" | head -n 1)"
if ! [[ "$CADDY_IMAGE" =~ ^caddy:[0-9A-Za-z.-]+@sha256:[0-9a-f]{64}$ ]]; then
    die "could not read the pinned caddy image from $COMPOSE_FILE (got: $CADDY_IMAGE)"
fi

# --- The env file -------------------------------------------------------------

if [ ! -f "$ENV_FILE" ]; then
    # Only whether the old file is there is asked, never what it holds, and
    # moving it is left to the operator.
    if [ -f "$OLD_ENV_FILE" ]; then
        echo "[edge] ERROR: $ENV_FILE not found, but $OLD_ENV_FILE is there. It is the edge's env file from before the edge moved to $EDGE_DIR, and git left it at its old path. Move it, from the repository root:" >&2
        echo "[edge]   mv $OLD_ENV_FILE $ENV_FILE" >&2
        echo "[edge] Do not make a new one from the sample instead. It holds the names this edge serves, which the sample does not know. Nothing was sent." >&2
        exit 1
    fi
    die "$ENV_FILE not found. Copy $EDGE_DIR/.env.sample to $ENV_FILE and set at least one of ADMIN_DOMAIN and MANAGER_DOMAIN."
fi

# The value of KEY as deploy.sh reads its env file: the last assignment wins,
# carriage returns and surrounding whitespace are not part of it, one pair of
# quotes is stripped, and an unquoted value ends at a " #" comment. That is
# also how the manager reads MANAGER_DOMAIN, whose deploy once reported
# success on a name with a trailing carriage return that Caddy then could not
# serve. Here the name that is checked is the name that is rendered.
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
    echo "[edge] ERROR: $ENV_FILE: $*" >&2
    PROBLEMS=$((PROBLEMS + 1))
}

# Sets DOMAIN_VALUE to KEY's name, lower case because a certificate names a
# host in lower case. Not a command substitution, which would run problem()
# in a subshell and lose the count.
read_domain() {
    DOMAIN_VALUE="$(lower "$(env_value "$1")")"
    [ -n "$DOMAIN_VALUE" ] || return 0
    if ! [[ "$DOMAIN_VALUE" =~ $HOSTNAME_PATTERN ]]; then
        problem "$1 is not a host name: '$DOMAIN_VALUE'. Give a plain dotted name with an A record on the host, such as $2, with no scheme, port, path or spaces, or leave it empty to not serve that console."
    elif [[ "$DOMAIN_VALUE" =~ ^[0-9.]+$ ]]; then
        problem "$1 is an IP address: '$DOMAIN_VALUE'. The edge serves names, each with its own certificate; give the name whose A record points at this address."
    elif [ "${#DOMAIN_VALUE}" -gt 253 ] || [[ "$DOMAIN_VALUE" =~ [a-z0-9-]{64} ]]; then
        problem "$1 is longer than DNS allows (253 characters, 63 per label): '$DOMAIN_VALUE'."
    elif [[ "$DOMAIN_VALUE" =~ (^|\.)example\.(com|net|org)$ ]]; then
        warn "$1 is $DOMAIN_VALUE, an example name. No certificate authority issues one for it, so that site will not come up. Put the deployment's real name in $ENV_FILE."
    fi
}

# Sets PORT_VALUE to KEY's port, or DEFAULT when KEY is empty.
read_port() {
    local raw
    raw="$(env_value "$1")"
    PORT_VALUE="$2"
    [ -n "$raw" ] || return 0
    if ! [[ "$raw" =~ ^[0-9]{1,5}$ ]] || [ "$((10#$raw))" -lt 1 ] || [ "$((10#$raw))" -gt 65535 ]; then
        problem "$1 must be a port number 1-65535 (got: $raw)."
        return 0
    fi
    PORT_VALUE=$((10#$raw))
    # Caddy itself holds these on the host, so a console there would be the
    # edge proxying to itself.
    if [ "$PORT_VALUE" -eq 80 ] || [ "$PORT_VALUE" -eq 443 ]; then
        problem "$1 is $PORT_VALUE, the edge's own port. It is the loopback port the console is published on, such as $2."
    fi
}

read_domain ADMIN_DOMAIN admin.example.org
ADMIN_DOMAIN="$DOMAIN_VALUE"
read_port ADMIN_PORT "$DEFAULT_ADMIN_PORT"
ADMIN_PORT="$PORT_VALUE"

read_domain MANAGER_DOMAIN streaminfra.example.org
MANAGER_DOMAIN="$DOMAIN_VALUE"
read_port MANAGER_PORT "$DEFAULT_MANAGER_PORT"
MANAGER_PORT="$PORT_VALUE"

if [ -z "$ADMIN_DOMAIN" ] && [ -z "$MANAGER_DOMAIN" ]; then
    problem "neither ADMIN_DOMAIN nor MANAGER_DOMAIN is set, so there is nothing to serve. Set at least one."
elif [ -n "$ADMIN_DOMAIN" ] && [ "$ADMIN_DOMAIN" = "$MANAGER_DOMAIN" ]; then
    problem "ADMIN_DOMAIN and MANAGER_DOMAIN are both $ADMIN_DOMAIN. Each console needs a name of its own."
fi

ACME_EMAIL="$(env_value ACME_EMAIL)"
if [ -n "$ACME_EMAIL" ]; then
    if ! [[ "$ACME_EMAIL" =~ $EMAIL_PATTERN ]]; then
        problem "ACME_EMAIL is not an email address: '$ACME_EMAIL'. Leave it empty to register without one."
    elif [[ "$(lower "$ACME_EMAIL")" =~ @example\.(com|net|org)$ ]]; then
        # The account is shared by every site, so this would stop them all.
        problem "ACME_EMAIL is $ACME_EMAIL. Let's Encrypt refuses an account with an address at example.com, example.net or example.org, and no site would get a certificate. Give a real address or leave it empty."
    fi
fi

if [ "$PROBLEMS" -gt 0 ]; then
    die "$PROBLEMS problem(s) in $ENV_FILE. Nothing was sent. See $EDGE_DIR/.env.sample for what each key means."
fi

if [ -n "$ADMIN_DOMAIN" ] && [ -n "$MANAGER_DOMAIN" ] && [ "$ADMIN_PORT" = "$MANAGER_PORT" ]; then
    warn "ADMIN_PORT and MANAGER_PORT are both $ADMIN_PORT, so both names lead to the same console."
fi

# The sites, one "<domain> <port> <key> <label>" line each. Every field has
# been held to a pattern above or is fixed here, so none carries a space of
# its own or a quote.
SITES=""
if [ -n "$ADMIN_DOMAIN" ]; then
    SITES="${SITES}$ADMIN_DOMAIN $ADMIN_PORT ADMIN_PORT web2-admin console"$'\n'
    log "https://$ADMIN_DOMAIN -> 127.0.0.1:$ADMIN_PORT (web2-admin console)"
else
    log "ADMIN_DOMAIN is empty: the web2-admin console is not served"
fi
if [ -n "$MANAGER_DOMAIN" ]; then
    SITES="${SITES}$MANAGER_DOMAIN $MANAGER_PORT MANAGER_PORT streaming-infra-manager console"$'\n'
    log "https://$MANAGER_DOMAIN -> 127.0.0.1:$MANAGER_PORT (streaming-infra-manager console)"
else
    log "MANAGER_DOMAIN is empty: the streaming-infra-manager console is not served"
fi
DOMAINS="$(printf '%s' "$SITES" | awk '{ print $1 }' | tr '\n' ' ')"
DOMAINS="${DOMAINS% }"

# --- Prerequisites ------------------------------------------------------------

# As in deploy.sh: ConnectTimeout keeps an unreachable host from hanging the
# run, and BatchMode, only without a terminal, keeps ssh from asking for a
# passphrase or a host key on input nobody can answer.
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

# --- The Caddyfile ------------------------------------------------------------

# Caddy cannot take an empty site address, so a site that is not configured
# must not appear at all, which a template with placeholders cannot express.
# The file is therefore written here, from values checked above. It is
# formatted as `caddy fmt` would, since `caddy validate` warns otherwise.
render_caddyfile() {
    local domain port key label
    cat <<'HEADER'
# The host's HTTPS edge. Written by infra/edge/edge.sh from infra/edge/.env on
# the machine that ran it: change that file and run edge.sh again, since the
# next run replaces this one.
#
# Each site proxies to a console published on the host's loopback. Caddy runs
# on the host's network, so 127.0.0.1 here is the host's own. It obtains and
# renews every site's certificate itself, which needs the name's A record
# pointing at this host and ports 80 and 443 reachable from the internet.
# Port 80 answers the ACME challenge and redirects everything else to https,
# so a password is never sent in the clear.
#
# X-Forwarded-For and X-Forwarded-Proto are added by Caddy, and set rather
# than passed along, since no proxy in front of it is trusted. nginx in both
# consoles takes the client address from the first: its set_real_ip_from
# ranges cover the Docker bridge gateway the proxied connection arrives from.
# The API marks the session cookie Secure from the second. Host is passed
# through as the browser sent it, which the API's cross-site check compares
# with Origin.
{
	# No admin API. On the host's network it would listen on the host's
	# 127.0.0.1:2019, where any local user could rewrite the routes. A new
	# Caddyfile takes effect by recreating the container, as edge.sh does.
	admin off
HEADER
    if [ -n "$ACME_EMAIL" ]; then
        printf '\temail %s\n' "$ACME_EMAIL"
    fi
    printf '}\n'
    while read -r domain port key label; do
        [ -n "$domain" ] || continue
        printf '\n# The %s, published on the host at 127.0.0.1:%s (%s).\n' "$label" "$port" "$key"
        printf '%s {\n' "$domain"
        printf '\tencode zstd gzip\n\n'
        printf '\theader Strict-Transport-Security "max-age=31536000; includeSubDomains"\n\n'
        printf '\treverse_proxy 127.0.0.1:%s\n' "$port"
        printf '}\n'
    done <<<"$SITES"
}

# Written beside the target and moved over it, so a failed render never leaves
# half a Caddyfile for the next step to ship.
render_caddyfile >"$CADDYFILE.tmp"
mv "$CADDYFILE.tmp" "$CADDYFILE"
log "rendered $CADDYFILE"

# Given on standard input rather than bind-mounted. Docker Desktop can show a
# file mount of a path that was just replaced, as the render above does, as
# missing for a moment, and a remote Docker context has no such path at all.
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    log "validating it with $CADDY_IMAGE"
    if ! VALIDATION="$(docker run --rm -i "$CADDY_IMAGE" \
        caddy validate --config /dev/stdin --adapter caddyfile <"$CADDYFILE" 2>&1)"; then
        echo "$VALIDATION" >&2
        die "Caddy refused the rendered $CADDYFILE, with its reason above. Nothing was sent."
    fi
    log "Caddy accepts it"
else
    log "Docker is not running on this machine, so $CADDYFILE was not validated here. The host's Caddy is the first to read it, and a refusal shows as Caddy not staying up."
fi

# --- What runs on the host ----------------------------------------------------

# The compose file the host's steps run: the copy sent to the host's edge
# directory, or with --host=localhost, which runs them here, this checkout's.
if [ "$LOCAL" = true ]; then
    HOST_COMPOSE_FILE="$COMPOSE_FILE"
else
    HOST_COMPOSE_FILE="$HOST_EDGE_DIR/docker-compose.yml"
fi

# One line per site for the host script to check. Every value in it has been
# held to a pattern above, so none can end the single quotes it sits in, which
# goes for the path, project and service interpolated below as well. The
# script is written to ssh's standard input, and its body is one function
# called with input from /dev/null, for deploy.sh's reason: bash -s reads the
# script as it runs it, and a command reading standard input would swallow the
# lines after it.
upstream_checks() {
    local domain port key label
    while read -r domain port key label; do
        [ -n "$domain" ] || continue
        printf "check_upstream '%s' '%s' '%s' '%s'\n" "$domain" "$port" "$key" "$label"
    done <<<"$SITES"
}

host_script() {
    local cd_line=""
    if [ "$LOCAL" = false ]; then
        cd_line="cd '$REMOTE_PATH'"
    fi
    cat <<HOST_SCRIPT
edge_on_host() {
set -euo pipefail
$cd_line

docker compose version >/dev/null 2>&1 || {
    echo "[edge] ERROR: docker compose is not available on this host" >&2
    exit 1
}

compose() {
    docker compose -p '$PROJECT' -f '$HOST_COMPOSE_FILE' "\$@"
}

# The edge's container when it exists, whatever its state.
edge_container() {
    compose ps -aq '$SERVICE' 2>/dev/null | head -n 1 || true
}

report_failure() {
    echo "[edge] ERROR: \$1" >&2
    compose ps -a >&2 || true
    echo "[edge] last log lines:" >&2
    compose logs --no-color --tail=40 >&2 || true
    exit 1
}

# Ports 80 and 443 belong to one process per host. Compose would start the
# edge anyway and Caddy would restart forever unable to bind, so the question
# is asked first. A container that publishes either port is named, and this
# edge publishes nothing, being on the host's network, so it never counts.
HOLDERS="\$(docker ps --filter publish=80 --filter publish=443 --format '{{.Names}}|{{.Label "com.docker.compose.project"}}')"
OTHERS=""
while IFS='|' read -r name project; do
    [ -n "\$name" ] || continue
    [ "\$project" = '$PROJECT' ] && continue
    OTHERS="\${OTHERS:+\$OTHERS, }\$name\${project:+ (compose project \$project)}"
done <<<"\$HOLDERS"
if [ -n "\$OTHERS" ]; then
    echo "[edge] ERROR: port 80 or 443 of this host is already published by \$OTHERS, and only one thing per host can hold them. Nothing was started." >&2
    echo "[edge] If that is the manager's own edge (compose project manager, container manager-edge-1), empty MANAGER_DOMAIN in the manager's manager/.env and deploy the manager again, which removes it, then run edge.sh again. Put the manager's name in MANAGER_DOMAIN of infra/edge/.env instead." >&2
    exit 1
fi

# Something that is not a published container can hold the ports too: a web
# server installed on the host, or a container on the host's network. Asked
# only while this edge is not running, since a running edge is itself what
# listens there.
EDGE_ID="\$(edge_container)"
EDGE_STATE=""
if [ -n "\$EDGE_ID" ]; then
    EDGE_STATE="\$(docker inspect -f '{{.State.Status}}' "\$EDGE_ID" 2>/dev/null || true)"
fi
if [ "\$EDGE_STATE" != running ] && command -v ss >/dev/null 2>&1; then
    LISTENERS="\$(ss -ltn 2>/dev/null | awk 'NR > 1 && \$4 ~ /:(80|443)\$/ { print \$4 }' | tr '\n' ' ' | sed 's/ \$//')"
    if [ -n "\$LISTENERS" ]; then
        echo "[edge] ERROR: something on this host already listens on \$LISTENERS, so Caddy could not bind. sudo ss -ltnp names it. Nothing was started." >&2
        exit 1
    fi
fi

# Recreated every time rather than left to compose's judgement. The Caddyfile
# is a bind-mounted file, which pins the file the container started with: the
# one rsync just wrote under the same name is a new file, and a container
# compose considers up to date would go on serving the old one. The
# certificates are in the volumes, so the new container has them at once.
echo "[edge] starting compose project $PROJECT"
compose up -d --force-recreate --remove-orphans || report_failure "docker compose up failed, with its error above"

# Caddy's image has no healthcheck. A Caddyfile it refuses, or a port it
# cannot bind, makes it exit at once and the restart policy start it again,
# so one look can land in a moment it happens to be running. It counts as up
# once it is running with the same start time and restart count on two looks
# five seconds apart.
EDGE_ID="\$(edge_container)"
[ -n "\$EDGE_ID" ] || report_failure "compose reports no $SERVICE container after starting it"
DEADLINE=\$((SECONDS + 60))
PREVIOUS=""
while :; do
    STATE="\$(docker inspect -f '{{.State.Status}} {{.State.StartedAt}} {{.RestartCount}}' "\$EDGE_ID" 2>/dev/null || echo missing)"
    case "\$STATE" in
        "running "*) [ "\$STATE" = "\$PREVIOUS" ] && break ;;
    esac
    PREVIOUS="\$STATE"
    if [ "\$SECONDS" -ge "\$DEADLINE" ]; then
        report_failure "Caddy did not stay running within 60 seconds (status, start time, restarts: \$STATE). The log below says why, typically a port it cannot bind."
    fi
    sleep 5
done
echo "[edge] Caddy is running"

# Whether each console answers where the edge will look for it, asked from the
# host, as Caddy on the host's network will. This is the check that shows a
# host firewall dropping Docker's bridge traffic, where the loopback port
# accepts a connection and nothing ever answers.
UPSTREAM_FAILED=""
check_upstream() {
    local domain="\$1" port="\$2" key="\$3" label="\$4" code rc=0
    code="\$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:\$port/" 2>/dev/null)" || rc=\$?
    case "\$rc" in
        0)
            echo "[edge] \$label on 127.0.0.1:\$port answers (HTTP \$code): https://\$domain is served"
            return 0
            ;;
        7)
            echo "[edge] ERROR: nothing listens on 127.0.0.1:\$port, so https://\$domain answers 502. Deploy the \$label on this host, or set \$key in infra/edge/.env to the port docker ps shows for it." >&2
            ;;
        28)
            echo "[edge] ERROR: 127.0.0.1:\$port did not answer within 5 seconds, so https://\$domain will time out. If docker ps shows the \$label healthy on that port, the host's firewall is dropping Docker's bridge traffic: see \"When a loopback port connects but nothing answers\" in apps/web2-admin/deploy/README.md." >&2
            ;;
        52 | 56)
            echo "[edge] ERROR: 127.0.0.1:\$port closed the connection without an answer, so https://\$domain answers 502. Check the \$label with docker ps." >&2
            ;;
        *)
            echo "[edge] ERROR: asking 127.0.0.1:\$port for the \$label failed (curl exit \$rc)." >&2
            ;;
    esac
    UPSTREAM_FAILED="\${UPSTREAM_FAILED:+\$UPSTREAM_FAILED, }\$label on 127.0.0.1:\$port"
}
if command -v curl >/dev/null 2>&1; then
$(upstream_checks)
else
    echo "[edge] WARNING: curl is not installed on this host, so the consoles behind the edge were not checked. sudo apt-get install -y curl" >&2
fi

if [ -n "\$UPSTREAM_FAILED" ]; then
    echo "[edge] the edge is running, but not everything behind it answers: \$UPSTREAM_FAILED" >&2
    exit $UPSTREAM_EXIT
fi
echo "[edge] the edge is up"
}
edge_on_host </dev/null
HOST_SCRIPT
}

HOST_RC=0
if [ "$LOCAL" = true ]; then
    log "starting the edge on this machine, from $REPO_ROOT"
    host_script | bash -s || HOST_RC=$?
else
    # edge.sh writes into deploy/edge/ and nowhere else, and deletes nothing,
    # but a mistyped --remote-path would still scatter files into somebody's
    # directory. The target must be new, empty, a checkout of this repository
    # (the test deploy.sh uses), or a directory an earlier run wrote into.
    if ! ssh "${SSH_OPTS[@]}" "$HOST" "mkdir -p '$REMOTE_PATH' && { { [ -f '$REMOTE_PATH/deploy/deploy.sh' ] && { [ -d '$REMOTE_PATH/web2-admin' ] || [ -f '$REMOTE_PATH/backend/Dockerfile' ]; }; } || [ -d '$REMOTE_PATH/$HOST_EDGE_DIR' ] || [ -z \"\$(ls -A '$REMOTE_PATH')\" ]; } && mkdir -p '$REMOTE_PATH/$HOST_EDGE_DIR'" </dev/null; then
        die "$HOST:$REMOTE_PATH could not be created, or it is a non-empty directory that is neither a checkout of this repository nor one an earlier edge.sh wrote into. Nothing was sent."
    fi
    # The two files the host needs. The env file stays here: the compose file
    # interpolates nothing, and the Caddyfile already says what it serves.
    log "rsync $CADDYFILE and $COMPOSE_FILE to $HOST:$REMOTE_PATH/$HOST_EDGE_DIR/"
    rsync -az -e "ssh ${SSH_OPTS[*]}" "$CADDYFILE" "$COMPOSE_FILE" "$HOST:$REMOTE_PATH/$HOST_EDGE_DIR/"

    log "starting the edge on $HOST"
    host_script | ssh "${SSH_OPTS[@]}" "$HOST" bash -s || HOST_RC=$?
fi

UPSTREAM_PROBLEM=false
case "$HOST_RC" in
    0) ;;
    "$UPSTREAM_EXIT") UPSTREAM_PROBLEM=true ;;
    *) die "the edge was not started, or did not stay up, with the reason above (exit $HOST_RC)" ;;
esac

# --- From the outside ---------------------------------------------------------

LOGS_CMD="docker compose -p $PROJECT -f $HOST_COMPOSE_FILE logs -f"
if [ "$LOCAL" = true ]; then
    WATCH="$LOGS_CMD"
else
    WATCH="ssh -t $HOST 'cd $REMOTE_PATH && $LOGS_CMD'"
fi

# The address ssh reaches the host at, when ~/.ssh/config gives it as an IPv4
# address, to compare with what the names resolve to. Read with `ssh -G`,
# which prints the configuration and connects nowhere.
TARGET_ADDRESS=""
if [ "$LOCAL" = false ]; then
    TARGET_ADDRESS="$(ssh -G "$HOST" 2>/dev/null | awk '$1 == "hostname" { print $2; exit }' || true)"
    [[ "$TARGET_ADDRESS" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || TARGET_ADDRESS=""
fi

resolved() {
    if command -v dig >/dev/null 2>&1; then
        dig +short A "$1" 2>/dev/null | grep -E '^[0-9.]+$' | tr '\n' ' ' | sed 's/ $//' || true
    fi
}

# What https://<domain>/ says from here, with curl verifying the certificate
# as a browser would. Sets PROBE_RC and PROBE_CODE.
probe_https() {
    PROBE_RC=0
    PROBE_CODE="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "https://$1/" 2>/dev/null)" || PROBE_RC=$?
}

report_answer() {
    local domain="$1" addresses code
    addresses="$(resolved "$domain")"
    if [ "$PROBE_CODE" = 502 ]; then
        warn "https://$domain has its certificate, but Caddy gets no answer from the console behind it (HTTP 502)."
    else
        log "https://$domain answers with a valid certificate (HTTP $PROBE_CODE)"
    fi
    code="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "http://$domain/" 2>/dev/null || true)"
    case "$code" in
        30[178]) log "http://$domain redirects to https (HTTP $code)" ;;
        000 | "") warn "http://$domain did not answer. Port 80 is probably closed in the provider's firewall: plain http:// links then fail, and Caddy renews over 443 alone." ;;
        *) warn "http://$domain answered HTTP $code instead of redirecting to https." ;;
    esac
    [ -n "$addresses" ] && log "$domain resolves to $addresses"
    return 0
}

report_pending() {
    local domain="$1" rc="$2" addresses
    addresses="$(resolved "$domain")"
    case "$rc" in
        6)
            warn "$domain does not resolve, so no certificate can be issued for it (dig +short $domain prints ${addresses:-nothing}). Add an A record for it pointing at the host; Caddy keeps trying, and the site comes up once the name resolves."
            ;;
        7 | 28)
            warn "https://$domain did not answer from here (curl exit $rc). Check that port 443 is open in the provider's firewall and that $domain points at the host${addresses:+: it resolves to $addresses}."
            ;;
        35 | 51 | 60)
            warn "https://$domain has no valid certificate yet (curl exit $rc). The first one usually takes under a minute; watch it with: $WATCH"
            ;;
        *)
            warn "https://$domain could not be asked (curl exit $rc)."
            ;;
    esac
    if [ -n "$TARGET_ADDRESS" ] && [ -n "$addresses" ] && [[ " $addresses " != *" $TARGET_ADDRESS "* ]]; then
        warn "$domain resolves to $addresses, which does not include $TARGET_ADDRESS, the address ssh reaches $HOST at. If that is the host's public address, the A record points elsewhere."
    fi
}

if [ "$PROBE_TIMEOUT" -eq 0 ]; then
    log "PROBE_TIMEOUT=0: not asking the sites from here"
elif ! command -v curl >/dev/null 2>&1; then
    log "curl is not installed on this machine, so the sites were not asked from here"
else
    log "asking each site from here, for up to ${PROBE_TIMEOUT}s while certificates arrive"
    # Each round asks every name still pending, as "<domain>:<last curl exit>".
    # A name answers, fails to resolve (which waiting will not fix), or stays
    # pending until the time is up.
    PENDING=""
    for domain in $DOMAINS; do
        PENDING="$PENDING $domain:none"
    done
    DEADLINE=$((SECONDS + PROBE_TIMEOUT))
    while :; do
        NEXT=""
        for item in $PENDING; do
            domain="${item%%:*}"
            probe_https "$domain"
            case "$PROBE_RC" in
                0) report_answer "$domain" ;;
                6) report_pending "$domain" 6 ;;
                *) NEXT="$NEXT $domain:$PROBE_RC" ;;
            esac
        done
        PENDING="$NEXT"
        [ -n "$PENDING" ] || break
        [ "$SECONDS" -lt "$DEADLINE" ] || break
        sleep 5
    done
    for item in $PENDING; do
        report_pending "${item%%:*}" "${item##*:}"
    done
    if [ -n "$PENDING" ]; then
        log "a certificate that is not there yet does not fail this run: Caddy goes on asking in the background"
    fi
fi

log "done: the edge on $HOST serves $DOMAINS"
log "watch the certificates: $WATCH"
# The way in that does not depend on the edge, its certificates or DNS.
if [ "$LOCAL" = false ]; then
    while read -r domain port key label; do
        [ -n "$domain" ] || continue
        log "without the edge, the $label: ssh -L $port:localhost:$port $HOST, then http://localhost:$port"
    done <<<"$SITES"
fi

if [ "$UPSTREAM_PROBLEM" = true ]; then
    die "the edge is up, but a console behind it does not answer on the host's loopback (above). Fix that and run edge.sh again."
fi
