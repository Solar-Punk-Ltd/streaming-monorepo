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
| Ingest engine | `apps/hls-stream/engines`                         | SRS (the default) or OvenMediaEngine. SRS takes SRT or RTMP from the encoder, OvenMediaEngine SRT alone, and cuts it into HLS segments. With the ABR ladder on, it transcodes every quality rung.                                    |
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

1. The encoder sends SRT to the ingest engine on a stage host. SRS can take RTMP as well, but the
   manager keeps RTMP closed by default, as the port table below says.
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
encoder --SRT/RTMP--> ingest engine --webhook--> uploader --HTTP--> one Bee node per rung --> Swarm

viewer <--HTTP-- Bee gateway <-- Swarm
viewer <--light node in the tab-- Swarm
```

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
| `10002 + 10 × s` | tcp      | RTMP ingest                                  | closed by default, see below                    |
| `10003 + 10 × s` | tcp      | the engine's HLS output                      | the host itself only                            |
| `10004 + 10 × s` | tcp      | the viewer page                              | the internet                                    |
| `10005 + 10 × s` | tcp      | the uploader Bee node's API                  | **never the internet**, see below               |
| `10006 + 10 × s` | tcp      | the uploader Bee node's peer port            | the internet, so Swarm peers can dial it        |
| `10007 + 10 × s` | tcp      | the gateway Bee node's API                   | **never the internet** without a proxy in front |
| `10008 + 10 × s` | tcp      | the gateway Bee node's peer port             | the internet                                    |
| `10009 + 10 × s` | tcp      | the engine's own HTTP API                    | the host itself only                            |

RTMP ingest is closed by default, so SRT is the one public ingest. SRS still listens for RTMP, because
the ABR ladder republishes every rung to that listener over loopback, but the firewall keeps the port
shut from outside. RTMP is plain RTMP and is not encrypted. While it is open, a broadcaster's stream
key crosses the network as readable text, anyone who reads it there can publish to that stream, and
with the takeover on they can replace a live broadcast. SRT does not hide the key either, because it
sends its stream id before encryption starts, so open RTMP makes the SRT passphrase no gate. And SRS
lets anyone who reaches its RTMP port play any stream unless the stack's loopback-only play rule runs,
which needs image `6.0-r2-swarm.3`. See the RTMP section of [ROADMAP.md](../ROADMAP.md).

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
| 5432    | the manager's Postgres                     | the host's loopback only                           |
| 22      | ssh                                        | your own address only                              |

The manager's API listens on 9876 inside its compose network and publishes nothing. The web2 admin's
database publishes nothing either.

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
them, so binding a port to a private address is the control and a firewall is the second layer. The
manager generates an nftables table from its own record of a host that opens exactly the public
ports above and closes the rest of the band. "Opening the manager to the internet" in
`apps/infra-manager/deploy/README.md` shows both steps.

## Where the money goes

Swarm charges for storage with postage batches bought in xBZZ, and for bandwidth through
chequebooks between Bee nodes. Each uploader Bee node needs xDAI for gas and xBZZ for its batch and
its chequebook. The manager shows each node's address and never holds a wallet of its own: whoever
runs the deployment sends the funds to that address. [The self-hosting guide](../self-hosting.md)
has the commands.
