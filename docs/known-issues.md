# Known issues

Problems we have seen and decided not to fix for now. Each one says what happens, how much it
matters, and how to see it again. Found in a live test round on a test deployment on 2026-10-04,
where real broadcasts ran through delay, jitter, packet loss, blackouts, restarts, takeovers and
crashes. Three other findings of that round are fixed: a stage that kept expired postage batches
after new ones were bought, quality rungs that lost their shared timeline after a long outage, and
ladder encoders that could hang at the start of a broadcast with nobody told.

Priority: **P2** costs time or confusion in normal use, **P3** is rare or cosmetic.

## Setup and upgrades

**The stages upgrade misses one copy of the admin token (P2).** Rotating a stage's admin token is
refused while `ADMIN_API_TOKEN` is still set in the bundled stack's `.env`. The upgrade steps in
[self-hosting.md](self-hosting.md) name the bundled version, but the active build keeps its own
copy under `bundled.builds/<commit>/.env`, made before the line was removed, so rotation stays
refused until both are cleaned. To see it: set the key in `bundled/.env`, build, delete it from
`bundled/.env` only, then rotate.

**The viewer goes blank after the catalogue moves to a catalogue node (P2).** The viewer is built
with the address of the catalogue feed's owner, and the manager hands it that address only from the
viewer deployment's own feed owner setting. After the stages upgrade the catalogue is written by the
catalogue node, so its owner changes, but the upgrade steps in
[self-hosting.md](self-hosting.md#upgrading-an-existing-installation)
name only the viewer's feed topic. A viewer redeployed without the owner builds with none: the page
stays empty and the browser console says `Missing env var: VITE_APP_OWNER`. The fix by hand is the
viewer deployment's **Edit** drawer: the owner the admin publishes at `/api/config` (its
`feed.owner`, with `0x` in front) under **Streamer to follow**, and its `feed.topic` under **Feed
topic**. Saving redeploys it. To see it: designate a catalogue node, give the viewer the new topic
only, redeploy it and open the page.

**A stray file in a version folder spreads into every build and deploy (P3).** The manager copies a
stack version's folder whole, so any extra file there, such as a backup of its `.env`, is copied into
each build under `bundled.builds/<commit>/` and into each deploy's snapshot under
`.executions/<id>/tree/`. One backup left beside a version's `.env` became four copies after two
deploys, each holding the secrets of the file it backed up. Nothing reads these copies, but deleting
the original does not remove them, and the folders belong to root, so the host account cannot delete
them without the manager container or root. To see it: put a file beside `bundled/.env`, build and
deploy twice, then search the versions folder for its name. Keep backups outside the versions folder.

## Broadcasting

**Nothing tells a broadcaster that their uplink is too slow (P3).** When the link is narrower than
the broadcast bitrate, SRT drops packets, segments arrive at 50 to 85 percent of real time, and the
stream recovers when the link does. The behaviour is right, but the broadcaster sees nothing in the
admin. To see it: broadcast 6 Mbit/s through a 3 Mbit/s link.

**After a long stretch on a too-narrow uplink, the ladder limps until the broadcaster reconnects
(P2).** Measured on 2026-10-15 with an ffmpeg SRT broadcaster held at 3 Mbit/s for about two
minutes: 720p and 1080p went 60 s without usable media and were finalized, while 360p and 480p
carried on. Once the link was restored, 720p and 1080p came back by themselves as new sessions on
their topics, but every rung then ran at about a third of real time, with the encoders reconnecting
every few seconds, until the broadcaster itself reconnected, after which everything was at full rate
at once. Nothing is lost. Whether the slow state comes from the test broadcaster's SRT library after
starvation or from the stage is not settled: a real OBS on the same squeeze would tell. To see it:
broadcast 6 Mbit/s through a 3 Mbit/s link for two minutes, lift the limit, and count segments per
rung for the next minute.

**A broadcast that starts while the last one still finalizes is dated from the last one's start
(P3).** When the source comes back while one rung of the previous broadcast is still writing its
recording, the uploader keeps that ladder, and the rungs that open the new broadcast take its anchor,
so every `#EXT-X-PROGRAM-DATE-TIME` of the new broadcast runs the gap between the two behind the
clock. The rungs agree with each other, so playback and quality switches work, but the recording's
clock is wrong by that gap. To see it: stop a long broadcast and start it again within the few
seconds its recording takes to write, then compare the new playlist's first date with the wall clock.

