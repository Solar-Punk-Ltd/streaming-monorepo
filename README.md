# Terraform for the two-stage POC

Implements [docs/rollout/two-stage-terraform.md](../docs/rollout/two-stage-terraform.md): the
cloud footing and nothing below it. One root module here, a one-off `bootstrap/` root for the
state bucket, static monitoring payload in `stacks/monitoring/`, and everything Terraform renders
lands under `rendered/` (gitignored) for an applier to push. Terraform never restarts a service
and never touches `BEE_PUBLISHERS`, `ABR_LADDER`, stamps or keys — those stay hand-authored.

## Prerequisites

- Terraform ≥ 1.9 (or `docker run hashicorp/terraform:1.15`), `gcloud` authenticated against the
  project (`gcloud auth login && gcloud auth application-default login`)
- On the project: rights to create compute, Secret Manager, service-account and storage
  resources, plus `roles/iap.tunnelResourceAccessor` for whoever will SSH
- For the appliers: `ssh`, `rsync`; the media deploy additionally follows
  `streaming-infra-manager/deploy/README.md`
- Nothing to install on the hosts: the startup scripts provision docker, `node_exporter` and the
  Grafana Alloy log shipper themselves on first boot

## First time

```sh
cd bootstrap
terraform init
terraform apply -var project_id=<project> -var state_bucket_name=<globally-unique-name>
cd ..
cp envs/poc.backend.hcl.example envs/poc.backend.hcl   # fill in the bucket name
terraform init -backend-config=envs/poc.backend.hcl
```

