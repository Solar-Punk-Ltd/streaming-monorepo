# Architecture overview

This page says what the platform is made of, how a live stream travels through it, which ports each
part listens on, and which of those ports must never be reachable from the internet. It names no
real host, address or domain. Every address below is a placeholder, and the ports are the defaults
the deploy scripts use.

## What the platform does

A broadcaster sends a live video stream from an encoder such as OBS or ffmpeg. The platform cuts it
into HLS segments, optionally transcodes it into a ladder of qualities, and writes every segment to
Swarm, the decentralised storage network run by Bee nodes. A viewer's browser then plays the stream
straight from Swarm, either through a Bee node that acts as a gateway or through a light Swarm node
running inside the browser tab. Once the segments are on Swarm, playback depends on no server of the
broadcaster's.

## The parts

| Part          | Folder                                            | What it does                                                                                                                                                                                                                                                                                           |
| ------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ingest engine | `apps/hls-stream/engines`                         | SRS (the default) or OvenMediaEngine. Takes SRT from the encoder and cuts it into HLS segments. With the ABR ladder on, it transcodes every quality rung.                                                                                                                                              |
| Uploader      | `apps/hls-stream/packages/stream-uploader`        | Hears about every closed segment from the engine, stamps it and uploads it to Swarm direct, writes each quality's live playlist as a time window every 2 s, and names each quality's finished recording by its reference on the stream list. Asks the web2 admin which stream an encoder publishes to. |
| Bee nodes     | `apps/hls-stream/nodes`, `apps/hls-stream/deploy` | Swarm nodes. One uploader node per quality rung publishes that rung's segments, each with its own postage batch and chequebook. A gateway node serves viewers. A catalogue node holds the catalogue's batch alone.                                                                                     |
| Feeds         | written by the uploader                           | Swarm feeds are mutable pointers signed by one key. The stream list is a feed, written direct, with notes beside it. A quality's live playlist is a time window and not a feed, and there is no master feed. Every stage signs with a key of its own. A viewer follows the stream list, not a host.    |
| Catalog       | written by the web2 admin                         | A feed signed with the brand key, which only the admin holds, that lists the streams of every stage, with their titles and thumbnails. Written through the dedicated catalogue node's immutable batch, which the manager designates.                                                                   |
| Viewer        | `apps/hls-stream/packages/client`                 | A browser player built on hls.js. Reads the catalog and the feeds and fetches segments from a gateway or from an in-tab Swarm node.                                                                                                                                                                    |
| Manager       | `apps/infra-manager`                              | A console and an API that deploy stack versions onto hosts over ssh, hand out port slots, buy postage and fund chequebooks. Pushes every stage it runs, and the catalogue's batch, into the web2 admin.                                                                                                |
| Web2 admin    | `apps/web2-admin`                                 | The brand console: streams, the stage each goes live on, and users. Publishes the catalog. Learns its stages from the manager's pushes and never calls the manager, a host or a wallet.                                                                                                                |
| Edge          | `infra/edge`                                      | One Caddy container per control host. Holds ports 80 and 443, gets the HTTPS certificates, and sends each domain to the console behind it.                                                                                                                                                             |

A stage is a manager deployment that runs a stream uploader, with the node pool behind it.
[stages.md](stages.md) says what the manager pushes about each one and how the admin uses it.

## How a stream travels

1. The encoder sends SRT to the ingest engine on a stage host.
2. The engine writes each closed segment to a media volume it shares with the uploader and calls the
   uploader's webhook. With the ladder on, it writes one segment per rung.
3. The uploader stamps each segment with its rung's postage batch and uploads it direct through that
   rung's own Bee node. Every 2 s it writes the rung's live playlist, naming the segments whose upload
   finished, as that rung's window chunk for the 2 s that just ended. When the broadcast ends it writes a
   closing window and uploads the rung's recording playlist once, named by its reference.
4. The stream list entry names every rung with its topic, its size and its bandwidth, which is all a
   player needs to build the ladder's master playlist. No master playlist is written to Swarm.
5. The viewer reads the catalog to find a stream, builds the master from the entry's renditions, and
   plays the rung its bandwidth allows, reading that rung's windows. Segments come from a Bee gateway
   over HTTP, or from a light node in the tab. The player moves onto windows in phase 3 of the windows
   plan, and until then it follows feeds this uploader no longer writes.

