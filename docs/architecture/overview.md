# Architecture overview

This is a concepts page. It says what the platform is made of, how a live stream travels through
it, which ports each part listens on, and which of those ports must never be reachable from the
internet. Every address below is a placeholder, and the ports are the defaults the deploy scripts
use.

## What the platform does

A broadcaster sends a live video stream from an encoder such as OBS or ffmpeg. The platform cuts it
into HLS segments, optionally transcodes it into a ladder of qualities (adaptive bitrate, ABR: the
player switches between them as its connection allows), and writes every segment to
Swarm, the decentralised storage network run by Bee nodes. A viewer's browser then plays the stream
straight from Swarm, either through a Bee node that acts as a gateway or through a light Swarm node
running inside the browser tab. Once the segments are on Swarm, playback depends on no server of the
broadcaster's.

## The parts

| Part          | Folder                                            | What it does                                                                                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ingest engine | `apps/hls-stream/engines`                         | SRS (the default) or OvenMediaEngine. Takes SRT from the encoder and cuts it into HLS segments. With the ABR ladder on, it transcodes every quality rung.                                                                                                                      |
| Uploader      | `apps/hls-stream/packages/stream-uploader`        | Hears about every closed segment from the engine, stamps it and uploads it to Swarm, and keeps the playlists and feeds that tell a viewer where each segment is. Asks the admin which stream an encoder publishes to.                                                          |
| Bee nodes     | `apps/hls-stream/nodes`, `apps/hls-stream/deploy` | Swarm nodes. One uploader node per quality rung publishes that rung's segments, each with its own postage batch and chequebook. A gateway node serves viewers. A catalogue node holds the catalogue's batch alone.                                                             |
| Feeds         | written by the uploader                           | Swarm feeds are mutable pointers signed by one key. Each rung has a feed of its playlist, and a master feed names the rungs. Every stage signs its feeds with a key of its own. A viewer follows a feed, not a host.                                                           |
| Catalogue     | written by the admin                              | A feed signed with the brand key, which only the admin holds, that lists the streams of every stage, with their titles and thumbnails. Written through the dedicated catalogue node's immutable batch, which the manager designates.                                           |
| Viewer        | `apps/hls-stream/packages/client`                 | A browser player built on hls.js. Reads the catalogue and the feeds and fetches segments from a gateway or from an in-tab Swarm node.                                                                                                                                          |
| Manager       | `apps/infra-manager`                              | A console and an API that deploy stack versions onto hosts over ssh, hand out port slots, buy postage and fund chequebooks. Pushes every stage it runs, and the catalogue's batch, into the admin.                                                                             |
| Admin         | `apps/web2-admin`                                 | The brand console: streams, the stage each goes live on, and users. Publishes the catalogue. Learns its stages from the manager's pushes, and funds the node wallets from its brand wallet through the manager's funding API, its one call to the manager. Never calls a host. |
| Edge          | `infra/edge`                                      | One Caddy container per control host. Holds ports 80 and 443, gets the HTTPS certificates, and sends each domain to the console behind it.                                                                                                                                     |

A stage is a manager deployment that runs a stream uploader, with the node pool behind it.
[stages.md](stages.md) says what the manager pushes about each stage and how the admin uses it.

The stack can also run on its own, without the manager and the admin. Its README calls that
standalone mode: the uploader then writes the catalogue itself. With the admin it runs in admin mode,
which is the platform this page describes.

## How a stream travels

1. The encoder sends SRT to the ingest engine on a stage host.
2. The engine writes each closed segment to a media volume it shares with the uploader and calls the
   uploader's webhook. With the ladder on, it writes one segment per rung.
3. The uploader stamps each segment with its rung's postage batch and uploads it through that rung's
   own Bee node. It then rewrites the rung's playlist, uploads that, and moves the rung's feed to it.
4. The master feed names every rung that is publishing. A rung that stops is dropped from it, so a
   viewer is never sent to a quality that has died.
5. The viewer reads the catalogue to find a stream, follows its master feed, and plays the rung its
   bandwidth allows. Segments come from a Bee gateway over HTTP, or from a light node in the tab.

The manager and the admin are not on this path. A running broadcast carries on while either of
them is down. They decide what runs where and who owns which stream.

```
encoder --SRT--> ingest engine --webhook--> uploader --HTTP--> one Bee node per rung --> Swarm

viewer <--HTTP-- Bee gateway <-- Swarm
viewer <--light node in the tab-- Swarm
```

## Who reads what we publish

