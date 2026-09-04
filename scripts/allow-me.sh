#!/usr/bin/env bash
# Let this machine's current public IPv4 address reach the SRT ingest port(s) for a test window.
#
#   scripts/allow-me.sh        allow <my public ip>/32 (replaces any earlier allowance)
#   scripts/allow-me.sh off    close it again
#
# It writes operator.auto.tfvars (gitignored, auto-loaded by Terraform from this directory) and
# runs the same plan/apply the runbook uses, so the rule stays Terraform-owned and there is no
# drift to discover later. One address at a time, on purpose: a re-run after the home router
# changed address replaces the old one rather than accumulating. Production never needs this —
# the venue encoder has a static address and goes into srt_source_ranges in envs/poc.tfvars.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TFVARS="${TFVARS:-envs/poc.tfvars}"
OPERATOR_FILE="operator.auto.tfvars"
cd "$ROOT"

# Terraform authenticates through Application Default Credentials, which the Workspace reauth
# policy expires on its own clock (`invalid_rapt`). The gcloud CLI credential is the one that has
# to be fresh anyway for the IAP tunnels, so borrow its token: both the gcs backend and the
# google provider honour GOOGLE_OAUTH_ACCESS_TOKEN, and one credential to keep alive beats two.
export GOOGLE_OAUTH_ACCESS_TOKEN="${GOOGLE_OAUTH_ACCESS_TOKEN:-$(gcloud auth print-access-token)}"

case "${1:-on}" in
  on)
    IP="$(curl -4 -fsS --max-time 10 https://api.ipify.org)"
    # The value lands inside HCL: anything but a dotted quad is refused, never spliced.
    if ! [[ "$IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
      echo "allow-me: could not determine this machine's public IPv4 address (got '$IP')" >&2
      exit 1
    fi
    printf '# Written by scripts/allow-me.sh — gitignored, never commit. Close with: scripts/allow-me.sh off\nsrt_operator_source_ranges = ["%s/32"]\n' "$IP" > "$OPERATOR_FILE"
    echo "allow-me: allowing $IP/32 on the SRT ingest port(s)"
    ;;
  off)
    rm -f "$OPERATOR_FILE"
    echo "allow-me: removing the operator allowance"
    ;;
  *)
    echo "usage: $0 [on|off]" >&2
    exit 2
    ;;
esac

# -detailed-exitcode: 0 = nothing to change, 2 = changes planned, 1 = error.
set +e
terraform plan -input=false -var-file="$TFVARS" -out=tfplan -detailed-exitcode
rc=$?
set -e
case $rc in
  0) echo "allow-me: the firewall is already in the requested state" ;;
  2) terraform apply -input=false tfplan ;;
  *) exit "$rc" ;;
esac
rm -f tfplan

if [ "${1:-on}" = "on" ]; then
  echo
  echo "Point the encoder at the EXTERNAL address (the internal one is VPC-only):"
  terraform output srt_ingest_endpoints
  echo 'OBS server field: srt://<endpoint>?streamid=#!::r=live/stream,m=publish'
fi
