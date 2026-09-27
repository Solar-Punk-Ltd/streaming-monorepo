# Hosts: roles, the edge, and the names that never change

A host is a Linux machine with Docker on it. The platform uses three kinds, and one machine can
carry all three at once, or each role can have machines of its own. This page says what runs on
each kind, who puts it there, which folder of this repository owns it, what the edge is, and which
names on the hosts must never change however the repository is rearranged. No real host, address
or domain appears here: those belong to one deployment and live in its env files, which are not
committed.

## The three roles

| Role                        | What runs there                                                                                                                             | Who puts it there                                                                                                                                                                                               | Owning folder                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Control host                | The edge, the manager, the admin console, and on the pilot's monitoring host the monitoring stack (Prometheus, Alertmanager, Loki, Grafana) | Each project's own deploy script, run by a person from a checkout: `infra/edge/edge.sh`, `apps/infra-manager/deploy/deploy.sh`, `apps/web2-admin/deploy/deploy.sh`, `infra/terraform/stacks/monitoring/push.sh` | `infra/edge`, `apps/infra-manager/deploy`, `apps/web2-admin/deploy`, `infra/terraform/stacks/monitoring` |
| Stage host                  | One stack deployment per profile and port slot: the ingest engine (SRS or OME), the uploader, a Bee gateway, the viewer                     | The manager, which runs the stack's `deploy.sh` on the host over ssh, or on its own host as `localhost`                                                                                                         | `apps/hls-stream/deploy`                                                                                 |
| Bee host                    | The Bee nodes of an ABR node pool, one per quality rung, which are the publish targets of a stage host's uploader                           | The manager                                                                                                                                                                                                     | `apps/hls-stream/deploy`                                                                                 |
| Every host Terraform builds | The bare machine: Docker, the firewall, node_exporter, and Alloy shipping logs to the monitoring host                                       | Terraform's first-boot scripts                                                                                                                                                                                  | `infra/terraform`                                                                                        |

The roles describe what runs where, not how many machines there are. A control host that also
carries stack deployments is a stage host as well, and the pilot's cloud hosts split the roles
across machines that Terraform builds.

## The edge

The edge is the front door of a control host: one small Caddy container that holds the two ports
every browser uses, 80 and 443, gets and renews the HTTPS certificates by itself, and sends each
domain to the console behind it, the admin's or the manager's. The consoles themselves listen on
the host's loopback only, so without an edge the way in is an ssh tunnel. The viewer and the
ingest ports do not pass through it.

Only one program per host can hold ports 80 and 443. That is why the edge is a compose project of
its own rather than a service inside each console's project, and why `edge.sh` refuses to start
when something else already holds them. The manager's compose file carries an edge of its own
too, switched on by `MANAGER_DOMAIN` in the manager's env file. On a host that runs this
repository's edge, the manager's stays off and the manager's domain goes into the edge's env file
instead.

`infra/edge/edge.sh` renders a Caddyfile from `infra/edge/.env`, copies it and the compose file to
the host, and starts or recreates the container. The certificates live in two named volumes, so a
recreate does not ask for new ones.

## The names that never change

Docker names a container, a network and a volume after its compose project, and a deploy script
finds its files under a fixed host folder. Rename either and the next deploy starts a fresh, empty
project beside the old one: a new database with no users, a new certificate store that asks for
certificates again. So these names are pinned by the scripts, written down here, and stay whatever
the files are called in the repository. Moving a folder in this tree never changes a name on a
host. On the host each volume carries its project's name in front, `web2-admin-brand-a_pg-data`,
`edge_caddy-data`, which is exactly why the project name is the thing to protect.

| Piece                        | Host folder                                                                                                                                                                              | Compose project                                                           | Volumes                                                          | Env file                                                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin console                | `/home/solarpunk/streaming-monorepo`                                                                                                                                                     | `web2-admin-<profile>`, and `web2-admin-default` when no profile is named | `pg-data`                                                        | `apps/web2-admin/backend/.env.<profile>` in the checkout it deploys from (`backend/.env` for the default profile), copied to the host on every deploy |
| Edge                         | `deploy/edge/` under `/home/solarpunk/streaming-monorepo`, where it was before its sources moved to `infra/edge/`                                                                        | `edge`                                                                    | `caddy-data`, `caddy-config`                                     | `infra/edge/.env` on the machine that runs `edge.sh`. Only the rendered Caddyfile goes to the host                                                    |
| Manager                      | `/home/solarpunk/streaming-infra-manager`, its compose run from the `manager/` folder inside it                                                                                          | `manager`, taken from that folder's name                                  | `manager-pg`, and `edge-data` and `edge-config` for its own edge | `manager/.env`, copied to the host on every deploy                                                                                                    |
| The stacks the manager keeps | `/home/solarpunk/streaming-infra-manager-versions` for the stack versions it builds, `/home/solarpunk/streaming-infra-manager-data/<deployment>` for each deployment's Bee data and keys |                                                                           |                                                                  |                                                                                                                                                       |
| A stack deployment           | the folder the stack's `deploy.sh` keeps for the profile, `~/swarm-hls-stream-<profile>` on a host it reaches over ssh                                                                   | the deployment's profile name, as it was chosen in the manager            | `srs-media`, `uploader-state`                                    | `.env.<profile>` at that folder's root and `engines/<engine>/.env.<profile>`, written by the manager                                                  |
| Monitoring stack             | `/home/solarpunk/monitoring` on the monitoring host, its data on the host's TSDB disk                                                                                                    | `devcon-monitoring`                                                       | bind mounts, in its compose file                                 | rendered by Terraform and pushed by `push.sh`                                                                                                         |
| Log shipper                  | `/opt/devcon-alloy` on every host Terraform builds                                                                                                                                       | `devcon-alloy`                                                            |                                                                  | written by Terraform's first-boot script                                                                                                              |

For the hosts it builds, Terraform fixes the manager's host folder and the Bee data root at the
paths above, so the manager's deploy script and its data land where every other host has them.