Besides the stack's own viewer, [stream-event-client](https://github.com/Solar-Punk-Ltd/stream-event-client)
reads what the platform writes to Swarm. It is a web app for watching an event's live streams and
recordings over Swarm, with a chat beside each stream, kept in its own public repository. It reads
the stream list (the catalogue) feed that its runtime `config.json` names, once a minute. For each
stream it reads the playlist feed of the one quality it plays and the segments that playlist names,
and the uploader's ladder time markers to find the newest slot. It builds the master playlist itself
from the catalogue's renditions and never reads the master feed. It imports no package of this
repository and no version pin ties it to the stack. It keeps its own copies of the catalogue format,
the feed following and the ladder marker layout in its `src/shared/`. So a change to the catalogue
format, the playlist feeds or the marker layout must land in stream-event-client's `src/shared/`
too.

## The three kinds of host

A host is a Linux machine with Docker on it. One machine can carry every role, or each role can have
machines of its own.

- **Control host**: the manager, the admin and the edge in front of them.
- **Stage host**: stack deployments, one per profile and port slot: the ingest engine, the uploader,
  the viewer page and a gateway node.
- **Bee host**: the Bee nodes of an ABR node pool, one per quality rung, which the uploaders on stage
  hosts publish through, and the brand's catalogue node, which the admin on the control host
  writes the catalogue through.

[The self-hosting guide](../self-hosting.md) says how to set up each one.

## Ports

### A stack deployment

Every stack deployment the manager creates takes a port slot `s`, from 1 to 99, and each of its
ports is `10000 + 10 × s` plus a fixed last digit, so two deployments on one host never collide.

| Port             | Protocol | What it is                                   | Reachable from                              |
| ---------------- | -------- | -------------------------------------------- | ------------------------------------------- |
| `10000 + 10 × s` | tcp      | the uploader's API and the engine's webhooks | the host itself only                        |
| `10001 + 10 × s` | udp      | SRT ingest                                   | the internet, so encoders can reach it      |
| `10002 + 10 × s` | tcp      | SRS's RTMP listener                          | the internet where the firewall opens it    |
| `10003 + 10 × s` | tcp      | the engine's HLS output                      | the host's Docker bridge, by default        |
| `10004 + 10 × s` | tcp      | the viewer page                              | the internet                                |
| `10005 + 10 × s` | tcp      | the uploader Bee node's API                  | never the internet, see below               |
| `10006 + 10 × s` | tcp      | the uploader Bee node's peer port            | the internet, so Swarm peers can dial it    |
| `10007 + 10 × s` | tcp      | the gateway Bee node's API                   | never the internet without a proxy in front |
| `10008 + 10 × s` | tcp      | the gateway Bee node's peer port             | the internet                                |
| `10009 + 10 × s` | tcp      | the engine's own HTTP API                    | the host's Docker bridge, by default        |

Every listen address is a setting. The Bee APIs and the engine's HTTP ports default to the host's
Docker bridge address, which the stack's deploy reads at deploy time, because Docker publishes a port
with rules of its own that a host firewall such as ufw never sees, and a Bee API has no password and
can spend money. A deployment on any host other than the manager's own is the exception for the Bee
APIs: the manager writes `0.0.0.0` into each Bee API bind its settings leave empty, so the manager
can dial it, and that host's firewall decides who reaches it. Ingest, the viewer and the peer ports default to every address, and which of them
the internet reaches is the operator's firewall.

An SRS stage takes RTMP beside SRT. The manager's console offers it, and the admin shows
broadcasters SRT only. SRS allows play from its own container only, because RTMP
publishing and playback share one port. RTMP is not encrypted. SRS 6 has no TLS on its RTMP
listener, so there is no RTMPS. A broadcaster's stream key crosses the network as readable text, and
a key read off the network publishes over RTMP whichever protocol it was read from, because SRT
sends its stream id, key included, before encryption starts. With the
takeover on, such a publisher can also replace a live broadcast. The SRT passphrase keeps the picture
private but not the key. A key of RTMP's own, separate from the SRT one, would close that last part,
and is not built. The manager's Publish card shows this warning beside RTMP.

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
| 9090    | the admin's console, with `/api/`          | the host's loopback only, reached through the edge |
| 22      | ssh                                        | your own address only                              |

The manager's API listens on 9876 inside its compose network and publishes nothing. The manager's
Postgres and the admin's database publish nothing either. Only the manager's development compose,
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
its chequebook. The manager holds no wallet of its own: it shows each node's address, and funds
reach that address in one of two ways. The operator sends them from any wallet, as
[the self-hosting guide](../self-hosting.md#funding-and-stamping-your-bee-nodes) describes, or the
brand sends them from the admin's brand wallet, through the manager's funding API, as
[funding.md](funding.md) describes.