The manager and the web2 admin are not on this path. A running broadcast carries on while either of
them is down. They decide what runs where and who owns which stream.

```
encoder --SRT--> ingest engine --webhook--> uploader --HTTP--> one Bee node per rung --> Swarm

viewer <--HTTP-- Bee gateway <-- Swarm
viewer <--light node in the tab-- Swarm
```

## Time windows on Swarm

Live playlists are moving off feeds onto time windows, the convention the chat already uses for
its slot notes. Asking Bee for a chunk before it exists makes Bee skip its peers for that address
for about a minute, so polling the next feed index delays the update it waits for. A window chunk
sits at an address computed from the clock and is asked for once, after it is due. The convention
lives once, in `packages/swarm-windows/src/windows.ts`, a package the stack's shared package
re-exports and the web2 admin depends on directly. The uploader writes each quality's `live`
windows on it, and both writers of the stream list write its notes. Nothing reads them yet.

- **The window.** Window `w` of length `windowMs` covers `[w * windowMs, (w + 1) * windowMs)` of
  Unix milliseconds. The writer writes window `w` once, at its end. A reader asks for it at its end
  plus a margin of 1 s to start, and not again while that ask could still be on Bee's skip list.
- **The identifier.** keccak256 of the UTF-8 text `<topic>/<kind>/<windowMs>/<w>`, numbers in plain
  decimal. The kinds are `live`, a quality's live playlist every 2 s window, and `note`, a feed's
  newest index in the chat's own format: the stream list in 10 s windows, the chat in 2 s windows.
- **The address.** keccak256 of the identifier's 32 bytes followed by the owner's 20 bytes, the
  single owner chunk rule. Readers ask `GET /chunks/<address>`, which public gateways serve.
- **The `note` payload.** The UTF-8 JSON `{"v":1,"newest":<index>,"writtenAt":<ms>}` with the keys
  in that order, at most 256 bytes. `newest` is -1 when nothing is written yet. For this kind the
  identifier, the address and the payload are byte for byte those of swarm-chat-js 7.2.0.
- **The `live` payload.** The quality's HLS live playlist with `#EXT-X-SWARM-WRITTEN-AT:<ms>` as its
  second line, the Unix milliseconds the writer wrote it. At most 4096 bytes, a hard limit: the
  floor rule that lets a feed playlist reach 8192 bytes does not apply to a window chunk.

### Writing windows

`packages/swarm-windows/src/windowWriter.ts` holds the writer, as pure logic with the
clock, the timers and the write injected. The caller's write signs the chunk and uploads it direct.

- **Two writers on one schedule.** The `live` writer publishes the composed playlist in every window
  that has one. The `note` writer names the newest stored feed index when it changed since the last
  note that was stored, and in every heartbeat window, a window whose number is a multiple of the
  heartbeat over the window length. So an empty feed still carries notes, and a reader can compute
  which windows must hold one.
- **Once, at the end.** Window `w` is written at its end, scheduled from the clock each time. It is
  never written twice and never retried. A failed write is reported, and the next window carries the
  same news at its own address.
- **Late, busy and stale windows are skipped.** A window whose timer fires more than 500 ms after
  its end is skipped, since readers ask 1 s after it. At most two writes run at once. A clock that
  moves back waits until it passes the last window reached. A clock jump forward or a stall writes
  only the window that just ended and reports the windows passed over as one event.
- **Every window gets one event**: written with the write's duration, failed with the error, or
  skipped with its reason (nothing to write, busy, late, clock not trusted, too large, stopped).
  Nothing is written after `stop()` returns.
- **Callbacks must not throw.** `onEvent` runs inside promise handlers, so a throw becomes an
  unhandled rejection. The same holds for the reader's found, state and ask callbacks.
- **The late limit and the clock's write slack are tied.** The late limit (500 ms) plus a write
  (about 120 ms measured) plus propagation (about 300 ms) must stay under the base read margin of
  1000 ms, or a reader with an accurate clock asks too early. Both constants say so where they are
  defined.
- **Named seams.** `maxInFlight` bounds the writes running at once, and `clockTrusted` lets the
  caller hold writes while it does not trust its own clock. Both skip a window and say why.
