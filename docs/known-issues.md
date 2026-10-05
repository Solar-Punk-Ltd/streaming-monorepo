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

**The admin shows "published" while nothing goes out (P3).** A broadcaster can be connected while
the ladder encoders produce nothing. The admin keeps showing the stream as published, with no
warning. Seen together with the encoder hang that is being fixed separately.

**Segments inside a network fault carry decode errors (P3, expected).** During a squeeze or a
blackout, three to four segments per rung decode with errors, and every other segment decodes
clean. That is damage from packets SRT dropped on the way in, not from the stack.

**One damaged segment after an unclean takeover (P3, cause unknown).** One recording had a single
segment per rung, about four seconds, with decode errors on every rung, so the source itself was
damaged. It sat a few seconds after a frozen old broadcaster was released during a takeover test.
SRS logged no drop. It did not happen again and was not chased.

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
