# Research notes

Condensed reports produced on 2026-09-11 while designing web2-admin, from
reading the sibling repositories and the live msrs-client deployment. They
are snapshots: file paths and line numbers refer to the commits current that
day (streaming-infra-manager master b94caf3, msrs-client master 84d36ee,
swarm-hls-stream main bbfb8bf plus the named origin branches).

| File | What |
|---|---|
| [msrs-client.md](msrs-client.md) | The deprecated admin console: routes, auth, the GSOC write path, the stream model, the stream key token, caveats. |
| [msrs-client-live-ui.md](msrs-client-live-ui.md) | What the deployment at ethisstream.eth.limo shows, screen by screen. |
| [streaming-infra-manager.md](streaming-infra-manager.md) | Conventions we copy, the Manager API, its data model, port arithmetic. |
| [swarm-hls-stream-ingest-and-feed.md](swarm-hls-stream-ingest-and-feed.md) | Ingest protocols and secrets, what a stream writes to Swarm, the publisher-auth branches, the old msrs-uploader. |
