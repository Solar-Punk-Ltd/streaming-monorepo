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
| Web2 admin layer | this repo, `web2-admin/` | runs locally; not deployed |
| Local loop | SRS in Docker, the uploader from source in admin mode, a Bee node | used for end-to-end tests |