- **The uploader is the `live` writer.** `StreamUploader` writes a quality's live playlist every 2 s
  window on the topic the stream list's rendition names, from its first segment on, through any pause
  in the media, until the end, when windows carry `#EXT-X-ENDLIST` until one is written. Its
  `clockTrusted` comes from the uploader's own option and holds every window while it answers false. A
  session on a topic an earlier session wrote waits until that session has stopped writing, then reads
  the topic's windows of the last minute once, newest first, and continues the media sequence the
  newest one left. Segments and the recording are uploaded direct.
- **A recording is its reference.** At the end each quality uploads its recording playlist once as
  bytes, and the stream list's rendition, the entry and the reports to the web2 admin name it by that
  reference, `recording`, and by nothing else. No writer names a recording by a feed index, and the
  admin refuses a report that does.

### The stream list's notes

The stream list stays a feed, so every version is kept in order. The uploader's `StreamCatalog`,
when it runs without an admin, writes each new version as the next feed index with a direct upload,
then runs one `note` writer for the list: 10 s windows, a heartbeat every 60 s, the topic being the
list's topic name (`STREAM_LIST_TOPIC`, the text the feed topic is made from), signed by the list's
key and uploaded direct. The note names the newest index whose own write finished. A reader takes
the same name from its own setting, `VITE_APP_RAW_TOPIC` in the monorepo's client and
`catalog.topic` in the event viewer's config.

The web2 admin writes the list at an event and runs the same writer from `ListNotes.ts`: the topic
is its `FEED_TOPIC`, the key its `FEED_PRIVATE_KEY`, the newest index the highest one its
`feed_writes` recorded, and each note goes through the node and batch the catalogue is written with.
The admin has no clock check, so its notes trust its clock.

### Reading windows

The reader core is `packages/swarm-windows/src/windowReader.ts`, and the clock calibration
it shares is `windowClock.ts` beside it. Both are pure logic: the read, the clock and the timers are
injected, and the caller checks the owner's signature before a payload reaches them.

**Why early asks are the cost that matters.** Asking Bee for a chunk before it exists makes Bee skip
its peers for that address for about a minute, on the gateway and on the nodes that forwarded the
ask. The skip list belongs to the node, so one viewer whose clock runs fast delays that window for
every viewer on the gateway. Being late only costs the viewer who is late. So the reader may run a
little late and keeps its early asks rare.

- **Opening.** Ask the newest window due by the corrected clock and the ones before it, newest first,
  4 at a time: at most 8 windows for `live`, and for `note` the heartbeat in windows plus 2. If none
  is found, ask further back at doubling distances until one is, or the clock limit is passed, so a
  reader whose clock runs 5 minutes ahead still finds the stream. The newest found chunk is handed on.
  What the first opening learns about the clock counts only once something is found, because a stream
  that is not running looks exactly like a clock far ahead.
- **Following.** Each window is asked once, at its end plus the margin plus the correction, and never
  again while that ask could still be on Bee's skip list. A window that was not found, and whose
  first ask came more than the skip list's minute (`BEE_SKIP_LIST_MS`, Bee's `skiplistDur`) before it
  is due by the current calibration, is asked once more when due, never a third time. That is how a
  reader whose clock ran minutes ahead still reads the windows its opening asked too soon. When
  several are due at once only the newest is asked, since it carries what the others would. While
  the clock is still calibrating, one ask is out at a time.
- **Margin and correction are kept apart.** The margin, 1 s to start, is how long propagation takes
  and belongs to one reader: three windows that must exist absent in a row, with the clock not to
  blame, double it, capped at 8 s, and five found in a row halve it back. The correction is how far
  the reader's clock runs ahead and belongs to the client.
- **One clock per client.** `WindowClock` is shared by every reader in a client, so the live reader's
  answer every 2 s also protects the stream list's note reader, which asks once every 10 s. Each found
  chunk bounds how far ahead the clock can be, by its received time less its written time. Each absent
  window that must exist bounds how far ahead it is at least. The correction moves up at once on an
  early ask, then descends from the best found ask an eighth of the way to the floor per found window,
  and once settled steps down 250 ms per 10 found windows, never below where an early ask last
  happened. It is limited to 5 minutes and 10 s either way.
