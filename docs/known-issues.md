# Known issues

This page lists the problems the platform has today. Each entry says what you see, why it happens,
and what to do about it where there is a workaround. Fixed problems leave this page.

## Setting up the manager

**Rotating a stage's admin token is refused while the stack version's `.env` sets `ADMIN_API_TOKEN`.**
The manager generates each stage's admin token itself, and refuses **Rotate the uploader's admin
token** while the stack version supplies one of its own. The check reads the `.env` of the version's
active build, under `bundled.builds/<build>/`, which a build copies from the version folder.
Workaround: delete the `ADMIN_API_TOKEN` line from the version's `.env`, build the version again,
then rotate.

**A stray file in a version folder spreads into every build and deploy.** The manager copies a stack
version's folder whole, so any extra file there, such as a backup of its `.env`, is copied into each
build under `bundled.builds/<build>/` and into each deploy's snapshot under `.executions/<id>/tree/`.
Each copy holds what the original holds, secrets included. Nothing reads the copies, deleting the
original does not remove them, and the folders belong to root, so the host account cannot delete
them without the manager container or root. Workaround: keep backups outside the versions folder.

## Broadcasting

**Nothing tells a broadcaster that their uplink is too slow.** When the link is narrower than the
broadcast bitrate, SRT drops packets, segments arrive slower than real time, and the stream
recovers when the link does. The admin shows nothing about it.

**After a long stretch on a too-narrow uplink, the ladder runs slow until the broadcaster
reconnects.** A rung that gets no usable media for longer than the 60 second reconnect window
(`ORPHAN_REAP_MS`) is finalized, while the lower rungs carry on. When the link recovers, the
finalized rungs come back by themselves as new sessions on their topics, but every rung can then run
at a fraction of real time, with the rung encoders reconnecting every few seconds. Nothing is lost.
Workaround: stop the broadcast in the encoder and start it again, after which every rung runs at
full rate.

**The admin shows a stream as published while nothing goes out.** A broadcaster can be connected
while the ladder's encoders produce nothing. The uploader reports such a ladder on its `/health` as
`ladder_not_started` once `FIRST_RUNG_DEADLINE_MS` (45 seconds) has passed, but neither the admin
nor the manager shows that reading. Workaround: stop the broadcast for longer than the encoder hold
and start it again, which starts fresh encoders.

**Two encoders with one stream's details take the stream from each other.** A stage lets an encoder
with the right key take over a stream that is already live, so a broadcaster whose OBS crashed
comes straight back. OBS reconnects by itself when it is pushed off, so two encoders with the same
details push each other off every few seconds for as long as both run. The stream then carries only
a fraction of its segments, and the admin shows it as Live throughout. A wrong passphrase or key,
another stream's key and a malformed stream id are refused without touching the live stream.
Workaround: press Rotate key on the stream's page, then put the new details into the one encoder
that should broadcast. The encoder connected at that moment stays on air, every reconnect with the
old key is refused, and the encoder with the new details then takes the stream over.

**Rotating a key does not disconnect a live broadcaster.** After a rotation the old key is refused
on the next connection, but a broadcaster already connected stays on air. Workaround: unpublish the
stream to stop someone who is live with a leaked key.

**A new broadcast may reach the catalogue up to about a minute after it starts.** The uploader
reports a broadcast as live only once its ladder's master playlist is on Swarm, so a viewer can find
a new stream in the catalogue some time after the broadcaster starts.

## Recordings and quality switching

These entries concern the numbering and dating of segments across the quality rungs of a ladder. In
each one every segment is kept and playback works. A viewer who switches quality at the affected
point can see about one segment skipped or repeated.

**A broadcast that starts while the last one is still finalizing is dated from the last one's
start.** When the source comes back while one rung of the previous broadcast is still writing its
recording, the uploader keeps that ladder, and the rungs of the new broadcast take its time anchor.
Every `#EXT-X-PROGRAM-DATE-TIME` of the new broadcast then runs behind the clock by the gap between
the two broadcasts. The rungs agree with each other, so playback and quality switches work.
Workaround: wait a few seconds after stopping before you start again.