Then edit `envs/poc.tfvars`: `project_id`, `ssh_public_key` (installed for user `solarpunk` on
every host), and `srt_source_ranges` (the encoder's address — `0.0.0.0/0` is rejected). A laptop
streaming during a test window is not an entry here; see "Letting a laptop in" below.

## Rollout, in the plan's milestones

**M1 — monitoring first.** With every stage commented out in `poc.tfvars`:

```sh
terraform apply -var-file=envs/poc.tfvars
./stacks/monitoring/push.sh            # rsync stack + rendered targets, compose up -d
ssh -F rendered/ssh_config -L 3000:localhost:3000 monitoring   # Grafana
```

Grafana's admin password: `gcloud secrets versions access latest --secret=devcon-grafana-admin`.
This host ships its own containers' logs to its own Loki from first boot, so the Loki datasource
has something in it before any stage exists — which is also how you tell a broken shipper on a
stage host from a broken Loki.
Dashboards are file-provisioned — drop JSON into
`stacks/monitoring/grafana/provisioning/dashboards/` (Node Exporter Full, grafana.com ID 1860,
is the useful first one) and push again.

**M2 — stage 1.** Uncomment `stage1` (europe-west3), apply, then hand the host its config:

```sh
terraform apply -var-file=envs/poc.tfvars
scp -p -F rendered/ssh_config rendered/stage1/manager.env stage1:/home/solarpunk/streaming-infra-manager/manager/.env
./stacks/monitoring/push.sh            # picks up the new scrape target
```

What M2 gives you before anything is deployed on the host: `node_exporter` scraped by Prometheus,
and Alloy shipping every container's logs to Loki — including the manager, Postgres, SRS and the
uploader from the moment they first start, with no step of its own. See "Reading the logs" below.

Deploy the manager stack per `streaming-infra-manager/deploy/README.md` (its deploy.sh works
with `ssh -F` aliases), then drive the media profile from the manager. Two things the plan
insists on: run the media stack from the ABR lineage (`main` predates `BEE_PUBLISHERS`), and
always deploy with `--portSlot >= 1` — slot 1 puts SRT on 10011, which is what the firewall and
`poc.tfvars` assume. The SRT passphrase for the hand-authored engine env:
`gcloud secrets versions access latest --secret=devcon-srt-passphrase-stage1`.

**M3 — stage 2** is uncommenting `stage2` and running the same two commands as M2.

**M4 — destroy and rebuild stage 2:**

```sh
terraform apply -var-file=envs/poc.tfvars -replace='google_compute_instance.stage["stage2"]'
scp -p -F rendered/ssh_config rendered/stage2/manager.env stage2:/home/solarpunk/streaming-infra-manager/manager/.env
```

then redeploy the manager stack and the media profile exactly as in M2 — the recovery procedure
IS the M2 procedure, which is what the test proves. Nothing else moves: both of the host's
addresses are reserved (external and internal), so the Hetzner allowlist, the Prometheus target
in `nodes.json` and the ssh alias all stay valid, no `push.sh` re-run is needed, and no host key
needs clearing (identity comes from IAP, which opens the tunnel by instance name against IAM).

## Day-to-day access

```sh
ssh -F rendered/ssh_config stage1                                  # or: monitoring
ssh -F rendered/ssh_config -L 8080:localhost:8080 stage1           # manager web UI
```

Aliases must stay dotless — `swarm-hls-stream` resolves deploy targets through `ssh -G` only for
names without a dot.

## Reading the logs

Every host runs Grafana Alloy, which discovers the containers on it from the docker socket and
ships their stdout and stderr to Loki on the monitoring host. Open Grafana over the tunnel above,
go to **Explore → Loki**, and query by label:

```logql
{host="devcon-stage-stage1", container="stage1-srs-1"}     # one container
{host="devcon-stage-stage1"} |= "error"                    # a whole host, filtered
{compose_project="devcon-monitoring"}                       # the monitoring stack itself
```

The labels are `host` (instance name), `role` (`stage` or `monitoring`), `stage` (the stage key,
or `monitoring`), `container`, `compose_project` and `compose_service`. `role` and `stage` carry
exactly the values the Prometheus targets do, so a dashboard panel and a log query can be lined
up on the same host without a translation table.

Nothing is configured per container: a new profile, a resized ladder or a redeployed stack shows
up in Loki on its own. Two consequences worth knowing:

- **Retention is 14 days**, enforced by Loki's compactor (`stacks/monitoring/loki/loki.yaml`) and
  not by anything on the stage hosts. The logs share a disk with the Prometheus TSDB, which is why
  it is a number and not "keep everything".
- **`docker logs` on the host is still the ground truth** for the last few minutes, and the place
  to look when Loki itself is the thing that is broken. Alloy keeps its read positions in a named
  volume, so a host that could not reach Loki for a while catches up rather than starting over.

To change what is shipped, edit `templates/alloy_provision.sh.tftpl` — see the operational note
below on making a startup-template edit take effect.

## Letting a laptop in for a test window

```sh
./scripts/allow-me.sh          # allow this machine's current public /32 on the SRT port(s)
./scripts/allow-me.sh off      # close it again
```

The script writes the gitignored `operator.auto.tfvars` and runs the usual plan/apply, so the
rule stays Terraform-owned. Run it again when the home router's address changes; one address is
held at a time, so a re-run replaces the old one. Whoever applies from a checkout without that
file closes the door, which is the right default. Then aim the encoder at the stage's **external**
address (output `srt_ingest_endpoints`; the internal `10.60.x.x` address is reachable only from
inside the VPC): `srt://<external-ip>:10011?streamid=#!::r=live/stream,m=publish`. Production
never needs this: the venue encoder has a static address and belongs in `srt_source_ranges`.

## Operational notes

- **Two Google credentials are in play.** Terraform (backend and provider) uses Application Default
  Credentials; `gcloud` and the IAP tunnels use the CLI login. A Workspace reauth policy expires
  them separately, so a Terraform run can fail with `invalid_rapt` while ssh still works: run
  `gcloud auth application-default login` again, or for one run export
  `GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token)`, which is what `allow-me.sh` does.
- **Startup-template edits are in-place metadata updates** that take effect on the next boot — the
  apply itself changes nothing on a running host, which is what keeps such an edit safe to land
  mid-window. To apply one to a host that is already up, in increasing order of disruption:
  `ssh -F rendered/ssh_config <alias> sudo google_metadata_script_runner startup` re-runs the
  script in place (idempotent by design — the apt work is behind a marker file, and the Alloy
  stack is recreated from the config it just wrote); a reboot; or `-replace`, which rebuilds the
  host. Apply first, then re-run: the runner reads the metadata Terraform has already written.
- **SSH is one shared key** for user `solarpunk` across all three hosts, so there is no per-human
  attribution and no per-human revocation. OS Login is off on purpose: `streaming-infra-manager`
  hardcodes `/home/solarpunk` on both sides of its bind mounts, and OS Login derives the username
  from IAM.
- **After M0, commit `envs/poc.backend.hcl`.** A bucket name is not a secret, and copying the
  example file is a per-checkout manual step of exactly the kind M4 exists to eliminate.
- **The state bucket's project should be one whose IAM the team actually controls**, which may not
  be the shared workload project. That IAM — not any bucket setting — is what makes the "state is
  the boundary" claim below real.
- **`bootstrap/` keeps local state.** On a checkout that does not have it, recover with
  `terraform import google_storage_bucket.state <bucket-name>` rather than re-applying — or move
  it into the bucket after M0 with a backend block and `terraform init -migrate-state`.

## What the security actually rests on

- **Nothing on a stage host authenticates** — not the manager, not the uploader API, not a Bee
  API. The VPC's default-deny ingress plus these rules is the entire control. Do not widen
  a rule "temporarily".
- **Loki's push port is the only thing published off-host** (tcp 3100 on the monitoring host), and
  Loki has no authentication either. What stands in front of it is one identity-based rule —
  source the stage service account, target the monitoring one — so only an instance running as
  that service account can write logs or read them back out. A `source_ranges` version of that
  rule would trust a subnet where this trusts two hosts. Everything else in the monitoring stack
  stays on loopback and is reached over an IAP tunnel.
- **The state bucket is a security boundary**: generated passwords live in Terraform state.
  The bootstrap bucket is versioned, uniform-access, public-access-enforced; who can read it is
  project IAM, decided outside this module.
- The stage hosts' static external IPs (output `stage_external_ips`) are the egress identity a
  Hetzner-side allowlist keys on — and also what apt depends on at first boot; removing
  `access_config` would silently break provisioning.
- Egress is the meter that matters while publishing (~12 Mbps for two stages); idle, the bill is
  the VMs — roughly $13/day list with stage 1 + monitoring up. Between test windows **stop the
  instances** rather than destroying: carrying cost drops to about a dollar a day (disks +
  reserved addresses), and the static IPs — the Hetzner allowlist identity — and the TSDB
  history survive. `terraform destroy` releases the addresses and deletes the TSDB disk along
  with everything else; save it for a real teardown, and expect to re-allowlist on the Bee side
  after the next apply.