- **Jumps.** A timer that fires early by its own measure is a backward jump, and the whole calibration
  moves by it, so no window is asked twice and the pace stays the same. A timer that fires late is a
  forward jump or a sleep, which look alike: only the newest due window is asked, the correction stays,
  so a sleep costs nothing, and the bracket opens upward, so an absent answer reads as the clock having
  moved and the reader scans back from that window for one not yet asked.
- **A forward step of the wall clock is not a sleep.** A sleep stops the timers too, so the reader
  sees it as a late timer and asks nothing early. A step moves the clock under timers that kept
  running, so the reader asks early by the step until it recalibrates: scenario 5 measured 2 harmful
  asks for a 10 s step, and a step of a minute or more can make one second ask harmful.
- **What a read can answer.** `failed` is neither evidence nor a miss, since a gateway that cannot
  answer says nothing about the window. A refused payload proves the chunk exists and carries no
  news, so it counts as evidence about the clock and as no miss.
- **Silence.** No chunk for 30 s on `live`, or for the heartbeat plus two windows plus the margin on
  `note`, reports the stream paused or down. The reader keeps asking one window per window, which
  costs nothing for a window nobody writes, and reports live on the next found chunk. A silence does
  not open the scan again. A clock that stepped forward looks exactly like a silence, and the follow
  loop's timer catches it instead, as a jump.
- **A clock running behind cannot be detected.** A reader 5 minutes behind asks windows written 5
  minutes earlier, finds every one, and plays 5 minutes late. Finding out would mean asking windows
  its own clock says are not due yet, which is the early ask that hurts everyone.
- **Known limit: opening during an outage.** A reader opened while no windows are being written, and
  told the stream is live, cannot tell the outage from a clock running ahead by as long. It may stay
  that late until reloaded: opened 60 s into an outage, it followed 65 to 67 s late in the
  simulation. The player should pass `isLive` from the stream list, and with it the same reader
  settles at the normal delay once the stream resumes. A direct clock reading from the gateway is the
  likely fix, a later phase's decision.
- **Known limit: a note reader alone calibrates slowly.** It learns about its clock only from
  heartbeat windows, one a minute. With a clock 3 s ahead it made one harmful heartbeat ask in its
  first 3 minutes, and in 36 of 200 simulated runs one or two more later. A note reader sharing the
  clock with a live reader made none once the live reader settled. A note reader also asks every
  window, news windows included, before its clock settles, so a fast clock may poison a few news
  notes in its first minutes: 0 to 4 harmful asks over 200 simulated runs.

## The three kinds of host

A host is a Linux machine with Docker on it. One machine can carry every role, or each role can have
machines of its own.

- **Control host**: the manager, the web2 admin and the edge in front of them.
- **Stage host**: stack deployments, one per profile and port slot: the ingest engine, the uploader,
  the viewer page and a gateway node.
- **Bee host**: the Bee nodes of an ABR node pool, one per quality rung, which the uploaders on stage
  hosts publish through, and the brand's catalogue node, which the web2 admin on the control host
  writes the catalog through.

[The self-hosting guide](../self-hosting.md) says how to set up each one.

## Ports

### A stack deployment

Every stack deployment the manager creates takes a port slot `s`, from 1 to 99, and each of its
ports is `10000 + 10 × s` plus a fixed last digit, so two deployments on one host never collide.

| Port             | Protocol | What it is                                   | Reachable from                                  |
| ---------------- | -------- | -------------------------------------------- | ----------------------------------------------- |
| `10000 + 10 × s` | tcp      | the uploader's API and the engine's webhooks | the host itself only                            |
| `10001 + 10 × s` | udp      | SRT ingest                                   | the internet, so encoders can reach it          |
| `10002 + 10 × s` | tcp      | SRS's RTMP listener                          | the internet where the firewall opens it        |
| `10003 + 10 × s` | tcp      | the engine's HLS output                      | the host's Docker bridge, by default            |
| `10004 + 10 × s` | tcp      | the viewer page                              | the internet                                    |
| `10005 + 10 × s` | tcp      | the uploader Bee node's API                  | **never the internet**, see below               |
| `10006 + 10 × s` | tcp      | the uploader Bee node's peer port            | the internet, so Swarm peers can dial it        |
| `10007 + 10 × s` | tcp      | the gateway Bee node's API                   | **never the internet** without a proxy in front |
| `10008 + 10 × s` | tcp      | the gateway Bee node's peer port             | the internet                                    |
| `10009 + 10 × s` | tcp      | the engine's own HTTP API                    | the host's Docker bridge, by default            |

