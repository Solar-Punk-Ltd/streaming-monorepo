# How the stream uploader publishes

This page explains how the stream uploader turns segments into playlists a viewer can follow on Swarm,
and why each part is shaped the way it is. It is the concepts page beside the uploader's
[README](README.md), which holds the settings, routes, health states and metrics.

Terms used throughout:

- A **feed** is a numbered series of single owner chunks at addresses derived from a signing key and a
  topic. Each playlist the uploader publishes goes into the next slot (index) of a feed.
- A **rung** is one quality of an ABR ladder, such as 720p. Each rung is a stream of its own with its
  own feed.
- The **master** is the multivariant playlist that names a ladder's rungs.
- The **catalogue** is the stream list, a feed that says which streams exist and their state.
- A **session** is one run of the uploader publishing one stream, from its announce to its stop.

## One Bee node per rung

A feed's address depends only on its signing key and topic, and bee-js signs each chunk locally
before it posts it. So a Bee node owns nothing here. It is a pipe with a wallet, and `BeePublisherPool`
decides which pipe carries which rung.

`BEE_PUBLISHERS` splits the rungs across nodes. Unset, one node serves everything. Postage batches
drain in proportion to bitrate, and 1080p spends roughly seven times the bytes of 360p, so equal
batches expire hours apart. With a node and a batch per rung, a batch running out means one rung goes
quiet and players step down, not that the stage stops.

All rungs still sign with one key, so all have one owner. Rung feeds differ only by topic, and moving
a feed to another node changes nothing a viewer sees.

The catalogue and every master are written through the lowest rung's node, called the coordinator.
Its batch outlives the others by the same factor of about seven, and those two feeds are all a viewer
needs to open a stage.

## The ABR ladder

With `ABR_ENABLED=true` the engine publishes one stream per rung. Each gets its own `StreamUploader`
and its own playlist feed. The feed's topic is derived from the ladder's group id and the rung's name
(`src/utils/rungTopic.ts`, a version-5 UUID), so a rung's feed outlives any one session. A rung that
restarts in the middle of a broadcast comes back onto the feed the master already names, reads its
head, and numbers its playlist on from there with one `#EXT-X-DISCONTINUITY` at the seam.

A session that opens over such a feed also takes the playlist at the feed's head into its own
recording. The recording at the head therefore carries every session the feed has held, oldest first,
with a discontinuity at each seam. The live playlists stay a window over the current session's own
segments.

Two things tie the rungs back together:

- **One catalogue entry.** The rungs merge into one entry keyed by the group id. Several uploaders
  write it concurrently, which is safe because every catalogue write goes through one serialized
  queue.
- **The master.** The same place writes the ladder's master to a fifth feed whose topic is the group
  id. It is the only place the whole ladder is known. The catalogue entry's `topic` points at the
  master, so one address yields every rung.

Each rung's `BANDWIDTH` in the master is measured from real segments (`BitrateMeter`). It is announced
again when it drifts more than 15%, at most every 30 s, because the catalogue is one feed every stream
shares.

The ladder becomes a recording once every rung has finalized or stopped without a recording, and at
least one finalized. A rung stops without a recording when its stop fails, for example when a full
postage batch refuses its recording. The finished entry and its master name only the rungs with a
recording, and `unfinishedRungs` names the rest. A rung that finishes later, when its recovery entry is
retried at the next boot, is added to the recording then.

### Which rungs the master offers

The master stops offering a rung that has stopped being produced (`LadderLiveness`). A rung is
delivering when its live playlist publishes land, not when its segments upload, because a segment no
playlist names reaches no viewer.

- **Count deliveries, never read a clock.** A rung is dropped from the next master when the ladder's
  middle rung has published `RUNG_DEATH_LAG_SEGMENTS` (4) playlists past it. Comparing with the middle
  rung, not the fastest, keeps one fast rung from dropping the rest. Each rung's lag is measured from
  where the ladder stood at that rung's own last delivery.
- **One rung at a time.** At most `MAX_RUNGS_DROPPED_AT_ONCE` (1) rung is dropped per master write.
- **A late starter gets a grace.** A rung that has never delivered in this process has until the
  middle rung's eighth playlist (`RUNG_FIRST_DELIVERY_GRACE_SEGMENTS`), counted from when the rung first
  came to notice. The first publish of a re-broadcast waits on a feed head read, which can take
  seconds.
