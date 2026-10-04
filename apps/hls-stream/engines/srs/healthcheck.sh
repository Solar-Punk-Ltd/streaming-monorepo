#!/usr/bin/env bash
#
# Answer whether this container can actually receive a broadcast, which is a different question from
# whether its process is running.
#
# On 2026-08-03 an SRS container ran 44 minutes with its SRT listener dead. SRS had failed to bind
# with `errno=98` because another container still held the port under host networking, and it wrote
# nothing about that to its log until it was stopped. Throughout, `docker ps` said `Up`, the
# uploader's `/health` said `ok` with `activeStreams: 0`, and the container healthcheck was satisfied.
# Every one of those reports on a process that exists. None of them reports on a socket that listens.
#
# ## Why the port being bound is not the check
#
# During that outage the port **was** bound, by the process that stole it, so a probe asking only
# "is anything listening on the SRT port" passes for the entire failure. Under `network_mode: host`
# this container shares the host's network namespace and would see that stranger's socket as readily
# as its own. What separates the two states is ownership.
#
# The network namespace is shared and the PID namespace is not. So the inode the kernel reports for
# each listening socket, in `/proc/net/udp` for SRT and `/proc/net/tcp` for RTMP, is compared against
# the socket inodes held by processes **in this container**, and a listener nothing here owns fails
# exactly as loudly as no listener at all.
#
# ## Scope
#
# Both ingest listeners, and both must pass: SRT on UDP and RTMP on TCP. RTMP is a public ingest as
# SRT is, and it also carries the ABR ladder's rung republishes, which SRS's own encoders send back to
# its RTMP listener over loopback, so a dead RTMP listener stops the ladder as well as every RTMP
# broadcaster. The HTTP API is not checked, because no broadcast depends on it.
#
# Usage:
#   healthcheck.sh [SRT_PORT] [PROC_DIR] [RTMP_PORT]
#
# SRT_PORT defaults to $SRS_SRT_PORT then to 10080, and RTMP_PORT to $SRS_RTMP_PORT then to 1935, the
# compose defaults. Both compose files put both variables into this container's environment, and they
# are what the entrypoint writes SRS's `listen` lines from, so compose runs this with no arguments. A
# config file of the operator's own that listens elsewhere has to set the variables to match. PROC_DIR
# defaults to /proc and exists so the tests can drive this against a tree they built, rather than
# against a kernel they cannot make fail on purpose.
set -euo pipefail

SRT_PORT="${1:-${SRS_SRT_PORT:-10080}}"
PROC_DIR="${2:-/proc}"
RTMP_PORT="${3:-${SRS_RTMP_PORT:-1935}}"

for port in "${SRT_PORT}" "${RTMP_PORT}"; do
  case "${port}" in
    '' | *[!0-9]*)
      echo "srs healthcheck: '${port}' must be a port number" >&2
      exit 2
      ;;
  esac
done

# The kernel's state for a TCP socket that is listening. A connection SRS accepted shares the
# listener's local port, so without this a dead listener with one open connection would still pass.
# UDP has no listening state, and an SRT socket is matched on its port alone.
TCP_LISTEN=0A

# Inodes of the sockets bound to PORT in the given /proc/net files, in STATE when one is given.
# `$2` is `local_address`, `$4` the state and `$10` the socket inode. The kernel writes a local
# address as uppercase hex, four digits for a port, and the match is anchored at the end of the field,
# so a port whose spelling contains another's is not mistaken for it. Both families are read because
# SRS binds whichever the host offers, and a v6 listener serving v4 clients is the ordinary case.
bound_inodes() {
  local port="$1" state="$2"
  shift 2
  awk -v port=":$(printf '%04X' "${port}")" -v state="${state}" \
    'FNR > 1 && index($2, port) == length($2) - length(port) + 1 && (state == "" || $4 == state) { print $10 }' \
    "$@" 2>/dev/null || true
}

# Every socket held by every process in this container's PID namespace, which under host networking
# is the only thing distinguishing our listener from someone else's.
owned_inodes="$(
  for fd in "${PROC_DIR}"/[0-9]*/fd/*; do
    [ -L "${fd}" ] || continue
    target="$(readlink "${fd}" 2>/dev/null || echo '')"
    # A socket link reads `socket:[12345]`. Matched by stripping the prefix rather than by a glob,
    # because the brackets are pattern syntax in both `case` and `${var#...}` and quoting them there
    # is the kind of detail that silently matches nothing.
    if [ "${target}" != "${target#socket:}" ]; then
      printf '%s\n' "${target}" | tr -dc '0-9'
      printf '\n'
    fi
  done
)"

# Returns when one of LISTENING is held here, and otherwise exits naming the protocol and the port.
require_held() {
  local listener="$1" listening="$2" unreachable="$3" stolen="$4" inode owned
  if [ -z "${listening}" ]; then
    echo "srs healthcheck: nothing is listening on ${listener}, so ${unreachable}" >&2
    exit 1
  fi
  for inode in ${listening}; do
    for owned in ${owned_inodes}; do
      if [ "${inode}" = "${owned}" ]; then
        return 0
      fi
    done
  done
  echo "srs healthcheck: ${listener} is bound by a process outside this container, so ${stolen}" >&2
  exit 1
}

require_held "UDP ${SRT_PORT} (SRT)" \
  "$(bound_inodes "${SRT_PORT}" '' "${PROC_DIR}/net/udp" "${PROC_DIR}/net/udp6")" \
  "no broadcaster can reach this engine over SRT" \
  "SRS never got the socket and every SRT publish will be refused while nothing in the log says so."

require_held "TCP ${RTMP_PORT} (RTMP)" \
  "$(bound_inodes "${RTMP_PORT}" "${TCP_LISTEN}" "${PROC_DIR}/net/tcp" "${PROC_DIR}/net/tcp6")" \
  "no broadcaster can reach this engine over RTMP and no ladder rung can republish" \
  "SRS never got the socket and every RTMP publish, the ladder's rungs included, will be refused."
