# Testing the stack

This is the testing page for the stack (`apps/hls-stream`). It says how to run the tests, what each
suite proves, and what each one needs. The end-to-end suites here drive the real pipeline, from the
media engine through the stream uploader, Bee and Swarm to the gateway and a viewer, and inject real
failures: they stop containers, freeze Bee nodes and kill the uploader.

| Layer          | What it is                                                        | Needs a deployment | Spends postage |
| -------------- | ----------------------------------------------------------------- | ------------------ | -------------- |
| Unit tests     | Each package's own `test/`, and `e2e/test/` for this harness      | no                 | no             |
| `e2e/suites/`  | Fault scenarios, service checks, viewer checks in a real browser  | yes                | yes            |
| `e2e/bench/`   | The latency benchmark                                             | yes                | yes            |
| `e2e/browser/` | Browser drivers that measure a viewer and report, with no verdict | yes                | yes            |

## Unit tests

```bash
pnpm test        # from apps/hls-stream: every package's unit tests, and this harness's own
pnpm verify      # lint, typecheck, build, test and format check, stopping at the first failure
```

Inside one package, `pnpm test` runs that package's tests alone. CI runs typecheck, lint, build and
test as steps of one job, and the format check as a job of its own. None of `suites/` runs in CI, so
the tables on this page are the only place a suite is listed. `test/readmeSuiteTables.test.ts` checks
that every suite file has a row here and every row names a file.

`packages/shared` has no publish-key test of its own yet. Its publish-key code is exercised through
the uploader's tests. The client's `typecheck` covers `src/` only, so its `test/` folder is not
type-checked.

### Why the harness has unit tests

The harness decides what every scenario concludes, and it fails in one direction: a pattern that
stops matching does not go red, it reports zero segments, and the scenario blames the publisher. So
the parts that can be wrong silently are pinned:

- `test/ports.test.ts` and `test/envFile.test.ts` run the real `deploy/scripts/_lib.sh` functions over
  the same inputs and compare. A deploy rule that changes fails here.
- `test/logLevel.test.ts` reads the uploader's own call sites, so a log line moving to another level
  fails here rather than in a live run.
- `test/logwatch.test.ts` drives the parsers with both formats `Logger` writes.
- `test/manifestContract.test.ts` checks the playlist rulebook against playlist text.
- `test/crashArm.test.ts` covers the rules the crash suites judge by.

## Pointing the suites at a deployment

The suites find a deployment the way `deploy/scripts/deploy.sh` does, from the same files. Give them
the `--profile` and `--portSlot` the deploy was given and they find the same containers on the same
ports.

```bash
E2E_SSH_TARGET=stage-host E2E_PUBLIC_HOST=203.0.113.10 pnpm e2e:smoke   # a default deploy
E2E_PROFILE=streamer1 E2E_PORT_SLOT=2 … pnpm e2e:smoke                   # a profile deploy
```

