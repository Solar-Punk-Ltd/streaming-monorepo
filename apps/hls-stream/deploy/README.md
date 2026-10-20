# Deploying the stack

This is the deploy guide for the stack (`apps/hls-stream`): how to put the Bee nodes, the media
engine, the stream uploader and the viewer on one or more hosts, and how to run several isolated
instances side by side. The scripts here read one topology file, `deploy/config.json`, and the stack's
`.env`, and drive Docker Compose locally or over SSH.

## Prerequisites

- Docker and Docker Compose
- Node.js 24 or later, and pnpm
- [jq](https://jqlang.github.io/jq/download/)
- SSH access to any remote host, working without a password prompt
- xDAI and BZZ on Gnosis Chain to fund each Bee node that publishes

## First deploy

Run every command from the stack's folder, `apps/hls-stream`. Always run the scripts with bash
(`./deploy/scripts/deploy.sh` or `bash ./deploy/scripts/deploy.sh`), never `sh`.

1. Create the config files and build the packages:

   ```bash
   ./deploy/scripts/setup.sh
   ```

   You now have `deploy/config.json` and `.env`, and an `engines/<name>/.env` for each enabled engine.

2. Edit `deploy/config.json` to say where each service runs (see [Topology](#topology)), and `.env` to
   set `STREAM_KEY`, `BEE_UPLOADER_NAT_ADDR` and any ports.

3. Start the Bee node:

   ```bash
   ./deploy/scripts/deploy.sh bee-uploader
   ```

4. Fund it. Print its address, then send xDAI and BZZ to it:

   ```bash
   pnpm node:addresses
   ```

5. Buy a postage batch. This writes `STAMP` to `.env`:

   ```bash
   pnpm stamp:setup
   ```

6. Start the engine and the uploader:

   ```bash
   ./deploy/scripts/deploy.sh srs stream-uploader
   ```

7. Check it:

   ```bash
   ./deploy/scripts/health.sh
   ```

   Each service it reaches prints an ok line with the address it answered on, followed by the
   containers and their status. The uploader's `/health` answers `waiting_for_node` until its Bee node
   answers.

8. Issue a publish key for a stream if `PUBLISH_KEY_SECRET` is set, and point an encoder at the
   address it prints:

   ```bash
   ./deploy/scripts/publish-key.sh video/demo
   ```

Running `./deploy/scripts/deploy.sh` with no service redeploys everything enabled. It is safe to run
again: it skips Bee initialisation when the node is already initialised, and `docker compose up` is
idempotent.

## Topology

`deploy/config.json` maps each service to a target:

| Value         | Meaning                                                            |
| ------------- | ------------------------------------------------------------------ |
| `"localhost"` | Run in Docker on this machine                                      |
| `"user@host"` | Deploy over SSH and rsync to a remote host. SSH aliases work too   |
| `"native"`    | The service runs as a host process outside Docker. Deploy skips it |
| `false`       | Disabled                                                           |

```json
{
  "services": {
    "srs": "localhost",
    "stream-uploader": "localhost",
    "bee-uploader": "user@stage-host",
    "bee-gateway": false
  }
}
```

`srs` and `stream-uploader` must be on the same target, because they share the media volume. `client`
and `bee-gateway` must be on the same target, because nginx proxies to the gateway by its service name.

To debug the uploader natively, set `stream-uploader` to `"native"` and run it on the host
(`pnpm build:uploader && pnpm uploader:start`). The deploy then skips it and points SRS at
`host.docker.internal`. `"native"` is only valid when `srs` is `"localhost"`.

### Services

| Service              | Image                                             | What it is                                                                            |
| -------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `bee-uploader`       | `ethersphere/bee:2.8.3`                           | The Bee node that publishes, and the 360p rung's node                                 |
| `bee-uploader-480p`  | `ethersphere/bee:2.8.3`                           | The 480p rung's own Bee node. Off by default                                          |
| `bee-uploader-720p`  | `ethersphere/bee:2.8.3`                           | The 720p rung's own Bee node. Off by default                                          |
| `bee-uploader-1080p` | `ethersphere/bee:2.8.3`                           | The 1080p rung's own Bee node. Off by default                                         |
| `bee-gateway`        | `ethersphere/bee:2.8.3`                           | The Bee node viewers read through                                                     |
| `stream-uploader`    | Built from `Dockerfile.uploader`                  | Receives segments and publishes them to Swarm                                         |
| `srs`                | `ghcr.io/solar-punk-ltd/swarm-srs:6.0-r2-swarm.4` | SRT and RTMP to HLS, ABR transcode. See the [engines reference](../engines/README.md) |
| `ome`                | `airensoft/ovenmediaengine:v0.21.0`               | SRT ingest. The uploader pulls HLS over HTTP                                          |
| `client`             | Built from `Dockerfile.client`                    | The viewer (nginx), which proxies `/bee/` to `bee-gateway`                            |

Those nine names are every key `config.json` accepts. A service the file does not mention runs, except
`ome` and the three per-rung Bee nodes, which stay off until the file names them.
`config.sample.json` names `ome` as `localhost` and the three rung nodes as `false`.

### One Bee node per rung

Running the ladder with one Bee node per rung takes two things: the three rung services enabled in
`config.json`, and `BEE_PUBLISHERS` in `.env` pointing at them. A rung node left out of
`BEE_PUBLISHERS` is a node nothing publishes through, and a `BEE_PUBLISHERS` entry with no node behind
it is a rung pointing at nothing.

`bee-uploader` is the 360p rung's node and the coordinator: the catalogue and every ladder master go
through it. Each rung node's ports, data directory and funding are in [.env.sample](../.env.sample)
under "Per-rung Bee nodes".

The uploader reads every publisher before its first broadcast. A coordinator that does not answer is
waited for: the uploader listens, answers `/health` with `waiting_for_node`, and retries until it
answers. Another rung node that does not answer is handled by `UPLOADER_START_GATES`, which by default
warns and starts degraded. See [Startup gates](../packages/stream-uploader/README.md#startup-gates).

### The viewer stack

The `client` image is built in two stages: Node builds `packages/client/dist`, and nginx serves it on
port 80 and proxies `/bee/` to `bee-gateway`. Each profile's `VITE_APP_OWNER` and `VITE_APP_RAW_TOPIC`
are built into its image, so two profiles' viewers are different images. So is the release named with
[`--release-label` and `--release-commit`](#--release-label-and---release-commit).

`bee-gateway` runs ultra-light by default: it downloads and can never spend. Set
`BEE_GATEWAY_RPC_ENDPOINT` and `BEE_GATEWAY_SWAP_ENABLE` together in `.env` to put it on the chain.
That costs gas and a funded chequebook at the address its `/addresses` reports as `chain_address`.

```bash
# Two viewer instances side by side. Each profile env file sets its own
# VITE_APP_OWNER and STREAM_LIST_TOPIC for a different streamer's feed.
./deploy/scripts/deploy.sh --profile=viewer1 --portSlot=4 client bee-gateway
./deploy/scripts/deploy.sh --profile=viewer2 --portSlot=5 client bee-gateway
```

For `viewer1` at slot 4, the client answers on `http://localhost:10044` and the gateway API on
`http://localhost:10047`, also reachable as `http://localhost:10044/bee/`. `health.sh --profile=viewer1`
checks `/` on the client port and `/health` on the gateway port.

## Settings

The stack's `.env` holds the core settings, shared by development and deploy. See
[.env.sample](../.env.sample). Engine settings live in `engines/<name>/.env` (samples:
[srs](../engines/srs/.env.sample), [ome](../engines/ome/.env.sample)). `setup.sh` creates them for the
engines enabled in `config.json`. `deploy.sh` loads them below the stack's `.env`, so a value in the
stack's `.env` wins, which matches the order the native uploader loads them in.

How settings reach a remote host:

- Cross-host URLs are resolved for you, for example `BEE_URL=http://<remote-ip>:1633` when the Bee node
  is on another host.
- A port on another host answers only on its Docker bridge address until its bind setting names one:
  `BEE_UPLOADER_API_BIND` (`BEE_UPLOADER_API_LISTEN` under `COMPOSE_NETWORK=host`) for the Bee API,
  `OME_HTTP_BIND` for OME's HLS port. The deploy warns when that setting is empty and does not open the
  port itself.
- `COMPOSE_NETWORK=host` adds `docker-compose.host.yml` for host networking.
- `SRS_CONF_FILE` or `OME_CONF_FILE` runs the engine on a config file of your own. See
  [Your own config file](../engines/README.md#your-own-config-file).

## What the broadcaster's encoder must send

Without the ABR ladder nothing transcodes. SRS cuts the stream it is given, so the encoder's keyframe
interval decides the segment length, and the segment is the largest single delay between a camera and
a viewer.

| Setting                 | Use                               | Why                                                                                     |
| ----------------------- | --------------------------------- | --------------------------------------------------------------------------------------- |
| Keyframe interval (GOP) | `HLS_FRAGMENT`, 2 s in the sample | SRS cuts on keyframes, so a matching interval cuts every segment at its declared length |
| Video bitrate           | 2500k                             | 720p30. 1080p at 6000k also works, and costs about 2.3 times the BZZ                    |
| B-frames                | off                               | `-tune zerolatency` or the equivalent                                                   |

In OBS this is Settings, Output, Advanced, Keyframe Interval, in seconds. Its default of 0 lets the
encoder choose. In ffmpeg it is `-g <frames>`, so a 2 s interval at 30 fps is `-g 60`.

- **`HLS_FRAGMENT` is a floor, not the segment.** It has no default and the sample sets 2. A segment is
  `ceil(GOP / fragment) * fragment`, so a keyframe interval below it is rounded up, and lowering the
  encoder's interval without lowering `HLS_FRAGMENT` changes nothing. A keyframe interval outside
  `[HLS_FRAGMENT, HLS_SEGMENT_MAX]`, `[2, 2.5]` in the sample, is rounded up or force-cut without a
  keyframe.
- **Raising `HLS_FRAGMENT` takes two settings with it.** `HLS_WINDOW`, 15 s unless set, has to grow,
  because the player sits three segments behind the live edge. `HLS_SEGMENT_MAX`, 2.5 unless set, makes
  SRS refuse to start with any fragment longer than it.
- **Both the engine and the uploader read `HLS_FRAGMENT`.** Set it once in the profile's `.env` and
  redeploy both. See [HLS_FRAGMENT reaches two containers](../engines/README.md#hls_fragment-reaches-two-containers).
- **Shorter segments are quicker on a single rendition and cost more.** A 0.5 s keyframe interval
  brings a segment to the gateway in about 1.5 s from capture, against about 3.9 s at 2 s, and costs
  about 19% more BZZ, because the extra bytes are keyframes. Below 0.5 s buys nothing and costs more.
- **With the ABR ladder on, the broadcaster's interval no longer sets the segment length.** The
  transcoders re-key every rung at `ABR_FPS x HLS_FRAGMENT`, and a four-rung ladder needs
  `HLS_FRAGMENT` of at least 1.0 because of [the announcement ceiling](../engines/README.md#the-announcement-ceiling).
  The broadcaster's interval still decides how long a lost packet damages the picture, see below.

### SRT: the latency window, and what a lossy uplink does

SRT resends a lost packet, but waits only `SRT_LATENCY` milliseconds for the resend. A packet still
missing when its time comes is dropped for good, and a dropped packet is a hole in a video frame. With
the ladder on, the transcoders decode the damaged frame, conceal the hole as best they can and encode
the result into every rung and the recording. The broadcaster's OBS preview shows the picture before
it is sent, so it never shows this damage.

`SRT_LATENCY` defaults to 2000 ms and fills both `latency` and `recvlatency`. Both are needed, because
SRS 6 sets `recvlatency` after `latency` and defaults it to 120 ms. Every packet waits the full window,
so the cost is about 1.9 s more delay at ingest.

A broadcaster can raise it from their side, because SRT uses the larger of the two ends' values. OBS
takes it in microseconds at the end of the SRT address:

```
srt://<host>:<port>?streamid=<id>&latency=3000000
```

That asks for 3 seconds. What else helps, in order: a wired connection instead of Wi-Fi, a lower
bitrate (720p30 needs no more than 3500 to 4000k), and a keyframe interval of 2 seconds or less. A lost
packet damages the picture until the broadcaster's next keyframe, because the transcoder cannot rebuild
a picture the source never sent whole.

### Reading the loss

SRS prints one line per SRT publisher about every ten seconds with the counts for that interval. It is
the only place these counts exist:

```bash
docker logs <deployment>-srs-1 2>&1 | grep 'Transport Stats' | tail -6
```

`pktRcvLoss` is what went missing, `pktRcvRetrans` how many resends arrived, and `pktRcvDrop` what was
given up on. A non-zero `pktRcvDrop` is damage in the picture. Loss, resends and drops all roughly equal
means the resends arrive after the window, so raise the window. Grep for that line rather than reading
the log whole: SRS writes its webhook token and each broadcaster's publish key into other lines.

### RTMP

SRS also takes a broadcast over RTMP on `SRS_RTMP_PORT`, TCP, 1935 with no slot and `10002 + 10 * slot`
with one. The uploader treats RTMP and SRT alike: one publish key per stream, one reconnect window, one
ladder. A broadcaster gets two OBS fields, Server `rtmp://<host>:<port>/<app>` and Stream Key
`<stream>?key=<key>`. ffmpeg takes them joined, `rtmp://<host>:<port>/<app>/<stream>?key=<key>`, with
`-f flv`.

TCP resends a lost packet until it arrives, so a lossy uplink shows as a stream that falls behind, or
frames the encoder drops before sending, rather than holes in the picture. There is no latency window.

RTMP is not encrypted, so the stream key crosses the network readable, and with the takeover on whoever
reads it can take a live broadcast over. SRS 6 has no TLS on its RTMP listener, so RTMPS would need a TLS
terminator in front. See [the takeover](../engines/README.md#the-takeover-of-a-silent-publisher).

A reachable RTMP port is not an open stream: SRS allows play only from loopback by default. See
[Play is loopback only](../engines/README.md#play-is-loopback-only-by-default).

## Scripts

### deploy.sh

```bash
deploy.sh [--profile=<name>] [--portSlot=<N>] [--host=<target>]
          [--release-label=<label>] [--release-commit=<commit>] [service...]
```

```bash
deploy.sh bee-uploader                              # just the Bee node
deploy.sh srs stream-uploader                       # just the engine and the uploader
deploy.sh                                           # everything enabled in config.json
deploy.sh --profile=streamer1                       # the full stack as the isolated instance streamer1
deploy.sh --profile=streamer1 --portSlot=1          # the same, every port shifted by 10
deploy.sh --host=localhost                          # ignore config.json targets, deploy everything here
deploy.sh --host=user@stage-host                    # ignore config.json targets, deploy everything there
```

#### Profiles

A profile is one deployment instance: the same topology from `config.json`, with its own identity.
Each profile gets:

- its own compose project name (`-p <profile>`), which namespaces containers and volumes
  (`streamer1-bee-uploader-1`, `streamer1_srs-media`)
- its own env file, `.env.<profile>`, required when `--profile` is given
- its own engine env files, `engines/<engine>/.env.<profile>`, created on first deploy from the
  engine's `.env` or `.env.sample`
- its own Bee data directories, set in the profile env (`BEE_UPLOADER_DATA_DIR=./data/bee-uploader-<profile>`)
- its own host ports, through `--portSlot` or set in `.env.<profile>`
- its own remote directory, `~/swarm-hls-stream-<profile>`

To create one:

```bash
cp .env .env.streamer1
$EDITOR .env.streamer1   # set STAMP, STREAM_KEY and the *_DATA_DIR settings
./deploy/scripts/deploy.sh --profile=streamer1 --portSlot=1
```

Without `--profile` the deploy uses the implicit `default` profile, `.env`, `~/swarm-hls-stream`, and
no port shift.

#### --portSlot

`--portSlot=<N>`, an integer from 1 to 99, shifts every port the deploy knows by `N * 10`. Each service
has its own last digit, so two profiles never collide. When the flag is given it is authoritative and
port values in `.env.<profile>` are ignored. Without it, the env files decide.

99 is the ceiling because the per-rung Bee nodes take 11001 to 11006 at slot 0, shifted the same way,
and slot 100 would put the first block on top of them.

| Setting               | No flag |  Base | `--portSlot=1` | `--portSlot=2` | `--portSlot=99` |
| --------------------- | ------: | ----: | -------------: | -------------: | --------------: |
| API_PORT              |    3000 | 10000 |          10010 |          10020 |           10990 |
| SRS_SRT_PORT          |   10080 | 10001 |          10011 |          10021 |           10991 |
| SRS_RTMP_PORT         |    1935 | 10002 |          10012 |          10022 |           10992 |
| SRS_HTTP_PORT         |    8080 | 10003 |          10013 |          10023 |           10993 |
| CLIENT_PORT           |    5173 | 10004 |          10014 |          10024 |           10994 |
| BEE_UPLOADER_API_PORT |    1633 | 10005 |          10015 |          10025 |           10995 |
| BEE_UPLOADER_P2P_PORT |    1634 | 10006 |          10016 |          10026 |           10996 |
| BEE_GATEWAY_API_PORT  |    1733 | 10007 |          10017 |          10027 |           10997 |
| BEE_GATEWAY_P2P_PORT  |    1734 | 10008 |          10018 |          10028 |           10998 |
| SRS_HTTP_API_PORT     |    1985 | 10009 |          10019 |          10029 |           10999 |

The Base column is where the slot arithmetic starts, not what you get with no flag. With no flag, values
set in the env files win and unset ones fall back to the No flag column. `SRS_SRT_PORT=10080` comes from
`engines/srs/.env.sample`.

`SRS_ADAPTER_PORT` follows `API_PORT`, so SRS's webhooks reach the right uploader. OME's ports
(`OME_SRT_PORT`, `OME_HLS_PORT`) are not shifted, so review the generated engine env file when you run
more than one OME instance on one host.

#### --host

`--host=<target>` ignores the targets in `config.json` and sends every enabled service to `<target>`,
`localhost` or `user@host` or an SSH alias. Services set to `false` stay off. Because every service
lands on one target, the co-location rules are met.

```bash
./deploy/scripts/deploy.sh --host=localhost --profile=streamer1 --portSlot=1
./deploy/scripts/deploy.sh --host=stage-host stream-uploader bee-uploader
```

#### --release-label and --release-commit

These name the release being deployed, and the client builds it in. The player's QoE overlay, opened
with `?qoe=1` on a watch URL, shows it as `Player <label> (<first nine characters of the commit>)`, or
the label alone when it already starts with those nine characters or no commit was given. The
deployment manager passes the label and commit of the stack build it deploys.

```bash
./deploy/scripts/deploy.sh --profile=viewer1 --portSlot=4 --release-label=QA-build-1 \
  --release-commit=<the 40 character commit> client bee-gateway
```

- A label is letters, digits and `. _ + / -`, 1 to 96 of them, as `tools/release/version.mjs` names a
  build. A commit is 40 lower-case hex characters. Anything else is refused before anything is
  deployed, and the refusal names the flag, not the value.
- They reach the client build as `VITE_APP_RELEASE_LABEL` and `VITE_APP_RELEASE_COMMIT`, written into
  the override file for a target that builds the client. Both lines are always written, empty without
  the flags, so a value from an env file or the shell never reaches the bundle.
- Without `--release-label` the overlay shows no release line.
- A stack version without these flags reads them as unknown service names and stops with
  `Unknown service`.

### stop.sh, health.sh and clean.sh

```bash
stop.sh   [--profile=<name>] [service...]   # stop containers, all of them if none is named
health.sh [--profile=<name>] [service...]   # check service health, all of them if none is named
clean.sh  [--profile=<name>] [--volumes] [--all] [--yes] [service...]
```

`stop.sh` keeps every volume and `health.sh` only reads.

```bash
clean.sh                                 # remove all containers
clean.sh bee-uploader                    # remove only bee-uploader
clean.sh --volumes                       # remove containers and Docker volumes (data loss)
clean.sh --all                           # remove everything, remote files included
clean.sh --profile=streamer1 --volumes   # remove streamer1's containers and volumes
clean.sh --yes                           # skip the confirmation prompt
```

A clean restart is `clean.sh --volumes` followed by `deploy.sh`.

### publish-key.sh

```bash
publish-key.sh <app>/<stream>
```

Prints the publish key for one stream, derived from `PUBLISH_KEY_SECRET`, with SRS's SRT and RTMP
addresses and OME's SRT address at the ports the deployment listens on. It names the file the SRT
passphrase lives in rather than printing it. See
[Publisher authentication](../packages/stream-uploader/README.md#publisher-authentication).

### drain-stage.sh

```bash
drain-stage.sh --profile=<name> --portSlot=<N> --rung=<name> print-buy [--days=2] [--depth=17]
drain-stage.sh --profile=<name> --portSlot=<N> --rung=<name> arm --batch=<64 hex> [--depth=17]
drain-stage.sh --profile=<name> --portSlot=<N> --rung=<name> restore
drain-stage.sh --profile=<name> --portSlot=<N> --rung=<name> status
```

Points one ABR rung at a tiny postage batch so the batch runs dry in the middle of a broadcast, then
puts the original back. It sets up the drain test described in
[the testing page](../e2e/README.md#one-rungs-postage-runs-out).

- `print-buy` reads the chain price off the rung's own node and prints one purchase command, its cost
  in BZZ, and how many chunks the batch takes before it starts refusing. It never runs the command.
  You buy the batch.
- `arm` takes the id the purchase returns, rewrites that rung's entry of `BEE_PUBLISHERS` in
  `.env.<profile>`, and redeploys the uploader. It refuses a batch that would not run dry as
  expected: one the node does not hold or will not spend, one whose depth is not the depth asked for
  (17 by default, the smallest Bee allows), one with less than 13 hours to live (the uploader's 12 hour
  floor from `STAMP_MIN_TTL_HOURS` plus an hour), one that already holds chunks, and a second arm on a
  rung already armed.
- `restore` writes the original batch back the same way.
- `status` prints the batch `BEE_PUBLISHERS` names for the rung, whether the rung is armed and with
  which original, and what the node says about the batch.

Before either rewrite the env file is copied to `.env.<profile>.bak-<timestamp>`, and the original and
armed batch ids are recorded in `.drain-stage.<profile>.env` as `<rung>=<original> <armed>`. `restore`
reads that record and deletes it once the last armed rung is restored. If the record is lost, the
original id is in the newest `.bak`. Before each redeploy the script saves the uploader's container log
to `~/drain-<profile>-<rung>-<utc>.uploader.log` on the deployment host, because a redeploy replaces
the container and its log. No batch id is printed whole.

### bench-on-host.sh

```bash
bench-on-host.sh --target <host> --profile <profile> --portSlot <slot> [--script bench:latency]
bench-on-host.sh --target <host> --profile <profile> --portSlot <slot> --setup-only   # sync, build, install, then stop
bench-on-host.sh --target <host> --profile <profile> --portSlot <slot> --no-setup     # reuse what is on the host
```

Runs a benchmark or a browser driver on the deployment host rather than a workstation, so capture and
fetch share one clock and your own uplink stays out of the reading. It syncs the checkout, builds an
image there, and runs one script in a container over SSH. `--target`, `--profile` and `--portSlot` are
required, and so they are for `browser-on-host.sh`, `bench-sweep.sh` and `bench-profiles.sh`.

- **The container is named `<profile>-harness-slot<N>`.** Every phase of a launch uses that name, so
  `docker stop <profile>-harness-slot<N>` always stops what the script started.
- **Every script runs behind the e2e preflight gates.** A `test:e2e*` script already chains them. Any
  other script, a `browser:*` driver or a `bench:*` run, gets `pnpm e2e:preflight && ` in front, so a
  refusal exits before anything is published. No flag turns this off.
- **A launch is refused when that container exists on the target at all**, running or exited. Two
  harness runs on one stage read each other's broadcasts. The refusal prints the `docker stop` or
  `docker rm` that clears it, and the script runs neither for you.
- **An interrupted launch stops its container.** A trap on INT, TERM and EXIT sends one `docker stop`
  over SSH, capped at 20 seconds (`BENCH_STOP_DEADLINE_SECONDS`). It is best effort: a Ctrl-C can
  occasionally kill the shell before the trap runs. The refusal above catches any container left
  behind.
- **A launch from a checkout with no `.spend-ledger.env` at its root is refused** before it syncs, so a
  checkout holding only tracked files never replaces the host's harness copy.

`drain-stage.sh` has no spend gate, because it spends nothing itself. The broadcast that drains the
batch is launched through `bench-on-host.sh`, behind the gates.

### Node and postage commands

```bash
pnpm stamp:setup [--yes]           # wait for the node, buy a batch, write STAMP to .env
pnpm stamp:buy [--rung <rung>] [amount] [depth] [--immutable] [--yes]
pnpm stamp:check                   # list every batch
pnpm node:status                   # health and sync status
pnpm node:addresses                # ethereum and overlay addresses
pnpm node:wallets                  # BZZ and xDAI balances
```

Each command finds its nodes from `config.json` and `.env`, and `--url <url>` narrows it to one. See
the [CLI reference](../packages/cli/README.md).

## How a deployed stack fits together

```
OBS or ffmpeg ──SRT or RTMP──> SRS (SRT on 10080/udp, RTMP on 1935/tcp)
                                 |
                                 +-- writes .ts segments to the shared volume (srs-media)
                                 +-- calls the stream-uploader's webhooks
                                       |
                                       +-- on_publish   -> start a stream session
                                       +-- on_hls       -> read the segment, upload it to Swarm
                                       +-- on_unpublish -> note a disconnect. The broadcast becomes a
                                                           recording if no media returns within
                                                           ORPHAN_REAP_MS (60 s by default)
```

Each service has a Docker Compose [profile](https://docs.docker.com/compose/how-tos/profiles/), and
only the activated ones start. A remote deploy rsyncs the files and starts Compose over SSH.
