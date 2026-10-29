# Ingest health

This is a feature page of the manager (`apps/infra-manager`), the web console and API that deploys
the streaming stack (`apps/hls-stream`) onto hosts. It describes the **Ingest** card: how the
broadcast coming into SRS, the stack's media server, held up over the last minute.

## What it does

A stream deployment takes its broadcast in over SRT or RTMP. SRT resends a missing packet, and
gives up on it once it could only arrive later than the latency the link runs with. A packet SRT
gave up on is a hole in the video, which shows as broken blocks of picture until the next
keyframe. Nothing else in the chain shows this: the broadcaster's encoder, the manager and the
uploader all look healthy. Only SRS's own log says it.

The **Ingest** card reads that log. For SRT it says how many packets arrived in the last minute,
how many went missing, how many came on a second try and how many were given up on, and what to
change when the link is losing picture. For RTMP it says how many publishers SRS reported and the
bitrate it received from them.

The card is observational. No deploy, start, health check, readiness step or **Needs attention**
count reads it, and it never changes a setting or a broadcast.

### Where the numbers come from

SRS prints a report line for each SRT publisher at its print interval, ten seconds unless
`pithy_print_ms` says otherwise, which the stack's template does not:

```
[2026-01-01 17:33:50.386][INFO][1][4ek6chsn] <- SRT_CPB Transport Stats # pktRecv=6500, pktRcvLoss=394, pktRcvRetrans=381, pktRcvDrop=397
```

SRS clears libsrt's counters as it reads them, so each line counts its own interval only. The
bracket before the message is SRS's id for the connection. The line is printed only while packets
arrive, so a publisher that stopped sending prints nothing. The four counts, as libsrt defines
them:

- `pktRecv`, data packets received.
- `pktRcvLoss`, packets detected missing.
- `pktRcvRetrans`, retransmitted packets received.
- `pktRcvDrop`, packets the receiver gave up on and never delivered. These become holes in the
  video.

SRS's HTTP API does not expose these counters, so the log is the only source.

### The RTMP part

SRS prints a line for each RTMP publisher at the same interval:

```
[2026-01-01 17:43:50.386][INFO][1][9tq3vz71] <- CPB time=40021, okbps=0,0,0, ikbps=0,4812,0, mr=0/350, p1stpt=20000, pnt=5000, vhost=__defaultVhost__
```

The ABR ladder's rungs are RTMP publishers too: SRS republishes each rung onto a vhost of the
rungs' own, `abr` unless the stack key `ABR_VHOST` says otherwise. Only the vhost tells a
broadcaster from a rung. The stack's SRS image (`swarm-srs`, `6.0-r2-swarm.3` and later, pinned
in `engines/srs/docker-compose.yml` and `deploy/docker-compose.yml` of `apps/hls-stream`) ends the
line with the publisher's vhost: `__defaultVhost__` for a broadcaster on the stack's template.
Older images end the line at `pnt`.

- Only reports on `__defaultVhost__`, the ingest vhost, count. Reports on any other vhost are
  left out.
- The bitrate is the 30-second average, the second of the three `ikbps` numbers. The first is
  meant to be the average since the connection began, but SRS never sets the start it divides by,
  so it reads zero. The third is the 5-minute average. The second stays zero until SRS has sampled
  30 seconds of a connection, about 40 seconds in, so zero there means not measured yet. SRS drops
  a publisher that sends nothing for seconds, so a real 30-second average of zero does not happen.
- A connection whose last report comes before another connection's first had ended by then, a
  reconnect or one broadcaster after another, and its bitrate is left out. Connections that send
  at once report in turn, so each counts, by the bitrate in its latest report.
- When the window holds RTMP reports and none names its vhost, the reading is `unattributed` and
  the card says RTMP ingest is not measured on this engine version, rather than counting the
  rungs. Once any report names its vhost, an older line still in the window is ignored.

What leaves the reader is the number of reports and connections on the ingest vhost and the
bitrate (`manager/src/domain/ingestHealth/rtmpPublishReport.ts` and `rtmpIngestReading.ts`).
Connection ids, vhost names and the rest of the line stay in the manager.

### How the manager reads the log

`IngestHealthService` (`manager/src/domain/ingestHealth/IngestHealthService.ts`) reads one
deployment at a time.

