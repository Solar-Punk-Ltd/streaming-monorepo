# Infrastructure state

What is deployed and where, kept current by hand. Update when something moves.

| Piece | Where | State |
|---|---|---|
| ABR Bee nodes (publishers, gateways) | Vultr | running |
| ABR uploader | GCP stage host | running |
| streaming-infra-manager | QA: the GCP control host, its own deploy (`./deploy/deploy.sh monitoring` from its checkout on `main`, which carries the login stack), console on loopback 8080 behind the same Caddy edge at https://streaminfra.beebridge.buzz (2026-09-25). It drives stage1 (GCP) and the Bee host (Vultr) over ssh with the identity in `~/manager-ssh`. The Hetzner test-host manager is retired from those targets. |
| Stage host | GCP `stage1`, still carrying the old manager's `stage1` profile containers until cleaned; the QA manager redeploys the uploader here | running |
| Viewer, uploader's catalogue | manager test host, one port slot | plays |
| Viewer, admin catalogue | manager test host, another port slot, built from the swarm-hls-stream branch off `main-v3` | plays |
| Web2 admin layer | this repo, `apps/web2-admin/` | QA: profile `qa` on the GCP control host (the monitoring VM, alias `monitoring`), console on loopback 9091 behind the host's Caddy edge at https://streamadmin.beebridge.buzz (deployed 2026-09-25, first user pending. Bee node, batch and ingest ports in `.env.qa` still placeholders until the manager has the pool and uploader). Deploy: `apps/web2-admin/deploy/deploy.sh --host=monitoring --profile=qa`. |
| Local loop | SRS in Docker, the uploader from source in admin mode, a Bee node | used for end-to-end tests |
| Host edge (Caddy) | GCP control host, compose project `edge` from `deploy/edge/`, ports 80/443 open in the VPC firewall (`devcon-https-public`) | serving both names with Let's Encrypt certificates since 2026-09-25 |