**A rung that rejoins a live ladder is numbered differently in the recording (P2).** When one rung gets no
media for longer than the 60 second reconnect window while its siblings keep publishing, it is finalized, and when
it comes back in the same broadcast it rejoins the ladder live at the siblings' sequence and dating line. The
recording written at the end numbers that rung's returning segments on from its own last segment instead, so after
the gap its sequences sit below its siblings' by the gap in segments, counted from the rung's last segment before it to
its first after the return. Every segment is kept and every date agrees, but a player that places a recording's
segments by summed durations can land the gap's length off at a quality switch after it. Measured on 2026-10-15 on the
build tagged `v1.2.1-rc.1`, with 2 s segments: 1080p's encoder was paused for 70 s, and about 92 s passed from its
last segment before the pause to its first after the return. It rejoined live at sequence 1057, and its recording
numbered the same segments from 1011, 46 below its siblings. To see it: during a
broadcast pause one rung's encoder for more than 60 s, let it go, and after the recording is written compare that
rung's sequence and date pairs with a sibling's.

**A restarted broadcast keeps each rung's own numbering until its first reconnect (P3).** At the end of a
broadcast the lower rungs often write one more short segment than the higher ones, so a recording's rungs end on
different sequences, and a later broadcast on the same stream opens each rung at its own next sequence. Dates agree
across rungs, the sequences are offset by one or two per earlier broadcast, and the offset goes away at the first
reconnect, which puts every rung on one sequence again. To see it: stop a broadcast, start it again on the same
stream, and compare the rungs' sequences at the same date.

**A rung rejoining a live ladder can land one segment off (P3).** Which sequence a rejoining rung's first segment
takes is decided from the gap between a sibling being handed its newest segment and this rung handing over its first,
divided by the segment length and rounded. A gap of half a segment or more makes it the next segment, a shorter one the
same. The dev stage ran 2 s segments, so the tipping point there is 1 s. On that stage on 2026-10-15 the time between
the first and last rung closing the same segment was 0.79 s typically, 0.96 s at the 90th percentile and 1.40 s at
worst, with 1080p last on nearly every segment. A viewer switching quality exactly there sees about one segment skipped or repeated. To see
it: read the close times from SRS's per-segment log lines for all rungs of one broadcast.

**The admin shows "published" while nothing goes out (P3).** A broadcaster can be connected while
the ladder encoders produce nothing. The admin keeps showing the stream as published, with no
warning. The uploader now reports such a ladder on `/health` as `ladder_not_started` after 45 s,
but the admin does not show it.

