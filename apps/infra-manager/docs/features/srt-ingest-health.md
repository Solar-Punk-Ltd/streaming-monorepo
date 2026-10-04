# Ingest health: how the broadcast coming into SRS is holding up

A stream deployment takes its broadcast in over SRT or RTMP. SRT sends a
missing packet again, and gives up on it once it could only arrive later than
the latency the link runs with. A packet SRT gave up on is a hole in the video,
and it shows as broken blocks of picture until the next keyframe. The
**Ingest** card on a deployment's page says, for the last minute, how many SRT
packets arrived, how many went missing, how many came on a second try and how
many were given up on, and what to change when the link is losing picture. For
RTMP it says how many publishers SRS reported and the bitrate it received from
them.

RTMP part, 2026-10-03: built on `feat/rtmp-ingest-manager` beside RTMP ingest
opening to broadcasters. It reads a line that images of the stack's SRS fork
print from `6.0-r2-swarm.3`, which no deployment runs yet, so it has been run
against fixture lines and a stand-in `docker` only. Below, "The RTMP part" says
what it reads and why.

Status, 2026-09-25. Merged to `main` through PR 45. It was built on
`feat/srt-ingest-health`, branched from `main` at `87673c99` on 2026-09-23 and
written at `2cf0b1eb` on that branch, with the stack pinned at `v3.1`
(`2c4867ae`). Not deployed, and never run against a live SRS.
The parser is tested on the lines of 2026-09-22 and the reads against a
stand-in Docker. The whole read was also run against this laptop's Docker 29.8
daemon, through a throwaway container printing those two lines in colour codes
beside the webhook line with a token, the publisher's address and forty drop
warnings a second: sixteen reports summed, a bad verdict, 252 ms, and no token,
address or connection id in the answer. That run found the window ending up to
a second in the past, which `2cfcfc79` fixed. The first look at a live host is
still the check that SRS 6 writes the line in this shape there. The SRT latency
setting the remedy points at came with PR 44, which reached `main` on
2026-09-24, before this one. PR 45 was revised on 2026-09-23 for three points of
its code review: the card on a stopped deployment, a bad minute with nothing
received, and a latency the remedy named that some deployments do not run with.

## Why it exists

On 2026-09-22 an outside tester broadcast over SRT into a manager-deployed SRS
and the recording came out with broken blocks of picture for five hours. OBS,
the manager and the uploader all looked healthy. The reason was only in SRS's
own log, which said every ten seconds that about six percent of the packets had
been dropped:

```
[2026-09-22 17:33:50.386][INFO][1][4ek6chsn] <- SRT_CPB Transport Stats # pktRecv=6500, pktRcvLoss=394, pktRcvRetrans=381, pktRcvDrop=397
[2026-09-22 17:34:00.410][INFO][1][4ek6chsn] <- SRT_CPB Transport Stats # pktRecv=6457, pktRcvLoss=367, pktRcvRetrans=350, pktRcvDrop=366
```

## Where the numbers come from

