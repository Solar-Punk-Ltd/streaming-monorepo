# Stream uploader

The stream uploader is the service at the centre of the stack (`apps/hls-stream`). It takes the HLS
segments a media engine produces, uploads each one to Swarm, and publishes the playlists a viewer reads
as Swarm feeds. When a broadcast ends it publishes the recording. This page is its README and its
reference: settings, HTTP routes, health states, metrics and limits. How the publishing works, and why
it is shaped the way it is, is in [concepts.md](concepts.md).

## What it does

```
Segments in ──▶ StreamOrchestrator ──▶ StreamUploader ──▶ Swarm
                      │                      │
                      │                      ├─ Upload segment data
                      │                      ├─ Update the playlist feed (a single owner chunk)
                      │                      └─ Update the catalogue, or report state to the admin
                      │
                      ├─ Backpressure (bounded queue, 429 on overflow)
                      ├─ Deduplication (a repeated segment index is accepted and does no work)
                      └─ Crash recovery (state kept on disk, a recovery timeout)
```

- **Ingest.** Segments arrive from SRS or OvenMediaEngine (OME) through an engine plugin, or from any
  producer through the generic HTTP API.
- **Publish.** Each segment is uploaded to Swarm through a Bee node. Each stream has a live playlist,
  written to a Swarm feed after every segment. A feed is an address derived from a signing key and a
  topic, so a viewer who knows both can always find the newest playlist.
- **ABR ladder.** With `ABR_ENABLED=true`, SRS transcodes a broadcast into several qualities, called
  rungs. Each rung gets its own feed, and the uploader writes a master playlist that names them all.
- **Finish.** When a broadcast ends, the uploader writes a closing playlist and a recording (VOD), a
  playlist that names every segment of the broadcast.
- **Announce.** The stream list, called the catalogue, is a Swarm feed that says which streams exist
  and whether each is live or recorded.

## Two modes

| Mode                  | Turned on by          | Who owns the catalogue                                                                                                                       |
| --------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Standalone, the default | `ADMIN_API_URL` empty | The uploader writes the catalogue feed itself. Any publisher with a valid publish key may start a stream                                   |
| Admin mode            | `ADMIN_API_URL` set   | The admin (`apps/web2-admin`) owns the catalogue. A stream must be declared in the admin before it may publish, and the uploader reports state to it |