**A rung that rejoins a live ladder is numbered differently in the recording.** When one rung gets
no media for longer than the 60 second reconnect window while the others keep publishing, it is
finalized. When it comes back in the same broadcast it rejoins the ladder live at the other rungs'
sequence numbers. The recording written at the end numbers that rung's returning segments on from
its own last segment instead, so after the gap its sequences sit below the other rungs' by the
length of the gap in segments. Every date agrees, but a player that places a recording's segments by
summed durations can land the gap's length off at a quality switch after it.

**A restarted broadcast keeps each rung's own numbering until its first reconnect.** At the end of a
broadcast the lower rungs often write one more short segment than the higher ones, so a recording's
rungs end on different sequence numbers, and a later broadcast on the same stream opens each rung at
its own next number. Dates agree across rungs, the numbers differ by one or two per earlier
broadcast, and the difference goes away at the first reconnect.

**A rung rejoining a live ladder can land one segment off.** The sequence number of a rejoining
rung's first segment is worked out from the time between another rung handing over its newest
segment and this rung handing over its first, divided by the segment length and rounded. Rungs
close the same segment up to about a second apart, the top rung last, so with 2 second segments
(`HLS_FRAGMENT`) the rounding can tip either way.

**A takeover by a second live encoder splits one segment across rungs.** When a second encoder with
the same key takes over while the first is still sending, SRS keeps the ladder's encoders running.
Rungs that had already delivered the old encoder's last segment start the new dating line one
sequence later than the others, so that one sequence holds different content on different rungs.
From the next sequence on every rung agrees again. A crash followed by a reconnect, and a clean stop
and restart, do not do this.

**After a return the top rung can miss its first segments.** When a broadcaster comes back inside
the reconnect window, every rung resumes on the same sequence and dating line, but the slowest
encoder can start a segment or two later. Those sequence numbers are then missing on that rung only,
and a player on that rung skips them.

## Media

**Segments inside a network fault carry decode errors.** During a squeeze or a blackout of the
broadcaster's link, a few segments per rung decode with errors. The damage comes from packets SRT
dropped on the way in.

**Some segments carry repeated decode timestamps.** Now and then a segment on every rung runs a
little longer than the segment length, and some of its frames carry a decode timestamp that does not
move past the one before. ffmpeg reports each as "non monotonically increasing dts to muxer". All the
frames are there and the picture decodes, and browsers play through such segments without a stall.
To see it, decode a recording's segments with `ffmpeg -v error -i <segment> -f null -`.

## The manager's console

**A pool's quality nodes can show "Reading balances" with no figures.** Every node of an ABR pool
can show "Reading balances", with funding, chequebook and wallet as a dash, and the pool's card
"Not ready yet", while the nodes run with usable stamps. The cause is not known. Workaround: read the
nodes' `/chequebook/balance` and `/wallet` directly.

**An uploader keeps "Last deployment failed" after it recovered.** An uploader that refused to
start because a stamp was below its time floor (`STAMP_MIN_TTL_HOURS`, 12 hours), and started by
itself once the stamp was topped up, keeps that label in the Deployments list while it runs
healthy. The manager sets a deployment's status only from deploys and actions. Workaround: deploy it
again.

**An open manager page keeps the old version after an upgrade.** A page reads the manager's version
once, when it loads, so a page left open through an upgrade shows and behaves as the previous
version. Workaround: reload the page.

## Logs

**SRS logs "Unlink ts failed" every two seconds per rung.** The uploader deletes each segment
itself, and SRS's own HLS cleanup then tries to delete it again. It is harmless, but it fills the SRS
log and hides real warnings.

## For anyone testing

`docker kill` on the uploader leaves it down, because its restart policy is `unless-stopped` and
Docker treats a kill as a manual stop. A real crash inside the process restarts it. A crash test that
uses `docker kill` must start the container again.
