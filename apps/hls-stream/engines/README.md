# Engines

Transcoding engines that produce HLS segments for the [stream-uploader](../packages/stream-uploader/).

Each engine has two parts:

1. **Server config** — lives here under `engines/<name>/` (docker-compose, config files)
2. **Plugin** — lives in the stream-uploader at `packages/stream-uploader/src/engines/<name>.ts`

The plugin registers engine-specific HTTP routes on the uploader's server. No separate process needed — the engine's webhooks call the uploader directly.

## Available Engines

| Engine        | Plugin       | Description                                                                                                  |
| ------------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| [srs](./srs/) | `ENGINE=srs` | SRT/RTMP ingest via [SRS](https://github.com/ossrs/srs)                                                      |
| [ome](./ome/) | `ENGINE=ome` | SRT ingest via [OvenMediaEngine](https://github.com/AirenSoft/OvenMediaEngine); uploader pulls HLS over HTTP |

## How It Works

1. The transcoding server (e.g., SRS) receives a stream and produces HLS segments on disk
2. The server sends webhooks to the stream-uploader under `/engines/<name>/`, at paths the engine chooses: `/engines/srs/streams` and `/engines/srs/hls` for SRS, `/engines/ome/admission` for OME. Only the prefix is generic
3. The engine plugin reads segments from disk and passes them to the upload pipeline
4. The uploader handles everything else (Swarm upload, manifests, feed management)

## The SRS image

The stack runs SRS from our public fork, [Solar-Punk-Ltd/swarm-srs](https://github.com/Solar-Punk-Ltd/swarm-srs),
which is SRS 6.0-r2 with three changes. Each is a general SRS feature with its own setting, and nothing in the fork
knows about this stack:

- **The encoder hold on reconnect**, described below.
- **The takeover of a silent publisher**, described below.
- **Upstream's fix for [ossrs/srs#4740](https://github.com/ossrs/srs/issues/4740)**, where a malformed H.264
  sequence header aborts the whole server. Upstream merged it only on its development line
  ([ossrs/srs#4741](https://github.com/ossrs/srs/pull/4741)), so the fork carries it on 6.0.

**Why the hold exists.** With the ABR ladder on, SRS runs one ffmpeg per rung. When the broadcaster drops, stock
SRS stops those encoders one after another before it lets the stream name be published again. Each stop waits up
to a second before it kills, and a stalled ffmpeg ignores the polite signal, so for about 4 seconds after a drop
every reconnect is refused as "stream busy". An encoder like OBS that reconnects straight away is refused, and the
broadcast can end there. Measured on a local rig with the stack's own config and a four-rung ladder, a reconnect
0.3 seconds after a clean drop was refused in 10 tries of 10, at 1 second in 9 of 10 and at 2 seconds in 6 of 10.
Upstream knows the symptom ([ossrs/srs#4173](https://github.com/ossrs/srs/issues/4173)), and every SRS line has the
same code.

**What the fork does instead.** When the broadcaster drops, SRS frees the stream name at once and keeps the rung
encoders running. If the broadcaster comes back within the hold, the same encoders carry on. If nobody comes back,
the encoders are killed when the hold runs out. Destroying the source, reloading the transcode config and shutting
SRS down kill held encoders at once.

The hold is the transcode directive `unpublish_hold`, in seconds, set inside the `transcode` block beside `ffmpeg`.
The fork leaves it at 0 by default, which is off and behaves as stock SRS does. The stack sets it from
`ABR_UNPUBLISH_HOLD`, **12 seconds by default**, and SRS checks it every 3 seconds, so a 12 second hold ends 12 to 15
seconds after the drop.
It is kept short on purpose, for the reason the measurements below show: SRS cuts the idle rung publishes about 13 to
17 seconds into a drop, and past that a held encoder only fails and restarts, which is slower than a fresh set. The
hold's own end, 12 to 15 seconds after the drop, can overlap the earliest of those cuts, so a broadcaster back 13 to 15
seconds after a drop can meet a held encoder that has to restart. The hold
does not decide how long a broadcaster may be away. That is the uploader's `ORPHAN_REAP_MS`, 60 seconds by default,
and a broadcaster back within it continues the same broadcast whatever the hold is.

**What a broadcaster and the uploader see.** Measured on the same rig with the fork's image, the stack's 12 second
hold and a clean drop, every reconnect was accepted at every gap from 0.3 to 70 seconds:

- **A gap of up to about 12 seconds.** The same four encoders carry on and no rung sends a hook. Each rung's segment
  numbers continue, and its media time continues without the gap, one frame later than the last frame before it,
  with no timestamp errors. Every rung has a new segment 2 to 3 seconds after the new publish. It makes no
  difference whether the broadcaster's clock restarts from zero or continues.
- **A longer gap.** The hold has stopped the encoders, so the return starts a fresh set, and every rung has a new
  segment about 4 seconds after the new publish. During the gap SRS also cuts each rung's idle publish on the ABR
  vhost, after its publish timeout of 5 seconds by default, which the stack does not set. So the uploader gets each
  rung's `on_unpublish` during the gap and its `on_publish` after the return, and takes the rungs up through its usual
  resume path.
- **Why the hold is not longer.** With a hold of 60 seconds, a return between about 13 and 60 seconds
  finds encoders whose rung publishes SRS has already cut. They fail on their first write and restart, and every rung
  is back after 8 to 10 seconds instead of about 4. Up to about 12 seconds the two behave the same.
- **The uploader** sees only the source's `on_unpublish` and `on_publish` while the rungs are held. When the source
  returns, it marks a break on each held rung's first segment after the return and dates the recording from the wall
  clock again at that point, because the rungs' media time ran on without the gap.
- **A broadcaster who returns with different settings.** Video is re-encoded to each rung's size as before. The rungs
  copy audio, so a different audio sample rate carries on inside the same rendition, and the change can fall inside a
  segment.

**The takeover of a silent publisher.** When a broadcaster's network dies without closing the connection, SRS keeps
the old publisher until it notices. Over SRT that is the dead peer, about 7 seconds. Over RTMP it is SRS's publish
timeout, `normal_timeout` in a vhost's `publish` section, which the stack does not set. Stock SRS refuses every
reconnect until then, and an encoder that gives up after one refusal ends the broadcast there. With the takeover on, a
new publisher that the `on_publish` hook accepted replaces the old one: SRS disconnects the old publisher, waits up to
5 seconds for it to be gone, and accepts the new one, or refuses it as before if the old one does not go.

Each protocol has its own setting, kept where SRS keeps that protocol's publisher settings, and the setting that
applies is the one for the protocol the **new** publisher comes over. The one it replaces can come over either, so a
broadcaster can switch from SRT to RTMP or back in the middle of a broadcast, and the switch is a takeover like any
other.

| New publisher | SRS directive, in the ingest vhost  | Stack knob      | In the fork's image from |
| ------------- | ----------------------------------- | --------------- | ------------------------ |
| SRT           | `takeover` in the `srt` section     | `SRT_TAKEOVER`  | `6.0-r2-swarm.2`         |
| RTMP          | `takeover` in the `publish` section | `RTMP_TAKEOVER` | `6.0-r2-swarm.3`         |

`6.0-r2-swarm.3` also ends the RTMP publisher's periodic statistics line, the `<- CPB time=...` line SRS prints for
each RTMP publisher about every ten seconds, with `, vhost=<vhost>`. That is the vhost SRS resolved for the publisher,
not the host it dialled, so a broadcaster that dialled a host no vhost names is logged as `__defaultVhost__`, and a
ladder rung as the ABR vhost. Older images end the line at `pnt=`. The manager reads RTMP ingest health from this
line, so on an older image it shows RTMP as not measured.

The fork leaves both off by default, because with no `on_publish` hook every publisher is accepted and could replace a
live one. The stack turns both on by itself wherever the uploader refuses a wrong publish key, which is when
`PUBLISH_KEY_SECRET` or admin mode (`ADMIN_API_URL`) is configured, and leaves them off otherwise, because the uploader
then accepts any publisher. Compose tells SRS only whether each of the two is set, never its value. `SRT_TAKEOVER` and
`RTMP_TAKEOVER`, each `on` or `off`, decide one outright. The entrypoint writes both into the ingest vhost and nowhere
else. The ladder's rungs are RTMP publishers on their own vhost that carry no key, so the hook admits a rung by its
loopback origin, and a takeover there would let any publisher that reaches SRS from loopback replace a live rung. Set
the two through these knobs and never through SRS's own `SRS_VHOST_SRT_TAKEOVER` or `SRS_VHOST_PUBLISH_TAKEOVER`,
because SRS applies such an override to every vhost, the ladder's included.

Measured for SRT on the same rig with the 12 second hold, a publisher killed without closing its connection and a new
one with the same key 1, 3 or 5 seconds later: all 30 reconnects were accepted, the takeover took 11 to 45
milliseconds, the four encoders were kept, and every rung had a new segment 2.2 to 3.6 seconds after the new publish.
A publisher with a wrong key was refused in 10 tries of 10 and never disturbed the live one. With `SRT_TAKEOVER=off`
the reconnect is refused as on stock SRS.

- **The uploader** sees `on_publish` for the new connection before `on_unpublish` for the old one, and ignores an
  `on_unpublish` from a connection that is no longer the stream's publisher. Both protocols send the same hooks, so
  it handles an RTMP takeover and a switch between protocols the same way.
- **SRS logs** one serve error line for each publisher it takes a stream from, `code=6003(SrtInterrupt)` for an SRT
  publisher and `code=1070(StThreadInterrupt)` for an RTMP one. It is the old connection being closed, not a fault.
- **Two encoders publishing with the same key** take the stream from each other in turn, over either protocol, and
  the picture alternates between them. Closing one of them ends it.
- **A stream key read off the network.** RTMP is not encrypted. Its stream key crosses the network readable, and
  RTMP has no passphrase as SRT has. Anyone who reads a key off the network can publish to that stream, and while a
  takeover is on they can also take a live broadcast over, whichever protocol it came in over. An SRT passphrase
  keeps the picture private and refuses an SRT publisher without it, but it does not keep the key private. The key
  travels in the SRT stream id, which SRT sends before encryption starts, so a key read off an SRT broadcaster's
  connection publishes over RTMP, where no passphrase is asked.

**How the image is built.** A workflow in the fork builds SRS's own root `Dockerfile` for `linux/amd64`, with the
configure flags of upstream's release (`--sanitizer=off --gb28181=on`), and pushes it to
`ghcr.io/solar-punk-ltd/swarm-srs`. That Dockerfile copies ffmpeg from upstream's build image instead of compiling
it. On 2026-10-01 that build image held the same ffmpeg 8.1.2 binary as the official `ossrs/srs:v6.0-r1` and
`v6.0-r2` images, byte for byte.

The compose files run `ghcr.io/solar-punk-ltd/swarm-srs:6.0-r2-swarm.3`, built from the fork's `main` at
`5a388649`, and pin it by digest, so every deploy runs the same build.

**Going back to stock SRS** means going back to a stack version from before this change as well. The entrypoint writes
`unpublish_hold` and `takeover`, and stock SRS refuses to start on a directive it does not know.

The segment-duration probes in `deploy/scripts/srs-segment-duration*` keep the stock `ossrs/srs` image on purpose.
They run a minimal config against upstream SRS, so a reproduction there points at SRS and a non-reproduction points
at our template.

## ABR ladder (SRS only)

Set `ABR_ENABLED=true` in the root `.env` and SRS produces four renditions instead of one. The
uploader and SRS both read this knob, and compose interpolates each service's copy from the root
`.env`. Setting it in `engines/srs/.env` instead reaches both as well, because `deploy.sh` writes
every key of the enabled engines' env files into the override file it hands compose as a second
`--env-file`. The root wins wherever both name a knob, so the root `.env` is the one place to set it
and a value left behind in the engine file changes nothing. What does leave the pair disagreeing is
recreating one container and not the other, and on this knob that is SRS producing four renditions
while the uploader publishes four unrelated streams. The paragraph below carries the rule.
Each rung is a stream in its own right, so the flow above is unchanged, it just happens four times,
and the uploader gets four feeds it groups back into one ladder.

`HLS_FRAGMENT` is the same two-container shape, and it bites harder because the two containers can
disagree rather than one of them simply being off. SRS cuts segments at it, and the uploader reads
every segment against it: a segment within 1% of the declared length is dated as exactly that length,
and one outside it by what it really held. Under a correctly deployed ladder every segment sits inside
that 1%, so nothing about the dating moved: each date is what stepping by the declared length always
gave, and the four rungs stamp one piece of media identically. An uploader on 0.5 behind an engine on
1.0 dates every 1.0 second segment by the second of media it really holds, so the recording's clock no
longer goes wrong. What that disagreement still costs is everything else the declared length is the
basis of: every `#EXT-X-GAP` entry is dated and sized at it, so a segment the broadcast loses leaves a
hole of the wrong size in the timeline, and the rung GOP, SRS's force-close and the announcement
ceiling described below are all derived from it. The deployment is not what its configuration says. A
container re-reads the variable only when it is recreated, so **recreate both after changing it**,
which `deploy/scripts/deploy.sh` does and recreating the engine alone does not. The uploader measures
its first eight segments and reports `fragment_mismatch` on `/health` when they are not the length it
was told, which is a signal after the fact rather than a substitute for redeploying the pair.

With the ladder **off** the same measurement reports `fragment_publisher_gop` instead, and it is a
different cause with the same consequence. Nothing transcodes there, so SRS closes a segment at the
first keyframe at or after `HLS_FRAGMENT` and the publisher's own keyframe interval decides the length,
which makes the configured value a floor. A live single-rendition stream was measured on 2026-09-15
cutting 2.067 to 10.033 seconds against a configured 2. No container is stale and no redeploy fixes it,
and the dates follow that media rather than the configured 2, so the recording's clock is right here
too. What the reason names is a stage cutting longer than the deployment declared, and its gap entries
are charged the declared length exactly as above. The lever is the publisher: set `HLS_FRAGMENT` to its
keyframe interval, or turn `ABR_ENABLED` on, where the fragment sets the segment directly. `/health`
names each such stream under `publisherGopStreams` with both lengths. Neither reason changes a date,
refuses a segment or ends a broadcast.

The uploader then writes a fifth feed: the ladder's **master playlist**, a multivariant playlist
naming the four rung feeds, on a topic that _is_ the ladder's group id. The catalog entry points at
that, so one URL yields the whole ladder. It is rewritten whenever a rung's measured bandwidth
drifts, and always before the catalog entry referring to it — the other order would publish an
entry whose topic resolves to nothing.

```
                             transcode (4x ffmpeg)         republish, RTMP 127.0.0.1
SRT or RTMP ingest ──▶ __defaultVhost__ ──────────────▶ vhost abr ──▶ HLS + webhooks ──▶ uploader
                       hls: off                         no transcode
```

Three things about this shape are load-bearing:

**The second vhost is what stops a transcode loop.** Transcode scope is matched at vhost, app and
stream level and the matches are cumulative (`parse_scope_engines` in SRS's `srs_app_encoder.cpp`).
A rung republished into the vhost that transcodes matches the same rule and gets transcoded again,
and so does _its_ output. A vhost with no transcode block terminates that. If `?vhost=` ever fails
to match, SRS silently falls back to `__defaultVhost__` and the loop starts — which is why the
ingest vhost keeps its webhooks even though it segments nothing, so the uploader can see a
rendition arrive on the wrong vhost and say so.

**Every rung must cut segments at the same media timestamps.** `ABR_FPS x HLS_FRAGMENT` is the GOP
and has to be a whole number of frames; the entrypoint refuses to start rather than round it,
because a fractional GOP drifts the rungs apart and every switch then lands mid-GOP.

**The transcode input dials the port the broadcast came in on.** SRS builds each rung's ffmpeg input
itself, as an RTMP play from `127.0.0.1` on the port in the broadcaster's own server URL
(`srs_app_encoder.cpp`). A broadcaster who dials the stage directly names `SRS_RTMP_PORT`, where SRS
listens. One behind a forward that changes the port, for example a public 11935 forwarded to the
stage's 1935, makes the input dial 11935 inside the container, where nothing listens, so that RTMP
broadcast gets no rungs while SRS and the uploader both look healthy. Keep the port the same on both
sides of any forward in front of RTMP. An SRT source carries no RTMP port and its input dials 1935,
which the entrypoint makes SRS listen on from loopback whenever its RTMP listener is on another port.

**A rung encoder whose input or output stalls exits, and SRS starts it again.** Each engine carries
ffmpeg's `rw_timeout`, in `perfile` for the input, which SRS puts before `-i`, and in `vparams` for the
output, which SRS puts after it. `ABR_IO_TIMEOUT` sets it in seconds, and unset it is the hold plus 8,
20 seconds at the default hold, and never below 18. The entrypoint refuses one no longer than the larger of the hold plus SRS's 3 second
check and 17 seconds, because a held encoder reads nothing while the broadcaster is away and SRS cuts an
idle rung publish about 16 seconds after the last packet. Seen once on a test
deployment, every encoder of a source that began on a slow link hung at its banner for minutes and
no rung ever published. If the transcoders still never start, the uploader reports `ladder_not_started`
on `/health` after `FIRST_RUNG_DEADLINE_MS`, and the broadcaster has to stop the broadcast for longer than the encoder hold (about 15 s at the default) and then start it again. A quicker reconnect meets the same hung encoders.

⛔⛔⛔ **`HLS_FRAGMENT` also sets how fast SRS has to announce, and that has a ceiling.** SRS fires
`on_hls` once per closed segment per rung, so a ladder asks for `rungs / HLS_FRAGMENT` announcements
a second. Measured on the deployment host 2026-08-31, SRS sustains about **6.7 a second** while its
own encoders were producing 8.0, and nothing errors when it cannot keep up. Announcements fall behind
the media at 0.46s per second of video until the lag passes `HLS_WINDOW`, after which SRS deletes
each segment before announcing it: the uploader gets a callback naming a file that is already gone,
the tallest rung is unpublished about two minutes in, and the master feed goes on advertising it.

A four-rung ladder therefore runs at `HLS_FRAGMENT=1.0` (4.0/s, verified over 600s with lag flat and
zero segments lost) and **not** the 0.5s that measures best on latency, which asks 8.0/s. A single
rendition at 0.5s asks 2.0/s and is unaffected. ⚠️ The 6.7/s is one measurement on a co-tenanted host,
nothing refuses a ladder that exceeds it, and what SRS spends the time on is not known: the uploader
answers each callback in 1ms.

Verify a running ladder with `curl http://localhost:1985/api/v1/streams`. That is the SRS stats
API on `SRS_HTTP_API_PORT`, which defaults to 1985 and shifts with `--portSlot`, and the deploy
compose now publishes it. Expect five streams (one source, four rungs) and the count _stable_. A
count that keeps climbing is the loop.

Audio is muxed into each rung rather than split into an `EXT-X-MEDIA` rendition group. With
`ABR_ACODEC=copy` the four copies are bit-identical and cost no CPU. Splitting it is the right
production answer and is left as a TODO.

## What SRS logs

The template leaves SRS at its default level, trace, on the console `docker logs` reads. At trace
every SRT connect logs its stream id and every RTMP publish logs its `param` in a `client identified`
line, both of which carry the broadcaster's publish key, and every hook
SRS calls logs its URL, which carries `SRS_WEBHOOK_TOKEN`, with a request naming the key again. The
uploader redacts its own copies of both. Measured 2026-10-01 on the pinned image: 49 such lines in a
25 second publish.

The level stays at trace on purpose. Warn, which drops those lines, also drops the per-publisher
`Transport Stats` line, the only place SRS reports SRT loss. The manager's SRT ingest card reads that
line, and so does "Reading the loss" in `deploy/README.md`. SRS has one level for its whole log, and
its HTTP API does not carry the counters, so no setting keeps the one and drops the others. Nor would
a higher level close the leak: a publish the uploader refuses is logged at error, whatever the level,
with the hook URL, the token and the key the broadcaster presented.

The engine's `docker logs` on a stage host are therefore as sensitive as its env file. SRS cannot
send the token other than in the URL, so this is the cost of that design rather than a setting.

## Play is loopback only, by default

SRS lets anyone who reaches one of its listeners play any stream it holds, unless a vhost's `security` section says
otherwise, and the publish key guards publishing only. RTMP publishing and playback share one port, so a firewall
that lets broadcasters reach it lets players reach it too. Without a rule that would let anyone play a
broadcaster's source over RTMP, an SRT broadcast as well through SRS's bridge from SRT to RTMP or over SRT itself, and
every rung of the ladder by adding `?vhost=abr`, all without a key. Nothing in the stack needs that: a viewer reads the
broadcast from Swarm, and the one thing that plays from SRS is the ladder's own transcode input, which SRS starts
inside its container and which dials loopback. So both vhosts, the ingest vhost in the template and the ladder vhost
the entrypoint writes, allow play from loopback alone (`127.0.0.1`, `::1` and `::ffff:127.0.0.1`), and publish from
everywhere, because the `on_publish` hook is what checks a broadcaster's key.

`SRS_PLAY_FROM` is that list, and the default is the three loopback addresses. It takes addresses and CIDR blocks,
separated by spaces or commas, or `all`, and the entrypoint refuses anything else. The ladder's transcode input plays
from loopback, so a list without it stops the ladder.

SRS checks deny rules first and allow rules after, and once a vhost has any allow rule it refuses whatever no allow
rule matches (`srs_app_security.cpp`). That is why publish carries its own `allow publish all`: without it, every
broadcaster would be refused. RTMP and SRT go through the same check, for play and for publish. So does a playlist
asked of SRS's file server, while a segment asked for by its name is not checked, which leaves `SRS_HTTP_BIND`, the
host's Docker bridge by default, as what decides who reaches the file server.

Checked on 2026-10-03 against stock SRS 6.0-r2 running the stack's rendered config, slotted and unslotted, on a
private docker network: a client in another container was refused RTMP play of a source, RTMP play of a rung, SRT
play of an SRT source and the rung's HLS playlist, while RTMP and SRT broadcasters in that container kept publishing
and the ladder produced every rung for both, which is the transcode input playing from loopback. Without the rules
every one of those plays succeeded.

Under host networking loopback is the host's, so any process on that host can still play. A config file of your own
that drops the `security` sections opens play to everyone again.

## Your own config file

Everything an engine can do beyond the knobs above is a matter of editing its config file, and both
engines are configured by file alone. SRS reads `srs.conf`, and
[full.conf](https://github.com/ossrs/srs/blob/develop/trunk/conf/full.conf) is the annotated
reference for every directive. OvenMediaEngine reads `Server.xml`, documented in its
[configuration guide](https://airensoft.gitbook.io/ovenmediaengine/configuration). Neither engine has
a configuration web page, and neither API writes configuration.

Set `SRS_CONF_FILE` or `OME_CONF_FILE` in `.env` (or `.env.<profile>`) to the path of a file on the
machine that runs compose, and the deploy mounts it read-only where the engine's entrypoint looks
(`deploy/docker-compose.srs-conf.yml`, `deploy/docker-compose.ome-conf.yml`). The entrypoint then
runs on your file exactly what it runs on the template:

- every `*_PLACEHOLDER` token you keep is filled from the environment, so the passphrase, the ports,
  the webhook token, `HLS_FRAGMENT`, `HLS_WINDOW` and the rest still come from the env knobs and
  never have to be written into the file
- a token you drop is gone, and the env knob behind it stops applying to that deployment
- with the ABR ladder on, `TRANSCODE_PLACEHOLDER` and `ABR_VHOST_PLACEHOLDER` mark where the
  generated transcode block and the rung vhost go. Drop them and the entrypoint warns and inserts
  nothing, which is right only if you wrote the ladder into the file yourself

A path that names no file on the machine that runs compose is refused, not fallen back from. Docker
mounts a missing host path as an empty directory, so the entrypoint finds a directory where the file
should be, exits with a line naming the variable to fix, and the engine does not start on the
template while the variable says otherwise.

Start from a copy of the template and edit from there. A file that does not parse takes the engine
down on its next start, so check it first. SRS has a test mode that names the offending line. It
checks values as well as syntax, so a file that still carries the tokens is refused at the first of
them, which on a copy of the template is the bare `TRANSCODE_PLACEHOLDER` line, and a mistake
of yours further down is never reached. Fill the tokens with a stand-in and drop the two bare lines
first. Check the copy with the fork's image, because stock SRS refuses the template's `takeover` lines:

```bash
sed -E '/^(TRANSCODE|ABR_VHOST)_PLACEHOLDER$/d; s/[A-Z_]+_PLACEHOLDER/1/g' my-srs.conf > my-srs.check.conf
docker run --rm -v "$PWD/my-srs.check.conf:/check/srs.conf:ro" \
  ghcr.io/solar-punk-ltd/swarm-srs:6.0-r2-swarm.3 ./objs/srs -t -c /check/srs.conf
```

The copy that passes is not the file you deploy. The deploy mounts `my-srs.conf` itself, and the
entrypoint fills its tokens from the environment. Measured 2026-10-01 with an arm64 build of that image's
source: a copy of the template is refused at that line, the filled copy passes, and a misspelt
`hls_window` in the filled copy is named. Stock `ossrs/srs:v6.0-r2` refuses the filled copy at `takeover`.

OvenMediaEngine has no test mode. Its log names the element it refused.

The file is read when the container starts, so a change needs the engine recreated
(`deploy.sh --profile <p> srs`), and a template change upstream does not reach a deployment that
runs on a file of its own.

## Generic API

The stream-uploader also exposes a generic API that works without any engine plugin:

```
POST /stream/start    { "streamId": "<id>", "mediatype": "video" | "audio" }
POST /stream/segment  Headers: x-stream-id, x-segment-index, x-duration  Body: raw binary
POST /stream/stop     { "streamId": "<id>" }  Answered 202, drains in the background
GET  /stream/status   ?streamId=<id>              live | draining | finalized | failed

All four require `Authorization: Bearer $API_AUTH_TOKEN`. There is no unauthenticated mode:
every accepted segment spends postage stamp money, so an open write endpoint drains the batch.
```

This can be used by any custom integration that sends segment data directly over HTTP.

## Adding a New Engine

1. Add server config: `engines/<engine-name>/` with docker-compose and config files
2. Add a plugin: `packages/stream-uploader/src/engines/<engine-name>.ts`
   - Implement the `EnginePlugin` interface from `packages/stream-uploader/src/engines/types.ts`
   - Register webhook routes that the engine server will call
3. Register it in `packages/stream-uploader/src/engines/registry.ts` (`engineRegistry`), which is what `loadEngines()` reads
4. Add the engine's docker service to `deploy/docker-compose.yml`

## Structure

```
engines/
  <engine-name>/
    docker-compose.yml        # Standalone engine server (for dev/testing)
    <config files>            # Engine-specific configuration

packages/stream-uploader/src/engines/
  types.ts                    # EnginePlugin interface
  registry.ts                 # engineRegistry — maps an engine name to its plugin factory
  load.ts                     # loadEngines() — builds the configured engine's plugins
  <engine-name>.ts            # Engine plugin implementation
```