**Two encoders on one stream's details take it from each other (P2, SPDV-1681).** A stage lets an encoder
with the right key take over a stream that is already live, so a broadcaster whose OBS crashed comes straight back.
OBS reconnects by itself when it is pushed off, so two encoders with the same details push each other off every 2 to
3 seconds for as long as both run. Measured on 2026-10-15 on the build tagged `v1.2.0`: the stream carried about 9 of its 30 segments a
minute, with three encoders none at all, and the admin showed Live throughout. When one encoder stops, the stream is
back to normal within about 10 seconds. A wrong or missing passphrase or key, another stream's key and malformed
stream ids are refused without touching the live stream. Kept as it is for now: a stream's details belong in one
encoder, and the way out is Rotate key on the stream's page, then the new details in the one encoder that should
broadcast. Measured the same day: right after the rotation the encoder connected at that moment stays on air and every
reconnect with the old key is refused, which ends the fight, and the encoder given the new details then takes the
stream over and keeps it at full rate. Options for later are in the [roadmap](ROADMAP.md#one-encoder-per-stream-later). To see it: start two
encoders with the same SRT details, each reconnecting after 2 seconds, and count segments per rung.

**A takeover by a second live encoder splits one segment across rungs (P3).** When a second encoder
with the same key takes over while the first is still sending, SRS keeps the ladder's encoders
running, so no rung disconnects. Rungs that had already delivered the old encoder's last segment
start the new dating line one sequence later than the others. That one sequence then holds the old
encoder's last segment on some rungs and the new encoder's first on the others, about one segment
apart in time, with the discontinuity one sequence apart too. From the next sequence on every rung
agrees again. A viewer who switches quality exactly there sees about two seconds skipped or
repeated. A crash followed by a reconnect, and a clean stop and restart, keep every rung on one
seam. To see it: while a broadcast is live, start a second encoder with the same key, then compare
the playlists of all rungs around the seam.

**After a return the top rung can miss its first segments (P3).** When a broadcaster comes back
inside the reconnect window, every rung resumes on the same sequence and dating line, but the
slowest encoder can start a segment or two later. Those sequence numbers are then absent on that
rung only. A player on that rung skips the gap, and the dates still line up across rungs. Seen once
on the 1080p rung, two segments.

**Segments inside a network fault carry decode errors (P3, expected).** During a squeeze or a
blackout, three to four segments per rung decode with errors, and every other segment decodes
clean. That is damage from packets SRT dropped on the way in, not from the stack.

**Some segments carry repeated decode timestamps (P3).** About one segment in 10 to 50, on every
rung at once, runs 2.025 s instead of 2.0 s, and about 40 of its frames carry a decode timestamp
that does not move past the one before. ffmpeg reports each of them as "non monotonically increasing
dts to muxer". All the frames are there and the picture decodes. A player could at most drop or
stutter a frame there, and a browser viewer played through such segments without a stall. It shows
on a normal network as much as during a fault, so some of the decode errors counted in the entry
above are probably this, not damage. To see it: decode the segments of any recording with
`ffmpeg -v error -i <segment> -f null -` and look for that message.

**One damaged segment after an unclean takeover (P3, cause unknown).** One recording had a single
segment per rung, about four seconds, with decode errors on every rung, so the source itself was
damaged. It sat a few seconds after a frozen old broadcaster was released during a takeover test.
SRS logged no drop. It did not happen again and was not chased.

**A new broadcast reaches the stream list about a minute late (P3).** On 2026-10-15 a gateway's segment warmer,
which follows only streams the stream list calls live, began following each new broadcast about 60 s after it
started, because the list marked it live only then. So a viewer probably finds a new stream in the catalogue about a
minute after the broadcaster starts. Not yet confirmed in a viewer. To see it: start a broadcast and time when the
catalogue feed first lists it as live.

## Manager

**A pool's quality nodes show "Reading balances" with no figures (P3).** On the dev stage on 2026-10-15 every node of
an ABR pool showed "Reading balances", with funding, chequebook and wallet as a dash, and the pool's card said "Not
ready yet" while all four nodes ran with usable stamps. The manager reached each node's API, and its balance requests
answered 304. Cause not found. To see it: open an ABR pool's page in the manager and compare with the nodes'
`/chequebook/balance` and `/wallet`.

**An uploader keeps "Last deployment failed" after it recovered (P3).** An uploader that refused to start because a
stamp was below its time floor, and started by itself once the stamp was topped up, kept that label in the
Deployments list for two hours while it ran healthy, until it was deployed again. To see it: start an uploader on a
stamp below 12 hours, top the stamp up, and watch the list.

**An open manager page keeps the old version after an upgrade (P3).** After the manager was upgraded, a page already
open kept showing the previous version and behaved as it, until it was reloaded. To see it: keep a manager page open
through an upgrade and read the version beside the instance name.

## Keys

**Rotating a key does not disconnect a live broadcaster (P3, product question).** After a rotation
the old key is refused on the next connection, but a broadcaster already connected stays on air.
If a key leaked and someone else is live with it, rotation alone does not stop them. Unpublish does.
Whether rotation should also end the live session is a product decision.

## Uploader

**A recovery entry for a deleted stream is retried on every boot (P3).** If a recording was
interrupted and its stream no longer exists in the admin, the uploader recovers it on every start,
waits its 60 second recovery window, tries to finalize, gets 404 from the admin, stops it, and keeps
the entry. It costs a minute of recovery and some log noise per boot and affects no other stream.
To see it: restart the uploader and look for `Report of rendition ... refused with 404`.

## Logs

**SRS logs "Unlink ts failed" every two seconds per rung (P3).** SRS's own HLS cleanup tries to
delete fragments that are already gone. Harmless, but it fills the SRS log and hides real warnings.
To see it: count `Unlink ts failed` in the SRS container's log during a broadcast.

## For anyone testing

`docker kill` on the uploader leaves it down, because its restart policy is `unless-stopped` and
Docker treats a kill as a manual stop. A real crash inside the process restarts it. A crash test
that uses `docker kill` must start the container again.
