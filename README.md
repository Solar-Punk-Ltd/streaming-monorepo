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
- For the appliers: `ssh`, `rsync`. The media deploy is not run from here — it runs on the
  `streaming-infra-manager` host, which reaches the stage hosts over ssh on its own
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

**M2 — stage 1.** Uncomment `stage1` (europe-west3) and apply:

```sh
terraform apply -var-file=envs/poc.tfvars
./stacks/monitoring/push.sh            # picks up the new scrape target
```

What M2 gives you before anything is deployed on the host: `node_exporter` scraped by Prometheus,
and Alloy shipping every container's logs to Loki — SRS and the uploader from the moment they
first start, with no step of its own. See "Reading the logs" below.

The host does not deploy itself and runs no manager of its own. The ABR Uploader — SRS plus
`stream-uploader` — is pushed onto it over plain ssh by the one `streaming-infra-manager` per
brand, which lives on a host outside GCP and drives the Bee hosts at Vultr the same way. Two
variables are what make that reach the host at all: `ssh_source_ranges` carries the manager
host's /32, which is the only thing besides IAP that gets past the VPC's deny-all on port 22,
and `additional_ssh_public_keys` carries its deploy key into the instance's `ssh-keys` metadata
alongside `ssh_public_key`, where the guest agent converges `solarpunk`'s `authorized_keys` to
the whole roster. The profile's host is entered in the manager as `solarpunk@<external ip>`,
never an ssh alias: the manager writes that value, minus the `user@`, straight into the SRT URL.

Two things the plan insists on: run the media stack from the ABR lineage (`main` predates
`BEE_PUBLISHERS`), and deploy with `--portSlot >= 1`. **Port slots are global to the manager's
one Postgres**, so the uploader takes whatever slot is free rather than always slot 1, and its
SRT port is `10001 + 10 × slot`. Put that number in `stages.stage1.srt_port` and apply again —
the ingest rule admits exactly one port per stage, and a mismatch is a stream that connects to
nothing. `rendered/stage1/manager.env` is still rendered here and is not part of this rollout:
the manager's env lives on the manager host, with the manager. The SRT passphrase for the
hand-authored engine env:
`gcloud secrets versions access latest --secret=devcon-srt-passphrase-stage1`.

**M3 — stage 2** is uncommenting `stage2` and running the same two commands as M2.

**M4 — destroy and rebuild stage 2:**

```sh
terraform apply -var-file=envs/poc.tfvars -replace='google_compute_instance.stage["stage2"]'
```

then redeploy the ABR Uploader from the manager exactly as in M2 — the recovery procedure IS the
M2 procedure, which is what the test proves. Nothing else moves: both of the host's addresses are
reserved (external and internal), so the Bee hosts' firewall allowlist, the manager's reach into
port 22 and the block for this host in its rendered ssh config, the Prometheus target in
`nodes.json` and the ssh alias all stay valid, and no `push.sh` re-run is needed. The human path
needs no host key cleared either — identity comes from IAP, which opens the tunnel by instance
name against IAM. The manager's does: it connects by address, so the rebuilt host presents a key
its `known_hosts` disagrees with, and that one line has to go before the redeploy.

## Bee hosts on Vultr

The Bee publishers run on their own machines at Vultr, in a second root:
[vultr/README.md](vultr/README.md). One host carries three ABR ladders — twelve Bee publisher
nodes — deployed onto it over ssh by the same external `streaming-infra-manager` that deploys the
uploader here. That root reads this one's `stage_external_ips` and `monitoring_external_ip` out
of the state bucket, so **this root is applied first**; the one thing that has to come back the
other way is a list of addresses:

1. `cd vultr && ./scripts/allow-me.sh` — applies the Vultr root (needs `VULTR_API_KEY`).
2. `terraform output bee_host_ips` there, paste them as /32s into `loki_push_source_ranges` in
   `envs/poc.tfvars`, and apply **this** root. Without it those hosts' logs cannot reach Loki,
   while their metrics arrive normally — a gap that is silent from the Grafana side.
3. `./stacks/monitoring/push.sh` — the Vultr root renders its Prometheus targets into
   `rendered/monitoring/prometheus/targets/vultr-bee-hosts.json`, so this ships them with no
   edit to the monitoring stack.

The rendered `ssh_config` here `Include`s the Vultr root's, so one file reaches every host; the
line is inert until that root has been applied. That file is the human path, over IAP. The
manager's path is a separate rendered file, `rendered/vultr/manager_ssh_config`, which the Vultr
root writes with a block for every host in both clouds — direct TCP, host keys pinned — and the
operator copies to the manager host. See [vultr/README.md](vultr/README.md).