Every listen address is a setting. The Bee APIs and the engine's HTTP ports default to the host's
Docker bridge address, which the stack's deploy reads at deploy time, because Docker publishes a port
with rules of its own that a host firewall such as ufw never sees, and a Bee API has no password and
can spend money. A deployment on any host other than the manager's own is the exception for the Bee
APIs: the manager writes `0.0.0.0` into each Bee API bind its settings leave empty, so the manager
can dial it, and that host's firewall decides who reaches it. Ingest, the viewer and the peer ports default to every address, and which of them
the internet reaches is the operator's firewall.

An SRS stage offers RTMP beside SRT. SRS allows play from its own container only, because RTMP
publishing and playback share one port. RTMP is not encrypted: a broadcaster's stream key crosses
the network as readable text, and a key read off the network publishes over RTMP whichever protocol
it was read from, because SRT sends its stream id, key included, before encryption starts. With the
takeover on, such a publisher can also replace a live broadcast. The SRT passphrase keeps the picture
private but not the key.

The per-rung Bee nodes of an ABR ladder take a second block, from `11001 + 10 × s`, with the same
rule: each peer port is public and each API is not.

Without a port slot the stack uses its stock ports: 3000 for the uploader, 10080 for SRT, 1935 for
RTMP, 8080 for the engine's HLS, 1633 and 1634 for the uploader node, 1733 and 1734 for the gateway
node, and 1985 for the engine's API.

### The control host

| Port    | What it is                                 | Reachable from                                     |
| ------- | ------------------------------------------ | -------------------------------------------------- |
| 80, 443 | the edge, and 443 over udp for HTTP/3      | the internet                                       |
| 8080    | the manager's console, with its API behind | the host's loopback only, reached through the edge |
| 9090    | the web2 admin's console, with `/api/`     | the host's loopback only, reached through the edge |
| 22      | ssh                                        | your own address only                              |

The manager's API listens on 9876 inside its compose network and publishes nothing. The manager's
Postgres and the web2 admin's database publish nothing either. Only the manager's development compose,
`pnpm database:start`, publishes its Postgres, on the host's loopback at `MANAGER_DEV_PG_PORT`.

## What must never be public

- **Every Bee API port.** A Bee API asks for no password. Anyone who can reach it can buy postage
  with the node's wallet, spend its chequebook and upload under its batch. On a Bee host whose rungs
  serve uploaders on other machines, open the API port to those machines' addresses alone, each as a
  `/32`, and to the control host's, and to nobody else. The manager's firewall generator does exactly
  this with `--bee-api-source`.
- **The Bee debug API**, on the Bee versions that still have one. It carries the same risk.
- **The uploader's API and the engine's HTTP API.** The uploader asks for a bearer token on its
  control routes, but it is an internal service and has no reason to answer from outside.
- **The consoles' own ports.** The edge is the only way in from the internet, with HTTPS. An ssh
  tunnel is the way in when the edge is down.
- **Postgres**, on any host.

Docker publishes a container port by rewriting packets before a host firewall's input rules see
them, so binding a port to a private address is the control and a firewall is the second layer. On
a host other than the manager's own, where the manager binds the Bee APIs to every address, the
firewall is the control for them, so it goes in before the first deploy there. The
manager generates an nftables table from its own record of a host that opens exactly the public
ports above and closes the rest of the band. "Opening the manager to the internet" in
`apps/infra-manager/deploy/README.md` shows both steps.

## Where the money goes

Swarm charges for storage with postage batches bought in xBZZ, and for bandwidth through
chequebooks between Bee nodes. Each uploader Bee node needs xDAI for gas and xBZZ for its batch and
its chequebook. The manager shows each node's address and never holds a wallet of its own: whoever
runs the deployment sends the funds to that address. [The self-hosting guide](../self-hosting.md)
has the commands.