| Variable               | Default                            | What it is                                                                             |
| ---------------------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| `E2E_SSH_TARGET`       | `localhost`                        | SSH target for container control and curl. Must work without a prompt                  |
| `E2E_PUBLIC_HOST`      | `127.0.0.1`                        | Address the publisher and viewer reach the deployment on                               |
| `E2E_PROFILE`          | `default`                          | The deploy's `--profile`, so containers are `<profile>-<service>-1`                    |
| `E2E_PORT_SLOT`        | `0`                                | The deploy's `--portSlot`. `0` means no slot, and the env files decide the ports       |
| `E2E_ENGINE`           | the deployment's `ENGINE`          | `srs` or `ome`                                                                         |
| `E2E_STREAM_PATH`      | per engine                         | `live/stream` for SRS, `video/stream` for OME                                          |
| `E2E_INGEST_PROTOCOL`  | `srt`                              | `srt` or `rtmp`, what a suite publishes over when it names neither. OME takes SRT only |
| `E2E_OME_SRT_PORT`     | `OME_SRT_PORT` from the engine env | Only for a standalone OME that no profile deployed                                     |
| `E2E_OME_CONTAINER`    | `<profile>-ome-1`                  | The same                                                                               |
| `E2E_EXPECT_ABR`       | undeclared                         | What this run covers: `true` a ladder, `false` a single rendition. See below           |
| `E2E_EXPECT_BROWSER`   | undeclared                         | Whether a real viewer watches. See below                                               |
| `E2E_EXPECT_SEGMENT_S` | undeclared                         | Seconds per segment this run needs, or `any`. See below                                |
| `E2E_RUN_PROFILE`      | `in-browser`                       | The run profile. See [Run profiles](#run-profiles)                                     |
| `E2E_MODE`             | `attach`                           | Only `attach` exists. `deploy` refuses and points at `deploy/scripts/deploy.sh`        |

Ports come from `.env` or `.env.<profile>` and `engines/<engine>/.env[.<profile>]`, layered under the
process environment in the order the deploy uses. OME's ports are not slot-shifted.

The Bee APIs, SRS's HTTP server and OME's HLS port answer where the deploy bound them, and the suites
dial them the way `deploy/scripts/bound-host.sh` does: at the address their bind setting names
(`BEE_UPLOADER_API_BIND`, `BEE_GATEWAY_API_BIND`, `*_API_LISTEN` under `COMPOSE_NETWORK=host`,
`SRS_HTTP_BIND`, `OME_HTTP_BIND`), else at `DOCKER_BRIDGE_ADDRESS` when set, else at the bridge
address the deployment host reports, else at 127.0.0.1.

### Declaring what the run covers

A skipped suite is invisible: `node --test` reports `# tests 0`, `# fail 0`, `# skipped 0` and exits 0.
So a run has to say what it covers, and three preflight gates refuse a run that has not.

**Whether it covers the ABR ladder.** `preflight/abr-coverage` reads `E2E_EXPECT_ABR`, which takes
`ABR_ENABLED`'s own spellings (`true`, `1`, `false`, `0`). Anything else is refused.

| `E2E_EXPECT_ABR` | `ABR_ENABLED` off                 | `ABR_ENABLED` on |
| ---------------- | --------------------------------- | ---------------- |
| unset            | refused                           | runs             |
| `true`           | refused                           | runs             |
| `false`          | runs, single rendition on purpose | refused          |

A single-rendition deployment sets `E2E_EXPECT_ABR=false` once in its profile env. A ladder with fewer
than two rungs is refused whatever was declared, because it cannot show a rung going missing.

**Whether a real browser watches.** `suites/viewer/` opens a real Chrome on the deployed client.
`preflight/viewer-coverage` reads `E2E_EXPECT_BROWSER`:

| `E2E_EXPECT_BROWSER` | What happens                                                                  |
| -------------------- | ----------------------------------------------------------------------------- |
| unset                | refused                                                                       |
| `false`              | the viewer suites skip, and the preflight says so                             |
| `true`               | a real browser watches, and `BROWSER_FETCH_BACKEND` must name the byte source |

`BROWSER_FETCH_BACKEND` is `weeb3` for a Swarm node in the viewer's own tab or `gateway` for a Bee
gateway. It belongs to the run, not the deployment. The default run profile sets it to `weeb3`.

A browser run also needs:

| Variable                | Default                    | What it is                                                                                                                                  |
| ----------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `E2E_BROWSER_REPO_DIR`  | required                   | Absolute path of the harness checkout on the host, mounted into the browser container as `/repo`. The directory `bench-on-host.sh` syncs to |
| `E2E_BROWSER_IMAGE`     | `swarm-hls-browser:latest` | The image `browser-on-host.sh` builds from `e2e/Dockerfile.browser`                                                                         |
| `E2E_BROWSER_CONTAINER` | `e2e-viewer-browser`       | The browser container's name. Reclaimed by exact name before each run                                                                       |

`E2E_BROWSER_REPO_DIR` has no default because the suite runs inside that mount and cannot work out the
host path. A guessed path that did not exist would make Docker mount an empty directory.

**How long a segment the run needs.** The two kinds of viewer want opposite segment lengths:

| Segment length                     | 0.5 s        | 2 s        |
| ---------------------------------- | ------------ | ---------- |
| In-tab weeb-3 node, realtime ratio | 0.426x       | 1.000x     |
| Buffer it holds ahead              | 0.5 to 3.5 s | about 90 s |
| Gateway, capture to fetchable      | 1.55 s       | 3.88 s     |

An in-tab node admits about one segment a second whatever its peer count, so it cannot keep up with
0.5 s segments. A gateway viewer gets shorter segments sooner. A four-rung ladder cannot run 0.5 s at
all, because of [the announcement ceiling](../engines/README.md#the-announcement-ceiling), so the
gateway profile uses 1.0 s. `preflight/segment-length` reads `E2E_EXPECT_SEGMENT_S`:

| `E2E_EXPECT_SEGMENT_S` | What happens                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| unset                  | refused                                                                                                                          |
| a number               | the running SRS config and both containers' `HLS_FRAGMENT` are read, and a stage that cuts or dates at another length is refused |
| `any`                  | the check stands down, and says so. Also the answer for OME, whose segmenter config this gate cannot read                        |

The engine cuts segments by `HLS_FRAGMENT` and the uploader dates them by it, so the gate reads both
containers and refuses a pair that disagrees. It reads the SRS config with one `docker exec cat` and
each container's environment with `docker inspect`, so it publishes nothing. It cannot see an encoder
that misses its own cadence. `deploy/scripts/stage-fingerprint.sh` reads raw `#EXTINF` off a live
playlist for that. A refused run names the fix:

```bash
echo 'HLS_FRAGMENT=2.0' >> .env.<profile>
deploy/scripts/deploy.sh --profile=<profile> [--portSlot=<N>] srs stream-uploader
```

Redeploy both services. A container reads the value only when it is recreated.

### The deployment has to log at debug

Every upload-side assertion is parsed out of the uploader's log, so `LOG_LEVEL` decides whether the
suites can measure anything. At `log` the catalogue feed location is missing and two tests cannot
start. At `info` the segment counter never moves, and every scenario waits out its timeout. The smoke
test reads the container's level and says so. `LOG_FORMAT` does not matter.

## Running

```bash
pnpm e2e:smoke
```

Read-only. Proves SSH reaches the host, the uploader is healthy, every publisher node holds a usable
batch with time to live, and the log level can be read. Spends nothing.

```bash
pnpm e2e:run
```

The full suite. It publishes real streams, stops real containers and spends real postage. It runs
serially, because every scenario uses the same live path, and each waits for `activeStreams=0` before
it starts. The order is preflight, scenarios, service, viewer, ingest.

The preflight runs as its own `tsx --test` invocation chained with `&&`, so a refusing gate stops the
run before anything is published. A run therefore prints two TAP documents with two `# tests`, `# pass`
and `# fail` blocks. Sum them.

| Command                            | Runs, after the preflight gates                                  |
| ---------------------------------- | ---------------------------------------------------------------- |
| `pnpm e2e:preflight`               | The gates alone                                                  |
| `pnpm e2e:abr-ladder`              | `service/abr-ladder`                                             |
| `pnpm e2e:master-rungs`            | `service/master-offers-every-rung`                               |
| `pnpm e2e:ladder-restored`         | The ladder suite and the master suite, after a drain is restored |
| `pnpm e2e:quality`                 | `viewer/quality-switch`                                          |
| `pnpm e2e:vod`                     | `viewer/vod-playback`                                            |
| `pnpm e2e:broadcast-ended`         | `viewer/broadcast-ended`                                         |
| `pnpm e2e:finalize-crash`          | `scenarios/finalize-crash`                                       |
| `pnpm e2e:crash-recovery`          | `scenarios/uploader-crash-recovery`                              |
| `pnpm e2e:reconnect-into-recovery` | `scenarios/reconnect-into-recovery`                              |
| `pnpm e2e:rung-restart`            | `scenarios/rung-restart`                                         |
| `pnpm e2e:rung-node-restart`       | `scenarios/rung-node-restart`                                    |
| `pnpm e2e:rung-never-starts`       | `scenarios/rung-never-starts`, on an armed stage                 |
| `pnpm e2e:long-broadcast`          | `scenarios/long-broadcast`                                       |
| `pnpm e2e:stream-list-restart`     | `scenarios/stream-list-after-restart`                            |
| `pnpm e2e:batch-drain`             | `scenarios/batch-drain`, on an armed stage                       |
| `pnpm e2e:batch-drain-viewer`      | `viewer/batch-drain-viewer`, on an armed stage                   |
| `pnpm e2e:rtmp`                    | `suites/ingest/`                                                 |
| `pnpm e2e:admin`                   | `suites/admin/`                                                  |

Browser drivers launched through `deploy/scripts/bench-on-host.sh`, directly or through
`browser-on-host.sh`, run the same gates first. The older measurement scripts under `deploy/scripts/` that
start the browser image themselves, such as `byte-source-arms.sh`, are not gated. A launch is also
refused from a checkout with no `.spend-ledger.env` at its root.

### Run profiles

A run profile is a named set of the settings that decide what a run is, never where the stack lives.
The files are `e2e/profiles/<name>.env` and the loader is `e2e/src/profiles.ts`. Pick one with
`E2E_RUN_PROFILE`. An unknown name stops the run and lists the names that exist.

| Profile        | Segment bytes come from                      | Segment length | Notes                                   |
| -------------- | -------------------------------------------- | -------------- | --------------------------------------- |
| `in-browser`   | a Swarm node running in the viewer's own tab | 2 s            | The default. The subject being measured |
| `light-client` | a Bee gateway                                | 1.0 s          | The control                             |

Both declare that the run covers the ABR ladder. The two segment lengths differ because of the byte
source, so do not reconcile them. A run that switches profiles on one stage states the length it
accepts with `E2E_EXPECT_SEGMENT_S`, or the stage is redeployed.

- **An explicit setting beats the profile.** Precedence is explicit, then profile, then unset. The
  profile says which keys it stood down on. Presence decides, so a value blanked on purpose
  (`BROWSER_FETCH_BACKEND=`) stays blank.
- **A profile carries no infrastructure.** `E2E_PROFILE`, `E2E_PORT_SLOT` and `E2E_RUN_PROFILE` are
  refused inside a profile file.
- `preflight/profile` refuses a run whose declarations contradict each other, before anything dials a
  host.

## What each suite proves

The single letters and V numbers are the labels the suite files carry in their own docblocks.

Read-only smoke. No faults, no broadcast, no postage:

| File           | Proves                                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `smoke/attach` | The harness reaches the deployed profile: SSH answers, the uploader is healthy, every publisher node holds its configured batch (with its TTL and fill), the ingest container is up, and the log level is readable. `pnpm e2e:smoke` |

Preflight gates, which run ahead of every paid run and spend nothing:

| File                           | Proves                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `preflight/chequebook-funding` | Every publisher node holds at least 0.5 BZZ available. Reports a shortfall with the deposit command, and never spends                  |
| `preflight/spend-ceiling`      | The run is inside the ceiling the operator authorised in `.spend-ledger.env`. Reads one balance per node that can spend                |
| `preflight/bee-publishers`     | The uploader's live routing is the one `BEE_PUBLISHERS` declares. Reads `/health` only                                                 |
| `preflight/client-shape`       | The client the stage serves was built from the sources this checkout holds. See [Stale builds](#stale-builds)                          |
| `preflight/abr-coverage`       | The run is not silently skipping the ABR suites. Reads config only                                                                     |
| `preflight/viewer-coverage`    | The run says whether a real browser watched, and which byte source. Config only                                                        |
| `preflight/profile`            | The run profile parses and the run declared what it covers. Config only                                                                |
| `preflight/segment-length`     | The stage cuts at the length this run declares, and its uploader dates by the same one                                                 |
| `preflight/announcement-rate`  | The ladder does not ask SRS for more announcements a second than SRS sustains, which would kill the top rung                           |
| `preflight/uploader-log-shape` | The deployed uploader writes every log family this harness parses, and prints how many it confirmed. See [Stale builds](#stale-builds) |

Fault scenarios:

| File                                    | Proves                                                                                                                                                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scenarios/bee-outage-short` (A)        | The writer's Bee node frozen inside the 15 s retry window: segments buffer, nothing is lost, nothing is announced                                                                                                                                                                    |
| `scenarios/bee-outage-long` (B)         | The writer's Bee node down past the window: the segment in flight is lost and reported, published as a gap entry, and the stream resumes cleanly                                                                                                                                     |
| `scenarios/publish-stop-to-vod` (D)     | A clean broadcaster stop becomes a recording one reap window later                                                                                                                                                                                                                   |
| `scenarios/gateway-outage-viewer` (G)   | The viewers' gateway down: uploads are unaffected                                                                                                                                                                                                                                    |
| `scenarios/engine-restart` (E)          | An engine restart, then the broadcaster reconnects: a sound timeline, and every rung publishing a moving live playlist again, reading the head of any topic it reopened                                                                                                              |
| `scenarios/uploader-crash-recovery` (F) | The uploader killed with SIGKILL: the same stream recovers and is not finalized by the recovery timer                                                                                                                                                                                |
| `scenarios/finalize-crash` (H)          | The uploader killed inside its finalize: after the restart there is exactly one recording, and the catalogue names it                                                                                                                                                                |
| `scenarios/whole-stack-restart` (I)     | A host reboot, where the finalize races a cold Bee node: one recording, no recovery entry left behind                                                                                                                                                                                |
| `scenarios/recovery-entry-corrupt` (J)  | A bad recovery entry is set aside loudly, never deleted in silence, and `/health` degrades                                                                                                                                                                                           |
| `scenarios/reconnect-during-drain` (K)  | The broadcaster reconnects the moment the outgoing session starts to drain: the reconnected session stays live, keeps the recovery entry, publishes a moving live playlist on every rung, and finalizes into a recording that joins both sessions                                    |
| `scenarios/abr-engine-restart`          | An engine restart under a ladder: every rung returns as one ladder, and every recovered rung publishes a moving live playlist, reading the head of the topic it reopened                                                                                                             |
| `scenarios/batch-drain` (L)             | One rung's postage runs out: that rung alone goes quiet, the others carry on, and the master drops it. Needs an armed stage, see [below](#one-rungs-postage-runs-out)                                                                                                                |
| `scenarios/reconnect-into-recovery` (M) | The uploader is killed while its engine restarts, and the broadcaster returns inside the recovery window: the restarted engine counter is taken rather than dropped as duplicates, and the same broadcast stays live                                                                 |
| `scenarios/rung-restart`                | One rung's transcode frozen past the 60 s reap, then resumed: the master drops it and takes it back, the rung reopens its own topic at or above the index its recording holds, no playlist goes stale, and the recording keeps two sessions on that rung. SRS and a ladder only      |
| `scenarios/long-broadcast`              | One broadcast of `E2E_LONG_BROADCAST_MINUTES` (20 by default), whose recording outgrows one chunk many times: every rung keeps a moving live playlist, the finalize succeeds, the catalogue flips to vod, the recording names every segment, and a browser plays it                  |
| `scenarios/stream-list-after-restart`   | Two broadcasts recorded, the uploader restarted while the coordinator node is paused for 30 s, then a third broadcast: the catalogue still lists every earlier entry, and the third                                                                                                  |
| `scenarios/rung-node-restart`           | One rung's own Bee node stopped for 20 s under a live ladder: the master drops that rung and offers it again once the node is back, while the other rungs keep moving playlists                                                                                                      |
| `scenarios/rung-never-starts`           | A rung that never lands a segment, because the stage routes its `BEE_PUBLISHERS` entry to a closed port: the master stops offering it, the others publish, `/health` says degraded, and a viewer is never told the broadcast ended. Needs a stage armed with `E2E_NEVER_STARTS_RUNG` |

Service checks, no faults:

| File                               | Proves                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `service/happy-path`               | Gapless segments and an advancing playlist, nothing lost or broken                     |
| `service/health-endpoint`          | `/health` across live and then idle                                                    |
| `service/catalog-via-gateway`      | A viewer's catalogue, read through the gateway, shows `live` and then `vod`            |
| `service/multi-stream-concurrent`  | Two concurrent streams, each with its own topic and its own recording                  |
| `service/abr-ladder`               | Every configured rung publishes, under one ladder, gapless                             |
| `service/master-offers-every-rung` | The ladder's master offers every rung the broadcast announced. Skips on an armed stage |

RTMP ingest. Every other suite publishes over SRT unless `E2E_INGEST_PROTOCOL=rtmp`. The publisher
dials the server and stream key the admin hands a broadcaster for OBS. These need an SRS image with the
RTMP takeover, `6.0-r2-swarm.3` or later:

| File                      | Proves                                                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ingest/rtmp-publish`     | An RTMP broadcast uploads gapless with every playlist advancing, holds to the manifest contract, and the gateway serves the newest segment it uploaded                           |
| `ingest/rtmp-wrong-key`   | An RTMP publish with a key issued for another stream is refused and counted, and never takes a live RTMP broadcast over. Skips where no key is checked                           |
| `ingest/rtmp-reconnect`   | An RTMP broadcaster back after a clean drop rejoins its session, and one whose network died takes its stream back through the takeover, each with one seam and nothing finalized |
| `ingest/protocol-switch`  | A broadcaster moving from SRT to RTMP, and back, in the middle of a broadcast stays one broadcast                                                                                |
| `ingest/rtmp-ladder-hold` | A ladder whose RTMP source drops for two seconds keeps every rung on the encoders it had, with one seam per rung. Skips without a ladder                                         |

The unclean reconnect and both switches need the takeover for the new publisher's protocol, and read
it off the running SRS config first. A stage with it off skips them and says why. The unclean drop
freezes the publisher rather than stopping it, which keeps its connection open and silent. No RTMP
suite opens a browser. For playback of an RTMP broadcast in a browser, run the viewer suites with
`E2E_EXPECT_BROWSER=true` and `E2E_INGEST_PROTOCOL=rtmp`.

Viewer checks, in a real browser. These are the only suites that can say what a viewer got rather
than what one could have fetched. They need the browser image on the host and the settings in
[Declaring what the run covers](#declaring-what-the-run-covers):

| File                             | Proves                                                                                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `viewer/live-playback`           | (V1) A viewer keeps up with a live broadcast, decodes a picture, hits no error, and is the byte source it is filed as                                                                          |
| `viewer/quality-switch`          | (V2) A viewer whose connection gets worse keeps watching at a quality it can carry, and comes back up when the squeeze lifts                                                                   |
| `viewer/rung-outage`             | (V3) A viewer whose rung goes quiet moves to one that has not, rather than freezing                                                                                                            |
| `viewer/vod-playback`            | (V4) A finished recording plays through, offers every rung it was published with, and every rung ends at the uploader's last segment                                                           |
| `viewer/broadcast-ended`         | (V5) The broadcaster stops under a watching viewer, and the viewer is told                                                                                                                     |
| `viewer/crash-gateway-outage`    | (V6) The gateway taken away for 20 s: the picture plays out its buffer, says why it stopped, and comes back on its own                                                                         |
| `viewer/crash-uploader-killed`   | (V7) The uploader killed: the viewer waits, and resumes when it answers again                                                                                                                  |
| `viewer/crash-writer-bee-pause`  | (V8) An 8 s pause of the writer's node costs a viewer no more than the pause                                                                                                                   |
| `viewer/crash-writer-bee-outage` | (V9) A 20 s writer outage costs a segment, published as a gap entry, and the viewer plays through the hole                                                                                     |
| `viewer/crash-engine-restart`    | (V10) The engine restart ends the broadcast, and the end reaches the screen                                                                                                                    |
| `viewer/batch-drain-viewer`      | (V11) A viewer watches through one rung's postage running out: the picture keeps moving, they are never told the broadcast ended, and the master loses exactly that rung. Needs an armed stage |
| `viewer/late-join`               | A viewer joining three minutes into a broadcast starts at the live edge, within the client's jump limit, rather than at the head of the live window                                            |

- None of them asserts how far behind live the player sat. That figure is printed and filed.
- V7 and V9 tolerate an overlay that says nothing during the freeze (`mustSpeak: false`). They refuse
  only what is untrue, and print whether the client explained the freeze. The client does not yet
  explain these two faults.
- Each fault ends the broadcast it lands in, so a full viewer run is several paid broadcasts. Each
  crash run is sized at four minutes by `crashArmMinutes`.

Admin mode, on a stage whose uploader takes its streams from the admin. These are the only suites that
reuse a declared stream's topic across broadcasts. They are outside `pnpm e2e:run`, so `pnpm e2e:admin`
is the only way to reach them, and they skip, printed as skipped, unless the admin settings are given:

| File                              | Proves                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin/rebroadcast`               | (G1) One declared stream broadcast twice: every rung publishes at least 6 live playlists within 120 s of its first segment both times, every head moves, nothing goes stale, every rung resumes the topic above index 0, the master offers every rung, and the recording grows by one session on every rung. A viewer on the ended overlay is taken into the second session |
| `admin/rebroadcast-three-times`   | (G2) Three broadcasts in a row on one declared stream: each rung resumes at a higher index each time, the recording grows by one session per broadcast, and the live recovery entry does not grow with every session                                                                                                                                                        |
| `admin/rebroadcast-vod`           | (G17) The recording a declared stream joined from several sessions plays as one broadcast: the whole ladder, finished, as long as its longest rung. Needs a browser, and reads the recording `admin/rebroadcast-three-times` leaves                                                                                                                                         |
| `admin/rebroadcast-expired-batch` | (G3) A declared stream broadcast again after its earlier batch expired still publishes a moving live playlist on every rung and finishes with a recording on every rung. Needs `E2E_ADMIN_EXPIRED_STREAM_ID`                                                                                                                                                                |
| `admin/catalog-lifecycle`         | A throwaway declared stream is broadcast, unpublished as a draft with its recording kept, published again as the same recording, then unpublished and deleted. The admin refuses an unpublish or delete while live. Needs `E2E_ADMIN_STAGE_ID`                                                                                                                              |
| `admin/admin-unreachable`         | With the admin stopped, a broadcast to a declared key is refused and uploads nothing. With it stopped for 30 s mid-broadcast, no rung loses its live playlist and the broadcast finalizes into a row the admin calls vod. Needs `E2E_ADMIN_CONTAINER`                                                                                                                       |

### Running the admin suites

Point the harness at a stage in admin mode as for any other suite, because the uploader's log is still
where every upload-side reading comes from.

| Variable                      | Needed by                                  | What it is                                                                                                       |
| ----------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `E2E_ADMIN_API_URL`           | every admin suite                          | The admin backend's base URL                                                                                     |
| `E2E_ADMIN_TOKEN`             | every admin suite                          | An operator's session token, the value of the `web2_admin_session` cookie. Environment only                      |
| `E2E_ADMIN_STREAM_ID`         | rebroadcast, three-times, vod, unreachable | A declared stream on the stage, broadcast to again and again                                                     |
| `E2E_ADMIN_STAGE_ID`          | catalog-lifecycle                          | The stage a throwaway stream is declared on and deleted from                                                     |
| `E2E_ADMIN_EXPIRED_STREAM_ID` | rebroadcast-expired-batch                  | A declared stream whose earlier batch has expired                                                                |
| `E2E_ADMIN_CONTAINER`         | admin-unreachable                          | The admin backend's container, on the deployment host's own Docker, stopped and started through `E2E_SSH_TARGET` |

The token never goes in a file. It is read from the process environment, sent only in the cookie
header, and never logged. Export it in the shell that runs the suite:

```bash
export E2E_ADMIN_TOKEN="$(<command that prints the token>)"
E2E_ADMIN_API_URL=https://admin.example.com E2E_ADMIN_STREAM_ID=<stream id> pnpm e2e:admin
```

The token is a session, so it expires with the session. Sign in to the console again to get a new one.

### Settings the newer scenarios read

| Variable                     | Default | What it is                                                                               |
| ---------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `E2E_LONG_BROADCAST_MINUTES` | `20`    | How long `scenarios/long-broadcast` broadcasts. A typo is refused at import              |
| `E2E_NEVER_STARTS_RUNG`      | unset   | Declares a stage armed for `scenarios/rung-never-starts`, naming the rung routed nowhere |
| `E2E_DRAIN_RUNG`             | `1080p` | The rung the drain suites expect to run dry. Never the coordinator                       |

## What a healthy ladder suite asks of every rung

A rung can keep uploading segments while its live playlist never lands, and a segment no playlist names
is media no viewer can reach. So every suite that claims a healthy ladder (`abr-ladder`,
`master-offers-every-rung`, `happy-path`, `rtmp-ladder-hold`, both engine restarts, both crash
recoveries, and K) asks three things of every rung, through `checkRungPlaylistsLive` in
`src/harness/rungPublishing.ts`:

| Reading                      | What it is                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Live playlist publishes (H1) | `Manifest of <stream> uploaded at SOC index N`, counted per rung, at least n in the window                                                             |
| No stale warning (H1)        | `Live manifest for stream X is stale`, which a broadcast with no fault never writes. A held publish, `is held:`, is printed and never counted as stale |
| The head moves (H2)          | Each rung's feed read off the gateway twice, and its last sequence moved on every rung                                                                 |

A suite whose session reopens a topic also asks for the uploader's `resumes its topic at SOC index N`
line on each such rung. After a stop, H3 in `src/harness/recordingListing.ts` reads the finished master
and every rung's recording: every rung present, the rungs within one segment of each other in length,
and as many sessions joined as broadcasts were made.

The metrics pairing in `abr-ladder` (H4) puts each rung's `swarm_hls_rung_segments_uploaded_total`
beside the playlists it published, and refuses any rung whose
`swarm_hls_rung_manifest_publish_failures_total` moved. On an uploader without the per-rung publish
metrics, H4 falls back to the log's publish count and the unlabelled
`swarm_hls_manifest_publish_failures_total`.

## One rung's postage runs out

Every rung of the ABR ladder publishes through its own Bee node with its own postage batch, a prepaid
allowance for storing chunks. The split means one batch running out costs one quality, not the
broadcast. Two suites prove it: `scenarios/batch-drain` (L) on the uploader side, and
`viewer/batch-drain-viewer` (V11) with a player watching.

A batch cannot be made to expire inside a test, because Bee refuses to create one that would live
under 24 hours. Filling one works: the smallest batch Bee allows, depth 17, fills in about twenty
seconds of 1080p. Nothing in a suite can arm that, so a drain run has three steps:

```bash
# 1. You buy the batch. print-buy prints the command and the price and never runs it.
deploy/scripts/drain-stage.sh --profile=<p> --portSlot=<n> --rung=1080p print-buy

# 2. The script wires that batch into one rung and redeploys the uploader.
deploy/scripts/drain-stage.sh --profile=<p> --portSlot=<n> --rung=1080p arm --batch=<64 hex>

# 3. One suite runs, then the stage goes back.
pnpm e2e:batch-drain                # scenario L, the uploader side
pnpm e2e:batch-drain-viewer         # V11, a viewer watching the same fault
deploy/scripts/drain-stage.sh --profile=<p> --portSlot=<n> --rung=1080p restore
pnpm e2e:ladder-restored            # every rung publishes again, and the master offers every rung
```

- **Run the last step from a shell that does not carry `E2E_DRAIN_ARMED`.** On an armed stage the
  master is correctly down a rung, so `master-offers-every-rung` skips.
- **One arming carries one suite.** The batch is spent by whichever suite fills it, so L and V11 each
  have their own script and their own arming.
- **`E2E_DRAIN_RUNG` names the rung, never the coordinator.** 360p is the coordinator, whose batch
  also writes the catalogue and every master, so draining it would stop the master being rewritten for
  every rung. The suites refuse it by name. This is a known limit of the uploader.

Three refusals keep a drain run apart from an ordinary one:

| The run                                             | What happens                                                                                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A drain script on a stage nobody armed              | Refused before a broadcast starts, naming the batch the rung is spending and the command that arms one. A batch a previous run already spent is refused too |
| Any other run, `pnpm e2e:run` included              | The two suites skip, because only the two drain scripts set `E2E_DRAIN_ARMED`                                                                               |
| `pnpm e2e:batch-drain-viewer` with no browser asked | Refused at import, because `E2E_EXPECT_BROWSER=false` leaves V11 nothing to read                                                                            |

`e2e/src/harness/stageStamps.ts` gates every suite on postage: every Bee node the uploader publishes
through must hold the batch `BEE_PUBLISHERS` routes its rung to, usable, with more time to live than
the run needs. The uploader's `/health` truncates batch ids to eight hex characters, and the gate finds
the batch on `/stamps` by that prefix. Its refusal names one of three causes: the node does not hold the
configured batch, Bee will not stamp with it, or its time to live will not outlast the run. Batch
utilisation is printed and never judged. On a small batch it reads high early: a depth 17 batch has two
chunks per bucket, so its first chunk prints as 50% full.

## The playlist timeline

The uploader's playlists follow a contract (see
[the manifest contract](../packages/stream-uploader/concepts.md#the-manifest-contract)): a session on a
fresh topic opens at `#EXT-X-MEDIA-SEQUENCE:0`, a session continuing a topic opens above zero with a
discontinuity on its first segment, every segment carries an `#EXT-X-PROGRAM-DATE-TIME`, and a lost
segment is an `#EXT-X-GAP` entry.

`manifestContractFailures` in `e2e/src/harness/manifestContract.ts` is the rulebook, and
`e2e/test/manifestContract.test.ts` proves it against playlist text in CI:

- A first session on a fresh topic starts at zero.
- Every entry carries a readable date, strictly rising.
- A step between entries with no `#EXT-X-DISCONTINUITY` matches the media the earlier entry declares,
  which under a ladder is exactly one fragment.
- Across a discontinuity a forward step of any size is legal, because a restart re-anchors the dates on
  the wall clock. A step that does not move forwards fails anywhere.
- A step of two fragments or more means a hole was left out rather than said with gap entries, and
  fails.

The uploader's log cannot check any of this. The log names the engine's own segment index and the
feed's SOC index, while the playlist publishes a different number, so a suite has to read the
playlist. `e2e/src/harness/manifestContractLive.ts` reads it, and `e2e/test/manifestContractLive.test.ts`
covers everything in it but the feed read. One `STREAM_KEY` signs the catalogue, every master and every
rung's feed, so the owner read from the `[StreamCatalog]` log line owns every rung playlist too.

The log-side counter `discontinuitiesArmed` in `harness/logwatch.ts` counts lines of several
messages, most of which report a lost segment rather than a break, and one of which can repeat for the
same segment. The suites assert its zero on clean runs. Read any non-zero figure as an upper bound, not
as a count of discontinuities.

Each live suite prints one line per rung: whether the feed answered a live playlist or a recording, how
many segments, gap entries and discontinuities it holds, the sequence it declares and its span of
dates. Everything but the sequence is asserted in all of them. `service/happy-path` and
`service/abr-ladder` also assert zero gap entries. The fragment length is the run's own
`E2E_EXPECT_SEGMENT_S`. A run declaring `any` skips the timeline and says so.

| Suite                                       | What only this one can see                                                                                               | Sequence 0 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------- |
| `service/happy-path`                        | The baseline, a broadcast with no fault                                                                                  | asserted   |
| `service/abr-ladder`                        | Every rung deriving both numbers from one anchor, which is what a level switch lands on                                  | asserted   |
| H `finalize-crash`, I `whole-stack-restart` | The recording's own numbering, which no catalogue entry speaks for                                                       | asserted   |
| E `engine-restart`, `abr-engine-restart`    | The resumed session dating its media off its own anchor                                                                  | when shown |
| F `uploader-crash-recovery`                 | The recovered session writing the playlist a viewer holds, on sequences restored from disk, with the hole as gap entries | no         |
| M `reconnect-into-recovery`                 | The break a reconnected session earns, and no hole invented by a forgotten accounting index                              | no         |

### What the sequence column says

`#EXT-X-MEDIA-SEQUENCE:0` is owed only while the live window still starts at the broadcast's first
segment, and the window is a byte budget of about 30 segments. No suite promises that on the clock. It
is settled two ways that need no stopwatch: a playlist that declares itself a recording names every
segment of its broadcast, and a live playlist naming at least as many segments as its rung has ever
published has dropped none. The published count is read after the playlist, because the other order
can call a slid window a first playlist.

- **asserted** means the check always applies. `happy-path` and `abr-ladder` open their log window
  after the stage is idle, so every segment line in it is their own broadcast's. H and I read after the
  finalize, where the feed head is the recording.
- **when shown** is E and the ABR engine restart. A retired session can drain queued segments after
  the restart and log them under the same stream id the recovered session uses, so the count can
  include a few of the dead session's segments. The check then declines to call the playlist the first,
  and asserts it only when the count is exact. If SRS reports the unpublish as it goes down, the
  reconnect resumes the same session instead, whose playlist carries on rather than opening at 0 again.
  Each suite's docblock says what it asserts in each case.
- **no** is F and M. F's final read comes after the recovery timeout, when the window holds only
  post-recovery media. F reads the timeline twice: first as soon as segments resume, waiting until the
  gap entries for the hole are inside a published window, and asserting the playlists declare no
  discontinuity. M's warm-up of 40 segments per rung is longer than the window, so the window has
  always slid before it reads. M reads early, before its own 90 s watch, for the break and the absence
  of a hole.

## Stale builds

`bench-on-host.sh` syncs this checkout to the host on every run and never rebuilds the uploader or
client images. Two gates refuse a stage whose deployed code is older than the harness that reads it:

- **`preflight/uploader-log-shape`** reads the deployed uploader's built code with one `docker exec`
  and checks it writes every log family the harness parses. A message reworded in this checkout and not
  yet deployed would otherwise leave a pattern matching nothing and a scenario blaming the product for
  the silence. Its refusal names redeploying as the fix, not rewording the patterns.
- **`preflight/client-shape`** reads `/build-stamp.json` from the served client over HTTP and compares
  the tree hashes of `packages/client`, `packages/shared` and the workspace `packages/contracts` with
  this checkout's. `bench-on-host.sh` passes those hashes in as `E2E_EXPECT_CLIENT_TREE`,
  `E2E_EXPECT_SHARED_TREE` and `E2E_EXPECT_CONTRACTS_TREE`, because its sync excludes `.git`. Tree
  hashes are content hashes, so a rebuild from unchanged sources still matches. It refuses four ways:
  no readable stamp, a mismatched tree, a build from uncommitted sources on either side, and an
  expectation it cannot establish.

`src/logLevel.ts` and `smoke/attach` guard the related question of whether `LOG_LEVEL` admits these
lines at all.

## Browser drivers

A driver is a script under `e2e/browser/` that you run and read the output of. It produces a report and
has no verdict. Launch drivers on the deployment host through `deploy/scripts/browser-on-host.sh`, which
runs the preflight gates first.

### The in-browser node first

The default subject of a viewer measurement is the client reading segment bytes from a Swarm node
running in the tab. A gateway is the control. `BROWSER_FETCH_BACKEND` sets it:

| Value     | What the viewer is                                                                                                      |
| --------- | ----------------------------------------------------------------------------------------------------------------------- |
| unset     | Whatever the client build defaults to. Reach it with `BROWSER_FETCH_BACKEND=`, because the default profile sets `weeb3` |
| `gateway` | Segment bytes from a Bee gateway                                                                                        |
| `weeb3`   | Segment bytes from the in-tab node, with feeds and playlists still read through a gateway                               |

`weeb3` is a hybrid. Fully gateway-less is weeb-3's own page, run by `pnpm browser:weeb3-native` and
compared with the hybrid by `pnpm browser:viewer-order` (see `src/browser/viewerConditions.ts`).

| Command                         | In-tab node  | Notes                                                                                |
| ------------------------------- | ------------ | ------------------------------------------------------------------------------------ |
| `browser:watch`                 | yes          | The long-run watcher                                                                 |
| `browser:crash`                 | yes          | The five fault scenarios                                                             |
| `browser:buffer-sweep`          | yes          | One byte source for the whole run                                                    |
| `browser:fetch-backend-check`   | yes          | The comparison of the two byte sources                                               |
| `browser:weeb3-native`          | gateway-less | weeb-3's own page                                                                    |
| `browser:viewer-order`          | both         | Native against hybrid, counterbalanced                                               |
| `browser:vod`                   | yes          | Recorded playback, with seeks or a squeeze                                           |
| `browser:selfcheck`             | no           | Proves the instrument, not a viewer condition                                        |
| `browser:gateway-check`         | n/a          | Gateway by definition                                                                |
| `browser:in-tab-throttle-probe` | in-tab only  | No player. Drives the node's retrieval path directly                                 |
| `e2e:run`                       | yes          | Upload side throughout, plus `suites/viewer/`, which launches `browser:watch` itself |

A comparison plays the viewer under two or more conditions in turn, such as the in-tab node and a
gateway. Each condition under test is an arm. `browser:arm-order` and `browser:byte-source-order` open
no viewer. They print the counterbalanced order in which a comparison runs its arms.

The in-tab node needs time to boot: a few megabytes of wasm and several seconds of dialling. Every
driver holds the boot for `BROWSER_BYTE_SOURCE_SETTLE_SECONDS` (60 by default) before it opens its
counted window. `watch.ts` reads `BROWSER_SETTLE_SECONDS` instead.

### An arm is proved before it counts

A weeb-3 run's headline is zero gateway reads, and a client that never loaded the node produces the
same zero. `openByteSourceArmSession` hands back a proof with the arm, so a driver cannot hold one
without the other, and the proof requires the wasm in the request log. Every in-browser viewer suite
refuses a run that is not the condition it is filed as. A gateway run playing a recording is proved
from playback start, because a finite recording is fetched whole in its first seconds. The artifact's
`byteSource.proofWindow` says which.

### Recorded playback: browser:vod

`browser:vod` plays a finished recording through the shipped client and, by default, seeks around in
it. It writes `vod.rungs`, one row per level the player parsed from the master, with the rung's
height, segment count, duration and the reference of its last segment. V4 judges completeness on that
last reference. hls.js loads a level playlist only when it plays that level, so most rungs are read
from their own feed through the gateway, and each row says which answered.

Set `BROWSER_VOD_SQUEEZE_KBPS` and it squeezes instead of seeking: it plays from the start, caps the
tab's download part way through, lifts the cap, and samples the three stretches, sized by
`BROWSER_VOD_SETTLE_S` (45), `BROWSER_VOD_SQUEEZE_S` (60) and `BROWSER_VOD_RECOVER_S` (60). A recording
has no live edge, so it is the control for a squeezed live viewer. Per stretch it reports the playback
advance ratio, stalls, the level of each fragment, and the inbound WebSocket bytes. Nothing is asserted.
A weeb-3 run spends its settle time booting the node, so a recording shorter than that plus the three
windows ends early and the driver says so.

### The in-tab throttle probe

`browser:in-tab-throttle-probe` asks why a capped in-tab viewer gets nothing. It opens no player: it
boots the node through the client's own switch, then pulls segment references from an existing
recording through the client's retrieval path, uncapped and capped, counting the tab's WebSocket frames
around each. It costs no BZZ and needs no gate.

```bash
deploy/scripts/browser-on-host.sh --target <host> --profile <profile> --portSlot <slot> \
  --script browser:in-tab-throttle-probe
```

`PROBE_OWNER`, `PROBE_TOPIC_360_HEX` and `PROBE_TOPIC_1080_HEX` choose the recording.
`PROBE_CAP_KBPS`, `PROBE_LOW_CAP_KBPS`, `PROBE_IDLE_SECONDS`, `PROBE_RETRIEVALS_PER_ARM`,
`PROBE_BUDGET_SECONDS`, `PROBE_TAIL_SECONDS` and `PROBE_GAP_SECONDS` size the run. The last is the quiet
time after every row, so a capped row's late chunks are not counted against the next.

`browser:weeb3-native` is its control. With `WEEB3_NATIVE_SQUEEZE_KBPS` set it runs three windows,
settle, capped and recovered, sized by `WEEB3_NATIVE_SETTLE_S` (45), `WEEB3_NATIVE_SQUEEZE_S` (60) and
`WEEB3_NATIVE_RECOVER_S` (60), and reports a per-phase table of realtime ratio, stalls and inbound
WebSocket bytes. It waits for weeb-3's own player to move its playhead first, bounded by
`WEEB3_NATIVE_START_WAIT_S` (90). It is for a finished recording only, and refuses when the media ahead
cannot hold the three windows plus 20 s. `WEEB3_NATIVE_HARNESS_BRACKET=1` reads the nodes' postage and
chequebook counters through the harness instead of over SSH.

### The cap and the recorder reach the worker

The in-tab node runs entirely inside a SharedWorker, so every WebSocket it opens belongs to the worker,
not the page. A cap applied to the page's debug session, or a recorder listening on the page, would see
none of it. `src/browser/workerTargets.ts` opens a second, raw CDP client to Chrome's debugging
endpoint, attaches to every worker the browser makes, records their frames into the same
`WebSocketTraffic` the readers sum, and applies the network emulation to every attached worker,
including ones that attach after a squeeze started. A raw client is needed because a flattened child
session is addressed by a `sessionId` on every message, which Playwright's `CDPSession.send` does not
take. Chrome is launched with `--remote-debugging-port` through `launchViewerWatchingWorkers`, and
`BROWSER_CHROME_PATH` chooses the binary. Only worker sessions get `Network.enable`, so no byte is
counted twice.

Neither instrument is believed without proof. `src/browser/capProof.ts` holds two refusals, both about
the instrument rather than the product:

- **The cap proof.** One retrieval of a known-size payload is timed under the cap, through the path the
  run's video takes. Faster than four fifths of what the cap allows, the run refuses with "the cap did
  not reach the node". A run with nothing to time refuses with "the cap could not prove itself".
- **The recorder proof.** An inbound total below the payload bytes means sockets the recorder never
  saw. The run refuses with "the recorder is blind" and never prints the zero as a reading.

weeb-3's own page publishes no retrieval handle, so `browser:weeb3-native` gets a one-sided pair: inbound
over the cap refuses, and a phase that gained media while the recorder counted nothing refuses. Its
report says that passing them does not prove the cap landed.

### A real shaped link

Chrome's network emulation is one budget the browser divides across every socket, and an in-tab node
holds about two hundred of them, so it is not the same as a slow link. To measure under a real one:

```bash
deploy/scripts/browser-on-host.sh --target <host> --profile <profile> --portSlot <slot> \
  --own-network --shape-kbps 2800 --script browser:in-tab-throttle-probe \
  -- PROBE_CAP_MODE=external PROBE_CAP_KBPS=2800
```

`--shape-kbps` implies `--own-network`, which gives the browser container its own network namespace.
With host networking it would share one namespace with every Bee node and the uploader, and a shaper
inside it would throttle all of them. The cost is loopback, so `E2E_LOCAL_HOST_ADDRESS`,
`E2E_PUBLIC_HOST` and `BROWSER_CLIENT_URL` move to `host.docker.internal`.

`deploy/scripts/shape-container-ingress.sh` installs a `tc` ingress policer on the container's own
interface, download only. It refuses the run rather than measure an unshaped link: when the client
answers on the container's own loopback (the namespace is shared), when the client is unreachable
across the bridge, when `tc` is missing or denied, and when the measured rate is more than 25% under or
15% over the cap. `PROBE_EXTERNAL_CAP_MEASURED_BPS` carries the measured rate into the driver.

`PROBE_CAP_MODE=external` applies no emulation, runs one idle window rather than three, and omits the
uncapped rows, because the policer holds for the life of the container. Every row carries `capSource`.
`--cap-add=NET_ADMIN` can leave the capability permitted but not effective on some runc versions, and
the shaper names that when `tc` is denied.

Paid crash and buffer-sweep runs go through their gated wrappers on the host,
`deploy/scripts/crash-arms.sh` and `deploy/scripts/buffer-sweep-sitting.sh`, with the same gates as
every other run, and a run that does not name its byte source is refused.

## The latency benchmark

From a workstation:

```bash
deploy/scripts/bench-on-host.sh --target <host> --profile <profile> --portSlot <slot> --script bench:latency
```

On the deployment host itself:

```bash
pnpm bench:latency
```

It publishes a real stream, follows it through the feed a viewer reads, and reports how far behind
live that viewer is, split into segment duration, upload, feed write, propagation and fetch, plus the
player's configured buffer. It writes a markdown report and its JSON to `BENCH_RESULTS_DIR`,
`bench-results/` in the stack's folder by default, ignored by git. The client's live target is three
segments with a floor of 6 s (`LIVE_SYNC_DURATION_S` in
`packages/client/src/components/SwarmHlsPlayer/playerConfig.ts`).

- **How the picture is timed.** ffmpeg publishes with `-use_wallclock_as_timestamps 1 -copyts`, so each
  frame carries the bench machine's clock, and ffprobe reads every video packet's timestamp from the
  fetched segment. MPEG-TS timestamps wrap every 26.5 hours or so, which `src/bench/wallclock.ts`
  folds back.
- **How much media a segment holds is measured.** The earliest timestamp anchors the capture instant.
  The span between the earliest and latest, plus one median gap for the final frame, is what the
  segment holds. The report prints the engine's declared `#EXTINF` beside it.
- **Both ends are timed on one machine.** The publisher runs here and the gateway is fetched from here
  over HTTP, so no clock skew enters. Set `BENCH_GATEWAY_URL`, or forward the port with `ssh -L`. The run
  refuses to start when the gateway is unreachable. Through `bench-on-host.sh` there is nothing to set.
- **It checks itself first, for free.** It publishes to a local file, probes it and recovers the capture
  instants offline in about fifteen seconds, and checks that consecutive segments are contiguous.
- **It refuses before it spends.** It reads the spend ceiling in `.spend-ledger.env`, every publisher's
  chequebook and every publisher's postage time to live, through the same helpers the suites use
  (`src/bench/authorisation.ts`). A missing ledger is a refusal.
- **It refuses to guess.** An engine that rebases timestamps yields a plausible but wrong number. A
  frame cannot be captured before the publisher started, nor fetched before it was captured, so outside
  those bounds the run says the timestamps did not survive. The per-hop split from the uploader's log
  still works then.

| Variable             | Default                             | What it is                                       |
| -------------------- | ----------------------------------- | ------------------------------------------------ |
| `BENCH_GATEWAY_URL`  | `http://<publicHost>:<gatewayPort>` | Viewer gateway, as reachable from this machine   |
| `BENCH_SAMPLES`      | `5`                                 | Segments carried end to end                      |
| `BENCH_FPS`          | `30`                                |                                                  |
| `BENCH_GOP_SECONDS`  | `2`                                 | Keyframe interval, which bounds segment duration |
| `BENCH_BITRATE_KBPS` | `2500`                              |                                                  |
| `BENCH_SIZE`         | `1280x720`                          |                                                  |

The deployment has to log at `debug`, and the run checks before it publishes. Each run takes one set of
these values. There is no matrix runner.

## Prerequisites

- `ssh <target>` works without a prompt.
- `ffmpeg` on `PATH`, standing in for OBS.
- A deployed stack where every publisher node holds a usable batch. The smoke test checks each one's
  time to live first.
- Every publisher node's chequebook funded to at least 0.5 BZZ. The preflight only reads, and prints the
  `curl` that deposits each shortfall. Fund the nodes yourself.
- `PUBLISH_KEY_SECRET` resolves from the same env files, so the harness derives the same per-stream key
  as the deployment. Left empty, the harness publishes without a key, which a deployment that checks
  keys refuses.

## Not covered

Seeking, viewer scale, soak, a quality lock (the client has only `?level=<rung>`, which turns ABR off),
and audio quality beyond "a tone is present". The proof that each rung's bytes leave through its own Bee
node, read from the nodes' own counters, is not built: the suites read only the uploader's per-rung
counters (`e2e/src/harness/uploaderMetrics.ts`). If it is not a row above, the suites do not verify it.
