# Infrastructure state

What is deployed and where, kept current by hand. Update when something moves.

| Piece | Where | State |
|---|---|---|
| ABR Bee nodes (publishers, gateways) | Vultr | running |
| ABR uploader | GCP stage host | running |
| streaming-infra-manager | test host, master branch | deployed |
| Player | swarm-hls-streaming, main-v2 | deployed with the manager |
| Test stream | manager test host, port slot 6 client port (address kept out of the repo) | plays |
| Web2 admin layer | this repo, `web2-admin/` | runs locally (checkpoint 2); not deployed |
