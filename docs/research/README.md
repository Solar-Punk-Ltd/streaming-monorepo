# Research notes

Historical: these notes date from before the two repositories were imported, and describe the code
as it was then.

Condensed reports produced on 2026-09-11 while designing web2-admin, from
reading the sibling repositories. They are snapshots: file paths and line
numbers refer to the commits current that day (streaming-infra-manager master
b94caf3, swarm-hls-stream main bbfb8bf plus the named origin branches).

Both repositories were imported whole on 2026-09-27 and live under
`apps/infra-manager` and `apps/hls-stream`. The `scratchpad/repos/...` paths in
the notes point at a copy made for the reading, which is not in this repository.

| File                                                                       | What                                                                                                             |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [streaming-infra-manager.md](streaming-infra-manager.md)                   | Conventions we copy, the Manager API, its data model, port arithmetic.                                           |
| [swarm-hls-stream-ingest-and-feed.md](swarm-hls-stream-ingest-and-feed.md) | Ingest protocols and secrets, what a stream writes to Swarm, the publisher-auth branches, the old msrs-uploader. |