- **A failing rung earns its way back.** A rung that fell behind while its deliveries were failing,
  such as a rung on a full batch, returns only after `RUNG_READMIT_AFTER_SEGMENTS` (8) deliveries in a
  row. A rung that fell behind for any other reason returns on its next publish. Without this, every
  stray segment from a filling batch would rewrite the master.
- **A held publish is not a failure.** A publish held back while the feed head read is unfinished
  writes nothing and does not count as a failed delivery.
- **Each broadcast starts a fresh count.** A ladder's count is dropped when it becomes a recording,
  which matters in admin mode, where every broadcast of a declared stream reuses one ladder.
- **A master naming no rung is never written.** That is an unplayable stream, not a degraded one.

The uploader asks this question on every delivery and every failed one, and rewrites the master only
when the set of live rungs changes. A recording's master names every rung that has a recording,
whatever liveness said during the broadcast.

A recording's master is written once. A later report from a rung of a finished ladder, including a
finalize resumed after a restart, writes nothing when the master feed's newest master already says the
same, and names that master's slot instead. A live master is always written, because a new broadcast
of the same declared stream can open with a master identical to the recording's and still has to land
above it.

The player keeps its own rule for the rung it plays. See the
[client README](../client/README.md#a-rung-that-stops-being-produced).

## The manifest contract

Every playlist the uploader writes, live, closing and recording alike, carries a media sequence for
the playlist and a date-time on every segment. Both come from one anchor the whole broadcast shares,
never from the number the engine handed over.

```
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:0

#EXT-X-PROGRAM-DATE-TIME:2026-01-01T12:00:00.000Z
#EXTINF:1,
2a5f…c1
#EXT-X-PROGRAM-DATE-TIME:2026-01-01T12:00:01.000Z
#EXTINF:1,
9b04…7e
```

### The anchor

The anchor is one instant, taken when the broadcast is admitted at the engine's publish callback
(`StreamOrchestrator.startStream`), plus the fragment length the deployment declares in
`HLS_FRAGMENT`. It is minted once per ladder group, so every rung reads the same value however far
apart they were admitted. It is stored with the group in `state/ladder/groups.json` and in each rung's
recovery entry, so a rung rebuilt after a crash keeps it.

### Dates

`#EXT-X-PROGRAM-DATE-TIME` is the date of the segment in front plus the media that segment holds, in
UTC to the millisecond. It is decided once, when the segment is placed. The broadcast's first segment
takes the anchor itself.

The media a segment holds is read against `HLS_FRAGMENT`. A segment within 1% of the declared length
counts as exactly that length, and one outside it counts as itself, rounded to the millisecond. That
1% is `DATING_SNAP_TOLERANCE` in `src/libs/broadcastDating.ts`. It covers the rounding of one keyframe
grid seen by several encoders.

It is not `FRAGMENT_TOLERANCE`, the 5% the fragment agreement check uses. That check asks whether a
stage is misconfigured, so it has to accept a segment SRS force-closed at
`HLS_FRAGMENT x HLS_AOF_RATIO`. Dating on that band would read a 2.067 s segment as 2.000 s and lose
67 ms every segment.

- **Under a ladder,** `engines/srs/entrypoint.sh` pins a keyframe every `ABR_FPS × HLS_FRAGMENT`
  frames and SRS cuts exactly there. Every segment is inside the 1% band, so the step is the declared
  length and all rungs date one piece of media identically.
- **On a single rendition,** the publisher's keyframe interval decides the segment and `HLS_FRAGMENT`
  is a floor. A segment longer than declared moves the next date by what it really holds, so the
  recording keeps the right clock. What stays wrong there is every `#EXT-X-GAP` entry, which is dated
  and sized at the declared length. Set the broadcaster's keyframe interval to divide `HLS_FRAGMENT`.
  `/health` names a stage that does not under `fragment_publisher_gop`.

A date is never an arrival time. Rungs stamping the time they received a segment would disagree by
their upload jitter, and hls.js reads that as the rungs covering different media. Millisecond
precision is what a sub-second fragment needs.

### The media sequence

The session-local media sequence counts from 0 at the broadcast's first segment. On a fresh topic that
is also the published `#EXT-X-MEDIA-SEQUENCE`.

A declared stream in admin mode can hold several broadcasts on one topic, and a rung keeps one derived
topic across sessions. Before either writes its first playlist, it reads the feed head and counts the
entries in the previous playlist, gap entries included. That count is the new session's published
offset. A previous playlist that starts at 12 and lists 30 entries makes the next session publish its
first segment as 42, with `#EXT-X-DISCONTINUITY` on it. The offset changes only the numbers written
into the playlist. Dating, ordering and restart detection use the session-local sequence. A recovered
session restores its saved offset.

The feed head read carries its own 15 s deadline (`FEED_LOOKUP_TIMEOUT_MS`), with a fresh reader per
attempt, because a head read on a busy node takes several seconds. Until it answers, the rung publishes
no playlist and asks again at its next segment, because a guess would write over the previous
broadcast.

Bee's answer to a head read is a floor, not always the head. Its feed finder gives each lookahead
probe one second and counts a probe that ran out as absent, so a slow node can answer below the real
head. The session therefore reads the slot above the answer directly. Usually it is absent and the
answer stands. When it holds a playlist, the distance doubles until a slot is absent, then halves back
to the last slot present, and the session continues from there. Only a 404 counts as absent. Any other
failure refuses the publish and asks again at the next segment.

The engine's own segment index is not used for the sequence. SRS keeps one counter per rung stream and
resets it only when its source is destroyed, a few seconds after a publisher leaves, so a broadcast on
a warm engine opens at whatever number the previous one ended on. The uploader's log lines still name
the engine's index (`Segment N of <stream> uploaded: <ref>`), because that matches the engine's own
logs.

### The sequence never moves backwards

An engine that restarts inside a broadcast resets its counter. An index that would publish at or below
a sequence already published re-anchors the numbering forwards: the playlist continues from the last
number plus one, the media is placed after the media it follows, a discontinuity is armed, and the
date re-anchors with it. hls.js reads a media sequence that moves backwards as a parsing error, which on
a single-variant stream is fatal, and the client answers a fatal parsing error by remounting the
player.

An index below the anchor before anything has been published is not a restart. It is a segment that
arrived out of order, and it takes its true place.

Three things arm a discontinuity, and only these: the engine's counter restarting, the origin
declaring one through `markDiscontinuity`, and an encoder returning inside the reconnect window through
`resumeAfterReconnect`. The discontinuity goes on the one segment where the break lands.

### A lost segment is a gap entry

A segment nothing took leaves its sequence empty. The playlist lists every empty sequence between two
held segments as an `#EXT-X-GAP` entry with the same derived date-time, the declared fragment length
and a URI of `gap-<sequence>`. RFC 8216bis §4.4.4.7 defines the tag as an entry a client skips, and
hls.js does.

Leaving the hole out would renumber every entry behind it, because HLS numbers listed entries
consecutively from `#EXT-X-MEDIA-SEQUENCE`. The rolling playlist would renumber media a viewer already
holds, and a rung that lost a segment would disagree with its siblings about which instant segment N
covers.

- A hole is not a break. A lost segment does not restart the encoder's clock, so the dates carry on and
  no discontinuity is armed.
- A gap entry never starts a live window and never ends a playlist. `#EXT-X-MEDIA-SEQUENCE` is always
  a held segment's own sequence.
- The live window is a byte budget of one chunk, `LIVE_WINDOW_MAX_BYTES` (4096 bytes). Gap lines count
  against it, and a hole too wide to fit stops the window at it. A date costs about 50 bytes per
  segment, so the window holds about 30 segments.
- `#EXT-X-VERSION` stays at 3. RFC 8216bis §8 lists no minimum version for `#EXT-X-GAP`.

### A gap in the engine's numbering is a loss

SRS posts each closed segment to `on_hls` once and never retries. Every segment it closes while the
uploader is down or unreachable is gone, and nothing reports it. So `StreamOrchestrator` keeps the last
index it accounted for per stream, and a segment arriving more than one above it is a skip. The indexes
in between that the duplicate filter does not hold are counted in `swarm_hls_segments_lost_total`, set
the `segment_loss` health reason, and appear as gap entries.

It does not count a hole the engine already reported, does not read a counter going backwards as a
hole, and infers nothing on the first arrival of a session recovered from an entry with no segments.

## An encoder that disconnects keeps its broadcast for one window

SRS ends a publish within seconds of any interruption. The uploader does not take that as the end of
the broadcast. `on_unpublish` is reported and ends nothing, and the live playlist simply stops
advancing. The broadcast ends after `ORPHAN_REAP_MS` (60 s by default) with no media.

| What the encoder does        | What a viewer gets                                                                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Comes back inside the window | The same session, recording and feed, with one `#EXT-X-DISCONTINUITY` at the seam and the dating re-anchored on the clock it returned at. No `#EXT-X-ENDLIST` was written, so a player following the feed carries on   |
| Does not come back           | The reaper finalizes the broadcast one window after its last segment: closing playlist, recording, and `vod` to the admin. An encoder returning later starts a new session, which takes the recording at the feed head |

So the catalogue shows `live` for up to one window after the encoder leaves, and a clean stop reaches
its recording about a window later.

- **A return buys one window, once.** The window runs from the last segment or from the encoder's
  first return after it, whichever is later. A later announce with no media in between buys a grace
  of `SEGMENT_STALL_MS`, capped at one grace past the window's deadline. An encoder that reconnects
  every few seconds and never sends a frame still ends.
- **SRS's own publish timeout is not lengthened to match.** A clean stop sends an explicit goodbye,
  and a publish SRS still believes in refuses the encoder's own reconnect as busy. Only the uploader
  can hold anything open.
- **The seam is armed by the reconnect, not by the numbering.** SRS keeps a source's HLS muxer alive
  for about `hls_dispose × 1.1` (about 132 s), so a returning encoder's segment numbers usually carry
  straight on. The returning segment publishes one above everything already published, and an
  in-order return emits no gap entries, because nothing was produced while the encoder was away.

Which announce joins a live broadcast: an announce that passes the takeover rules joins only when it
is the publisher that left. Both sides proving the publish key is the strongest form, and in admin mode
or with `PUBLISH_KEY_SECRET` every publish proves a key. An announce against an incumbent nobody can
name resumes if it proved the key. Two announces that proved nothing resume unless their addresses are
both known and different. A provably different publisher finalizes the session it displaces and starts
its own, so a recording never opens with someone else's media.

The operator stop (`POST /stream/stop`), the recovery timeout and the reap all finalize at once, and so
does OME's closing webhook. `/health` lists every stream waiting for its encoder under
`disconnectedStreams`.

## After a restart the dating re-anchors on the clock

A broadcast's dating is a list of epochs, `BroadcastAnchor.epochs`:

- Media published before the restart keeps its dates, because a viewer may already hold it.
- The first segment after the restart is dated at the wall clock it arrived at, and later segments
  carry on from the media each holds. On a ladder where a rung kept publishing through the restart,
  that rung's line takes the wall clock's place.
- A segment placed at or above an epoch's `fromSequence` takes that epoch's instant, under the newest
  epoch that reaches it. The broadcast's start is the implicit first epoch.

Every restart path re-anchors: an encoder re-announcing a stream the uploader still holds, one
re-announcing a session rebuilt after the uploader's own crash, and segments resuming after the
engine's counter restarted. The one path that numbers from zero again is a session announced while a
stop of the same id is still finalizing, which is a new broadcast (`reanchorReplacedBroadcast`). A new
epoch is never dated before the segment in front of it, because a date moving backwards is a parsing
error to hls.js. A single rendition is a ladder of one.

Nothing yet measures what a player makes of the forward step across the break, which is the length of
the outage. The e2e contract accepts a forward step of any size there and refuses one that does not
move forwards.

### Every rung of a ladder dates from one line

Segment N of every rung carries one date, whatever happened to the rungs one at a time. Four rungs
dating one segment four ways is the disagreement the tag exists to prevent, because hls.js then lands
a level switch somewhere else.

- **A re-anchoring is minted once per return.** The orchestrator is the only layer that sees the
  rungs' separate reconnect webhooks as one event, so it names the return with a UUID and every rung of
  it asks the dating with that name. A rung joins a line that carries its return's name and mints one
  otherwise (`reanchorDecision` in `src/libs/broadcastDating.ts`). The name is a UUID because the
  epochs outlive the process. The engine's own counter restarting has no such witness and is judged by
  the clock, within `SAME_RESTART_TOLERANCE_MS` (two minutes).
- **Every rung of one return resumes at one sequence.** Rungs stop at different counts before an
  outage. The first rung of a return to place a segment agrees the resume point as the furthest any
  live rung has counted (`agreedResumePoint`), and the ladder group record keeps it with the return's
  name. Later rungs read it there and resume at it, with the discontinuity on the same sequence. A rung
  that counted less lists the sequences between as gap entries. The point never lowers a rung below
  its own count, and never raises it further than the fragments it was away plus `RESUME_RAISE_SLACK`
  (5). Outside those bounds the rung resumes at its own count with a warning.
- **The line is minted over every rung's floor.** The rung minting the line takes the latest of the
  dates every rung of the return, and every rung that kept publishing, gives the resume point, and the
  wall clock (`ReanchorRequest.ladderFloorMs`).
- **A return some rung never left resumes on that rung's line.** That rung's media is continuous, so
  its dates are the ladder's timeline (`ReanchorRequest.keptPublishingAtMs`). A rung counts as having
  kept publishing when it delivered media at least half a fragment after the newest media of the rungs
  that went away.
- **A rung back as a new session joins the ladder's sequence and line.** A rung reaped while its
  siblings kept publishing comes back on its own topic, a minute or more of sequences behind. If it had
  a session in this broadcast, it takes the sequence its siblings are publishing and their line's date
  as its first segment is placed (`ManifestManager.joinLiveLadder`). Its own feed is never numbered
  backwards: where its head is already past the ladder's sequence, the head wins.
- **A ladder opening is left alone.** A rung announcing after a sibling's first cut is still segment 0.
  Only a rung that had a session in this broadcast is taken as rejoining.
- **Which of two adjacent sequences a rejoining segment is, comes from delivery time.** SRS posts each
  rung's copy of one cut a fraction of a fragment apart, and the next cut a whole fragment later. A
  sibling segment delivered within half a fragment of the rejoining rung's is the same cut.

A return takes in only the rungs that were away when it started, including one whose disconnect lands
after a sibling announced but whose last media is older than the return. A return is closed once a
rung that placed a segment of it, or never left it, goes away again.

The epochs are stored with the group in `state/ladder/groups.json` and in each rung's recovery entry,
so a crash after a restart keeps the re-anchored dating. The recording is built by the same function
as the live playlists, so it carries the same dates.

### Known gaps in ladder alignment

- **A rung reaped while every sibling is away** has no live line to join. Its new session numbers from
  its own feed head and dates from the ladder's opening line, while the siblings' return mints a line at
  the wall clock. It stays apart until the next return in which the whole ladder comes back together.
- **A replaced rung clears the ladder's shared epochs.** A session announced while its predecessor is
  still finalizing writes an epoch at sequence 0, which replaces the ladder's whole list. A sibling
  still coming back from a return then mints a second line. This needs a replacement and a return at
  the same moment.
- **A rung that rejoined as a new session can carry different sequences in the recording.** The
  recording numbers the rung's returning segments on from its own last segment, so after the gap its
  sequences sit below its siblings' by the length of the gap in segments. The dates still agree.

## Ladder time markers

A rung's playlist feed is a numbered series, and a viewer that starts or switches quality has to find
the newest number. Bee's own feed lookup walks at most 255 indexes a round from 0, so on a long
broadcast it costs many round trips. Each live ladder therefore writes a time marker every ten seconds:
one small single owner chunk that says where every rung's feed stood. A viewer computes the address of
a recent marker from the clock, reads it once, and is then at most one round of parallel reads from the
newest entry. A viewer that finds no marker searches the feeds instead. The convention lives in
`@swarm-hls-stream/shared` (`ladderMarker.ts`), so the writer and every reader compute the same
address.

| Part    | Value                                                                                                                                                                                                                                                     |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Period  | `p = floor(unix seconds / 10)` (`MARKER_PERIOD_SECONDS`). Global time, so a reader needs only the clock                                                                                                                                                   |
| Address | A single owner chunk owned by the ladder's signer, with identifier `keccak256("ladder-marker" ‖ group topic ‖ p as 8 bytes big-endian)`. The group topic is the master feed's topic, `Topic.fromString(group)`                                            |
| Payload | JSON naming only rungs that have published, keyed by each rung's feed topic in hex, and `segmentMs`, the stage's `HLS_FRAGMENT` in milliseconds. A viewer joining from a marker moves the head on by the time since the write, in segments of that length |
| Version | `LADDER_MARKER_VERSION`, 2. A reader treats any other version as absent and searches instead. `parseLadderMarker` rejects anything malformed                                                                                                              |

```json
{ "v": 2, "period": 175983840, "writtenAt": 1759838400250, "rungs": { "<rung feed topic hex>": 41 }, "segmentMs": 2000 }
```

`LadderMarkerWriter` starts a ladder's markers with its first published playlist and writes each
period's marker shortly after the period begins. It stops when the ladder's last rung is released.
Writes go direct, on a queue of their own through the master's node, so a marker never delays a
playlist. A write that cannot finish inside its period is abandoned, logged once per run of failures
and counted in `swarm_hls_ladder_markers_failed_total`. A marker is never rewritten, even when the wall
clock steps back.

The cost is one chunk per ladder every ten seconds, 360 an hour, on the coordinator's batch.
`LADDER_MARKERS=false` turns markers off.

## The ABR ladder in admin mode

With `ABR_ENABLED` and `ADMIN_API_URL` both set, the declared topic becomes the ladder's master feed.
The declared topic is the one address the admin hands a viewer before anything publishes, and the
master's topic is the group id, so the two have to be the same.

- Each rung publishes its playlists on a topic derived from the group and its rung name. Rungs sharing
  the master's feed would overwrite each other. The derived topic is stable for the life of the
  declaration, so a restarted rung continues its feed, and its recording opens with the one already
  there. The admin's entry therefore points at a recording of the whole broadcast, seams marked. The
  admin accepts `live` after `vod` for this reason: a broadcaster who stops and comes back is a stream
  going live again. It does so within its restart window only. Once that has run out, the admin
  changes the stream's key, and the old key is refused at the next connect.
- The merge of rungs moves from the catalogue feed into the admin. Each rung posts its `Rendition` to
  `POST /api/internal/streams/:id/renditions` with `ADMIN_API_TOKEN`. The admin merges it by the same
  rule `StreamCatalog.keepingWhatFinished` states, a rung that has finished stays finished, writes
  `renditions` into its catalogue entry, and answers with the merged ladder. The uploader writes the
  master from that answer, filtered by `LadderLiveness`. Answers are applied in the order the admin
  merged them, by the catalogue write index each one carries.
- `live` and `vod` are reported for the ladder, not per rung. `live` goes out once the first master
  lands. `vod` goes out from the rung whose report finished the ladder, or from the failed stop of a
  rung when that is what finishes it. Its `index` is the final master's index in the declared topic's
  feed, and its `duration` is the ladder's. A later announce that finds the ladder finished while the
  admin still holds the stream as anything but `vod` reports `vod` again, which the admin accepts.

A declared stream, and every rung, resumes its feed index and media sequence from its topic's feed
head, and holds its publishes until a re-announced predecessor has drained, because two sessions share
one feed. A standalone single rendition, whose topic is a fresh UUID per session, does neither.

## Crash recovery and the finalize

`finalize` writes the closing playlist, then the recording, then the catalogue entry, and deletes the
recovery entry last. A crash between the recording and the catalogue leaves a recording already paid
for under an entry that still says the broadcast is recoverable. A recovered session therefore reads
its own feed's head first, which costs no postage. If it finds its finished recording there, it logs
`Resuming the finalize of <stream> at the catalog write`, publishes nothing, and completes only the
catalogue write and the entry delete. A head that did not read is not taken for an empty feed, and the
finalize waits for the next boot.

A live playlist fits one 4096-byte chunk and goes out as one request under `BEE_REQUEST_TIMEOUT_MS`. A
recording names every segment, about 9 KB a minute at one-second segments, and bee-js uploads every
chunk of it before the feed update. That write gets 15 s plus 300 ms per chunk, 240 s at most
(`MANIFEST_WRITE_TIMEOUT_CEILING_MS` in `BeePublisherPool.ts`). A finalize can therefore take about
285 s, inside the five minute drain deadline, and the compose `stop_grace_period` of the uploader is
330 s, the drain deadline plus 30 s for the rest of shutdown.
