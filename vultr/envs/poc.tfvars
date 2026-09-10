# The same key as ../../envs/poc.tfvars, character for character. One key across both roots is
# what lets one ~/.ssh/config reach every host in the pilot; two keys would mean two IdentityFile
# paths and a deploy script that works for one host and not the other.
ssh_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGW7evFxxJK2rb7KQmvvandmtjf8DFthn5X7+lcis2kG your_email@example.com"

# The streaming-infra-manager host (Hetzner, static): it deploys the Bee pools over ssh, so it is
# the one standing ssh source. A laptop is never listed here — open a window with
#   ./scripts/allow-me.sh          # this machine's current /32
#   ./scripts/allow-me.sh off      # close it again
ssh_source_ranges = ["65.108.40.56/32"]

# The same host reaches every rung's Bee API to buy and inspect postage batches. The GCP stage
# uploaders are admitted from the GCP root's state; this list is for addresses that state does not
# know.
bee_api_source_ranges = ["65.108.40.56/32"]

# The manager host's deploy key (~/.ssh/manager_deploy.pub on 65.108.40.56), installed for
# solarpunk on every Bee host by the provisioning script.
additional_ssh_public_keys = [
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJcfXyVNl9YhCXekkm2c8dodKJrxgnliiQrKp9Vso5Le streaming-infra-manager@65.108.40.56",
]

# region/plan: `fra` (Frankfurt) is ~10 ms from the GCP europe-west3 stage, which keeps the
# two-region measurement in docs/rollout/two-stage-terraform.md meaningful once stage2 exists.
#
# plan — 12 light Bee nodes is the target (three ABR ladders of four rungs). At the repo's own
# per-node envelope (tools/fleet-cost/model.py: 3 GB RAM, 40 GB disk, 0.5 threads per node, plus
# 2 GB for the OS) that is 38 GB of RAM, 480 GB of disk and 6 threads before the manager, its
# Postgres and the web UI:
#
#   vc2-16c-64gb  16 vCPU / 64 GB / 1280 GB SSD  / 10 TB transfer   $320/mo, $0.438/h   fra, bom
#                 → 20 nodes by RAM, 32 by disk, 32 by CPU. Real headroom for the manager.
#   vc2-8c-32gb    8 vCPU / 32 GB /  640 GB SSD  /  6 TB transfer   $160/mo             fra
#                 → 10 nodes by RAM, i.e. SHORT of twelve before the manager is counted. It is
#                   the cheap option for a two-ladder host, not for a three-ladder one.
#
# Vultr bills a stopped instance at the full rate, so "stop it between windows" — the GCP root's
# cost lever — does not exist here. The host either runs or is destroyed, and destroying it
# destroys the Bee wallets, keys and postage batches on its local disk. See README.md.
bee_hosts = {
  # Bee host 1 — EU, next to stage1 (europe-west3).
  bee1 = {
    region = "fra"
    plan   = "vc2-16c-64gb"
  }
}

# Defaults are 3 and 4 — three ABR ladders of four rungs, twelve slots. Stated here because the
# firewall's port band and its rule budget are the visible consequence, and because a host on the
# 32 GB plan should carry two ladders rather than three:
# ladders_per_host = 3
# rungs_per_ladder = 4