See [Admin mode](#admin-mode) for what changes.

## Run it

You need Node.js 24 or later, pnpm, and a running Bee node with a usable postage batch. From the
stack's folder, `apps/hls-stream`:

```bash
pnpm install                   # the whole workspace, from the root lockfile
pnpm build
cp .env.sample .env            # then set STREAM_KEY, and run `pnpm stamp:setup` for STAMP
pnpm uploader:start
```

The API listens on port 3000 unless `API_PORT` says otherwise. The service reads one `.env` in the
stack's folder, `apps/hls-stream`, never the monorepo root. Engine settings live in
`engines/<name>/.env`, loaded when `ENGINE` names that engine. A value in the stack's `.env`, or in the
container's environment, wins over the engine file. [.env.sample](../../.env.sample) lists every
setting.

To deploy it with the rest of the stack, see the [deploy guide](../../deploy/README.md).

## Settings

Required:

| Variable            | Description                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BEE_URL`           | Bee node API URL                                                                                                                                         |
| `STAMP`             | Postage batch id (`pnpm stamp:setup`). Required on a single-node deployment. With `BEE_PUBLISHERS` set it is optional and unread                         |
| `STREAM_KEY`        | Private key (hex) that signs every feed                                                                                                                  |
| `STREAM_LIST_TOPIC` | Feed topic of the catalogue                                                                                                                              |
| `API_AUTH_TOKEN`    | Bearer token for `/stream/*` and `GET /metrics`, at least 32 characters. Generate one with `openssl rand -hex 32`                                       |
| `HLS_FRAGMENT`      | The stage's segment length in seconds, the same variable the engine reads. Every segment's date is read against it. No default, `2` in `.env.sample` |

Optional:

| Variable                 | Default              | Description                                                                                                                                                                       |
| ------------------------ | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BEE_PUBLISHERS`         | _(empty)_            | One Bee node and batch per rung, as `rung@url<batch>`. Empty means one node for everything. See [One Bee node per rung](concepts.md#one-bee-node-per-rung)                   |
| `PUBLISH_KEY_SECRET`     | _(empty)_            | Master secret for per-stream publish keys, at least 32 characters. Empty leaves publishers unauthenticated. See [Publisher authentication](#publisher-authentication)          |
| `API_PORT`               | `3000`               | HTTP API port                                                                                                                                                                     |
| `STATE_DIR`              | `./state`            | Directory for crash recovery state                                                                                                                                                |
| `MAX_QUEUE_SIZE`         | `100`                | Most segments queued per stream                                                                                                                                                   |
| `RECOVERY_TIMEOUT`       | `60000`              | How long, in ms, a stream recovered after a crash waits for its encoder before it is finalized                                                                                   |
| `SEGMENT_STALL_MS`       | `30000`              | Silence after which `/health` reads degraded                                                                                                                                      |
| `FIRST_RUNG_DEADLINE_MS` | `45000`              | How long a ladder source SRS accepted may go without any rung publishing before `/health` reports `ladder_not_started`                                                            |
| `ORPHAN_REAP_MS`         | `60000`              | Silence after which a live stream is finalized. This is also the reconnect window                                                                                                |
| `UPLOADER_START_GATES`   | `chequebook-warn`    | Which startup gate stops the boot. See [Startup gates](#startup-gates)                                                                                                            |
| `START_GATE_TIMEOUT_MS`  | `20000`              | How long one startup gate read of one node, or the liveness probe before the gates, may take. 600000 at most. Separate from `BEE_REQUEST_TIMEOUT_MS`                             |
| `CHEQUEBOOK_MIN_BZZ`     | `0.5`                | Available chequebook balance every node must hold to count as funded. 1000 at most                                                                                               |
| `CHEQUEBOOK_RECHECK_MS`  | `60000`              | Time between reads of every node's chequebook while the uploader runs, 1000 to 3600000                                                                                           |
| `STAMP_MIN_TTL_HOURS`    | `12`                 | Hours a postage batch must have left for the postage gate to accept it                                                                                                           |
| `STAMP_MAX_UTILIZATION`  | `0.9`                | How full an immutable batch may be, as a ratio, for the postage gate to accept it. A mutable batch overwrites its oldest chunks when full, so it is never held to this          |
| `BEE_REQUEST_TIMEOUT_MS` | `4000`               | Deadline on every upload-loop call to a Bee node. A feed lookup carries a 15 s deadline of its own, and a recording's write one sized to the recording                         |
| `SEGMENT_DEDUP_WINDOW`   | `10000`              | Segment indexes remembered per stream for deduplication. Twice this many are held at most                                                                                        |
| `SEGMENT_REDUNDANCY`     | `1`                  | Erasure-coding parity on segment uploads. `0` turns it off                                                                                                                        |
| `ENGINE`                 | _(empty)_            | Engine plugin to load: `srs`, `ome` or empty                                                                                                                                      |
| `ABR_ENABLED`            | `false`              | Whether the engine publishes a ladder. Read here to group the rungs                                                                                                              |
| `ABR_LADDER`             | the engine's default | The rungs, as `name:width:height:kbps`. See `engines/srs/.env.sample`                                                                                                             |
| `ABR_VHOST`              | `abr`                | The SRS vhost rungs arrive on                                                                                                                                                     |
| `LADDER_MARKERS`         | `true`               | Write a time marker per ladder every 10 s, so a viewer finds every rung's newest playlist with one read. See [Ladder time markers](concepts.md#ladder-time-markers)            |
| `ADMIN_API_URL`          | _(empty)_            | Admin service base URL. Setting it turns on admin mode                                                                                                                           |
| `ADMIN_API_TOKEN`        | _(empty)_            | Bearer token for the admin's internal routes, at least 32 characters. Required when `ADMIN_API_URL` is set. It is the stage's own token, which the manager generates           |
| `LOG_LEVEL`              | `debug`              | `debug`, `log`, `info`, `warn`, `error` or `silent`. `log` writes one line per segment, `info` one per lifecycle event                                                           |
| `LOG_FORMAT`             | _(empty)_            | `json` for one `{ts, level, msg}` object per line. Anything else keeps the readable format                                                                                       |

Admin mode does not change what the uploader needs from Bee. `BEE_URL`, `STREAM_KEY`,
`STREAM_LIST_TOPIC`, `API_AUTH_TOKEN` and `HLS_FRAGMENT` stay required, and `STAMP` stays conditional
on `BEE_PUBLISHERS`.

Engine settings, such as `SRS_MEDIA_PATH` or the `OME_*` variables, live in `engines/<name>/.env`.
Copy [engines/srs/.env.sample](../../engines/srs/.env.sample) or
[engines/ome/.env.sample](../../engines/ome/.env.sample) to start.

## Engines

The uploader loads one engine plugin, chosen by `ENGINE`. A plugin is a thin adapter that turns the
engine's webhooks into calls on the `StreamOrchestrator`. The generic API works beside it, and both
feed the same orchestrator.

```typescript
interface EnginePlugin {
  name: string;
  prefix: string;
  createRouter(streamOrchestrator: StreamOrchestrator): Router;
}
```

Without the ABR ladder neither engine transcodes. Both remux the broadcaster's own streams into HLS,
so the picture a viewer gets is the picture that was published, and resolution and bitrate are the
broadcaster's choice. With the ladder on, SRS re-encodes every rung.

### SRS

With `ENGINE=srs` the uploader mounts:

| Route                       | What SRS sends                                 |
| --------------------------- | ---------------------------------------------- |
| `POST /engines/srs/streams` | The `on_publish` and `on_unpublish` webhooks   |
| `POST /engines/srs/hls`     | The `on_hls` webhook, one per closed segment   |

SRS writes segments to a volume both containers share. The uploader reads each segment from disk,
uploads it, and deletes the file. Both routes check `SRS_WEBHOOK_TOKEN` in the hook URL, the only
channel SRS 6 offers for a secret.

### OME

With `ENGINE=ome` the uploader mounts `POST /engines/ome/admission`, which OME calls when a publish
starts and stops. The uploader verifies the HMAC signature, then starts or stops the stream.

1. The broadcaster pushes SRT into OME, which remuxes it into MPEG-TS HLS.
2. OME calls the admission webhook, and the uploader starts the stream.
3. An `HlsPuller`, one per stream, polls `{app}/{stream}/ts:playlist.m3u8` and fetches each new
   segment over HTTP. That is OME's MPEG-TS playlist, so the segments are `.ts` and nothing
   downstream sees LL-HLS.
4. The orchestrator uploads each segment, and finalizes the recording when OME says the publish
   stopped.

### Adding an engine

Each engine owns its configuration. A `create<Name>EngineFromEnv()` factory reads the engine's
variables, and `src/engines/registry.ts` maps the `ENGINE` value to that factory. To add one, create
its module under `src/engines/`, register it, and add an `engines/<name>/.env.sample` with its
variables. The [engines reference](../../engines/README.md#adding-a-new-engine) lists the rest.

## HTTP API

| Route                  | Input                                 | What it does                                          |
| ---------------------- | ------------------------------------- | ----------------------------------------------------- |
| `POST /stream/start`   | JSON body `{ streamId, mediatype }`   | Register a stream                                     |
| `POST /stream/segment` | Raw body, and the headers below       | Push one segment                                      |
| `POST /stream/stop`    | JSON body `{ streamId }`              | End a stream. Answered `202`, drains in the background |
| `GET /stream/status`   | Query `?streamId=<id>`                | What became of a stream                               |
| `GET /metrics`         | None                                  | Prometheus exposition                                 |
| `GET /health`          | None                                  | Service health, `200` ok or `503`                     |

The four `/stream/*` routes and `GET /metrics` need `Authorization: Bearer $API_AUTH_TOKEN`. The token
is checked in constant time before the body is parsed, so an unauthenticated request neither reaches
the orchestrator nor costs a buffered body. `GET /health` takes no credential. It accepts no input and
spends nothing, and the compose healthcheck and `deploy/scripts/health.sh` read it.

The `/engines/*` webhook routes carry their own checks instead: the HMAC signature for OME and
`SRS_WEBHOOK_TOKEN` for SRS. Both refuse every request when their secret is empty.

Segment headers on `POST /stream/segment`:

| Header            | Meaning                    |
| ----------------- | -------------------------- |
| `x-stream-id`     | Stream identifier          |
| `x-segment-index` | Segment sequence number    |
| `x-duration`      | Segment duration in seconds |

Error answers:

| Status | When                                                                                                                                         |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | A required field is missing, or `x-duration` is not a usable segment length                                                                  |
| `401`  | A missing or wrong bearer token, on any `/stream/*` route and on `GET /metrics`                                                              |
| `404`  | Unknown stream                                                                                                                               |
| `409`  | Another session holds the id on `POST /stream/start`, or the stream is finalizing and takes no more segments. No retry of either can succeed |
| `429`  | The queue is full. Retry after the `Retry-After` header                                                                                      |

A segment whose index the stream has already taken is answered `200 {ok: true, queued: true}` and
nothing is queued. That makes a sender's retry after a network timeout safe. A caller counting its own
`200` answers therefore counts every retry, and `swarm_hls_segments_uploaded_total` is the number that
does not.

### Stop and status

`POST /stream/stop` answers `202` with `{ ok, accepted, streamId, statusUrl }` and drains in the
background, because a drain has up to five minutes to publish the recording and no media server holds
a webhook open that long. Read the outcome from `GET /stream/status?streamId=<id>`:

| `state`     | Meaning                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------- |
| `live`      | Registered and accepting segments                                                        |
| `draining`  | Stopping. The recording has not settled yet                                              |
| `finalized` | The recording was committed and the catalogue entry published                            |
| `failed`    | The finalize did not complete, with a `reason`. There is no recording and no retry is scheduled |

A stream the service has never seen, or one whose stop settled more than fifteen minutes ago, answers
`404`, so a caller polling a mistyped id is not told its broadcast is fine.

### Who may take a live stream id

An announce for an id a live session holds is refused when both publisher addresses are known and
different and something is still publishing into it. Everything else is allowed, because not every
engine reports a publisher address. A stream nothing has published into for `SEGMENT_STALL_MS` can be
claimed by anyone, so a refusal is never permanent.

- The rule protects whoever got there first. Someone who claims a stream id before your broadcaster
  does, and keeps feeding it, holds it. `POST /stream/stop` is the operator override.
- A publisher at the same address as your broadcaster is not told apart from them. One host, one NAT
  or one VPN exit all look the same.
- `swarm_hls_takeovers_refused_total` counts every refusal and cannot tell an attack from a
  locked-out broadcaster. Read it as a reason to check who holds the stream.

A publish key closes both gaps. See the next section.

## Publisher authentication

Without `PUBLISH_KEY_SECRET`, anyone who can reach the engine can publish under any stream name, and
the name is public because it is in every HLS URL.

Setting `PUBLISH_KEY_SECRET` turns on a publish key per stream. The key is derived from the secret and
the stream id, so it authorises that stream and no other, and a leaked key compromises one broadcast.

```bash
# Generate the secret once, put it in the stack's .env, and redeploy the stream-uploader.
openssl rand -hex 32

# Issue a key per stream. It prints SRS's SRT and RTMP addresses and OME's SRT address,
# and names the file the SRT passphrase lives in rather than printing it.
./deploy/scripts/publish-key.sh video/demo
```

Turning it on refuses every publisher that does not present a key, so issue the keys before you set
the secret. With it set, an announce carrying a valid key takes its stream id back at once from any
address, and an announce without one can never take a stream whose owner proved the key.

The key travels as a `key` query parameter:

| Publish path | Where the key goes                                                          |
| ------------ | --------------------------------------------------------------------------- |
| SRS, RTMP    | `rtmp://<host>:<SRS_RTMP_PORT>/video/demo?key=<key>`                        |
| SRS, SRT     | `srt://<host>:<SRS_SRT_PORT>?streamid=#!::r=video/demo?key=<key>,m=publish` |
| OME, SRT     | `srt://<host>:<OME_SRT_PORT>?streamid=<percent-encoded publish url>`        |

In OBS the RTMP form is two fields: Server `rtmp://<host>:<SRS_RTMP_PORT>/video` and Stream Key
`demo?key=<key>`. SRS reports the key in the hook's `param`, with a leading `?` over RTMP and without
it over SRT, and the plugin reads both, so a broadcaster may use either protocol, or switch in the
middle of a broadcast, under one key.

RTMP is not encrypted, so an RTMP key crosses the network readable. Anyone who reads it can publish to
that stream and, while the engine's takeover is on, take a live broadcast over. The SRT stream id is
sent before encryption starts, so an SRT passphrase keeps the picture private but not the key. See the
takeover section of the [engines reference](../../engines/README.md#the-takeover-of-a-silent-publisher).

Take the ports from `publish-key.sh`, which resolves them the way the deploy does. With no port slot
SRS uses 1935 for RTMP and 10080 for SRT. `--portSlot N` moves every host port into a band between
10000 and 19999, and `engines/ome/.env.sample` sets `OME_SRT_PORT=10081` so OME's SRT does not collide
with SRS's.

OME's stream id is percent-encoded, because the key sits inside a value that is itself inside a query.
`publish-key.sh` prints the encoded form.

Rotating `PUBLISH_KEY_SECRET` invalidates every key at once. There is no per-stream revocation.

## Admin mode

Setting `ADMIN_API_URL` turns admin mode on. A stream must then be declared in the admin before
anything may publish to it. The admin mints the feed topic and the publish key.

| Without `ADMIN_API_URL`                             | With it                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| Any publisher with the right derived key may start  | Only an ingest id the admin has declared, presenting that declaration's key    |
| A single rendition gets a random feed topic         | A single rendition publishes on the declared topic, resuming from its feed head |
| The uploader writes the catalogue feed              | It writes none, and reports `live` then `vod` to the admin                     |
| `PUBLISH_KEY_SECRET` authenticates publishers       | `PUBLISH_KEY_SECRET` is ignored                                                |
| A ladder's rungs are merged in the catalogue feed   | The admin merges them, and the declared topic is the ladder's master feed      |

A publish is refused when:

- the ingest `app/stream` is not declared, or the admin cannot be reached,
- the presented `key=` is not the declaration's,
- the declaration is owned by a feed key this uploader does not sign with,
- the ingest `app` and the declared media type disagree,
- the ingest id is not spelled exactly as the declaration's own `<app>/<topic>`. The admin finds a
  topic in any letter case, so this check stops a second session on the same feeds.

Each refusal is named in the log. SRS refuses the publish itself, so the encoder sees a rejected
connection.

### The signing key has to match the stage

Each stage signs with a key of its own, `STREAM_KEY`. The manager tells the admin each stage's owner
address, and the admin's catalogue entry points a viewer at that owner. An uploader signing with
another key writes feeds nobody reads while every report answers 200. So the uploader compares its own
address with the stage's owner at boot, and with each declaration's `owner` on every publish.

| The admin's answer to `GET /api/internal/stages/self` (with `ADMIN_API_TOKEN`) | The uploader                                                                               |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 200 with `{ stageId, owner }`                                                  | Compares `owner` with its signer. A mismatch refuses to start, naming both addresses       |
| 404, an admin with no stages or one answering a shared token                   | Compares the catalogue owner of the public `/api/config` instead                           |
| 401, an admin that takes only a stage's own token                              | Warns and starts. Every lookup and report it makes is refused the same way                 |
| Anything else, or nothing                                                      | Warns and starts. The publish gate still compares each declaration's owner                 |

A refusal says to fix the deployment's `STREAM_KEY` in the manager, or the stage the admin holds for
it. An uploader the manager did not deploy against that admin has no stage token and cannot report to
it.

How the ladder works in admin mode is in [concepts.md](concepts.md#the-abr-ladder-in-admin-mode).

## Health

`GET /health` answers `200` with `status: "ok"`, or `503` with `status: "degraded"` or
`status: "waiting_for_node"` and a `reasons` array.

The compose healthcheck polls it every 30 seconds and counts a `503` as a failure, so `docker ps`
shows `(unhealthy)` after three in a row. It reports and does not act. Compose does not restart a
container for failing its healthcheck, and a restart would drop every live broadcast without fixing
media that is already lost.

| Reason                   | Meaning                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `segment_upload_failure` | A segment reached the uploader and was never stored, because its upload retry window ran out or Bee refused it with a status the uploader does not retry, such as a full postage batch. That data is gone                                                                                                                                                                   |
| `segment_loss`           | A segment never reached the uploader: the engine could not get it from its origin, or skipped the index. Reported for `SEGMENT_STALL_MS` after the loss                                                                                                                                                                                                                      |
| `stale_manifest`         | Three live playlist publishes in a row failed or were held, so the live playlist is not moving. A held publish waits for a restarted stream's feed position and logs `is held:`, so a few seconds of this at the start of a re-broadcast is that wait                                                                                                                       |
| `queue_pressure`         | A segment queue is above 80% of `MAX_QUEUE_SIZE`, where the next segments start being refused, or a backlog holds more than `SEGMENT_STALL_MS` of playing time                                                                                                                                                                                                              |
| `segment_stall`          | A stream that should be producing has sent nothing for `SEGMENT_STALL_MS`                                                                                                                                                                                                                                                                                                    |
| `ladder_not_started`     | SRS accepted a ladder source and none of its rungs published within `FIRST_RUNG_DEADLINE_MS`, so its transcoders never started and viewers see the broadcast as scheduled. `ladderNotStartedStreams` names each source. Cleared when a rung publishes or the source leaves. The broadcaster has to stop for longer than the encoder hold (about 15 s by default) and start again |
| `unlisted_stream`        | A live stream is missing from the catalogue, so no viewer can find it. Reported from the first failed announce, after the catalogue's own retries (10 s for the write, 15 s for the read it appends to, none for a 404)                                                                                                                                                     |
| `state_not_persisted`    | A write into `STATE_DIR` is failing, so the next restart would resume from stale state                                                                                                                                                                                                                                                                                       |
| `ingest_refused`         | A credential gate turned away an ingest request (an engine webhook, or `POST /stream/start` or `/stream/segment`) and no segment has reached Swarm since the process started. This is what a wrong `SRS_WEBHOOK_TOKEN` or `OME_ADMISSION_SECRET` looks like. Latched until the first segment lands. A refused operator route, such as a tokenless `/metrics` scrape, never raises it |
| `unrecoverable_stream`   | A recovery entry could not be parsed at boot, so a broadcast that was live when the service last stopped cannot be finalized. The entry is kept as `<id>.json.corrupt` for repair. Latched until an operator clears it                                                                                                                                                      |
| `fragment_mismatch`      | With `ABR_ENABLED`, eight measured segments of a stream miss `HLS_FRAGMENT` by more than 5%. The engine and the uploader disagree on the segment length, which usually means one container runs an older deploy. Redeploy both                                                                                                                                              |
| `fragment_publisher_gop` | With no ladder, eight measured segments run more than 5% over `HLS_FRAGMENT`. The publisher's keyframe interval decides the segment, so set `HLS_FRAGMENT` to that interval, or turn the ladder on. `publisherGopStreams` gives both lengths                                                                                                                                 |
| `postage_refused`        | Bee refused a paid write on a rung's postage batch with a status nothing retries, usually a full or expired batch. Latched until a restart, because a rung's batch is read once at start. Redeploy once the batch pays again                                                                                                                                                |
| `node_unavailable`       | The boot is waiting for a Bee node to answer. Always reported alone. See [Waiting for the node](#waiting-for-the-node)                                                                                                                                                                                                                                                      |
| `start_gate_warned`      | A startup gate could not clear a node and the uploader started anyway, as `UPLOADER_START_GATES` allows. `startGateWarnings` names the gate and the rung. A postage warning stays until a restart. A chequebook warning clears per rung once its node holds its floor                                                                                                       |
| `chequebook_low`         | A publisher node's available chequebook balance has fallen under `CHEQUEBOOK_MIN_BZZ` after the boot, or the node no longer has a chequebook. A dry node keeps answering its own health check while every paid push on its rung stalls. `lowChequebooks` names each rung. Cleared on the first read that finds the node funded. The broadcast goes on                        |

Neither fragment reason changes a date, refuses a segment or ends a broadcast. They report a stage
that cuts a length the deployment did not declare.

`segment_upload_failure` and `postage_refused` answer different questions. The first is a count over
the streams registered now, so it clears on the next segment that lands and goes away when the
broadcast ends. A filling batch refuses a growing share of segments, so that count flaps.
`postage_refused` is about a node and a batch, so it outlives the stream that found it.

### The body

The route returns every signal the reasons are derived from: `activeStreams`, `staleManifestStreams`,
`maxConsecutiveManifestFailures`, `maxConsecutiveSegmentFailures`, `staleManifestStreamIds`,
`segmentFailingStreamIds`, `queuePressure`, `msSinceStreamActivity`, `msSinceSegmentLoss`,
`msSinceCatalogAnnounceFailed`, `msSinceStatePersistFailed`, `queueBacklogSeconds`,
`msSinceAuthRejection`, `disconnectedStreams`, `hasIngestedMedia`, `segmentsSkipped`,
`openingSegmentsWithheld`, `segmentsNeverNamed`, `quarantinedRecoveryEntries`,
`fragmentMismatchStreams`, `publisherGopStreams`, `postageRefusedPublishers`, `startGateWarnings`,
`publishers`, `refusedPublishers` and `engines`.

- `segment_stall` is measured per stream and reported for the worst one. A draining stream, a stream
  waiting for a reconnect after a crash, and a stream whose encoder has disconnected are left out.
- `disconnectedStreams` names every live stream whose encoder has gone and not come back. It raises no
  reason, because a disconnect is held for one reap window by design and is how every SRS broadcast
  ends. On a ladder, all rungs listed together is a whole-encoder outage, and one rung alone is a dead
  transcoder.
- `staleManifestStreamIds` names every live stream whose last live playlist publish failed, and
  `segmentFailingStreamIds` every live stream whose last segment upload failed. A ladder rung is a
  stream of its own, such as `live/stream_1080p`. Both name a stream from its first failure, so a name
  can appear while the service still answers `ok`.
- `queueBacklogSeconds` says which of `queue_pressure`'s two triggers fired.
- `msSinceAuthRejection` beside `hasIngestedMedia` is what `ingest_refused` is read from.
- `refusedPublishers` says which rung's batch was refused: the rung's line from `publishers` (node URL
  without credentials, batch id truncated), `statuses`, every distinct status Bee answered, and
  `firstRefusedAt`, the epoch milliseconds of the first refusal.

### Waiting for the node

The API listens before anything reads a Bee node, so `/health` answers from the first second. While
the part of the boot that needs a node has not finished, the answer is `503` with
`status: "waiting_for_node"`, the single reason `node_unavailable`, a `waitingSince` timestamp, and a
`node` object with `url`, `attempts` and, after a failure, `lastError`.

Meanwhile the service checks that the coordinator node is alive, runs the two startup gates, looks up
the catalogue feed and runs crash recovery (`libs/NodeWait.ts`). It retries with one log line per
attempt, backing off from 1 s and doubling up to 30 s, for as long as the node takes. A failure that
says the node is not answering is waited on. Any other failure, such as a feed payload that will not
parse or a key this deployment cannot sign with, ends the boot with exit 1.

While it waits, `/stream/*` and every engine route answer `503` naming the node, with
`Retry-After: 5`. `/metrics` keeps answering.

### Startup gates

Two gates read every publisher node before the first broadcast. The chequebook gate checks that each
node holds `CHEQUEBOOK_MIN_BZZ`. The postage gate checks that each node holds its configured batch, with
`STAMP_MIN_TTL_HOURS` left and, for an immutable batch, under `STAMP_MAX_UTILIZATION`.

| `UPLOADER_START_GATES`        | Chequebook gate | Postage gate                                                                                  |
| ----------------------------- | --------------- | --------------------------------------------------------------------------------------------- |
| `chequebook-warn`, the default | warns           | refuses a batch the node answered about as absent, unusable, expired or full. Warns on a batch it could not read at all |
| `warn`                        | warns           | warns                                                                                         |
| `refuse`                      | refuses         | refuses                                                                                       |

A gate that warns reads every node rather than stopping at the first, so one boot names every rung to
fix. The service is degraded while a warning stands, which the healthcheck and
`deploy/scripts/assert-started.sh` report. After the boot, every chequebook is read again each
`CHEQUEBOOK_RECHECK_MS` (`libs/ChequebookRecheck.ts`). The uploader never moves money. Funding a node
is the operator's job.

## Metrics

`GET /metrics` serves Prometheus text exposition. The values are totals for the life of the process,
so they outlive the streams they count, which `/health` cannot do. `/metrics` is behind the bearer
token. Point a scraper at it with an `authorization` credential:

```yaml
# `stream-uploader:3000` is the default. `API_PORT` sets both sides of the compose port map,
# and `deploy.sh --portSlot` shifts it.
scrape_configs:
  - job_name: swarm-hls-stream
    authorization:
      credentials: <API_AUTH_TOKEN>
    static_configs:
      - targets: ['stream-uploader:3000']
```

| Metric                                           | Type    | Meaning                                                                |
| ------------------------------------------------ | ------- | ---------------------------------------------------------------------- |
| `swarm_hls_segments_uploaded_total`              | counter | Segments whose payload reached Swarm                                   |
| `swarm_hls_rung_segments_uploaded_total`         | counter | The same, by ABR rung. Empty with no ladder                            |
| `swarm_hls_segments_dropped_total`               | counter | Segments never stored: retry window spent, or Bee refused it           |
| `swarm_hls_rung_segments_dropped_total`          | counter | The same, by ABR rung. Empty with no ladder                            |
| `swarm_hls_segments_lost_total`                  | counter | Segments the engine never obtained, or never posted at all             |
| `swarm_hls_segments_skipped_total`               | counter | Segments discarded on purpose at a puller handover                     |
| `swarm_hls_opening_segments_withheld_total`      | counter | Opening segments held back until the broadcast showed video            |
| `swarm_hls_segments_never_named_total`           | counter | Segments in Swarm that no published playlist named                     |
| `swarm_hls_auth_rejections_total`                | counter | Requests refused by a credential gate, on every route                  |
| `swarm_hls_takeovers_refused_total`              | counter | Announces refused because a live session still holds the id            |
| `swarm_hls_manifest_publish_failures_total`      | counter | Live playlist publishes that failed                                    |
| `swarm_hls_rung_manifest_publishes_total`        | counter | Live playlist publishes that landed, by ABR rung. Empty with no ladder |
| `swarm_hls_rung_manifest_publish_failures_total` | counter | The failures above, by ABR rung. Empty with no ladder                  |
| `swarm_hls_ladder_markers_written_total`         | counter | Ladder time markers written                                            |
| `swarm_hls_ladder_markers_failed_total`          | counter | Markers given up on inside their period. Playback is unharmed          |
| `swarm_hls_streams_finalized_total`              | counter | Stops that published a recording                                       |
| `swarm_hls_streams_failed_total`                 | counter | Stops that did not. Those broadcasts have no recording                 |
| `swarm_hls_streams_reaped_total`                 | counter | Broadcasts finalized because their engine went silent                  |
| `swarm_hls_segment_durations_unread_total`       | counter | Segments published on the engine's word, unreadable here               |
| `swarm_hls_postage_refused_publishers`           | gauge   | Rungs whose postage batch Bee has refused. Never clears                |
| `swarm_hls_last_segment_timestamp_seconds`       | gauge   | Unix time of the newest segment that landed, 0 while none              |
| `swarm_hls_active_streams`                       | gauge   | Streams registered and expected to be producing                        |
| `swarm_hls_queue_depth`                          | gauge   | Segments waiting to upload across every stream                         |
| `swarm_hls_queue_backlog_seconds`                | gauge   | Playing time still queued for the worst stream                         |

Reading the per-rung breakdowns:

- **They are empty without a ladder.** A single-rendition stream has no rung, so it counts only in the
  unlabelled totals. The totals and the breakdowns therefore need not sum. Difference two scrapes to
  get a rate. Each rung needs `1 / HLS_FRAGMENT` uploads a second.
- **One rung's drops climbing while its uploads slow is that rung's postage batch filling.** Each rung
  publishes through its own Bee node and batch, so a batch running out stops one rung and leaves the
  others publishing. The uploader also logs one error line per status Bee answers, per stream:
  `Postage batch <id> of <stream> refused by bee (<status> <message>), the rung thins out as the batch fills and this is the first refusal bee answered with this status`.
  A filling batch refuses a growing share of segments, so segments keep landing in between.
- **A rung whose playlist publishes stand still while its uploads climb is a rung no viewer can find.**
  Its segments are in Swarm, but no playlist names them. Read
  `swarm_hls_rung_manifest_publishes_total` and `swarm_hls_rung_manifest_publish_failures_total` on the
  same label.
- **One rung reading zero uploads while the others hold** means SRS deletes that rung's segments
  before it announces them, because the ladder asks for more announcements a second than SRS can
  deliver. See the announcement ceiling in the
  [engines reference](../../engines/README.md#the-announcement-ceiling).

## Known limits

- A segment and the playlist that names it race by about a tenth of a second. The uploader writes
  segment bytes deferred, so the feed slot that names a segment can become readable before the
  segment itself. A reader at the live edge can then get a 404 for a segment that is readable a
  moment later. A player retries and does not notice.
- The catalogue and every master playlist are written through the coordinator's node and batch, the
  lowest rung's. If that batch runs dry, the master cannot be rewritten and the recording cannot be
  announced for any rung. The uploader has no coordinator failover.
- Each rung's batch is read once at start from `BEE_PUBLISHERS`. Replacing a batch needs a redeploy.
- `stamp:buy` buys the same amount and depth for every rung, although 1080p fills a given batch about
  seven times sooner than 360p.
- A deployment without a publish key starts a new session when a broadcaster returns from a different
  address. Set `PUBLISH_KEY_SECRET`, or run in admin mode, to keep one session across an address change.
- A single-rendition stage whose publisher keyframe interval does not divide `HLS_FRAGMENT` cuts
  segments longer than declared. The dates stay right, but every `#EXT-X-GAP` entry is sized at the
  declared length. See [concepts.md](concepts.md#the-manifest-contract).
- Two ladder cases keep rungs apart in numbering or dates. See
  [concepts.md](concepts.md#known-gaps-in-ladder-alignment).

## Local development

### Push segments by hand

The generic API needs no engine:

```bash
curl -X POST http://localhost:3000/stream/start \
  -H "Authorization: Bearer $API_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"streamId": "test/mystream", "mediatype": "video"}'

curl -X POST http://localhost:3000/stream/segment \
  -H "Authorization: Bearer $API_AUTH_TOKEN" \
  -H 'x-stream-id: test/mystream' \
  -H 'x-segment-index: 0' \
  -H 'x-duration: 1.5' \
  --data-binary @segment-0.ts

curl -X POST http://localhost:3000/stream/stop \
  -H "Authorization: Bearer $API_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"streamId": "test/mystream"}'

# The stop is accepted, not completed. Poll for the outcome.
curl -G http://localhost:3000/stream/status \
  -H "Authorization: Bearer $API_AUTH_TOKEN" \
  --data-urlencode 'streamId=test/mystream'
```

### Publish a test pattern to SRS

With SRS running and `ENGINE=srs`:

```bash
# Video and audio
ffmpeg -re -f lavfi -i testsrc=size=1280x720:rate=30 \
  -f lavfi -i sine=frequency=1000 \
  -c:v libx264 -preset veryfast -g 45 -c:a aac -b:a 128k \
  -f mpegts "srt://localhost:10080?streamid=#!::r=video/test,m=publish"

# Audio only (macOS microphone)
ffmpeg -f avfoundation -i ":0" -ac 1 -c:a aac -b:a 128k \
  -f mpegts "srt://localhost:10080?streamid=#!::r=audio/test,m=publish"
```

With `PUBLISH_KEY_SECRET` set, add the stream's key inside the `r=` value:
`streamid=#!::r=video/test?key=<key>,m=publish`. Get the key from
`./deploy/scripts/publish-key.sh video/test`.

### SRS in Docker, the uploader on the host, against an admin

1. Start SRS from `engines/srs` with the `local` overlay, which points SRS's webhooks at
   `host.docker.internal`:

   ```bash
   cd engines/srs
   cp .env.sample .env
   ```

   ```ini
   # engines/srs/.env: the values the local overlay needs
   SRS_WEBHOOK_TOKEN=<same value the uploader gets>   # openssl rand -hex 32
   SRT_PASSPHRASE=<10-79 chars, or empty for no SRT encryption>
   SRS_ADAPTER_HOST=host.docker.internal              # the uploader is on the host
   SRS_ADAPTER_PORT=3000                              # must equal the uploader's API_PORT
   SRS_RTMP_PORT=1935
   SRS_SRT_PORT=10080
   SRS_HTTP_PORT=8080
   SRS_HTTP_API_PORT=1985
   ```

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
   # or, from apps/hls-stream:  pnpm srs:local
   ```

   SRS publishes `1935` RTMP, `10080/udp` SRT, `8080` HLS and `1985` for its HTTP API, each on the
   same number inside and outside the container.

2. Start the uploader from `apps/hls-stream`, with an admin API running on port 9877 and this in the
   stack's `.env`:

   ```ini
   BEE_URL=http://localhost:1633
   STAMP=<batch id, pnpm stamp:setup>
   STREAM_KEY=<32-byte hex private key>
   STREAM_LIST_TOPIC=swarm-stream
   API_AUTH_TOKEN=<min 32 chars>
   STATE_DIR=./state
   ENGINE=srs
   API_PORT=3000
   ADMIN_API_URL=http://localhost:9877
   ADMIN_API_TOKEN=<min 32 chars, the stage's own token>
   ```

   ```bash
   pnpm --filter @swarm-hls-stream/stream-uploader build
   pnpm --filter @swarm-hls-stream/stream-uploader start
   ```

   The boot log names the mode: `[Admin] Admin mode against <url>`, or
   `[Admin] ADMIN_API_URL is not set, running standalone`. `SRS_WEBHOOK_TOKEN` is read from
   `engines/srs/.env` and has to be the same on both sides.

3. Declare the stream in the admin. The admin uses the stream's topic, a UUID, as `<stream>`, and shows
   the URLs and the key on the stream's page. `<app>` is `video` or `audio` and has to match the
   declared media type. Then publish:

   ```bash
   ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine \
     -c:v libx264 -preset veryfast -g 60 -keyint_min 60 -c:a aac \
     -f flv "rtmp://localhost:1935/video/<stream>?key=<publishKey>"
   ```

   Over SRT, with the same key inside the `r=` value:

   ```bash
   ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine \
     -c:v libx264 -preset veryfast -g 60 -keyint_min 60 -c:a aac \
     -f mpegts "srt://localhost:10080?streamid=#!::r=video/<stream>?key=<publishKey>,m=publish"
   ```

   In OBS, under Settings, Stream, Service Custom, set Server to `rtmp://localhost:1935/video` and
   Stream Key to `<stream>?key=<publishKey>`. Under Settings, Output, set Keyframe Interval to 2 s. The
   segment length is `ceil(HLS_FRAGMENT / GOP) * GOP`, so an unknown keyframe interval is an unknown
   segment length. For SRT, set Server to
   `srt://localhost:10080?streamid=#!::r=video/<stream>?key=<publishKey>,m=publish` and leave Stream
   Key empty.

## Source layout

| Module               | What it does                                                                     |
| -------------------- | -------------------------------------------------------------------------------- |
| `StreamOrchestrator` | Stream lifecycle, queue, backpressure, recovery                                  |
| `StreamUploader`     | One stream's upload session: uploads segments, publishes its playlists           |
| `StreamCatalog`      | The catalogue feed                                                               |
| `RecoveryStore`      | Stream state on disk, for crash recovery                                         |
| `ManifestManager`    | Builds the live, closing and recording playlists                                 |
| `AbrLadder`          | The rung list from `ABR_LADDER`, and the map from a stream name to its rung      |
| `BeePublisherPool`   | Which Bee node and postage batch each rung publishes through                     |
| `MasterPlaylist`     | Builds a ladder's master playlist                                                |
| `MasterFeedWriter`   | Publishes the master to a feed per ladder, whose topic is the ladder's group id  |
| `BitrateMeter`       | Measures each rung's real bitrate, which becomes the master's `BANDWIDTH`        |
| `LadderLiveness`     | Which rungs are still producing, so the master stops offering one that is not    |
| `LadderMarkerWriter` | Writes a ladder's time markers                                                   |
| `NodeWait`           | The boot's wait for a Bee node                                                   |

| Script           | What it does                                                             |
| ---------------- | ------------------------------------------------------------------------ |
| `pnpm build`     | Compile TypeScript                                                       |
| `pnpm start`     | Start the server                                                         |
| `pnpm lint`      | Run oxlint                                                               |
| `pnpm typecheck` | Type check without emitting                                              |
| `pnpm test`      | Unit tests, then the test-count floor in `scripts/assert-test-floor.mjs` |

Two unit tests read this page. `test/metrics.test.ts` checks that the metric table names exactly the
metrics `/metrics` serves, with the right type. `deploy/test/uploaderEnv.test.js` checks that every
setting the uploader reads has a row in one of the two settings tables.