SRS prints that line for each SRT publisher at its print interval, ten seconds
unless `pithy_print_ms` says otherwise, which the stack's template does not. It
clears libsrt's counters as it reads them, so each line counts its own interval
only (`do_publishing` in SRS's `srs_app_srt_conn.cpp`). The bracket before the
message is SRS's id for the connection. The line is printed only while packets
arrive, so a publisher that stopped sending prints nothing. The four counts, as
libsrt's statistics define them:

- `pktRecv`, data packets received.
- `pktRcvLoss`, packets detected missing.
- `pktRcvRetrans`, retransmitted packets received.
- `pktRcvDrop`, packets the receiver gave up on and never delivered, which is
  what becomes a hole in the video.

SRS's HTTP API does not expose these counters (SRS issue 4554), so the log is
the only source there is.

## The RTMP part

SRS prints a line for each RTMP publisher at the same interval:

```
[2026-10-03 17:43:50.386][INFO][1][9tq3vz71] <- CPB time=40021, okbps=0,0,0, ikbps=0,4812,0, mr=0/350, p1stpt=20000, pnt=5000, vhost=__defaultVhost__
```

The ABR ladder's rungs are RTMP publishers too: SRS republishes each rung from
its own host onto a vhost of the rungs' own, `abr` unless `ABR_VHOST` says
otherwise. So a count of RTMP publishers counts the rungs, and only the vhost
tells a broadcaster from them. Every other line that names a publisher's vhost
also carries the stream key, the tcUrl or the publisher's address, and is
printed once, when the publisher connects. Images of the stack's SRS fork from
`6.0-r2-swarm.3` end the periodic line with the vhost the publisher is on,
which is the configured vhost's name: `__defaultVhost__` for a broadcaster on
the stack's template, whatever host it dialled. Older images end the line at
`pnt`.

- **Only the ingest vhost counts.** Reports on `__defaultVhost__` are the
  broadcasters. Reports on any other vhost are left out.
- **The bitrate is the 30-second average.** Of the three `ikbps` numbers, the
  first is meant to be the average since the connection began, but SRS never
  sets the start it divides by, so it reads as zero. The second is the average
  over SRS's last 30-second sample, and the third over its last 5-minute one.
  The second stays zero until SRS has sampled 30 seconds of a connection, about
  40 seconds in at the ten second interval, so a zero there means "not measured
  yet". SRS drops a publisher that sends nothing for seconds, so a real
  30-second average of zero does not happen.
- **A connection that ended is not counted in the bitrate.** A connection whose
  last report comes before another connection's first had ended by then: a
  publisher that reconnected, or one broadcaster after another. Its last
  bitrate is left out. Connections that send at once report in turn, so each
  is counted, by the bitrate in its latest report.
- **An engine that names no vhost is said to be one.** When the window holds
  RTMP reports and none of them names its vhost, the reading is `unattributed`,
  and the card says RTMP ingest is not measured on this engine version rather
  than counting the rungs. Once any report names its vhost, the engine is one
  that does, and an older line left in the window from before an upgrade says
  nothing more.

What comes out is the number of reports and connections on the ingest vhost
and the bitrate. The connection ids, the vhost names and every other part of
the line stay in the manager (`manager/src/domain/ingestHealth/rtmpPublishReport.ts`
and `rtmpIngestReading.ts`).

## What the manager reads, and what it never hands on

`GET /profiles/:name/ingest-health`, behind the session, one deployment at a time.
`manager/src/domain/ingestHealth/IngestHealthService.ts` does the reading. The
answer's SRT part is under `srt`, and the states that say no log was read, SRS
not running, a log that could not be read and an engine that is not SRS, belong
to the answer as a whole (`common/src/ingestHealth.ts`).

- **The window.** The last 60 seconds of the `srs` container's log, and of those
  at most the last 20,000 lines (`INGEST_LOG_WINDOW`). Under loss libsrt
  writes a line per dropped packet into the same log, `RCV-DROPPED 1 packet(s).
Packet seqno %861816580 delayed for 4.5 ms`, about forty a second on
  2026-09-22, so a read that asked for the whole log would grow by megabytes a
  minute. The daemon applies the window before it sends anything, and both of
  its ends carry milliseconds, since a whole second put `until` behind the
  present and cut the newest lines. The local read also stops at 16 MiB, half a
  second after the last byte, or five seconds in, whichever comes first. Against
  the local daemon a window with lines in it answered in 30 to 260 ms, and one
  with no line at all took the five seconds, 5,048 ms, since nothing arrives to
  end it.
- **The channel.** A deployment on the manager's own host is read through the
  Docker socket the Logs button reads through,
  `ContainerControl.logLinesContaining`. One on another host is read over the
  ssh path `TargetDocker` already takes for its snapshots and published ports,
  and there `grep -E` holds each line to one report's whole shape, SRT's or
  RTMP's, from start to end with colour codes allowed, on the remote host
  (`INGEST_LOG_LINES` in `manager/src/domain/ingestHealth/IngestHealthService.ts`,
  which joins `TRANSPORT_STATS_HOST_PATTERN` and `RTMP_PUBLISH_HOST_PATTERN`, and
  the command in `manager/src/domain/ports/remoteLogLines.ts`).
  So no other line of the log crosses the connection, not even a hook line
  whose publisher chose a stream id or a stream name that quotes a report. A filter on the
  marker text alone let such a line through, token and all, until the code
  review of PR 45 found it. That command frames its answer, because a pipeline
  into grep reports grep's status alone and would make no container, a quiet
  window and a failed read look the same.
- **The filter.** Only lines carrying `CPB `, the tag SRS gives a publisher's
  report in both shapes, `SRT_CPB` and `CPB`, leave the reader. On a remote host
  the pattern is the two whole-line shapes joined, so a line crosses only when
  it is one report or the other from start to end. A last line the read cut
  short is dropped, since a count cut after two of its digits still parses, and
  a line is parsed only when it has one report's exact shape from start to end,
  colour codes aside (`transportStatsLine.ts` and `rtmpPublishReport.ts` in
  `manager/src/domain/ingestHealth/`, on the frame in `srsLogLine.ts`).
- **The answer is numbers and states.** SRS writes its webhook URL, with the
  uploader's token in it, into every hook line of the same log, the publisher's
  address into others, and an RTMP publisher's stream key into its identify
  line. None of the log's text is returned, stored, logged or rendered. A failed
  read is logged as the kind of failure, such as `DockerUnavailableError` or
  `ENOENT`, and never with its message.

The SRT reports in the window are summed into one reading, across connections
too, since a publisher that dropped out and came back is the same link.

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

`percent` is each count as a share of `received`, and `null` when nothing was
received rather than a division by zero. The verdict is `healthy` when nothing
was dropped, `degraded` when something was, and `bad` when the dropped packets
reached one percent of those received (`SRT_BAD_DROP_PERCENT`), or when packets
were dropped and none arrived. The card then says SRS gave up on packets and
received none, since it has no share to quote. Loss that a
retransmission recovered in time is healthy, because it never reached the
picture. The rule and the shape live in `common/src/srtIngestHealth.ts`, which
the manager, the page and the offline mock all read.

## What the operator sees

The **Ingest** card sits directly under Readiness on the page of every
deployment whose media server is SRS, while the deployment is running and its
`srs` container is reported. The manager keeps a stopped deployment's container
records, so those alone do not bring the card back, and a stopped deployment is
not asked at all. It
asks again every ten seconds while the page is open, which is also about how
often SRS prints a report, and a new ask waits for the last one to answer. A
failed ask clears the last reading rather than leaving it on screen.

- The pill leads with the SRT link's verdict while SRT is measured, `Healthy`,
  `Degraded` or `Bad`, since that is the one quality SRS reports. Otherwise it
  says `Receiving over RTMP` for an RTMP broadcast, `RTMP not measured` on an
  engine that names no vhost, or `No publisher`. With nothing read it says
  `SRS not running`, `Not read` or `Reading`.
- An SRT part, while SRT is measured, says how many reports it came from and
  over how many connections, then the packets received and the share and count
  of each of the other three, each with a line saying what it means. A count of
  zero reads `none`.
- An RTMP part, while SRS reported RTMP publishers, says how many reports and
  connections on the ingest vhost, that the ladder's rungs are not counted, and
  the incoming bitrate in kbps, or `Not measured yet` for a connection that
  began moments ago. On an engine that names no vhost it says why RTMP ingest
  is not measured there instead.
- A broadcast over RTMP alone shows the RTMP part and no SRT part, so it never
  reads as a missing or broken SRT link.
- A minute with no publisher at all says so in one sentence. It never shows a
  row of zeros, which would read as a healthy link.
- A degraded or bad link carries the remedy, as a warning or an error: the
  broadcaster's connection is losing packets and some arrive too late to use, so
  the picture breaks up. Raise the SRT latency of this deployment, to 4000 ms
  for example. Or add `&latency=4000000` to the end of the SRT address in OBS,
  which counts microseconds, so that is 4 seconds, and since SRT uses the larger
  of the two sides this only helps when it is above the latency the deployment
  runs with. The card names no number for that latency, because it cannot see
  it: the manager writes 2000 ms, and SRS on v3.1 waits its own 120 on ingest
  whatever is set. Lower the bitrate OBS broadcasts at. Use a wired connection
  instead of WiFi.

The latency step reads the deployment's engine settings. When they list
`SRT_LATENCY`, as an SRS deployment's do since PR 44, the step says to raise it
in the deployment's stack settings and carries a **Change SRT latency** button,
which brings the Stack settings card into view at that setting, focused. It
opened the Engine card's settings drawer until the drawer went on 2026-09-26.
When they do not list it, the step says that the change in OBS does the same
from the broadcaster's side.

## What it does not do

It gates nothing and changes nothing. No deploy, start, health check, readiness
step or "Needs attention" count reads it, and it never touches a setting or a
broadcast. RTMP runs over TCP, which resends what it loses, so SRS reports no
loss for it and the RTMP part has no verdict: a link that cannot keep up shows
as a bitrate below what the encoder sends.

## Limits

These are low priority: rare, with no damage path, and recorded here once.

- **A crafted stream id can put fake numbers on the card.** A publisher chooses
  its SRT stream id and SRS quotes it into its log. An id carrying a newline and
  then a line in the exact report shape would be counted as a report. The cost
  is wrong numbers on an observational card, never a leak or a change, and on a
  deployment with an SRT passphrase the publisher needs it to connect at all. An
  RTMP connection can write the same line with no key, as the last limit says.
  `manager/test/unit/srtTransportStats.test.ts` shows the same text refused
  anywhere but at the start of a line, which is the part the parser can hold.
- **A read that reaches its byte or time bound keeps the older part of the
  minute.** The daemon sends the window oldest first. Not reachable with 20,000
  lines of the lengths SRS and libsrt write.
- **The reading does not say how old its newest report is.** A publisher that
  left fifty seconds ago still shows the minute it was sending.
- **A remote answer larger than 64 KiB reads as unreadable.** The remote read
  goes through the same bounded command runner as every other remote read,
  whose output stops at 64 KiB. That is about 460 report lines, six a minute for
  each SRT publisher, so it takes more than seventy publishers on one SRS in a
  single minute. Raised in the review of PR 45 and recorded rather than fixed,
  because widening the bound changes the runner every remote read shares.
- **The suggested 4000 ms is a fixed number.** It is twice the manager's default
  and well above the 120 ms SRS waits on ingest on `v3.1`, whose template fills
  only `latency`. A deployment an operator has already set above 4000 ms gets a
  suggestion that changes nothing.
- **An RTMP publisher that stopped beside another still sending keeps its
  bitrate in the sum for up to a minute.** The rule that leaves out a
  connection that ended reads the order of the reports, and two publishers
  sending at once report in turn, so one that stops is told from one that goes
  on only once its reports leave the window. It takes two RTMP broadcasts on one
  stage at once, and costs a number that is high for under a minute.
- **A crafted RTMP connection can put fake numbers and a fake state on the card,
  with no key.** SRS strips line breaks from an RTMP publisher's stream name, but
  it prints the tcUrl, pageUrl and swfUrl of the connect command, and the
  `param` that carries the key, as they came, before any hook runs (the "connect
  app" and "client identified" lines in SRS's `srs_app_rtmp_conn.cpp`, and the
  "Ignore parse url" warning for a tcUrl it cannot parse). One of them carrying
  a newline and then a line in the exact report shape is counted as a report,
  and it is in the log before any key is checked, so one TCP connection to the
  public RTMP port does it. What it can forge is numbers and states: the RTMP
  part `measured` with any counts and bitrate, or `unattributed`, and the same
  carrier can write an SRT report too, so the SRT counts and verdict as well. It
  can forge no text, and no other line's content reaches the card, because a
  line is read only when it is one report from start to end. The cost is wrong
  numbers on an observational card, never a leak or a change.

## Tests

- `common/src/srtIngestHealth.test.ts`: the verdict at nothing dropped, at one
  packet, just under and exactly at one percent, and at zero packets received,
  and shares that are null rather than a division by zero.
- `manager/test/unit/rtmpPublishReport.test.ts`: the RTMP parser on a
  broadcaster's line, a rung's line and an older engine's line without the
  vhost, through colour codes, and refusing the play side, an SRT report, every
  line around them that carries a key, a token or an address, the report text
  quoted inside another line, anything after the vhost, a line cut short and a
  number too long or negative. The same cases go through a real `grep -E` with
  the RTMP host pattern.
- `manager/test/unit/srtTransportStats.test.ts`: the parser on the real lines,
  through colour codes, several connections, a line cut in half, the viewer
  side's own statistics, libsrt's drop warnings, a count too long to be exact,
  and the report text quoted inside another line, anchored so each case fails
  when its guard is removed. The same cases also go through a real `grep -E`
  with the host pattern, which has to keep exactly the lines the parser reads.
- `manager/test/unit/containerControl.test.ts`: the local read asks for the
  window alone, with both ends in milliseconds, keeps only marked lines from
  both streams, drops a cut last line, and stops at its byte bound.
- `manager/test/unit/remoteLogLines.test.ts`: the remote command, refused for a
  name or pattern that could leave its quotes, and run by a real POSIX shell
  against a stand-in `docker` for no container, two containers, an empty window,
  a log without a final newline, a failed read, and hook lines whose stream id
  quotes the report, with and without a line break, which stay on the host
  while a report in colour codes crosses, and the ingest's own read, where both
  report shapes cross and no RTMP line with a key or a token does. Run by hand
  under dash, the macOS sh and zsh as well, before the pattern replaced the
  marker.
- `manager/test/unit/ingestHealth.test.ts`: the service's states, the RTMP part
  leaving the rungs out, an RTMP broadcast as no SRT publisher rather than a
  broken link, an engine that names no vhost, a reconnect, two publishers at
  once, a bitrate not sampled yet, the joined host pattern through a real
  `grep -E`, and a log holding the webhook token, the publisher's address and a
  stream key beside the reports, after which neither the reading nor anything
  logged carries any of it, the failure path included.
- `manager/test/unit/ingestHealthRoute.test.ts`: the route answers the reading
  whole, needs a session, refuses a bad name and answers 404 for a missing one.
- `frontend/src/deployments/ingestHealthText.test.ts`: the pill and the card's
  own sentence in every state, an RTMP broadcast never reading as a missing or
  broken SRT link, and no em dash or semicolon anywhere on the card.
- `frontend/src/deployments/srtIngestText.test.ts`: the SRT part's words for
  every verdict, a bad minute with nothing received, and the remedy's steps
  naming no latency the deployment is said to run with.
- `frontend/src/deployments/rtmpIngestText.test.ts`: the RTMP part's words, a
  bitrate not measured yet, and an engine that names no vhost.
- `frontend/src/deployments/shape.test.ts`: the card is asked for only while an
  SRS deployment runs, not for a stopped or failed one that keeps its records.
- `frontend/test/ingest-health-browser.test.mjs`: the card in a real Chrome, bad
  with its remedy, on a phone, healthy, an RTMP broadcast, an engine that names
  no vhost, with no publisher, the latency button
  landing on the SRT latency in the Stack settings card, focused, no card and
  no request without SRS, and none for a
  stopped deployment that still carries its SRS records.
- `frontend/test/mock-ingest-health-http.test.mjs`: the offline mock answers the
  route in the manager's shape and keeps the state a reviewer picked.

`pnpm --filter @streaming-infra-manager/frontend-prototype dev:mock` serves the
card offline. `GET /profiles/<name>/ingest-health?state=bad` picks what a
deployment shows for SRT, and it sticks: `healthy`, `recovered`, `degraded`,
`bad`, `no_reports` or `unreadable`. `?rtmp=` picks the RTMP part the same way:
`no_reports`, `measured`, `measuring` or `unattributed`. `?state=no_reports&rtmp=measured`
is a broadcast over RTMP alone.
