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

| Part          | Folder                                            | What it does                                                                                                                                                                                                                         |
| ------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ingest engine | `apps/hls-stream/engines`                         | SRS (the default) or OvenMediaEngine. Takes SRT from the encoder and cuts it into HLS segments. With the ABR ladder on, it transcodes every quality rung.                                                                            |
| Uploader      | `apps/hls-stream/packages/stream-uploader`        | Hears about every closed segment from the engine, stamps it and uploads it to Swarm, and keeps the playlists and feeds that tell a viewer where each segment is. Asks the web2 admin which stream an encoder publishes to.           |
| Bee nodes     | `apps/hls-stream/nodes`, `apps/hls-stream/deploy` | Swarm nodes. One uploader node per quality rung publishes that rung's segments, each with its own postage batch and chequebook. A gateway node serves viewers. A catalogue node holds the catalogue's batch alone.                   |
| Feeds         | written by the uploader                           | Swarm feeds are mutable pointers signed by one key. Each rung has a feed of its playlist, and a master feed names the rungs. Every stage signs its feeds with a key of its own. A viewer follows a feed, not a host.                 |
| Catalog       | written by the web2 admin                         | A feed signed with the brand key, which only the admin holds, that lists the streams of every stage, with their titles and thumbnails. Written through the dedicated catalogue node's immutable batch, which the manager designates. |
| Viewer        | `apps/hls-stream/packages/client`                 | A browser player built on hls.js. Reads the catalog and the feeds and fetches segments from a gateway or from an in-tab Swarm node.                                                                                                  |
| Manager       | `apps/infra-manager`                              | A console and an API that deploy stack versions onto hosts over ssh, hand out port slots, buy postage and fund chequebooks. Pushes every stage it runs, and the catalogue's batch, into the web2 admin.                              |
| Web2 admin    | `apps/web2-admin`                                 | The brand console: streams, the stage each goes live on, and users. Publishes the catalog. Learns its stages from the manager's pushes and never calls the manager, a host or a wallet.                                              |
| Edge          | `infra/edge`                                      | One Caddy container per control host. Holds ports 80 and 443, gets the HTTPS certificates, and sends each domain to the console behind it.                                                                                           |

A stage is a manager deployment that runs a stream uploader, with the node pool behind it.
[stages.md](stages.md) says what the manager pushes about each one and how the admin uses it.

## How a stream travels

1. The encoder sends SRT to the ingest engine on a stage host.
2. The engine writes each closed segment to a media volume it shares with the uploader and calls the
   uploader's webhook. With the ladder on, it writes one segment per rung.
3. The uploader stamps each segment with its rung's postage batch and uploads it through that rung's
   own Bee node. It then rewrites the rung's playlist, uploads that, and moves the rung's feed to it.
4. The master feed names every rung that is publishing. A rung that stops is dropped from it, so a
   viewer is never sent to a quality that has died.
5. The viewer reads the catalog to find a stream, follows its master feed, and plays the rung its
   bandwidth allows. Segments come from a Bee gateway over HTTP, or from a light node in the tab.

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
lives once, in `apps/hls-stream/packages/shared/src/windows.ts`. Nothing reads or writes it yet.

- **The window.** Window `w` of length `windowMs` covers `[w * windowMs, (w + 1) * windowMs)` of
  Unix milliseconds. The writer writes window `w` once, at its end. A reader asks for it once, at
  its end plus a margin of 1 s to start, and never again.
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

`apps/hls-stream/packages/shared/src/windowWriter.ts` holds the writer, as pure logic with the
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
