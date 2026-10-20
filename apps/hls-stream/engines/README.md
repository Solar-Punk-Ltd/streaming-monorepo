# Engines

This is the reference for the media engines of the stack: SRS and OvenMediaEngine (OME). An engine
takes a broadcaster's SRT or RTMP stream and cuts it into HLS segments, which the
[stream uploader](../packages/stream-uploader/) publishes to Swarm. A deployment runs one engine.

Each engine has two parts:

1. **Server config**, here under `engines/<name>/`: a compose file, a config template and an
   entrypoint.
2. **Plugin**, in the uploader at `packages/stream-uploader/src/engines/<name>.ts`. It registers the
   engine's webhook routes on the uploader's HTTP server, so no separate process is needed.

| Engine        | Plugin       | Ingest                                                                                                     |
| ------------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| [srs](./srs/) | `ENGINE=srs` | SRT and RTMP into [SRS](https://github.com/ossrs/srs). The only engine with the ABR ladder                 |
| [ome](./ome/) | `ENGINE=ome` | SRT into [OvenMediaEngine](https://github.com/AirenSoft/OvenMediaEngine). The uploader pulls HLS over HTTP |

## How it works

1. The engine receives a stream and produces HLS segments.
2. The engine calls the uploader's webhooks under `/engines/<name>/`: `/engines/srs/streams` and
   `/engines/srs/hls` for SRS, `/engines/ome/admission` for OME.
3. The plugin reads each segment, from the shared volume for SRS or over HTTP for OME, and hands it to
   the upload pipeline.
4. The uploader does the rest: Swarm upload, playlists, feeds.

## The SRS image

The stack runs SRS from a public fork, [Solar-Punk-Ltd/swarm-srs](https://github.com/Solar-Punk-Ltd/swarm-srs):
SRS 6.0-r2 with three general features, each behind its own setting. Nothing in the fork knows about
this stack.

- **The encoder hold on reconnect**, below.
- **The takeover of a silent publisher**, below.
- **Upstream's fix for [ossrs/srs#4740](https://github.com/ossrs/srs/issues/4740)**, where a malformed
  H.264 sequence header aborts the whole server. Upstream merged it only on its development line, so
  the fork carries it on 6.0.

The compose files run `ghcr.io/solar-punk-ltd/swarm-srs:6.0-r2-swarm.4` and pin it by digest, so every
deploy runs the same build. A workflow in the fork builds SRS's own root `Dockerfile` for
`linux/amd64` with upstream's release flags (`--sanitizer=off --gb28181=on`). That Dockerfile copies
ffmpeg from upstream's build image.

| Image tag        | Adds                                                                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `6.0-r2-swarm.2` | The SRT takeover                                                                                                                                                                   |
| `6.0-r2-swarm.3` | The RTMP takeover, and `, vhost=<vhost>` at the end of each RTMP publisher's statistics line, which the manager reads for RTMP ingest health                                       |
| `6.0-r2-swarm.4` | Keeps a new RTMP broadcast's source while its publisher is still getting ready (upstream [ossrs/srs#4755](https://github.com/ossrs/srs/issues/4755), fixed upstream only in SRS 7) |

Without the `swarm.4` change, stock SRS 6 can drop a new RTMP source between the publisher connecting
and its `on_publish` hook answering. The publisher then publishes into the dropped source while the
ladder's encoders read a second, empty one, so the broadcaster looks live and no rung ever publishes.
The uploader reports such a ladder as `ladder_not_started`.

Going back to stock SRS means going back to a stack version without these settings as well. The
entrypoint writes `unpublish_hold` and `takeover`, and stock SRS refuses to start on a directive it
does not know.

The segment-duration probes in `deploy/scripts/srs-segment-duration*` run the stock `ossrs/srs` image
with a minimal config, so a problem they reproduce points at SRS rather than at the stack's template.

### The encoder hold on reconnect

With the ABR ladder on, SRS runs one ffmpeg per rung. When a broadcaster drops, stock SRS stops those
encoders one after another before it lets the stream name be published again. Each stop waits up to a
second, and a stalled ffmpeg ignores the polite signal, so for about 4 seconds after a drop every
reconnect is refused as "stream busy". An encoder like OBS that reconnects at once is refused, and the
broadcast can end there.

The fork frees the stream name at once and keeps the rung encoders running for a hold. If the
broadcaster returns within the hold, the same encoders carry on. If not, they are killed when the hold
runs out. Destroying the source, reloading the transcode config and stopping SRS kill held encoders at
once.

The hold is the transcode directive `unpublish_hold`, in seconds, inside the `transcode` block. The
fork defaults it to 0, which is off. The stack sets it from `ABR_UNPUBLISH_HOLD`, 12 seconds by
default. SRS checks it every 3 seconds, so a 12 second hold ends 12 to 15 seconds after the drop.

| Gap before the broadcaster returns | What happens                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Up to about 12 s                   | The same encoders carry on and no rung sends a hook. Each rung's segment numbers and media time continue without the gap. Every rung has a new segment 2 to 3 seconds after the new publish                                                                                                  |
| Longer                             | The hold has stopped the encoders, so the return starts a fresh set, and every rung has a new segment about 4 seconds after the new publish. SRS also cuts each idle rung publish after its 5 second publish timeout, so the uploader sees each rung's `on_unpublish` and later `on_publish` |

The hold is short on purpose. SRS cuts the idle rung publishes about 13 to 17 seconds into a drop, and
a held encoder past that point fails on its first write and restarts, which takes 8 to 10 seconds
instead of about 4. A broadcaster back 13 to 15 seconds after a drop can still meet that case. The hold
does not decide how long a broadcaster may be away. The uploader's `ORPHAN_REAP_MS`, 60 seconds by
default, does.

While rungs are held, the uploader sees only the source's `on_unpublish` and `on_publish`. On the
return it marks a break on each held rung's first segment and dates the recording from the wall clock
again, because the rungs' media time ran on without the gap. A broadcaster who returns with different
settings keeps working: video is re-encoded to each rung's size, and the rungs copy audio, so a
different audio sample rate carries on inside the same rendition.

### The takeover of a silent publisher

When a broadcaster's network dies without closing the connection, SRS keeps the old publisher until it
notices: about 7 seconds over SRT, and SRS's publish timeout over RTMP. Stock SRS refuses every
reconnect until then. With the takeover on, a new publisher that the `on_publish` hook accepted
replaces the old one: SRS disconnects the old publisher, waits up to 5 seconds for it to go, and
accepts the new one, or refuses it as before if the old one stays.

The setting that applies is the one for the protocol the new publisher uses. The one it replaces can
use either, so a broadcaster can switch between SRT and RTMP in the middle of a broadcast.

| New publisher | SRS directive, in the ingest vhost  | Stack setting   |
| ------------- | ----------------------------------- | --------------- |
| SRT           | `takeover` in the `srt` section     | `SRT_TAKEOVER`  |
| RTMP          | `takeover` in the `publish` section | `RTMP_TAKEOVER` |

The fork leaves both off by default, because with no `on_publish` hook any publisher could replace a
live one. The stack turns both on wherever the uploader refuses a wrong publish key, which is when
`PUBLISH_KEY_SECRET` or admin mode (`ADMIN_API_URL`) is set, and leaves them off otherwise. Set
`SRT_TAKEOVER` or `RTMP_TAKEOVER` to `on` or `off` to decide one outright. The entrypoint writes both
into the ingest vhost only. The ladder's rungs are RTMP publishers on their own vhost and carry no key,
so a takeover there would let anything on loopback replace a live rung. Never set the takeover through
SRS's own `SRS_VHOST_SRT_TAKEOVER` or `SRS_VHOST_PUBLISH_TAKEOVER`, which apply to every vhost.

- The uploader sees `on_publish` for the new connection before `on_unpublish` for the old one, and
  ignores an `on_unpublish` from a connection that is no longer the stream's publisher.
- SRS logs one serve error for each publisher it takes a stream from, `code=6003(SrtInterrupt)` over
  SRT or `code=1070(StThreadInterrupt)` over RTMP. It is the old connection closing, not a fault.
- Two encoders publishing with the same key take the stream from each other in turn, and the picture
  alternates between them.
- RTMP is not encrypted, so its stream key crosses the network readable. Anyone who reads a key can
  publish to that stream and, with the takeover on, take a live broadcast over. An SRT passphrase keeps
  the picture private, but the key travels in the SRT stream id, which is sent before encryption
  starts. A key read off an SRT connection publishes over RTMP, where no passphrase is asked.

## ABR ladder (SRS only)

Set `ABR_ENABLED=true` in the stack's `.env` and SRS produces several renditions, four by default,
instead of one. The uploader and SRS both read this setting. Setting it in `engines/srs/.env` reaches
both too, because `deploy.sh` passes the enabled engines' env files to compose, but the stack's `.env`
wins where both name a setting, so set it there. Each rung is a stream of its own, and the uploader
groups the rungs back into one ladder.

```
                             transcode (one ffmpeg per rung)    republish, RTMP 127.0.0.1
SRT or RTMP ingest ──▶ __defaultVhost__ ───────────────────▶ vhost abr ──▶ HLS + webhooks ──▶ uploader
                       hls: off                               no transcode
```

The uploader then writes a master playlist naming the rung feeds, on a feed whose topic is the ladder's
group id. The catalogue entry points at the master, so one address yields the whole ladder. See
[the ladder in the uploader's concepts](../packages/stream-uploader/concepts.md#the-abr-ladder).

Audio is muxed into each rung rather than split into an `EXT-X-MEDIA` group. With `ABR_ACODEC=copy`,
the default, the copies are identical and cost no CPU.

What holds this shape together:

- **The second vhost stops a transcode loop.** SRS matches transcode rules at vhost, app and stream
  level, and the matches add up (`parse_scope_engines` in `srs_app_encoder.cpp`). A rung republished
  into the vhost that transcodes would be transcoded again, and so would its output. A vhost with no
  transcode block ends that. If `?vhost=` ever fails to match, SRS falls back to `__defaultVhost__`
  and the loop starts, which is why the ingest vhost keeps its webhooks: the uploader can see a
  rendition arrive on the wrong vhost and say so.
- **Every rung cuts at the same media timestamps.** `ABR_FPS x HLS_FRAGMENT` is the rung keyframe
  interval and has to be a whole number of frames. The entrypoint refuses to start rather than round
  it, because a fractional interval drifts the rungs apart.
- **The transcode input dials the port the broadcast came in on.** SRS builds each rung's ffmpeg
  input as an RTMP play from `127.0.0.1` on the port in the broadcaster's own server URL. A broadcaster
  behind a forward that changes the port, for example a public 11935 forwarded to the stage's 1935,
  makes the input dial 11935 inside the container, where nothing listens, so that broadcast gets no
  rungs. Keep the port the same on both sides of any forward in front of RTMP. An SRT source carries no
  RTMP port and its input dials 1935, which the entrypoint makes SRS listen on from loopback when the
  RTMP listener is on another port.
- **A rung encoder whose input or output stalls exits, and SRS starts it again.** Each encoder carries
  ffmpeg's `rw_timeout`, set from `ABR_IO_TIMEOUT` in seconds. Unset, it is the hold plus 8, which is
  20 seconds at the default hold, and never below 18. The entrypoint refuses a value no longer than
  the larger of the hold plus SRS's 3 second check and 17 seconds, because a held encoder reads nothing
  while the broadcaster is away. If the transcoders still never start, the uploader reports
  `ladder_not_started` after `FIRST_RUNG_DEADLINE_MS`, and the broadcaster has to stop for longer than
  the encoder hold (about 15 s) and start again.

To check a running ladder, ask the SRS stats API on `SRS_HTTP_API_PORT` (1985 by default, shifted by
`--portSlot`): `curl http://localhost:1985/api/v1/streams`. Expect one source plus one stream per rung,
and a stable count. A count that keeps climbing is the transcode loop.

### HLS_FRAGMENT reaches two containers

SRS cuts segments at `HLS_FRAGMENT`, and the uploader dates every segment against it. Under a correctly
deployed ladder every segment is within 1% of the declared length, so every rung dates one piece of
media identically. If the two containers disagree, the dates still follow the media, but every
`#EXT-X-GAP` entry is dated and sized at the wrong length, and the rung keyframe interval, SRS's
force-close and the announcement ceiling below are all derived from it. A container reads the variable
only when it is recreated, so recreate both after changing it. `deploy/scripts/deploy.sh` does,
recreating the engine alone does not. The uploader reports `fragment_mismatch` on `/health` when its
first eight segments are not the declared length.

With the ladder off the same measurement reports `fragment_publisher_gop` instead. Nothing transcodes,
so SRS closes a segment at the first keyframe at or after `HLS_FRAGMENT`, the publisher's keyframe
interval decides the length, and the declared value is a floor. Set `HLS_FRAGMENT` to the publisher's
keyframe interval, or turn the ladder on. `/health` names each such stream under `publisherGopStreams`
with both lengths. Neither reason changes a date, refuses a segment or ends a broadcast.

### The announcement ceiling

SRS calls `on_hls` once per closed segment per rung, so a ladder asks for `rungs / HLS_FRAGMENT`
announcements a second. SRS sustains roughly 6 to 7 a second on a shared host, and nothing errors when
it cannot keep up. Announcements fall behind the media until the lag passes `HLS_WINDOW`, after which
SRS deletes each segment before announcing it: the uploader gets a callback naming a file that is
already gone, and the tallest rung is unpublished a few minutes in.

| Rungs | `HLS_FRAGMENT` | Announcements asked | Result                               |
| ----: | -------------: | ------------------: | ------------------------------------ |
|     1 |          0.5 s |               2.0/s | Fine                                 |
|     4 |          0.5 s |               8.0/s | Over the ceiling. Loses the top rung |
|     4 |          1.0 s |               4.0/s | Fine, lag stays flat                 |
|     4 |          2.0 s |               2.0/s | Fine. The shipped default            |

A four-rung ladder therefore needs `HLS_FRAGMENT` of at least 1.0. The e2e preflight
`announcement-rate` refuses a run on a stage that asks for more, but the stack itself does not refuse
such a ladder.

## What SRS logs

The template leaves SRS at its default log level, trace, on the console `docker logs` reads. At trace,
every SRT connect logs its stream id and every RTMP publish logs its `param`, both of which carry the
broadcaster's publish key, and every hook SRS calls logs its URL, which carries `SRS_WEBHOOK_TOKEN`.
The uploader redacts its own copies of both.

The level stays at trace because warn, which drops those lines, also drops the per-publisher
`Transport Stats` line, the only place SRS reports SRT loss. The manager's SRT ingest card reads that
line, and so does "Reading the loss" in the [deploy guide](../deploy/README.md#reading-the-loss). SRS
has one level for its whole log. A higher level would not close the leak anyway: a publish the
uploader refuses is logged at error with the hook URL, the token and the key.

Treat the engine's `docker logs` on a stage host as sensitive as its env file.

SRS also logs `Unlink ts failed` once per segment on each rung. The uploader deletes each segment
file once it has read and accepted it, and SRS's own HLS cleanup then tries to delete it again. The
line is harmless, but it fills the log, so filter it out when you look for real warnings.

## Play is loopback only, by default

SRS lets anyone who reaches one of its listeners play any stream it holds, unless a vhost's `security`
section says otherwise. RTMP publishing and playback share one port, so a firewall that admits
broadcasters admits players too. Nothing in the stack needs to play from SRS: a viewer reads the
broadcast from Swarm, and the only player is the ladder's own transcode input, which dials loopback
inside the container. So both vhosts allow play from loopback alone (`127.0.0.1`, `::1` and
`::ffff:127.0.0.1`) and publish from everywhere, because the `on_publish` hook checks a broadcaster's
key.

`SRS_PLAY_FROM` is that list. It takes addresses and CIDR blocks, separated by spaces or commas, or
`all`, and the entrypoint refuses anything else. A list without loopback stops the ladder.

SRS checks deny rules first and allow rules after, and once a vhost has any allow rule it refuses
whatever no allow rule matches (`srs_app_security.cpp`). That is why publish carries its own
`allow publish all`. RTMP and SRT go through the same check. So does a playlist asked of SRS's file
server, while a segment asked for by name is not checked, which leaves `SRS_HTTP_BIND`, the host's
Docker bridge by default, as what decides who reaches the file server.

Under host networking loopback is the host's, so any process on that host can play. A config file of
your own that drops the `security` sections opens play to everyone.

## Your own config file

Both engines are configured by file alone. SRS reads `srs.conf`, and its
[full.conf](https://github.com/ossrs/srs/blob/develop/trunk/conf/full.conf) documents every directive.
OME reads `Server.xml`, documented in its
[configuration guide](https://airensoft.gitbook.io/ovenmediaengine/configuration). Neither has a
configuration web page, and neither API writes configuration.

Set `SRS_CONF_FILE` or `OME_CONF_FILE` in `.env` (or `.env.<profile>`) to the path of a file on the
machine that runs compose. The deploy mounts it read-only where the engine's entrypoint looks
(`deploy/docker-compose.srs-conf.yml`, `deploy/docker-compose.ome-conf.yml`), and the entrypoint runs
on your file what it runs on the template:

- every `*_PLACEHOLDER` token you keep is filled from the environment, so the passphrase, the ports,
  the webhook token, `HLS_FRAGMENT`, `HLS_WINDOW` and the rest still come from settings
- a token you drop is gone, and the setting behind it stops applying
- with the ABR ladder on, `TRANSCODE_PLACEHOLDER` and `ABR_VHOST_PLACEHOLDER` mark where the generated
  transcode block and the rung vhost go. Drop them and the entrypoint warns and inserts nothing, which
  is right only if you wrote the ladder into the file yourself

A path that names no file is refused. Docker mounts a missing host path as an empty directory, so the
entrypoint finds a directory where the file should be, exits with a line naming the variable, and the
engine does not start on the template.

Start from a copy of the template. A file that does not parse takes the engine down on its next start,
so check it first. SRS has a test mode that names the offending line, and it checks values as well as
syntax, so fill the tokens with a stand-in and drop the two bare placeholder lines before you check.
Use the fork's image, because stock SRS refuses the template's `takeover` lines:

```bash
sed -E '/^(TRANSCODE|ABR_VHOST)_PLACEHOLDER$/d; s/[A-Z_]+_PLACEHOLDER/1/g' my-srs.conf > my-srs.check.conf
docker run --rm -v "$PWD/my-srs.check.conf:/check/srs.conf:ro" \
  ghcr.io/solar-punk-ltd/swarm-srs:6.0-r2-swarm.4 ./objs/srs -t -c /check/srs.conf
```

Deploy `my-srs.conf` itself, not the checked copy. The entrypoint fills its tokens from the
environment. OME has no test mode, and its log names the element it refused.

The file is read when the container starts, so a change needs the engine recreated
(`deploy.sh --profile <p> srs`). A template change in the repository does not reach a deployment that
runs on a file of its own.

## Generic API

The uploader also takes segments from any producer over HTTP, with no engine plugin:

```
POST /stream/start    { "streamId": "<id>", "mediatype": "video" | "audio" }
POST /stream/segment  Headers: x-stream-id, x-segment-index, x-duration  Body: raw binary
POST /stream/stop     { "streamId": "<id>" }  Answered 202, drains in the background
GET  /stream/status   ?streamId=<id>          live | draining | finalized | failed
```

All four need `Authorization: Bearer $API_AUTH_TOKEN`. There is no unauthenticated mode, because every
accepted segment spends postage. The [uploader reference](../packages/stream-uploader/README.md#http-api)
has the details.

## Adding a new engine

1. Add the server config under `engines/<engine-name>/`, with a compose file and config files.
2. Add a plugin at `packages/stream-uploader/src/engines/<engine-name>.ts` that implements
   `EnginePlugin` from `packages/stream-uploader/src/engines/types.ts` and registers the webhook routes
   the engine will call.
3. Register it in `packages/stream-uploader/src/engines/registry.ts` (`engineRegistry`), which
   `loadEngines()` reads.
4. Add an `engines/<engine-name>/.env.sample` with its settings.
5. Add the engine's service to `deploy/docker-compose.yml`.

```
engines/
  <engine-name>/
    docker-compose.yml        # the engine on its own, for development
    <config files>

packages/stream-uploader/src/engines/
  types.ts                    # EnginePlugin
  registry.ts                 # engineRegistry: engine name to plugin factory
  load.ts                     # loadEngines(): builds the configured engine's plugin
  <engine-name>.ts            # the plugin
```