- **The window.** The last 60 seconds of the `srs` container's log, and of those at most the last
  20,000 lines (`INGEST_LOG_WINDOW`). Under loss libsrt writes a line per dropped packet into the
  same log, so a read of the whole log would grow by megabytes a minute. Docker applies the window
  before it sends anything, with both ends in milliseconds so the newest lines are not cut. The
  local read also stops at 16 MiB, half a second after the last byte, or five seconds in,
  whichever comes first (`DEFAULT_FILTERED_LOG_BOUNDS` in `manager/src/domain/ContainerControl.ts`).
  A window with no line at all therefore takes the full five seconds.
- **The channel.** A deployment on the manager's own host is read through the Docker socket,
  `ContainerControl.logLinesContaining`. One on another host is read over ssh, and there
  `grep -E` keeps only lines that are one whole report, SRT's or RTMP's, from start to end with
  colour codes allowed, on the remote host (`INGEST_LOG_LINES`, which joins
  `TRANSPORT_STATS_HOST_PATTERN` and `RTMP_PUBLISH_HOST_PATTERN`, and the command in
  `manager/src/domain/ports/remoteLogLines.ts`). No other line of the log crosses the connection,
  not even a hook line whose stream id quotes a report. The command frames its answer, so no
  container, a quiet window and a failed read stay distinct.
- **The filter.** Only lines carrying `CPB `, the tag SRS gives a publisher's report in both
  shapes, leave the reader. A last line the read cut short is dropped, since a count cut after two
  of its digits still parses. A line is parsed only when it has one report's exact shape from
  start to end, colour codes aside (`transportStatsLine.ts`, `rtmpPublishReport.ts` and
  `srsLogLine.ts` in `manager/src/domain/ingestHealth/`).
- **Numbers and states only.** The same log holds the webhook URL with the uploader's token in
  every hook line, the publisher's address, and an RTMP publisher's stream key. None of the log's
  text is returned, stored, logged or rendered. A failed read is logged as the kind of failure,
  such as `DockerUnavailableError` or `ENOENT`, never with its message.

A crafted SRT stream id can put fake numbers on the card. A publisher chooses its stream id and SRS
quotes it into its log, so an id carrying a newline and then a line in the exact report shape is
counted as a report. On a deployment with an SRT passphrase the publisher needs the passphrase to
connect at all.

A crafted RTMP connection can put fake numbers and a fake state on the card, with no key. SRS prints
the tcUrl, pageUrl, swfUrl and key parameter of the connect command as they came, before any hook
runs, so one TCP connection to the public RTMP port can write a line in report shape. It can forge
the RTMP part, `measured` with any numbers or `unattributed`, and the SRT counts and verdict. It
cannot forge text, since a line is read only when it is one whole report.

A read that reaches its byte or time bound keeps the older part of the minute, because Docker sends
the window oldest first. 20,000 lines of the lengths SRS and libsrt write do not reach it.

A remote answer larger than 64 KiB reads as `unreadable`. Every remote read goes through the same
command runner, whose output stops at 64 KiB (`manager/src/domain/ports/TargetDocker.ts`). That is
about 460 report lines, more than seventy publishers on one SRS in one minute.

### The reading

The SRT reports in the window are summed into one reading, across connections too, since a
publisher that dropped out and came back is the same link.

| `state`       | When                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `read`        | The log was read. The answer carries `windowSeconds`, the SRT part `srt` and the RTMP part `rtmp` |
| `not_running` | No `srs` container is running for the deployment                                                  |
| `unreadable`  | The log could not be read. Says nothing about the broadcast                                       |
| `not_srs`     | The deployment's media server is not SRS                                                          |

| Part   | `state`        | When                                                                                                                                                  |
| ------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `srt`  | `measured`     | SRS printed at least one SRT report. It carries `reports`, `connections`, `counts`, `percent` and `verdict`                                           |
| `srt`  | `no_reports`   | SRS printed no SRT report                                                                                                                             |
| `rtmp` | `measured`     | SRS reported RTMP publishers on the ingest vhost. It carries `reports`, `connections` and `incomingKbps`, null while none has a 30-second average yet |
| `rtmp` | `no_reports`   | SRS reported no RTMP publisher on the ingest vhost                                                                                                    |
| `rtmp` | `unattributed` | SRS reported RTMP publishers without naming their vhost, as images before `6.0-r2-swarm.3` do                                                         |

`percent` is each count as a share of `received`, and null when nothing was received. The
verdict (`common/src/srtIngestHealth.ts`, which the manager, the page and the offline mock all
read):

