# Terraform for the Bee hosts on Vultr

The second root in this repo. `../` builds the GCP footing — stage hosts, monitoring, SRT
ingest; this one builds the machines the **Bee publishers** run on, at Vultr. One host carries
**three ABR ladders = 12 Bee publisher nodes**, put there over ssh by the **one
`streaming-infra-manager` per brand**, which runs on a host of its own outside both clouds and
deploys to the Bee hosts and the GCP stage hosts alike. A Bee host carries docker,
`node_exporter` and Alloy from this root's provisioning script, Bee node containers from the
manager, and nothing else — no manager, no Postgres, no web UI.

The rule from [docs/rollout/two-stage-terraform.md](../../docs/rollout/two-stage-terraform.md)
holds here unchanged: **Terraform knows about hosts, never about rungs.** There is no resource per
rung and nothing in the graph knows which rung is which. `ladders_per_host × rungs_per_ladder`
appears exactly once, to size a firewall port band. Profiles, port slots, `BEE_PUBLISHERS`,
`ABR_LADDER`, stamps and keys are the manager's and the operator's, created in the manager UI.

Two roots rather than one module for a reason worth stating: a Vultr apply must not be able to
touch a running GCP stage, and a GCP apply must not need a Vultr API key. What crosses between
them is one read-only `terraform_remote_state` (this root reads the GCP root's addresses) and one
list of /32s copied the other way, by hand, in step 2 below.

## Prerequisites

- `VULTR_API_KEY` exported in the shell. Create it at
  <https://my.vultr.com/settings/#settingsapi>, and **restrict it with Vultr's API access-control
  list** to the operator's address while you are there: the key is account-wide with no resource
  scoping, so it can destroy every instance on the account. It is never a Terraform variable and
  never belongs in `envs/poc.tfvars`.
- `gcloud` authenticated (`gcloud auth application-default login`), because both the state backend
  and the read of the GCP root's outputs are GCS.
- **The GCP root applied first**, with at least one stage. This root refuses to plan without
  `stage_external_ips` and `monitoring_external_ip` in its state — those addresses are the entire
  ingress control for an unauthenticated Bee API and the endpoint its log shipper pushes to.
- Terraform ≥ 1.9. `ssh`, `rsync`, `curl` locally. The media deploy is not run from here at all:
  it runs on the manager host, from inside the manager's own api container.
- Nothing to install on the host: the Vultr startup script provisions docker, compose v2,
  `node_exporter` and the Grafana Alloy log shipper itself on first boot.

## First time

```sh
export VULTR_API_KEY=...
terraform init -backend-config=envs/poc.backend.hcl
```

Same bucket as the GCP root, prefix `vultr` — one place to guard, two states. Then check
`envs/poc.tfvars`: the `ssh_public_key` must be **character for character** the same as
`../envs/poc.tfvars`, so one `~/.ssh/config` reaches every host in the pilot.

## Rollout

**1. Open a window and apply.**

```sh
./scripts/allow-me.sh                       # this machine's /32 on tcp 22, then plan+apply
```

`allow-me.sh` does the apply itself. To apply without opening ssh:
`terraform apply -var-file=envs/poc.tfvars`. The resting state is the committed
`ssh_source_ranges` and nothing else — the manager host, which needs port 22 to deploy and
redeploy the Bee pools. `allow-me.sh` adds a laptop's /32 on top for the length of a window and
`off` takes it away again; nothing else on the host cares, because neither publishing nor
scraping nor log shipping arrives over port 22.

**2. Let the host into Loki.** This is the step that is easy to skip and silent when skipped:

```sh
terraform output bee_host_ips
# put each address as a /32 into loki_push_source_ranges in ../envs/poc.tfvars
cd .. && terraform apply -var-file=envs/poc.tfvars && cd vultr
```

The GCP root's Loki port is admitted by a service-account rule that cannot match traffic from
another cloud, so a public /32 rule is what lets this host's Alloy push. Until it exists, metrics
arrive and logs do not.

**3. Ship the Prometheus target.**

```sh
../stacks/monitoring/push.sh
```

Nothing to edit: this root writes `../rendered/monitoring/prometheus/targets/vultr-bee-hosts.json`
into the GCP root's rendered tree on purpose, `push.sh` rsyncs that directory wholesale, and
`prometheus.yml` globs `targets/*.json`.

**4. Hand the manager host its ssh config.** The manager's deploys run inside its api container
(`node:22-alpine`, root, with `openssh-client` and `rsync`), and `swarm-hls-stream`'s `deploy.sh`
calls bare `ssh <target>` — so the container needs an ssh identity, and the container has none of
its own. The manager host carries the directory the compose file mounts at `/root/.ssh`,
`/home/solarpunk/manager-ssh/`, holding the dedicated `manager_deploy` ed25519 key, a
`known_hosts`, and this root's rendered config:

```sh
scp -p ../rendered/vultr/manager_ssh_config \
  solarpunk@65.108.40.56:/home/solarpunk/manager-ssh/ssh_config
```

The manager's compose mounts that file at `/etc/ssh/ssh_config`, read-only — the system-wide
file itself, not a drop-in under `ssh_config.d` and not `~/.ssh/config`: OpenSSH rejects a
per-user config the running user does not own and applies the same check to every file an
`Include` pulls in, and a bind-mounted file keeps the host's uid, so both fail with "Bad owner or
permissions". The top-level system file is the one path read without it. The rendered file carries one
block per host — the Bee hosts here and the GCP stage hosts read out of the other root's state —
each matching **both the alias and the bare address**, with `IdentitiesOnly` and the
`known_hosts` pinning. Direct TCP to both clouds; no IAP, which is a gcloud on a human's laptop
and not a thing a container has.

**5. Build the ladders in the manager UI.** Terraform stops at the machine; this part is the
operator's.

- Create an **ABR Node Pool** per ladder, four rungs each, with its host entered as
  **`solarpunk@<bee host ip>`** — `solarpunk@108.61.171.132` for `bee1`. Never an ssh alias: the
  manager copies the host value, minus the `user@`, literally into the `BEE_PUBLISHERS` URLs. An
  ssh alias is a name in an ssh config, not an address anything else can dial.
- **Port slots are global per manager**, not per host — one Postgres serves every profile — so
  the rungs take whatever slots are free rather than a fixed 1..12. Keep them inside the band the
  firewall admits: slot `s` puts the Bee API on `10005 + 10s` and P2P on `10006 + 10s`, and
  `terraform output bee_p2p_ports` lists exactly which ports are open. A slot outside that range
  deploys a node nothing can reach.
- Set **`BEE_UPLOADER_NAT_ADDR`** to this host's public address (`terraform output bee_host_ips`)
  on every rung. It is what each Bee node advertises to Swarm; left at its default the node
  announces `localhost` and no peer can dial it. Terraform does not touch profiles.
- Fund the nodes, buy a postage batch per rung, then copy the ladder's `BEE_PUBLISHERS` string
  into an **ABR Uploader** profile whose host is the GCP stage host, `solarpunk@<stage ip>`. That
  string is the whole interface between the two clouds. The uploader's own slot decides its SRT
  port (`10001 + 10s`), which has to go into `stages.<key>.srt_port` in `../envs/poc.tfvars`
  followed by an apply of the GCP root — that rule admits one port and no other.
- Then push a feed at that port from an encoder whose address the GCP root admits, either
  committed in `srt_source_ranges` or opened for the window by `../scripts/allow-me.sh`.

## Day-to-day

```sh
ssh -F ../rendered/vultr/ssh_config bee1
./scripts/allow-me.sh off                                          # close the ssh window
```

There is no manager web UI to tunnel to here: the manager runs on its own host and this one only
receives Bee node containers. Aliases must stay dotless — `swarm-hls-stream` resolves deploy
targets through `ssh -G` only for names without a dot. Logs and metrics are on the GCP monitoring
host's Grafana exactly as for a stage host; these hosts carry `role="bee"` and
`stage="<host key>"`, so
`{host="devcon-bee-bee1"}` is a working Loki query and the same labels line up in a dashboard
panel. See [../README.md](../README.md#reading-the-logs).

## Rebuilding a host, and what a rebuild costs

```sh
# BACK UP THE BEE DATA ROOT FIRST — see below.
terraform apply -var-file=envs/poc.tfvars -replace='vultr_instance.bee["bee1"]'
rm -f ../rendered/vultr/known_hosts        # the new host presents a new key
```

**What survives:** the reserved public address. It is a separate resource precisely so it does —
which keeps the GCP allowlist rules, `loki_push_source_ranges`, `PUBLIC_HOST`, the Prometheus
target and the ssh alias all valid, with no second apply on the GCP side.

**What does not:** everything on the local disk. A Vultr instance's disk *is* its root filesystem —
there is no separate volume to detach — so `/home/solarpunk/streaming-infra-manager-data` goes
with the instance, and with it **every Bee node's wallet, its libp2p key and its postage
batches**. Those are funded, on-chain and not recreatable. Copy the data root off the host
(`rsync -az bee1:/home/solarpunk/streaming-infra-manager-data/ ./backup/`) with the nodes stopped
before any `-replace`, and treat a plan that says *must be replaced* for `vultr_instance.bee` as a
data-loss event. The arguments that trigger one, in `vultr/vultr` 2.32.0: `region`, `os_id`,
`hostname`, `ssh_key_ids`, `reserved_ip_id`, `script_id`, `user_scheme`, `snapshot_id`,
`user_data`. `plan` is not among them — a plan change is a live resize (one-way, upgrade only,
with a reboot the nodes survive).

**Changing the provisioning script does not need a rebuild.** A Vultr startup script runs once per
instance (cloud-init vendor scripts are per-instance, not per-boot) and there is no metadata
script runner to invoke, so the way to apply an edit to a live host is the rendered copy:

```sh
terraform apply -var-file=envs/poc.tfvars       # updates the account-level script object in place
ssh -F ../rendered/vultr/ssh_config bee1 sudo bash -s < ../rendered/vultr/bee1/provision.sh
```

That is why `provision.sh` is rendered at all, and why the script is idempotent by design.

## What the security actually rests on

- **The Bee API has no authentication**, and `swarm-hls-stream` binds it on `0.0.0.0` so an
  off-host uploader can reach it. Anyone who reaches one of those ports can spend the node's
  postage batches. The **only** control is one firewall rule per admitted address: the GCP stages'
  external /32s, read from the other root's state, plus the manager host's /32 in
  `bee_api_source_ranges` — it buys and inspects the batches, so it needs the same band the
  uploaders do. Do not widen either "temporarily".
- **Bee P2P is public by design** — a publisher that cannot be dialled cannot push chunks — one
  rule per slot port, from `0.0.0.0/0`. TCP only: bee's libp2p host registers the TCP transport
  and websockets over it, and no UDP or QUIC transport at all.
- **Three things cross the public internet in cleartext**: the stage uploader's Bee API calls, the
  Prometheus scrape of `node_exporter` (which names every process and mount on the host) and the
  Alloy log push into Loki (which has no authentication either). Each is gated by a /32 and
  nothing more. **A WireGuard mesh between the two clouds is the intended follow-up** and would
  remove all three from the public internet; public IPs plus allowlists is the deliberate first
  step, not the end state.
- **sshd is on a public address**, and it is a deploy surface rather than a human one: the manager
  host reaches it from the committed `65.108.40.56/32` in `ssh_source_ranges` to push Bee node
  containers, and a laptop adds one more /32 for the length of a window through
  `scripts/allow-me.sh`. The provisioning script turns off ufw, which Vultr's image ships active
  and which would otherwise block the node_exporter scrape while docker's published ports bypass
  it anyway, so the Vultr firewall group is the one control. It turns off password and
  keyboard-interactive auth (Vultr's images ship a generated root password) and leaves
  `PermitRootLogin prohibit-password`, so root's key stays the recovery path if the copy to
  `solarpunk` ever fails. Close the operator window when it is done; the manager's /32 stays, and
  that is the difference between "no sshd reachable" and the resting state now.
- **Host keys are the identity here**, unlike the GCP hosts reached through IAP. The rendered
  `ssh_config` pins them with `StrictHostKeyChecking accept-new` into a `known_hosts` file scoped
  to this root, so a rebuild is fixed by deleting that one file — never by weakening a global
  setting.
- **The state bucket is the only secret boundary.** There is no Secret Manager equivalent here:
  the Postgres password this root generates per host lives in its state and in the 0600 rendered
  `manager.env` — a file nothing pushes to a Bee host, the manager and its Postgres being
  elsewhere — and nowhere else. Whoever can read `gs://<bucket>/vultr/` can read it. The note
  in [../README.md](../README.md#operational-notes) about choosing a state-bucket project whose
  IAM the team controls applies to this root unchanged.

## What this costs

| | |
|---|---|
| `vc2-16c-64gb` in `fra` | $320/mo list, **$0.438/h** — 16 vCPU, 64 GB, 1280 GB SSD, shared vCPU |
| Included transfer | 10 TB/mo, pooled across the account |
| Overage | $0.01/GB |
| Reserved IP | free while attached to a running instance |

**A stopped Vultr instance bills at the full rate.** The GCP root's main cost lever — stop the VMs
between test windows, drop to about a dollar a day — does not exist here. The host either runs at
$0.438/h or is destroyed, and destroying it destroys the Bee wallets. Budget for it to stay up for
the duration of a test phase, and size the phase accordingly.

Egress is the meter that matters and the one that scales: the pilot's twelve publishers are a
rounding error against the pooled 10 TB, and the same arithmetic at 800 nodes is the wall in
[feasibility/fleet-hosting.md](../../docs/feasibility/fleet-hosting.md). `tools/fleet-cost/model.py`
is where the per-node envelope this host is sized against lives.

## Operational notes

- **Two credentials, two expiry clocks.** `VULTR_API_KEY` is static and account-wide; the Google
  credential behind the backend and the remote-state read expires on a Workspace reauth policy and
  fails with `invalid_rapt`. `scripts/allow-me.sh` borrows the gcloud CLI token
  (`GOOGLE_OAUTH_ACCESS_TOKEN`) to keep one credential alive instead of two.
- **Three things the provisioning script does to the host itself**, none of them obvious from the
  Terraform: it grants `solarpunk` passwordless sudo through `/etc/sudoers.d/solarpunk`, which is
  what makes the in-place re-run above work as `solarpunk` rather than as root; it disables ufw
  (see the security section on why); and it writes sshd's hardening to
  `/etc/ssh/sshd_config.d/10-devcon.conf`. The `10-` is load-bearing — sshd keeps the **first**
  value it reads for a keyword and Vultr's image ships `50-cloud-init.conf` saying
  `PasswordAuthentication yes`, so a drop-in sorting after it is read and ignored. Check the
  effective settings with `sshd -T`, never by reading one file.
- **The two roots share one Alloy image digest**, pinned in `locals.tf` and `../locals.tf`. They
  render one shared fragment and ship into one Loki, so change both in the same commit.
- **Vultr rate-limits its API.** A large `for_each` over hosts can hit it; a re-run of the same
  apply is safe and picks up where it stopped.
- **`os_id` is a literal, not a floating image.** Look up a new one with `vultr-cli os list` — and
  note that changing it reinstalls the OS, which is a rebuild by another name.
- **Adding a host, a ladder or an ssh range costs firewall rules.** `terraform output
  firewall_rule_budget` breaks down what this design spends; compare it against the group's cap
  (`vultr-cli firewall group list`) before growing any of the three.
