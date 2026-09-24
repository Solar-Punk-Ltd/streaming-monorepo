# Infrastructure state

What is deployed and where, kept current by hand. Update when something moves.

| Piece | Where | State |
|---|---|---|
| ABR Bee nodes (publishers, gateways) | Vultr | running |
| ABR uploader | GCP stage host | running |
| streaming-infra-manager | test host | deployed; its own line is now `main-v2`, which carries the auth stack this repo ported |
| Stage host | GCP, an `abr-uploader` profile with an ABR node pool on Vultr | running |
| Viewer, uploader's catalogue | manager test host, one port slot | plays |
| Viewer, admin catalogue | manager test host, another port slot, built from the swarm-hls-stream branch off `main-v3` | plays |
| Web2 admin layer | this repo, `web2-admin/` | deployed with `deploy/deploy.sh --host=<target> [--profile=<name>] [--portSlot=<N>]` (loopback console on 9090); first server deploy 2026-09-24; on the dev host the host firewall blocks the forward (see deploy/README.md). Reachable over HTTPS through the host's edge when one is configured (`deploy/edge.sh`, one Caddy per host, names in the gitignored `deploy/edge/.env`), SSH tunnel otherwise; the edge is not deployed on any host yet |
| Local loop | SRS in Docker, the uploader from source in admin mode, a Bee node | used for end-to-end tests |