- `healthy` when nothing was dropped. Loss that a resend recovered in time never reached the
  picture.
- `degraded` when something was dropped.
- `bad` when the dropped packets reached 1% of those received (`SRT_BAD_DROP_PERCENT`), or when
  packets were dropped and none arrived.

RTMP runs over TCP, which resends what it loses, so SRS reports no loss for it and the RTMP part
has no verdict. A link that cannot keep up shows as a bitrate below what the encoder sends.

The reading does not say how old its newest report is. A publisher that left fifty seconds ago still
shows the minute it was sending.

An RTMP publisher that stopped beside another still sending keeps its bitrate in the sum for up to a
minute, until its reports leave the window. It takes two RTMP broadcasts on one stage at once.

## How to use it in the console

The **Ingest** card sits under Readiness on the page of every deployment whose media server is
SRS, while the deployment runs and its `srs` container is reported. A stopped deployment is not
asked, even though the manager keeps its container records. The page asks every 10 seconds
(`NODE_REFRESH_INTERVAL_MS`), about as often as SRS prints a report, and a new ask waits for the
last one to answer. A failed ask clears the last reading.

- The pill leads with the SRT verdict while SRT is measured: `Healthy`, `Degraded` or `Bad`.
  Otherwise it says `Receiving over RTMP`, `RTMP not measured` on an engine that names no vhost,
  or `No publisher`. With nothing read it says `SRS not running`, `Not read` or `Reading`.
- The SRT part says how many reports it came from and over how many connections, then the packets
  received and the share and count of each of the other three, each with a line on what it means.
  A count of zero reads `none`.
- The RTMP part says how many reports and connections on the ingest vhost, that the ladder's rungs
  are not counted, and the incoming bitrate in kbps, or `Not measured yet` for a connection that
  began moments ago.
- A broadcast over RTMP alone shows the RTMP part and no SRT part, so it never reads as a missing
  or broken SRT link.
- A minute with no publisher says so in one sentence, never as a row of zeros.

A degraded or bad SRT link carries the remedy, as a warning or an error:

1. Raise the SRT latency of this deployment, to 4000 ms for example. When the deployment's engine
   settings list `SRT_LATENCY`, the step has a **Change SRT latency** button that brings the Stack
   settings card into view at that setting, focused. When they do not, the step says the change
   in OBS does the same from the broadcaster's side.
2. Or add `&latency=4000000` to the end of the SRT address in OBS. OBS counts microseconds, so
   that is 4 seconds. SRT uses the larger of the two sides' latencies, so this only helps when it
   is above the deployment's own.
3. Lower the bitrate OBS broadcasts at.
4. Use a wired connection instead of WiFi.

The suggested 4000 ms is twice the manager's default `SRT_LATENCY` of 2000 ms. The card names no
current latency, because it cannot see the one SRS runs with.

The suggested 4000 ms is a fixed number. A deployment already set above it gets a suggestion that
changes nothing.

### Offline preview

`pnpm --filter @streaming-infra-manager/frontend-prototype dev:mock` serves the console against an
offline mock manager (`frontend/dev/mock-ingest-health.mjs`).
`GET /profiles/<name>/ingest-health?state=bad` picks the SRT part a deployment shows, and it sticks:
`healthy`, `recovered`, `degraded`, `bad`, `no_reports` or `unreadable`. `?rtmp=` picks the RTMP
part the same way: `no_reports`, `measured`, `measuring` or `unattributed`.
`?state=no_reports&rtmp=measured` is a broadcast over RTMP alone.

## Settings and routes

| Method | Path                            | Body | Answer                                                                     |
| ------ | ------------------------------- | ---- | -------------------------------------------------------------------------- |
| GET    | `/profiles/:name/ingest-health` | none | `{ state, windowSeconds, srt?, rtmp? }`, as in [The reading](#the-reading) |

The route needs a session, refuses a malformed name and answers 404 for an unknown deployment.
The full reference is [../../manager/README.md](../../manager/README.md).

Stack keys the card depends on:

| Key           | What it does here                                                            |
| ------------- | ---------------------------------------------------------------------------- |
| `SRT_LATENCY` | The SRT latency SRS runs with, the setting the remedy's first step leads to  |
| `ABR_VHOST`   | The vhost the ABR rungs publish on, left out of the RTMP part. Default `abr` |
