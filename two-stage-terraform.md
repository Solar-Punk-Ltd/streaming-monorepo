# Rolling out two stages with Terraform

Provisioning plan for the first real deployment: **two stages, one lane, no backup uploaders**, on
Google Cloud, with the Bee publishers on our own machines and outside this plan's scope. Written
2026-08-14, following the decision on 2026-08-12 to plan with Google Cloud
([feasibility/gcp-alibaba-deployment.md](../feasibility/gcp-alibaba-deployment.md)).

One stage is `SRS → stream-uploader → 4 Bee publishers`, one per rung. Two stages is that twice,
plus monitoring. Nothing else from the twenty-stage architecture is in scope: no lane B, no standing
spares, no prefetch fleet, no CDN, no standby stack.

---

## The short version

**Terraform's job is the cloud footing and nothing below it.** Three facts set the boundary:

1. **The uploader fan-out is already built.** `BEE_PUBLISHERS`, the publisher pool, per-rung batch
   buying in the CLI and per-ladder master feeds all landed on
   `feat/multi-feed-abr-on-uploader-hardening` in August. The engineering that looked like the
   critical path is done.
2. **The Bee fleet is handled separately**, in the infra manager repo. Terraform does not create,
   configure, place or discover Bee nodes, and does not render `BEE_PUBLISHERS`.
3. **Stream config stays hand-authored for the POC.** `ABR_LADDER`, `BEE_PUBLISHERS`, stamps and
   keys are written by hand. Automating them is a post-POC question.

| | Owner |
|---|---|
| Machines, network, firewalls, addresses, secrets, state | **Terraform** |
| `manager/.env`, SSH aliases, Prometheus targets, Grafana provisioning | **Terraform renders, applier pushes** |
| Profiles, port slots, per-profile env, containers | **the manager, one instance per host** |
| Bee nodes, `BEE_PUBLISHERS`, `ABR_LADDER`, stamps, keys | **hand-authored, outside this plan** |

**The rule that keeps Terraform stable: it knows about hosts, never about rungs.** No resource
per rung, no rung count in the resource graph. Everything per-rung now lives above Terraform, which
makes that rule free rather than a discipline.

---

## What Terraform builds

### Google Cloud, existing project

| Resource | Count | Note |
|---|---|---|
| VPC + subnets | 1 + 2 | one subnet per region; not the default network |
| Stage host | 2 | SRS + `stream-uploader` + **its own manager, Postgres and web UI** |
| Monitoring host | 1 | 2 vCPU, separate persistent disk for the TSDB and the log store |
| Static external IP | 3 | two are the floating SRT addresses, and they double as the egress identity a Hetzner allowlist would key on |
| Firewall rule | 4 + 1/stage | SRT UDP per stage from test sources only; IAP-range SSH; monitoring scrape; log push to Loki; manager UI over IAP only |
| Service account | 3 | stage, monitoring, deployer. Never the default SA |
| Secret Manager secret | ~5 | SRT passphrase per stage, `POSTGRES_PASSWORD` per stage, Grafana admin |
| GCS bucket | 1 | Terraform state, versioned |

### Terraform lives in `terraform/` in this repo

Separate from the application repos, colocated with the plan it implements, and moved out later if
it outgrows that. One root module, `envs/poc.tfvars` for the two stages, GCS backend, plus a
one-off `bootstrap/` root that creates the state bucket the backend needs. The runbook, milestone
by milestone, is [terraform/README.md](../../terraform/README.md).

```hcl
variable "stages" {
  type = map(object({
    region   = string   # europe-west3 | asia-south1
    srt_port = number
    machine  = string
  }))
}
```

Two entries today. Twenty stages is a longer `.tfvars` and no HCL change. If adding a stage means
editing a `.tf` file, this rollout failed its own test.

### What it renders

Short, now that per-rung config is hand-authored:

| Rendered file | Consumed by |
|---|---|
| `manager/.env` per stage host | that host's manager stack |
| `ssh_config` fragment, used via `ssh -F` | `deploy/deploy.sh` and every tunnel |
| `prometheus/targets/*.json` | Prometheus file_sd |
| `grafana/provisioning/*` | Grafana datasources and dashboards |
| `inventory.json` | anything that needs to know what exists |