## Day-to-day access

```sh
ssh -F rendered/ssh_config stage1                                  # or: monitoring
ssh -F rendered/ssh_config -L 3000:localhost:3000 monitoring       # Grafana
```

Aliases must stay dotless — `swarm-hls-stream` resolves deploy targets through `ssh -G` only for
names without a dot. The manager's web UI is not on either of these hosts and needs no tunnel
from here.

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
address and the port its uploader's slot decided (output `srt_ingest_endpoints` prints both; the
internal `10.60.x.x` address is reachable only from inside the VPC):
`srt://<endpoint>?streamid=#!::r=live/stream,m=publish`. Production never needs this: the venue
encoder has a static address and belongs in `srt_source_ranges`.

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
- **SSH is one shared key** for user `solarpunk` across all three hosts, plus the manager host's
  deploy key on the stage hosts through `additional_ssh_public_keys`, so there is no per-human
  attribution and no per-human revocation. Instance metadata is authoritative for that roster and
  the guest agent converges `authorized_keys` to it, which is also why a key appended by hand on
  a host does not survive. OS Login is off on purpose: `streaming-infra-manager` hardcodes
  `/home/solarpunk` on both sides of its bind mounts, and OS Login derives the username from IAM.
- **After M0, commit `envs/poc.backend.hcl`.** A bucket name is not a secret, and copying the
  example file is a per-checkout manual step of exactly the kind M4 exists to eliminate.
- **The state bucket's project should be one whose IAM the team actually controls**, which may not
  be the shared workload project. That IAM — not any bucket setting — is what makes the "state is
  the boundary" claim below real.
- **`bootstrap/` keeps local state.** On a checkout that does not have it, recover with
  `terraform import google_storage_bucket.state <bucket-name>` rather than re-applying — or move
  it into the bucket after M0 with a backend block and `terraform init -migrate-state`.

## What the security actually rests on

- **Nothing on a stage host authenticates** — not the uploader API, not SRS's own HTTP surface.
  The VPC's default-deny ingress plus these rules is the entire control. Do not widen a rule
  "temporarily".
- **One rule puts a stage host's sshd on the public internet**: `devcon-ssh-external`, tcp 22
  from the /32s in `ssh_source_ranges`, targeting the stage tag only. It exists because the
  `streaming-infra-manager` host deploys the uploader over plain ssh from inside a container and
  has no gcloud and no Google identity to open an IAP tunnel with. It is IP-keyed and logged,
  like the SRT ingest rule and for the same reason: with no application auth behind it, matching
  the rule is the whole authorization event and the only record of it. The monitoring host is not
  a target — nothing external deploys to it — and IAP stays the human path to both. The variable
  refuses anything wider than a /24.
- **Loki's push port is the only thing published off-host** (tcp 3100 on the monitoring host), and
  Loki has no authentication either. What stands in front of it is one identity-based rule —
  source the stage service account, target the monitoring one — so only an instance running as
  that service account can write logs or read them back out. A `source_ranges` version of that
  rule would trust a subnet where this trusts two hosts. Everything else in the monitoring stack
  stays on loopback and is reached over an IAP tunnel. The Bee hosts at Vultr cannot be admitted
  that way — a source-service-account filter never matches traffic from outside the project — so
  each of their reserved addresses is a named /32 in `loki_push_source_ranges`, and that rule is
  logged where the two internal ones are not. It is absent while the list is empty.
- **The state bucket is a security boundary**: generated passwords live in Terraform state.
  The bootstrap bucket is versioned, uniform-access, public-access-enforced; who can read it is
  project IAM, decided outside this module.
- The stage hosts' static external IPs (output `stage_external_ips`) are the egress identity a
  Bee hosts' firewall (terraform/vultr) keys on — and also what apt depends on at first boot; removing
  `access_config` would silently break provisioning.
- Egress is the meter that matters while publishing (~12 Mbps for two stages); idle, the bill is
  the VMs — roughly $13/day list with stage 1 + monitoring up. Between test windows **stop the
  instances** rather than destroying: carrying cost drops to about a dollar a day (disks +
  reserved addresses), and the static IPs — the Bee-host allowlist identity — and the TSDB
  history survive. `terraform destroy` releases the addresses and deletes the TSDB disk along
  with everything else; save it for a real teardown, and expect to re-allowlist on the Bee side
  after the next apply.
