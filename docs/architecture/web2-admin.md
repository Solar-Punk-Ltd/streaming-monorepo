# The admin

This page explains what the admin (`apps/web2-admin`) is for, how it fits with the manager and the
stack, and why it is shaped the way it is. It describes concepts, not routes or settings: those are
in [the backend's README](../../apps/web2-admin/backend/README.md).

## What it is for

The admin is the brand console and the API behind it. A brand is a customer that streams under its
own name. Its operators sign in to the admin to draft streams, publish them to the stream list that
viewers read, called the catalogue, get the OBS details for each broadcast, watch the stages their
streams run on, fund the nodes behind those stages, and download a recording as an MP4.

The admin is the one place a brand changes anything. Anything that touches a host or a node's
wallet belongs to the manager. If the admin is down, broadcasts that are running carry on, and
published streams stay published, because Swarm holds them. Nobody can create, publish or change a
stream, or fund a node, until it is back.

## The parts

| Part         | Role                                                                                                                                                                                                                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The console  | The only surface an operator touches: streams and the stage each is on, the stages the manager pushed with their readiness, stamps and chequebooks, the catalogue's batch, funding, exports of recordings, and the users who may sign in. It has two looks, and a host's default look is a setting. |
| The API      | Every change an operator can make, in one place. It is the only writer of the catalogue, so who may do what is enforced in one place. It takes the manager's pushes and each stage uploader's reports on bearer tokens, calls the manager's funding API, and exports recordings.                    |
| Postgres     | Users and sessions, streams and their stages, the records the manager pushed, every catalogue write with its exact bytes, the funding journals, the export on the server and the audit log.                                                                                                         |
| Sign-in      | Usernames, passwords, an admin role and server-side sessions ([web2-admin-auth.md](web2-admin-auth.md)).                                                                                                                                                                                            |
| The contract | `@streaming-monorepo/web2-admin-common`, the types the API answers and the console reads.                                                                                                                                                                                                           |

## How it relates to the manager and the stack

```
  console ──────────────────────────▶ admin API ──── writes ───▶ the catalogue on Swarm
                                       ▲     │
     stage and catalogue stamp pushes  │     │  funding API calls
                                       │     ▼
                                      manager

  stage's uploader ── lookup and state reports, on the stage's own token ──▶ admin API
```

- **The manager** (`apps/infra-manager`) deploys and runs the stages, a stage being one deployment
  of the stack that takes broadcasts in, and the Swarm nodes they upload through. Over its admin
  link, it pushes the admin a record of every stage it runs (its ingest address, the address it
  signs as, its rungs' stamps and chequebooks, its readiness, and the sha256 of its uploader's own
  token) and the record of the catalogue stamp, the postage batch and node the catalogue is written
  with. The admin keeps what it was told. [stages.md](stages.md) describes those records.
- **The admin calls the manager** for one thing, its funding API, on a bearer token of its own:
  to read the node wallets, to relay transfers the brand wallet signed, and to ask a node to top up
  or dilute a batch, buy a new one, or move its chequebook, which the node pays for itself.
  [funding.md](funding.md) describes it.
- **Exports read through the catalogue node.** To export a recording, the admin reads its playlist
  and segments through the node the manager designated for the catalogue, the one it already reads
  the catalogue and thumbnails through. It reads; it never stamps, pays or moves anything.
- **The stack's uploader** runs on each stage. When an encoder connects, it asks the admin which
  stream that is, checks the stream's key, and uploads the broadcast. It reports to the admin when
  the broadcast goes live and when it ends, and each rung of an adaptive bitrate ladder reports its
  own feed.

## Who writes what on Swarm

A viewer finds streams in the catalogue, a Swarm feed holding one JSON list of entries, and plays a
stream from its own manifest feeds. Two writers on one feed fork it, because each would take the
same next index. So the writing is split:

- **The admin is the only writer of the catalogue.** It signs it with the brand key, a key that
  never leaves the admin. It takes the next index from its own record of every write, never from a
  Bee node, because a node's view of a feed can lag a write it just made.
- **The uploader is the only writer of each stream's feeds.** Each stage signs with a key of its own,
  and a stream takes its stage's address as its owner, so the owner on the catalogue entry is the
  owner of the feeds the viewer plays. The admin holds no stage's key.
- **The uploader reports, the admin rewrites the entry.** A state report moves the stream to live
  or recorded, and the admin writes that onto the stream's catalogue entry. With an adaptive bitrate
  ladder, the stream's topic is the topic of the master playlist, each rung's feed topic is derived
  from it and the rung's name, and the admin merges the rungs' reports onto the entry.

A stream is a row in Postgres first and a catalogue entry second. An operator drafts it, and
publishing writes the entry. A write that fails leaves the row as it was, with the reason, to try
again.

## Exporting a recording

A broadcaster wants their recording as a file, to cut it and post-process it. The admin exports one
quality of a finished recording, published or not, into an MP4, and keeps it on its server so any
user can save it, as often as they like, without reading Swarm again. The [backend's
README](../../apps/web2-admin/backend/README.md#exporting-a-recording) has the routes, the states
and the settings.

- **The admin does it, through the catalogue node.** Everything an export needs is already the
  admin's: each stream's owner, each rung's feed and the slot its recording is in, the lengths and
  bitrates the estimates come from, and the users. It reads through the node the manager designated,
  so it carries no Bee address of its own.
- **One export at a time, for the whole admin.** One node reads it, and a second export would only
  halve the speed of both. While one is reading, paused or waiting, nobody can start another, and
  every signed-in user sees it in the header of every page. An archive takes the
  same place, so neither starts while the other holds it ([Archiving a recording](#archiving-a-recording)).
  A finished export's panel offers "Archive this quality", since the recording is on the node then.
- **The last file is kept.** The finished MP4 stays until it is cleared or the next export starts
  and replaces it, so saving it again costs no Swarm read. Its stream's page shows it above the OBS
  details. A user can clear it from the panel or from that card, which asks first and deletes it for
  everyone, and then export that quality again.
- **A kept file says when it is out of date.** The export remembers which recording playlist it
  read. Once the stream is live again, the card, the panel and the widget say the file holds the
  earlier recording, and once it has recorded again, that the file is out of date. The file can be
  saved and cleared as before, and a new export of that quality replaces it.
- **It never fails, it pauses.** Segments that cannot be read, a stream that goes live again while
  the export reads or joins, a full disk or any other problem pause the export with the reason,
  keeping everything read. The panel comes to front for the user who started it, and a user
  decides: try again, save what was read as a partial file, wait until the stream finishes, or
  cancel. Saving what was read is the answer to a stream that went live, so it finishes even while
  the stream is live.
- **Nothing is re-encoded.** ffmpeg copies the segments into the MP4 as the viewers got them. A seam
  between sessions of one broadcast, a gap the uploader left, or a stretch that could not be read
  becomes a cut.
- **A playlist names references, not addresses.** Only the Swarm reference of each segment is read,
  through the node, so a recording can never make the admin fetch an address of its choosing.

## Archiving a recording

A stage's batches are mutable and short lived, so a recording lasts only while they do. The admin
archives a finished recording, quality by quality, onto an archive stamp: an immutable batch on the
brand's catalogue node that the admin buys, tops up and dilutes. The copy is byte for byte, so every
address stays the same, and the catalogue entry, the viewer and the export read an archived
recording exactly as before. The shapes and the routes are in
`apps/web2-admin/common/src/archive.ts`.

- **A user starts it, by hand,** for one stream, and picks the qualities.
- **It runs in the admin as a background job,** like the export, and shares the export's widget.
- **A quality is archived once Bee reports every one of its chunks synced** to Swarm.
- **The archive stamp alone keeps the chunks on Swarm.** The node pins none of them.

The copy outlives the stage's batch because Bee's reserve keeps one chunk under several stamps, with
one item per batch. When the stage batch expires, eviction removes that batch's item only, and the
bytes stay while the archive stamp's item holds them (Bee 2.8 `reserve.go`, `EvictBatchBin`,
`chunkstore.Delete`).

### What is copied

Per quality, one row of `stream_renditions` or the stream itself for a single-quality recording:

1. **The playlist slot.** The single-owner chunk at `keccak(keccak(topic, index), owner)`, with the
   stream's owner, the quality's topic and its `manifest_index`. It is written with
   `POST /soc/{owner}/{identifier}?sig=`, with the signature it already carries, so the copy needs
   no key.
2. **The playlist root.** A playlist above 4096 bytes is a single-owner chunk that wraps a root
   chunk. The root is rebuilt from the slot's payload and span, its address computed, and posted
   with `POST /chunks`. The export reads a playlist through this root.
3. **The playlist tree** under that root.
4. **Every segment** the playlist names: its root, intermediate chunks, data chunks and parity
   chunks. A parity chunk is copied and never opened. Which references are parity follows from the
   erasure level in the chunk's span and Bee's parity tables (`pkg/file/redundancy/level.go`).
   Segments are level 1 and playlists level 0, and the level is read from each chunk.

Every job starts, with its first quality and under that quality's tag, with **the master playlist
slot**, at the stream's own topic and `manifest_index`, as it is, and **the stream card's frame**: the
playlist slot, root and tree of the quality the master lists first, and its first segment that is
not a gap. That quality is found as the viewer finds it, by the first variant's topic, and read at
its rung's `manifest_index`. Both are posted on every pass, whatever qualities the job archives: a
chunk posted again under the same stamp takes no more room. The frame stays outside the quality's
counts. A frame that cannot be copied is logged and left out.

Every post must answer the address the job expected, and any other answer stops the quality.

An uploaded thumbnail and the catalogue already live on the catalogue batch. Feed slots below the recorded
index stay with the stage, since a recording is read by index. The ladder's time markers serve a
live stream alone, and a player of a recording reads none.

The stack player reads an archived recording only at the slots the catalogue entry names: each
quality's final playlist at its `renditions[].index`, which lists every segment, and a single-quality
recording's at the entry's `index`. It reads no earlier slot and no feed head, so the recording plays
after its stage batch has expired. A quality that was not archived is dropped once its stage batch
has expired, and the archived ones play.

| Reader                                                     | How it finds a quality's playlist                                     |
| ---------------------------------------------------------- | --------------------------------------------------------------------- |
| The export                                                 | `stream_renditions.manifest_index`, then the root through `/bytes`    |
| The event viewer and the stack player, for a listed stream | the catalogue entry's `renditions[].index`, which is that same column |
| The stack player, for a listed single-quality stream       | the catalogue entry's `index`                                         |
| Any reader of an unlisted stream                           | the master feed's head                                                |

The master playlist names every recorded quality with no slot, and the stage key signs it, so the
copy is the playlist as it stands. The catalogue entry says which qualities are archived.

### Archive stamps

An archive stamp is an immutable batch on the catalogue node, kept by the manager as an archive
batch (`apps/infra-manager/docs/features/stages.md`, "Archive batches"). There can be any number,
of any depth. The manager pushes them inside the catalogue stamp record, which the admin keeps
whole, so the archive stamps are the record's `archiveBatches`. The admin copies onto a stamp the
record calls `writable`: a usable, unexpired one on the catalogue node.

The admin buys them. The catalogue node pays from its own wallet, and the manager carries the
purchase out through that node's Bee API ([funding.md](funding.md)). One buy dialog serves two
places:

- **The Stamps tab**, where the "Archive stamps" group has a "Buy archive stamp" button. The
  purchase goes to the admin's own purchase route, which asks the manager.
- **The archive panel**, which offers the archive stamps that have room, or "Buy a new archive
  stamp" sized to the selection. The confirm goes to the job, which owns that purchase and asks the
  manager.

The dialog works like this:

1. **Size.** In the archive panel the depth starts at the smallest whose capacity holds the measured
   chunks plus a 5% margin, and the user can pick any deeper one. On the Stamps tab the user picks
   among all depths. Each choice shows its capacity and its cost. The capacity table is
   `packages/contracts/src/archiveCapacity.ts`: an immutable batch refuses a chunk when that chunk's
   bucket is full, so it holds less than its `2^depth` stamps.
2. **Duration.** The user picks days, `ARCHIVE_BUY_DEFAULT_DAYS` by default, 2 at least.
3. **Cost.** Each chunk gets the price of every block of those days, and the batch costs that
   amount for each of its `2^depth` stamps, in xBZZ, plus gas in xDAI. The dialog shows the cost,
   the catalogue node's wallet balances, and what is missing when they fall short.
4. **Confirm.** A confirm dialog without the password, as for a top-up, since the node pays. The
   choice is the depth, the days and the cost the dialog showed. The API prices it again, and
   refuses a cost that is another by then, so the cost the user confirmed is exactly what is spent.
   The node's wallet is the most a purchase can spend, and only a password-confirmed transfer from
   the brand wallet fills it.
5. **Buy, then wait.** The admin records the purchase and asks the manager. A new batch is usable
   some minutes after its transaction, and the Stamps tab shows it as being bought, then waiting to
   be usable.

| Case                                              | Outcome                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| The wallet lacks xBZZ or xDAI                     | refused before the node is asked, with the amount missing                                                        |
| The node does not answer                          | the purchase fails, and nothing was spent                                                                        |
| The node does not buy the stamp                   | the purchase fails, in Bee's words from the manager's status route when it gives any                             |
| The manager stops between asking and the answer   | the manager finds the batch on the node by the purchase's own label and settles it, or fails it after 30 minutes |
| The price moved since the dialog priced the stamp | refused with the cost now, to confirm again                                                                      |
| The batch does not become usable in 30 minutes    | an archive job waiting for it pauses with the reason                                                             |
| Another operation is under way on the node        | refused in the manager's own sentence when it sends one, to try again once it has ended                          |
| The manager offers no purchases                   | the dialog says so, as a manager older than archive stamps answers                                               |

### The job

One job exists at a time for the whole admin, an export or an archive. An archive is started from
the stream's page, from the Archive page, or from the download panel's finished export, where the
recording is already on the node and every chunk of it is readable.

| State                      | What happens                                                                                                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `measuring`                | reads each segment root's span and level, which gives the bytes and an upper bound of the chunks, and proves each segment's root is on Swarm before any postage is spent. A chunk deeper in a segment that cannot be read shows while copying, as the `unreadable` pause |
| `awaiting_purchase`        | with "Buy a new archive stamp": the buy dialog comes to front with the sized stamp, its cost and what the wallet lacks, for the user's confirm                                                                                                                           |
| `buying`, `waiting_usable` | the purchase runs, then the job waits until the batch is usable and the manager lists it as writable, which can come later, since the manager may list a new batch while Bee still has it pending. Thirty minutes after the purchase it pauses as `batch`, saying why    |
| `copying`                  | chunks are read through the catalogue node and posted to it under the archive stamp                                                                                                                                                                                      |
| `verifying`                | waits for Bee to report every posted chunk synced                                                                                                                                                                                                                        |
| `paused`                   | stopped, with a reason                                                                                                                                                                                                                                                   |
| `waiting`                  | the stream went live again, and the job continues once it is a recording again                                                                                                                                                                                           |
| `done`                     | every picked quality is complete, or complete with reduced protection                                                                                                                                                                                                    |

It never fails, it pauses, and a user decides. The panel comes to front once per pause for the user
who started it.

| Reason       | When                                                                      | Choices                                     |
| ------------ | ------------------------------------------------------------------------- | ------------------------------------------- |
| `user`       | a user paused it                                                          | Resume, Cancel                              |
| `unreadable` | a data or tree chunk was neither read nor rebuilt                         | Try again, Cancel                           |
| `live`       | the stream went live again                                                | Wait, Cancel                                |
| `batch`      | the stamp is not usable yet, expired, unread, full, removed or lacks room | another stamp, a new one, Try again, Cancel |
| `node`       | the catalogue node does not answer or is designated anew                  | Try again, Cancel                           |
| `funds`      | the catalogue node's chequebook is under the floor                        | Try again after funding it, Cancel          |
| `problem`    | anything else, such as a tag that stopped moving                          | Try again, Cancel                           |

Chunks already copied stay on Swarm whatever the user chooses, and the quality shows as partial.

- **One place for a job.** The export and the archive take one shared lock at start, check that the
  other holds no place, then begin. A kept export file holds none. An archive that a user paused,
  or that waits for the user's confirm of a purchase, gives its place up, so an export can run
  meanwhile, and it resumes from its ledger once the place is free. Any other pause keeps the place.
  The widget shows the running job, and a paused archive beside it.
- **Tag.** Each quality gets one Bee tag. Every post of that quality carries `swarm-tag`, the feed
  slots included, and no `swarm-deferred-upload` header. With a tag Bee defers the push, and the tag
  counts it: `split` counts every post, a chunk posted again included.
- **Push window.** The job stops posting while the tag's `split` is more than
  `ARCHIVE_PUSH_WINDOW_CHUNKS` ahead of `synced` and `seen` together. The catalogue node also
  publishes the catalogue for live stages, and this keeps its push queue short.
- **Rebuilding.** A data chunk the node answers not found for comes back by reading its segment
  through `/bytes`, which makes Bee restore it from parity, then reading the chunk again.
- **Lost parity.** A parity chunk the node answers not found for is tried once more before its
  segment goes into the ledger, then counted and left out. The quality then completes with reduced
  protection.
- **Node outage.** A read the node does not answer, of any chunk, is no sign the chunk is lost: the
  job pauses as `node`, and nothing counts as lost or unreadable.
- **Resume.** The ledger is the list of segments done. A segment restarts whole, which costs pushes
  and no room, because Bee's stamper keeps one stamp per batch and chunk. A chunk posted again
  after it synced is pushed and counted in `synced` again. One posted again while its first post
  still waits is counted in `seen`, and the first post syncs. After a restart the job takes the
  tag's `split` as the posts it made, since Bee counted every post it answered.
- **Complete.** A quality is complete when no data or tree chunk failed, the tag's `split` equals
  the posts the job made under it, and its `synced` and `seen` together equal its `split`. The
  posts the job made are the larger of the count it saved and the tag's `split`, which a restart
  reads, and a `split` below the saved count means the node lost count, so the quality restarts
  under a new tag. A complete row in `stream_archives` is what "archived" means.
- **A tag the node no longer knows.** The quality takes a new tag and is posted again from its
  first segment, which costs pushes and no room.
- **Room.** Room on a stamp is its capacity less the sum of the node's `GET /stamps/{id}/buckets`.
  `utilization` and `fillRatio` name the fullest bucket. One quality goes whole onto one stamp. A
  chunk already on the stamp takes no room, so for a stream that recorded again the estimate is an
  upper bound.

### What it costs

The archive stamp is postage, bought and topped up by the user. The copy itself costs bandwidth:
the catalogue node pays its peers from its chequebook to read and to push, about 300,000 accounting
units a chunk to read and 388,000 to push. A node's free time allowance covers part of it, more of
it the slower the copy runs.

| Per 1080p hour, about 2.7 GB with parity        | Recording on the node | Recording read from Swarm |
| ----------------------------------------------- | --------------------- | ------------------------- |
| Measured on a light node with about 90 peers    | about 0.5 BZZ         | about 0.75 BZZ            |
| With nothing covered by the free time allowance | about 2.6 BZZ         | about 4.7 BZZ             |

- The panel shows an estimated range before a start and warns when the chequebook holds less.
- Under `ARCHIVE_CHEQUEBOOK_FLOOR_BZZ` the job pauses with reason `funds`. An empty chequebook
  raises no error, and the catalogue's own writes need it too. The Chequebooks tab funds it.
- A finished job shows what the chequebook went down by. The catalogue's writes share it, so the
  figure is approximate.

The push to Swarm sets the pace. With a tag the posts are deferred, and Bee's own pusher pushes
them, at 130 to 200 chunks a second, 0.5 to 0.8 MB/s, on a light node with about 90 peers. A 1080p
hour, about 650,000 chunks, then takes 55 to 85 minutes. `ARCHIVE_PARALLEL_CHUNKS` bounds the
reads and the node's stamping, 16 at once. For a recording read from Swarm the reads through one
light node, about 0.57 MB/s at 16 at once, can be the limit instead. A host's rate follows its
network and its peers. The panel estimates from the rate the last job measured.

### What a stream shows

| State    | Meaning                                                                                        | Badge in the stream list     |
| -------- | ---------------------------------------------------------------------------------------------- | ---------------------------- |
| none     | nothing copied                                                                                 | none                         |
| partial  | a copy stopped before it was complete                                                          | Archive incomplete           |
| complete | at least one quality complete at its current index                                             | Archived                     |
| reduced  | complete, with parity chunks missing                                                           | Archived, reduced protection |
| unlisted | complete, on a stamp the manager no longer lists, before the end last read for it              | Archive stamp not listed     |
| outdated | the stream recorded again after the copy                                                       | Archive outdated             |
| expired  | the stamp's reading says expired, or the end last read for a stamp no longer listed has passed | Archive expired              |

A stamp the manager no longer lists, once removed in the manager, with its deployment gone, or left
out of a full record, where the expired ones go first, is `unlisted` while the end the admin last
read for it is still ahead, and `expired` once it has passed. Each catalogue stamp record that
arrives gives every copy on each archive stamp it lists that stamp's end, its `observedAt` plus its
time to live, or its `observedAt` once it reads expired or gone, so the latest reading wins: later
after a top-up, sooner after a dilution. The admin keeps it with the copy, so it outlives the
stamp's place in the record. With no end read, a copy whose stamp is not listed stays `unlisted`: its
recordings stay on Swarm until the stamp runs out. `unlisted` counts as archived, for the badge and
for the switch, and the card and the Archive page say it cannot be topped up from the admin;
`expired` does not, and the quality can be archived again. A catalogue stamp record without
`archiveBatches`, from a manager older than the field, tells nothing of the archive stamps, so no
copy reads as expired or unlisted from it.

- **Archive page.** Only streams with an archive: title, date, qualities, size, stamp label, the
  stamp's time left, archived at and by. A user archives more qualities there, and archives again
  when a copy is outdated. A copy stays on its stamp for the stamp's life.
- **Stream page.** An archive card with each quality's state, the start action and the switch.
- **List only archived qualities.** A per-stream switch, set by hand, off by default, offered once
  one quality is archived. On, the catalogue entry lists the archived qualities only, which the
  players honour: a quality without an index is not offered. With no quality archived any more, it
  lists every quality, as with the switch off, and never none. The card hints at it when a stage batch
  that holds an unarchived quality reads expired.
- **A stamp running low or out.** Nothing is funded by itself. Under `ARCHIVE_TTL_WARNING_DAYS` the
  Stamps tab group, the Archive page and the stream's archive card warn. An expired stamp turns its
  streams to "Archive expired". A full stamp pauses the job with the dilute hint.

### What it keeps

| Table                     | Holds                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stream_archives`         | one row per stream and quality: the stamp, the playlist slot copied, partial or complete, what the copy holds, and when its stamp runs out as last read |
| `streams.archived_only`   | the "List only archived qualities" switch                                                                                                               |
| `archive_jobs`            | at most one row: the stream, the stamp or the purchase, the state, the pause, who started it                                                            |
| `archive_job_items`       | one per picked quality: its state, its counters and its tag                                                                                             |
| `archive_job_segments`    | the segments done, which is the resume ledger                                                                                                           |
| `archive_stamp_purchases` | each purchase, written before the manager is asked                                                                                                      |
| `archive_rate`            | the rate the last job measured                                                                                                                          |

Its settings are `ARCHIVE_PARALLEL_CHUNKS` (16), the chunks read and posted at once,
`ARCHIVE_PUSH_WINDOW_CHUNKS` (2000), `ARCHIVE_CHEQUEBOOK_FLOOR_BZZ`, `ARCHIVE_TTL_WARNING_DAYS` (30)
and `ARCHIVE_BUY_DEFAULT_DAYS` (30).
Every action goes to the audit log, with times in UTC.

## Lost recordings

A recording lives on Swarm while a batch that stamped it has time left. When a stage's batches run
out, the network drops its recordings, and the admin still lists them. The Streams page finds them
and removes them.

**Check recordings** is started by a person, and one check runs at a time for the whole admin.

- **What it reads.** Through the catalogue node, each recording's own playlist, the master playlist
  of a ladder, and for each quality its playlist and the first 64 KiB of its first segment. A recording copied onto an
  archive stamp reads from there, so it is found readable.
- **Three rounds.** Every recording is read once. The ones that failed are read again ten minutes
  later, and what still failed ten minutes after that (`RECORDING_CHECK_ROUNDS`,
  `RECORDING_CHECK_ROUND_GAP_SECONDS`). Only a failure in every round counts, so a slow read or a
  node that was out of step for a moment loses nothing.
- **A healthy node.** A check starts, and goes on to its next round, only while the catalogue node
  is connected to 4 peers or more (`RECORDING_CHECK_MIN_PEERS`). A node with fewer reads nothing
  whatever is on Swarm, so the check stops with no result and says so.
- **Which streams.** One rule decides, `recordingSkipReason`: a live stream, a stream inside its
  restart window and a stream with an export or an archive under way are left unjudged.
- **The result.** **Lost**: the master playlist failed in every round, or every quality did.
  **Partly lost**: some quality failed in every round and another was read; it is listed with the
  qualities that failed and left alone. The stream's row carries the mark until the stream goes live
  again or a later check reads it.

**Remove lost recordings** opens a confirm that lists the lost recordings of the latest check, which
is good for six hours (`RECORDING_CHECK_VALID_SECONDS`).

- Each stream is asked the rule again and read once more, and one that reads now, or that may not
  be judged now, is kept and named with the reason.
- The rest leave the catalogue in one write.
- A stream with an export file on the server stays, as a draft off the catalogue, with its file.
  Every other is deleted.
- Each removal is audited.

The removal needs a catalogue that can be written. While the catalogue batch has run out the page
says to buy a new catalogue batch first ([funding.md](funding.md#buying-a-new-batch)).

## What it does not do

- It never holds a node's key and never touches a host. Postage, cheques, ssh and Docker all belong
  to the manager. The one wallet the admin holds is the brand wallet, and it signs with that alone.
- It does not provision or stop a stage, buy a stage's batch or the catalogue's, or choose the
  catalogue's batch. The manager pushes what it runs, and the admin reads it. An archive stamp is
  the one batch the admin buys, and the manager carries the purchase out.
- It carries no stage in its settings: no ingest address, port or passphrase, Bee address or batch
  id. It learns them from the manager's pushes, and refuses to publish, saying why, until the
  manager has designated a catalogue batch.
- It serves no live media. Ingest, the bitrate ladder, packaging and upload live on a stage host,
  and viewers play from Swarm. The one file it serves is an exported recording, to a signed-in user.
- It serves one installation. Every signed-in operator can act on every stream, and the audit log
  records who did.
- It is not deployed by the manager. Its deploy script takes the manager's flags and is run by hand
  ([the deploy guide](../../apps/web2-admin/deploy/README.md#deploying)).

## The stack it is built on

The admin follows the manager's conventions where a choice is arbitrary, so the two read as one
codebase: TypeScript and ESM with exact-pinned dependencies in the repository's pnpm workspace,
Express 5 with `pg` and yup, SQL migrations run at startup, `node:test` through tsx, and a React,
MUI and Vite console. Sign-in shares its code with the manager through `packages/web-auth`.
