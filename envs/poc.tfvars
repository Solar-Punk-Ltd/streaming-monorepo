project_id     = "streaming-504704"
ssh_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGW7evFxxJK2rb7KQmvvandmtjf8DFthn5X7+lcis2kG your_email@example.com"

# The test feed pushes from inside GCP, so the VPC subnets are the sources and the encoder aims
# at the stage's INTERNAL IP. A real external encoder later (the venue) is one /32 added here,
# aimed at the external IP instead. A feed run on the stage host itself needs no rule at all.
srt_source_ranges = ["10.60.1.0/24", "10.60.2.0/24"]

# machine: t2d-standard-8 is 8 physical Milan cores where n2-standard-8 is 4 cores
# hyperthreaded, and it is cheaper in both regions. It earns no sustained-use discount, which
# costs nothing here: a test window below a quarter of the month earns 0% SUD anyway. Cheaper
# candidates once there is a measured run to size against: c2d-highcpu-8 / c3d-highcpu-8 — check
# the manager plus Postgres share against their 16 GB first. Verify availability in both zones
# before the first apply:
#   gcloud compute machine-types list --filter="name=t2d-standard-8 AND zone~'europe-west3-a|asia-south1-a'"
stages = {
  # Stage 1 — EU, ~10 ms from the Bee publishers in Frankfurt (terraform/vultr). Live since M2 (2026-09-01).
  # srt_port: SRS SRT = 10001 + port_slot*10, and the slot is whatever the manager assigns the ABR
  # Uploader profile — slots are global across one manager's database, not per host. Read the slot
  # off the profile in the manager UI and set this to match, then apply; the firewall admits only
  # this port.
  stage1 = {
    region   = "europe-west3"
    srt_port = 10051
    machine  = "t2d-standard-8"
  }
  # Stage 2 — Mumbai (M3). Uncommenting this entry IS the M3 rollout step.
  # stage2 = {
  #   region   = "asia-south1"
  #   srt_port = 10011
  #   machine  = "t2d-standard-8"
  # }
}

# The Bee hosts at Vultr, allowed to push container logs into Loki on the monitoring host. There
# is no shared identity plane between the clouds, so this is IP-keyed. Fill it from the other
# root — `cd vultr && terraform output bee_host_ips` — as /32s, then apply. Empty means those
# hosts' metrics arrive and their logs do not.
loki_push_source_ranges = ["108.61.171.132/32"] # bee1, terraform/vultr output bee_host_ips

# The streaming-infra-manager host (Hetzner, static). It deploys the ABR uploader to the stage
# hosts over plain ssh, so it gets tcp/22 on them directly and its deploy key on user solarpunk.
# Humans keep using IAP through rendered/ssh_config.
ssh_source_ranges = ["65.108.40.56/32"]
additional_ssh_public_keys = [
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJcfXyVNl9YhCXekkm2c8dodKJrxgnliiQrKp9Vso5Le streaming-infra-manager@65.108.40.56",
]
