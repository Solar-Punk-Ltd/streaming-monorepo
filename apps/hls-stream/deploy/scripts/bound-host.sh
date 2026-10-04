# shellcheck shell=bash
#
# Sourced, never executed, so it carries a shell directive instead of a shebang.
#
# The address to dial, on the host that publishes it, for a port the stack binds to the host's Docker
# bridge address wherever its own setting is empty: the Bee APIs (BEE_UPLOADER_API_BIND,
# BEE_GATEWAY_API_BIND and each rung's *_API_BIND, or *_API_LISTEN under COMPOSE_NETWORK=host), SRS's
# HTTP server and API (SRS_HTTP_BIND, SRS_HTTP_API_BIND) and OME's HLS port (OME_HTTP_BIND). Nothing
# listens on 127.0.0.1 for those on a default Linux host, so a read from there gets no answer.
#
# `_lib.sh` sources this, and so does every script that runs on the deployment host without it.
#
# Usage, resolving the bridge once per run and the address per port:
#   bridge="$(bridge_address)"                 # this host
#   bridge="$(bridge_address "$TARGET")"       # a remote host, asked over ssh
#   host="$(bound_host "$(bee_api_bind BEE_GATEWAY)" "$bridge")"

BOUND_HOST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The bridge address the host that runs compose for <target> binds to, or this host's when <target>
# is empty or localhost. DOCKER_BRIDGE_ADDRESS wins when the stage's env files set it, and the daemon is
# then not asked. Otherwise docker-bridge-address.sh is run on that host, over ssh for a remote one,
# because the bridge is a fact about the host that publishes the ports. Prints nothing when it could
# not be read.
bridge_address_on() {
  local target="${1:-}"
  if [ -n "${DOCKER_BRIDGE_ADDRESS:-}" ]; then
    echo "$DOCKER_BRIDGE_ADDRESS"
    return 0
  fi
  if [ -n "$target" ] && [ "$target" != "localhost" ]; then
    ssh "$target" sh -s < "$BOUND_HOST_DIR/docker-bridge-address.sh" 2>/dev/null || true
  else
    sh "$BOUND_HOST_DIR/docker-bridge-address.sh" 2>/dev/null || true
  fi
}

# The same, falling back to 127.0.0.1 the way the compose files do when the deploy named no bridge.
bridge_address() {
  local bridge
  bridge="$(bridge_address_on "${1:-}")"
  echo "${bridge:-127.0.0.1}"
}

# The address a published port answers on, from its bind setting the way compose reads it: the
# address it names, 127.0.0.1 for every address, and <bridge> when it names none.
bound_host() {
  local bind="$1" bridge="$2"
  case "$bind" in
    '') echo "$bridge" ;;
    0.0.0.0 | '::' | '[::]') echo "127.0.0.1" ;;
    *) echo "$bind" ;;
  esac
}

# A Bee node's bind setting by its prefix: *_API_BIND on a bridge network, and under host networking
# *_API_LISTEN, the process's own address, which is the whole bind there.
bee_api_bind() {
  local key="${1}_API_BIND"
  [ "${COMPOSE_NETWORK:-}" = "host" ] && key="${1}_API_LISTEN"
  echo "${!key:-}"
}

# The address a Bee API port answers on, for a script that knows the port and not the node: the bind
# of the node whose *_API_PORT it is, and <bridge> for a port no node variable names.
bee_api_host_for_port() {
  local port="$1" bridge="$2" prefix port_var
  for prefix in BEE_UPLOADER BEE_RUNG_480P BEE_RUNG_720P BEE_RUNG_1080P BEE_GATEWAY; do
    port_var="${prefix}_API_PORT"
    if [ -n "${!port_var:-}" ] && [ "${!port_var}" = "$port" ]; then
      bound_host "$(bee_api_bind "$prefix")" "$bridge"
      return 0
    fi
  done
  echo "$bridge"
}
