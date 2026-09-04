#!/usr/bin/env bash
# Pushes the monitoring stack to the monitoring host and brings it up.
#
# Terraform renders and stops there: config-then-reload ordering inside a plan graph is how a
# plan stops being idempotent. This script is the applier, the same split deploy/deploy.sh uses.
#
#   ./push.sh [ssh-alias]      # alias defaults to "monitoring"
set -euo pipefail

ALIAS="${1:-monitoring}"
[[ "$ALIAS" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "push.sh: alias '$ALIAS' is not a rendered host alias" >&2; exit 1; }

STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$(cd "$STACK_DIR/../.." && pwd)"
SSH_CONFIG="$TF_DIR/rendered/ssh_config"
RENDERED_DIR="$TF_DIR/rendered/monitoring"
REMOTE_DIR="/home/solarpunk/monitoring"

for required in "$SSH_CONFIG" "$RENDERED_DIR"; do
  if [ ! -e "$required" ]; then
    echo "push.sh: $required is missing — run terraform apply first" >&2
    exit 1
  fi
done

# Array for direct invocation so a space in the checkout path cannot split the command.
# rsync's -e takes a string and does its own splitting; that one stays a join.
SSH_BIN=(ssh -F "$SSH_CONFIG")

# No --delete: the static stack and the rendered files land in the same remote directory, so
# each pass would delete the other's files.
rsync -az --exclude 'push.sh' -e "${SSH_BIN[*]}" "$STACK_DIR/" "$ALIAS:$REMOTE_DIR/"
rsync -az -e "${SSH_BIN[*]}" "$RENDERED_DIR/" "$ALIAS:$REMOTE_DIR/"

# shellcheck disable=SC2029 # REMOTE_DIR is a local constant, expanding it here is intended
"${SSH_BIN[@]}" "$ALIAS" "cd $REMOTE_DIR && docker compose pull --quiet && docker compose up -d"

# `up -d` never recreates a container because bind-mounted content changed, so the rsync above
# would otherwise land without effect: SIGHUP reloads Prometheus config and rules without the
# lifecycle endpoint, and Grafana re-reads provisioning only at start.
#
# The SIGHUP is sent from INSIDE the container (busybox kill to PID 1), never as `docker kill`:
# Docker records any `docker kill`, whatever the signal, as a manual stop, and that disarms
# `restart: unless-stopped` at the next daemon shutdown or host stop. That is how Prometheus
# alone stayed down after the 2026-09-02 pause while the other three containers came back.
# shellcheck disable=SC2029 # REMOTE_DIR is a local constant, expanding it here is intended
"${SSH_BIN[@]}" "$ALIAS" "cd $REMOTE_DIR && docker compose exec -T prometheus sh -c 'kill -HUP 1' && docker compose restart grafana"

echo "push.sh: stack up on $ALIAS. Grafana: ${SSH_BIN[*]} -L 3000:localhost:3000 $ALIAS"
