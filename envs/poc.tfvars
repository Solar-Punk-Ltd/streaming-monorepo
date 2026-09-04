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
  # Stage 1 — EU, ~10 ms from the Hetzner publishers. Live since M2 (2026-09-01).
  # srt_port: SRS SRT = 10001 + port_slot*10; the media profile takes slot 1 ⇒ 10011.
  stage1 = {
    region   = "europe-west3"
    srt_port = 10011
    machine  = "t2d-standard-8"
  }
  # Stage 2 — Mumbai (M3). Uncommenting this entry IS the M3 rollout step.
  # stage2 = {
  #   region   = "asia-south1"
  #   srt_port = 10011
  #   machine  = "t2d-standard-8"
  # }
}