**Terraform writes files and never restarts a service.** Config-then-reload ordering is something
Terraform is bad at, and `remote-exec` inside the plan graph is how a plan stops being idempotent.
`deploy/deploy.sh` already does rsync-then-`docker compose up -d`; it stays the applier. The
monitoring stack gets an applier of the same shape, `terraform/stacks/monitoring/push.sh`, which
also carries the alert rules, the compose file and Loki's retention config as static payload.

`swarm-hls-stream/.env` is *not* on that list. It carries the ladder, the publishers and the keys,
so it stays hand-authored and Terraform does not touch it.

---

## One manager per host, and what it costs

Each stage host runs its own manager, Postgres and web UI alongside SRS and the uploader. No
central control instance, no cross-host `config.json`: each manager deploys locally, so its
`config.json` is all `localhost` with the Bee services disabled.

**Two consequences worth naming before sizing the machines:**

- **The manager competes with ffmpeg for CPU.** A four-rung ladder is about 7 vCPU on its own. Add a
  Postgres, an API and a web container on the same box and 8 vCPU is tight. Size the stage hosts
  above the transcode figure rather than at it, and watch steal time during the first real feed.
- **Port slots become per-host.** Each manager has its own Postgres, so the globally-unique
  `port_slot` is unique per host instead. Simpler, and it means the two stages can use identical
  slot numbers.

```mermaid
flowchart LR
    subgraph FRA["GCP europe-west3"]
        S1["Stage 1<br/>manager + SRS + uploader"]
    end
    subgraph BOM["GCP asia-south1"]
        S2["Stage 2<br/>manager + SRS + uploader"]
    end
    subgraph OWN["Our machines — outside this plan"]
        B1["Bee publishers, stage 1"]
        B2["Bee publishers, stage 2"]
        GW["gateway, read path"]
    end
    subgraph MON["GCP · monitoring"]
        M["Prometheus, Grafana,<br/>Loki, Alertmanager"]
    end
    S1 -->|"~10 ms"| B1
    S2 -->|"~120 ms"| B2
    B1 --> SW["Swarm"]
    B2 --> SW
    SW --> GW
    M -.->|"scrape"| S1
    M -.->|"scrape"| S2
    M -.->|"scrape"| OWN
    S1 -.->|"logs"| M
    S2 -.->|"logs"| M
    style OWN fill:#fff3e0,stroke:#e65100,color:#1a1a1a
```

**The two regions are the measurement.** Same bytes, same code, one uploader roughly 10 ms from its
publishers and one roughly 120 ms away. That only works because the publishers are remote — with
them co-located the hop would be `localhost` in both regions and the comparison would measure
nothing.

**What it does not tell us.** Ingest latency from the venue, because there is no venue feed yet, and
per-node peer-to-peer egress, which still needs [tools/bee-egress](../../tools/bee-egress/) on two
idle nodes for a week. Neither is blocked by this rollout, and neither is answered by it.

---

## Hand-authored config, and why that is safe here

`ABR_LADDER` and `BEE_PUBLISHERS` are checked against each other at uploader startup: every rung in
the ladder must have a publisher and nothing else may, or the uploader refuses to start. **That
makes hand-authoring low-risk** — a mismatch fails loudly, immediately, before any traffic, rather
than silently spending a batch sized for the wrong bitrate. Two things to keep in mind when writing
it:

- **The batch is bracketed, `rung@url<batchid>`.** A `#` opens a comment in that file and would
  truncate the value, losing the batch ids silently.
- **Coordination writes go to the lowest rung's node**, chosen from the ladder rather than from the
  order the variable is written in, so top-down ordering cannot invert it.

---

## Protecting the Bee API

Bee has **no API authentication of any kind** in 2.8.1 — no token, no password, no restricted mode
anywhere in the source. Reaching it is enough to spend a postage batch, upload arbitrary chunks and
write feeds, with the node's wallet behind it. Upstream's own packaged default is `127.0.0.1:1633`
for that reason.

