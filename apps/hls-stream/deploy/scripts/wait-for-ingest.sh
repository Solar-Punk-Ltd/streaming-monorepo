#!/bin/bash
#
# Block until SRS's two ingest listeners are actually there, SRT on its UDP port and RTMP on its TCP
# port, or give up loudly naming the one that is missing. The RTMP listener matters beyond RTMP
# broadcasters: the ladder's rungs republish over it.
#
# ## Why a separate check, when the container is already reported healthy
#
# Every signal the deployment has answers a question next to this one. `docker ps` says the process is
# running, the compose healthcheck says it answered on its HTTP port, and the uploader's `/health`
# says how many streams are active, which is zero both when nobody is publishing and when nobody can.
# None of them asks whether the ingest socket is bound.
#
# That gap was observed on a bench stage on 2026-08-03: SRS failed to bind its SRT listener with
# `errno=98` because a container from a previous stack still held the UDP port under host networking,
# and it ran 44 minutes reporting healthy and accepting nothing. The bind error was not written to the
# log until the container was stopped, so there was nothing to grep for while it mattered.
#
# `ss` answers the question directly and is the one thing that cannot be satisfied by a process that
# merely started.
#
# ## What each probe proves and what that costs
#
# SRT is UDP, so a bound socket is `UNCONN` rather than `LISTEN` and there is no handshake to observe
# from here. RTMP is TCP, and `-l` keeps its probe to a socket in `LISTEN`, so a broadcaster's open
# connection to the port cannot stand in for the listener it was accepted on. Either probe proves the
# port is claimed by something in the host's network namespace, which is what the failure above
# destroys. Neither proves that SRS is what holds it, which the container's own health check proves
# from inside, nor that the engine behind it will accept a publish. A deeper probe would have to
# publish, which spends money and takes a stream id.
#
# Usage:
#   deploy/scripts/wait-for-ingest.sh [--profile=<name>] [--portSlot=<N>] [--timeout=<seconds>]

# shellcheck source=_lib.sh
source "$(cd "$(dirname "$0")" && pwd)/_lib.sh"

require_jq
require_config

TIMEOUT_S=60
REMAINING_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --timeout=*) TIMEOUT_S="${arg#*=}" ;;
    *) REMAINING_ARGS+=("$arg") ;;
  esac
done

# Profile flag drives ENV_FILE / REMOTE_BASE / docker compose project name.
parse_profile_args ${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}

load_env
load_engine_envs
# The ports are read through the same slot arithmetic the deploy used rather than passed in, so this
# cannot end up watching a port no one was asked to bind.
apply_port_slot

SRT_PORT="${SRS_SRT_PORT:?SRS_SRT_PORT is unset after apply_port_slot, so there is no SRT port to wait on}"
RTMP_PORT="${SRS_RTMP_PORT:?SRS_RTMP_PORT is unset after apply_port_slot, so there is no RTMP port to wait on}"
TARGET="$(get_target srs)"

if ! is_enabled "${TARGET}"; then
  log_error "srs is disabled in config.json, so it has no ingest to wait for"
  exit 1
fi

# `-H` drops the header so an empty result is an empty string, and the filter is applied by `ss`
# rather than by grep, which would also match a port that merely contains these digits.
srt_probe='ss -H -lun "sport = :'"${SRT_PORT}"'"'
rtmp_probe='ss -H -ltn "sport = :'"${RTMP_PORT}"'"'

probe() {
  if [ "${TARGET}" = "localhost" ]; then
    bash -c "$1" 2>/dev/null
  else
    ssh "${TARGET}" "$1" 2>/dev/null
  fi
}

log_info "waiting up to ${TIMEOUT_S}s for SRS to listen for SRT on UDP ${SRT_PORT} and RTMP on TCP ${RTMP_PORT} (${TARGET})"

srt_bound=""
rtmp_bound=""
deadline=$((SECONDS + TIMEOUT_S))
while [ "${SECONDS}" -lt "${deadline}" ]; do
  srt_bound="$(probe "${srt_probe}")"
  rtmp_bound="$(probe "${rtmp_probe}")"

  if [ -n "${srt_bound}" ] && [ -n "${rtmp_bound}" ]; then
    log_ok "SRS ingest bound: SRT on UDP ${SRT_PORT}, RTMP on TCP ${RTMP_PORT}"
    exit 0
  fi
  sleep 2
done

if [ -z "${srt_bound}" ]; then
  log_error "no listener on UDP ${SRT_PORT} (SRT) after ${TIMEOUT_S}s, so no SRT broadcaster can reach SRS."
fi
if [ -z "${rtmp_bound}" ]; then
  log_error "no listener on TCP ${RTMP_PORT} (RTMP) after ${TIMEOUT_S}s, so no RTMP broadcaster can reach SRS"
  log_error "and no ladder rung can republish."
fi
log_error "SRS can be running in this state: check whether another container held the port when it"
log_error "started, with 'ss -lunp | grep ${SRT_PORT}' or 'ss -ltnp | grep ${RTMP_PORT}' on ${TARGET}."
exit 1
