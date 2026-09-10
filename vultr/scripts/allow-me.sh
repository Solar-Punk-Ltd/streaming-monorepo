#!/usr/bin/env bash
# Let this machine's current public IPv4 address reach sshd on the Bee hosts for a test window.
#
#   scripts/allow-me.sh        allow <my public ip>/32 (replaces any earlier allowance)
#   scripts/allow-me.sh off    close it again
#
# Same shape and the same reasoning as ../scripts/allow-me.sh, one port different: there the
# unauthenticated surface is SRT ingest, here it is a root-capable sshd on a public address. It
# writes operator.auto.tfvars (gitignored, auto-loaded by Terraform from this directory) and runs
# the same plan/apply the runbook uses, so the rule stays Terraform-owned and there is no drift
# to discover later. One address at a time, on purpose: a re-run after the home router changed
# address replaces the old one rather than accumulating.
#
# With this closed and ssh_source_ranges empty, the hosts have no reachable sshd at all — which
# is the resting state, and costs nothing: the Bee nodes keep publishing, Prometheus keeps
# scraping and Alloy keeps shipping, because none of that arrives over port 22.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TFVARS="${TFVARS:-envs/poc.tfvars}"
OPERATOR_FILE="operator.auto.tfvars"
cd "$ROOT"

# Checked before anything is written: the Vultr provider takes its credential from the
# environment and from nowhere else (see providers.tf), and without it the apply below fails
# several steps later with a provider error that does not say what to do.
if [ -z "${VULTR_API_KEY:-}" ]; then
  cat >&2 <<'MSG'
allow-me: VULTR_API_KEY is not set.
  Create a key at https://my.vultr.com/settings/#settingsapi, restrict it to your address with
  Vultr's API access control list, then:
      export VULTR_API_KEY=...
  It is never a Terraform variable and never belongs in envs/poc.tfvars.
MSG
  exit 1
fi

# Prove the key works FROM THIS ADDRESS before planning. A plan never calls Vultr (it reads GCP state
# and renders files), so a wrong key, or a key whose access-control list does not include this
# machine, only surfaces mid-apply as "Invalid API token" (Vultr answers a blocked source with a 401,
# not a 403) after the local resources have already been created. One cheap read catches both.
VULTR_ACCOUNT_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
  -H "Authorization: Bearer $VULTR_API_KEY" https://api.vultr.com/v2/account || echo 000)"
if [ "$VULTR_ACCOUNT_STATUS" != "200" ]; then
  cat >&2 <<MSG
allow-me: Vultr rejected the API key from this machine (GET /v2/account returned $VULTR_ACCOUNT_STATUS).
  A 401 usually means the key's access-control list does not include this address, not that the
  key is wrong: add it under Account -> API -> Access Control at my.vultr.com, then re-run.
  Also check that the key was pasted whole and that API access is enabled on the account.
MSG
  exit 1
fi

# The gcs backend AND data.tf's terraform_remote_state read of the GCP root both authenticate as
# Google, through Application Default Credentials, which a Workspace reauth policy expires on its
# own clock (`invalid_rapt`). Borrow the gcloud CLI token the same way ../scripts/allow-me.sh
# does: one credential to keep alive beats two.
# Always minted fresh, never inherited from the shell: an access token lives for an hour, and one
# exported by hand for an earlier command is exactly the thing that makes the backend fail with a
# bare "AuthenticationRequired" 401 while `gcloud auth login` has just succeeded.
export GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token)"

case "${1:-on}" in
  on)
    IP="$(curl -4 -fsS --max-time 10 https://api.ipify.org)"
    # The value lands inside HCL: anything but a dotted quad is refused, never spliced.
    if ! [[ "$IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
      echo "allow-me: could not determine this machine's public IPv4 address (got '$IP')" >&2
      exit 1
    fi
    printf '# Written by scripts/allow-me.sh — gitignored, never commit. Close with: scripts/allow-me.sh off\nssh_operator_source_ranges = ["%s/32"]\n' "$IP" > "$OPERATOR_FILE"
    echo "allow-me: allowing $IP/32 on tcp 22 for the Bee hosts"
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
  echo "Reach the hosts with the rendered config, or add the Include line to ~/.ssh/config so"
  echo "streaming-infra-manager's deploy/deploy.sh (which calls bare \`ssh <alias>\`) can resolve them:"
  terraform output ssh_hint
fi