`swarm-hls-stream` now has the knobs for it: `*_API_BIND` for the published port under bridge
networking, `*_API_LISTEN` for the process's own bind under `COMPOSE_NETWORK=host`, where published
ports are ignored entirely and the first pair does nothing. Both default to empty, reproducing the
previous behaviour exactly. P2P stays on every interface in both modes.

**Choosing the address is a Bee-side decision and sits outside this plan.** The one thing worth
carrying across: the manager reaches a node's API via `host.docker.internal`, which resolves to the
docker bridge address rather than loopback, so binding to `127.0.0.1` cuts off stamp management.

The GCP side supports whichever way it goes. The stage hosts have static external IPs, and GCP VM
egress uses the instance's external address, so an allowlist on the Bee side is two source
addresses and no coordination.

---

## Rollout order

| | What | Done when |
|---|---|---|
| **M0** | Foundations: state bucket, provider pins (`hashicorp/google ~> 7.44`), `terraform/` skeleton, `envs/poc.tfvars` | `terraform apply` twice in a row, second run reports no changes |
| **M1** | Monitoring host, before any stage exists | Grafana reachable over IAP, scraping `node_exporter` on itself |
| **M2** | Stage 1 in `europe-west3`: host, manager, SRS, uploader, pointed at existing publishers | test feed in, segment published, played back, visible end to end in Grafana |
| **M3** | Stage 2 in `asia-south1` is one `.tfvars` entry | the A/B number: same feed, two hop latencies |
| **M4** | Rebuild stage 2 from nothing (`terraform apply -replace` of its instance — a full destroy would also release its reserved addresses) | back up inside ~15 minutes with no manual step |

**M1 before M2 is deliberate.** Every component after it is observable from its first boot, which is
the difference between debugging the pipeline and guessing at it. **M4 is the acceptance test for
the whole exercise**: if a stage comes back from nothing without a human remembering something, the
configuration is really in Terraform. If it does not, it was in somebody's shell history.

---

## What this costs

Three VMs, three external static addresses, four disks. Worth costing in the calculator once before
the first apply rather than estimating here.

**The line worth watching is egress, because it is the same meter as the fleet's.** Two stages of a
four-rung ladder plus parity is roughly 12 Mbps leaving GCP, continuously while publishing:

| Window | Volume | GCP egress, list |
|---|---|---|
| A 40-hour test week | ~216 GB (201 GiB) | ~$24 |
| Left running a full month | ~3.9 TB (3,670 GiB) | ~$425 |

Trivial per test, and not trivial if it stays up for the eleven weeks to November. **Bring the pilot
up per test window.** The same arithmetic at 800 nodes is the $26,000 to $205,000 wall in
[feasibility/gcp-alibaba-deployment.md](../feasibility/gcp-alibaba-deployment.md), which is why this
small number is worth metering from the first day rather than after the first invoice.

---

## Open questions

1. **Machine size for the stage hosts.** A four-rung ladder is ~7 vCPU, and the per-host manager,
   Postgres and web UI now share the box. 8 vCPU is tight; the real number wants one measured run.
2. **Does the manager's web UI need to be reachable per host?** Three IAP tunnels is workable for
   two stages and tedious at twenty. Not urgent, but it is the kind of thing that gets built wrong
   once and kept.

Settled: one manager per host; Terraform in `terraform/` in this repo; Bee nodes and their
placement handled separately; `ABR_LADDER` and `BEE_PUBLISHERS` hand-authored for the POC; the
Mumbai host is `asia-south1`, because Live Stream API is not available in `asia-south2`.

---

## What this does not cover

Lane B, standing spares, the 640-node prefetch fleet, the CDN, the standby stack, the multi-stage
player, the Bee fleet itself, and the move to Vultr. Each is in
[architecture-plan.md](../architecture-plan.md) or
[feasibility/fleet-hosting.md](../feasibility/fleet-hosting.md). When the fleet does move,
[`vultr/vultr`](https://registry.terraform.io/providers/vultr/vultr/latest) v2.32.0 is first-party
and covers instances and bare metal, so that migration is a module rather than a rewrite.
