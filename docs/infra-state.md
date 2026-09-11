# Infrastructure state

What is deployed and where, kept current by hand. Update when something moves.

| Piece | Where | State |
|---|---|---|
| ABR Bee nodes (publishers, gateways) | Vultr | running |
| ABR uploader | GCP stage host | running |
| streaming-infra-manager | test host, master branch | deployed |
| Player | swarm-hls-streaming, main-v2 | deployed with the manager |
| Test stream | http://65.108.40.56:10064/#/watch/video/0501b0ccf4e91006673e2ead7c521bb5997eb12b/1f79f309-a4fd-4941-b5f3-8c72eeb722ef?qoe=1 | plays |
| Web2 admin layer | this repo | not started (checkpoint 1) |
