# @streaming-monorepo/web2-admin-frontend

The console of the admin: the web app a brand's operators sign in to. This page says how to run
and develop it, what each of its pages does, and how its looks are built. It is a React 19, MUI 9
and Vite single-page app. It talks to [the backend](../backend/README.md) over `/api` and takes its
types from [`../common`](../common/).

## Run it

```bash
pnpm install                                               # anywhere in the repository, once for the whole workspace
pnpm --filter @streaming-monorepo/web2-admin-frontend dev  # http://localhost:5081
```

The dev server proxies `/api` to `VITE_WEB2_ADMIN_URL`, which defaults to `http://localhost:9877`,
the backend's port. To point it elsewhere:

```bash
VITE_WEB2_ADMIN_URL=http://127.0.0.1:9877 \
  pnpm --filter @streaming-monorepo/web2-admin-frontend dev
```

### Without the backend: the mock API

`scripts/mock-api.mjs` stands in for the backend with no dependencies, keeping everything in
memory. It is for working on the console only: it does not validate the way the backend does, and
it is not the contract. Use it to click through the console without Postgres or a Bee node:

```bash
node frontend/scripts/mock-api.mjs                         # from apps/web2-admin, listens on 127.0.0.1:9877
pnpm --filter @streaming-monorepo/web2-admin-frontend dev
```

From this package, `pnpm mock-api` does the same. Sign in as `admin` with the password
`admin1234`. Nothing deployed the mock, so its build line reads `Version development build`.

| Variable               | Default                  | What it does                                                                                                                                         |
| ---------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MOCK_API_PORT`        | `9877`                   | the port it listens on                                                                                                                               |
| `SEED_ADMIN_USERNAME`  | `admin`                  | the user it starts with                                                                                                                              |
| `SEED_ADMIN_PASSWORD`  | `admin1234`              | that user's password, which the console can change                                                                                                   |
| `MOCK_NO_USERS`        | unset                    | `true` starts with no users, the only way to see the console's "no users yet" screen                                                                 |
| `MOCK_NO_STAGES`       | unset                    | `true` starts with no stages: the Stages page's empty state, and a stage picker with nothing to pick                                                 |
| `MOCK_RECORDING`       | unset                    | `true` adds one more recording, which ended on 2026-09-11 and is finalized at start, beside the [seeded streams](#the-mock-streams)                  |
| `MOCK_FUNDING`         | unset                    | `off` shows the Funding page's "not set up" state. `refuse` and `lost` play the two failures, as [below](#the-mock-funding)                          |
| `MOCK_ARCHIVE`         | `off`                    | the archive seeded at start, as [below](#the-mock-archive): `off`, or a job state such as `copying` or `paused_batch`                                |
| `MOCK_EXPORT`          | `running`                | the export seeded at start, as [below](#the-mock-export): `running`, `paused`, `done`, `outdated` or `off`                                           |
| `MOCK_ARCHIVE_STAMPS`  | `some`                   | the archive stamps, as [below](#the-mock-funding): `some`, `none`, `buying`, `left` or `unoffered`                                                   |
| `MOCK_BATCH_PURCHASES` | `fresh`                  | Buy new on the Stamps tab, as [below](#the-mock-funding): `fresh`, `stages`, `failed`, `failed_ran_out`, `catalogue`, `catalogue_off` or `unoffered` |
| `MOCK_RECORDING_CHECK` | `none`                   | the latest check of the recordings, as [below](#the-mock-recording-check): `none`, `running`, `done` or `stopped`                                    |
| `MOCK_NOTIFICATIONS`   | `set`                    | the notification services and the people counted, as [below](#the-mock-notifications): `set`, `none` or `unavailable`                                |
| `MOCK_DEFAULT_THEME`   | `swarm`                  | the host's default look `GET /api/config` answers. The mock checks no name. Set `web3privacy` to see a host's default at work                        |
| `VIEWER_BASE_URL`      | `http://localhost:10074` | the "open player catalogue" link. It must be a viewer built for this catalogue                                                                       |

#### The mock streams

Every start seeds three published streams on the catalogue, on the mock stage or, with
`MOCK_NO_STAGES`, on none. They show the states the stream page tells apart once a stream has gone
live:

- "Live now", live since 12 minutes before the start.
- "Ended a few minutes ago", which ended 5 minutes before the start and can go live again until 25
  minutes after it.
- "Ended days ago", which ended 3 days before and is finalized at start with a new key.

Four more recordings, which ended days or weeks before the start, carry an archive each, as
[below](#the-mock-archive).

So a default run never shows the Streams list's "No streams yet." state, and the live seed cannot
be deleted (`409 stream_live`, as the API answers).

Every stream carries `finishedAt`, null until it is finalized, and `restartUntil`, `endedAt` plus 30
minutes while it is `vod` and not finalized, and null otherwise. The window is fixed at 30 minutes,
the API's default, and the mock reads no `STREAM_RESTART_WINDOW_MINUTES`. Its sweep runs at start
and before every request under `/api/streams`. It finalizes every `vod` whose 30 minutes have
passed, or that has no `endedAt`, with a new key, and sets `publishKeyRotatedAt` and `finishedAt` to
that moment.

`POST /api/streams/:id/finish`, Finalize, does the same at once on a recording not finalized yet,
and answers `200 { stream, ingest }` with the new key. A live stream is `409 stream_live`, as on a
real host: the page keeps Finalize disabled on "Live now", and a call made anyway is refused. A
draft, published or publishing stream is `409 stream_not_started` and a finalized one
`409 stream_finished`. Each refusal is answered `{ error, id, message }` with the API's sentence.
An unknown id is `404 not_found`, the mock's own convention where the API answers
`stream_not_found`. Rotate key, Unpublish and Republish leave `finishedAt` as it is, and nothing in
the mock goes live, so nothing clears it.

#### The mock funding

Unless `MOCK_FUNDING` is `off`, the mock holds a brand wallet and the mock stage's nodes, one in
each address state. It takes the seeded password and locks it out for a minute after four wrong
ones. It answers every transfer, stamp operation and chequebook move with `settled` and `watched`
as the API works them out, names an open one in `openBulkId`, `openStampBulkId` or
`openChequebookBulkId` until it settles, and refuses another of the same kind until then.

- **Balance.** A send is confirmed in a block six seconds after it is made.
- **Stamps.** The view answers today's price of postage. The nodes hold one batch of each kind the
  tab shows: the catalogue's, an immutable one whose 30 days cost more than its node holds, one no
  dilution leaves 7 days, an expired one, and one its node could not be read about. A stamp bulk is
  checked as the API checks it, then sends its operations two seconds apart and confirms each six
  seconds after it is sent, when the batch gains its days or its depth and its node pays.
- **Archive stamps.** `MOCK_ARCHIVE_STAMPS=some`, the default, puts three on the catalogue node:
  "Talks", depth 22 with 200 days and room, "Spring", depth 20 with 120 days and nearly full, and
  "Autumn", depth 21 with 20 days, under the 30-day warning. `none` has none. `buying` adds a depth
  19 purchase, "Summer", waiting to be usable, which turns into a stamp 10 seconds after the mock
  starts. `left` adds "Old node", left on the mock stage's uploader, a node that is the catalogue
  node no longer, topped up only. `unoffered` answers every purchase as a manager that offers no
  purchases does. A purchase from the buy dialog is checked as the API checks it, the cost it names
  priced again, so a cost that differs is refused as a moved price. It is being bought for 5
  seconds, waits to be usable for 10 more, then is a stamp, its cost taken from the catalogue
  node's wallet. `MOCK_FUNDING=refuse` fails every purchase.
- **Buy new.** Every node but a gateway carries the manager's recommendation, the depth and kind of
  its batch. The 720p rung's batch has run out, and its wallet holds no xDAI, so its dialog says so
  and offers Fund it; a 480p rung has no batch at all. A purchase is checked as the API checks it,
  its cost priced again, and is being bought for 5 seconds, then waits for the network for 12. A
  rung's batch is then set on its node and the mock stage's uploader restarted in 4 seconds, or,
  while "Live now" is live on the stage, it waits for Restart now. A catalogue purchase moves the
  catalogue a slot a second, clears one thumbnail on the way, and releases the previous batch 3
  seconds after the move, which the Stages page shows too. `MOCK_BATCH_PURCHASES` seeds:
  - `fresh`, the default: no purchase yet.
  - `stages`: a 720p purchase restarting, with a stage line in each state: waiting for a broadcast,
    unknown, other settings waiting, applied, failed (with Check again), set by hand, stopped.
  - `failed`: a 720p purchase whose batch was bought and did not become usable in time.
  - `failed_ran_out`: the same purchase, its bought batch gone from the node since, so the row
    offers Buy new again and the line says why, with no Check again.
  - `catalogue`: the catalogue batch has run out, the move is on, and a purchase of its replacement
    is moving the catalogue.
  - `catalogue_off`: the catalogue batch has run out and the move is off, so its row says so.
  - `unoffered`: every purchase is refused as by an admin whose manager offers none.
- **Chequebooks.** The catalogue node's chequebook holds 1 xBZZ. Against a target of 2 xBZZ, the
  stage nodes hold a chequebook under it (whose node
  cannot pay a deposit to a target over 5.4 xBZZ), one over it, one at it (whose node holds no xDAI
  for gas), one whose node could not be read, a light gateway's shown read-only, and an ultra-light
  gateway with none. A chequebook bulk is checked as the API checks it, sends its moves two seconds
  apart, reports each `mined` two seconds after it is sent and confirms it six seconds after that.

- **Auto top-up.** The numbers start saved by the seeded user at 21 days under and 42 to, so four
  stamps not on auto top-up read as running low: the mock stage's uploader and 360p batches, the
  720p one, which has expired, and the archive stamp "Autumn". The catalogue batch starts marked.
  The three jobs ran at the last 10 minutes and found nothing to do, and no warning stands: the mock
  tops nothing up and sends nothing. Saving the numbers takes the seeded password, a switch pauses a
  job, and marking a stamp on the Stamps tab takes it off the list of stamps not on auto top-up.

With `MOCK_FUNDING=refuse`, every transfer fails at the relay with no block and is then mined
anyway six seconds later, and every stamp and chequebook operation is refused. With
`MOCK_FUNDING=lost`, every operation is first not known, as when the manager loses the chain's
answer, then sent three seconds later and confirmed.

#### The mock notifications

The Notifications page and the notices on the Auto top-up tab work as the API holds them: two shared
services, which `admin` saves behind the password, switches and removes, and each user's own email
address, Telegram chat and ticks. Of the other users the view answers numbers alone.
`MOCK_NOTIFICATIONS` seeds them:

- `set`, the default: both services saved by `admin` and on, the email service with a failure a day
  old, and three people the mock makes up, with no account, whose destinations and ticks count in
  the numbers and nowhere else: two get the four notices of stamp auto top-up by email, one of them
  on a Telegram chat as well, which failed its last notice and has one waiting, and "Stage stamps";
  the third gets "A top-up failed" on Telegram.
- `none`: no service saved, and nobody else.
- `unavailable`: as `none`, and the page says no service can be saved, as an admin without
  `BRAND_WALLET_SECRET` does.

Each user starts with no destination and no tick, and their first saved address ticks the four
notices of stamp auto top-up. A test notice goes out unless the address holds `fail`, and a second
within a minute is refused. Find my chat shows a code for the mock's bot, and finds your own chat
once 5 seconds have passed since the code started. To see the page as a user without the admin
role, add one on the Access page and sign in as them. The mock sends nothing anywhere and keeps no
secret.

#### The mock recording check

A check reads a recording a second and waits 5 seconds between its rounds, where the API waits ten
minutes. Of the seeded recordings, "Ended days ago" and "Last year's meetup" read as lost, the first
with an export file kept on the server as far as the check is told, and "Panel discussion" as
partly lost, its 1080p unread. Live streams and those inside their restart window are left
unjudged. A removal deletes the lost recordings, keeps the one with an export file as a draft, and
writes the feed once. `MOCK_RECORDING_CHECK` seeds the latest check: `none`, the default, none yet;
`running`, one started at start; `done`, one that has ended with that result; `stopped`, one that
stopped on the catalogue node's peers. The removal is refused while the catalogue batch has run out,
as with `MOCK_BATCH_PURCHASES=catalogue`.

#### The mock export

The mock exports as the API does, one export at a time: it reads for 45 seconds, joins for 5, and
keeps the file until the next export starts. Every quality is offered, 1080p to 360p, with sizes
estimated from the recording's length. `MOCK_EXPORT` decides the export seeded at start, of the first
seeded recording:

- `running`, unset: a 720p export another user started, so the header shows one moving at once.
- `paused`: one the seeded user started, which pauses on segments it could not read, so the panel
  comes to front. Every export started from the panel then pauses the same way part-way.
- `done`: a kept file, above the OBS panel of its stream and in the header.
- `outdated`: a kept file its stream recorded again after, which says it is out of date.
- `off`: none.

Save file answers a stand-in file under the export's name, not a video.

#### The mock archive

The mock archives as the API does, one archive at a time, sharing the place a job has with the
export: it measures for 6 seconds, copies for 60 and verifies for 8, and a new stamp is bought in 6
seconds and is usable 6 seconds later. The archive panel offers the catalogue node's archive stamps:
"Archive 2026", depth 22, with room; "Short talks", depth 20, nearly full and under the 30-day
warning; and "Old archive", expired, which is not offered. A new stamp is priced at the funding
mock's price of postage, from a catalogue node wallet of 10 xBZZ, and a confirm at another cost is
refused as `price_moved`, with the cost now. The panel reads the catalogue node's chequebook at 2
xBZZ, or at the archive's own reading while one exists (0.4 xBZZ with `MOCK_ARCHIVE=paused_funds`).
Its answer lists 1080p of "Ended days ago" on "Short talks" as well as on "Archive 2026", the further
copy the Archive page lists too, so the panel's copy mode shows a stream with copies on two stamps.
The mock's start still refuses a quality that is archived, so it starts no further copy.

The recordings carry an archive each, whichever `MOCK_ARCHIVE` is:

- "Ended a few minutes ago": none. The seeded archive is of this one.
- "Ended days ago": 1080p and 720p archived on "Archive 2026", with the hint that the stage batch of
  its other qualities has expired.
- "Workshop recording": 1080p archived with reduced protection, 12 parity chunks left out.
- "Panel discussion": 720p partly copied onto "Short talks".
- "Keynote, recorded twice": 1080p, outdated.
- "Last year's meetup": 1080p on "Old archive", expired.
- "Conference opening": 1080p on "Removed archive", a stamp in no listing, so not listed.

`MOCK_ARCHIVE` decides the archive seeded at start, of the first seeded recording:

- `off`, unset: none.
- `measuring`, `copying`, `verifying`: one another user started, moving.
- `awaiting_purchase`: one the seeded user started, waiting on the buy dialog, which comes to front.
- `buying`: one whose new stamp is being bought, which turns usable, then copies.
- `paused_user`, `paused_unreadable`, `paused_batch`, `paused_funds`, `paused_node`: one the seeded
  user started, paused for that reason. The panel comes to front for every reason but the first.
- `waiting`: one whose stream went live again.
- `done`, `done_reduced`: a finished one, the second with 12 parity chunks of 1080p left out.

The Archive page, the archive card and the panel show the same copies and images. "Ended days ago"
also has 1080p on "Short talks", beside its copy on "Archive 2026", and its image is archived; the
image of "Workshop recording" is not archived, and that of "Keynote, recorded twice" changed since the
archive. A stream with no copy shows nothing of its image, as the API answers `none` for it.

`GET /api/archive/streams` answers the Archive page, and the stream answers carry each stream's
`archive`. With the default `MOCK_EXPORT` an export runs at start, and a new archive is refused
until it is done, as the API keeps one job at a time: set `MOCK_EXPORT=off` to start one at once.

## Pages

The router is a `HashRouter`, so every route starts with `#/`.

Every page after sign-in has the same header, and it stays at the top while the page scrolls: the
console's name, which leads to the streams, the indicators of the export and the archive on the
server, the build line, and the user menu.

### Sign in, `#/login`

Username, password and Log in. The API's error text shows inline. On a database with no users the
page says so and shows the command that makes the first one.

### Streams, `#/`

Every stream of the installation, whoever drafted it: thumbnail, title with up to two lines of
description (all of it on hover), stage (retired ones marked, No stage for none), media type,
status (VOD reads "Video On Demand" on hover, here and on the stream's page) with the archive badge
under it, scheduled start, and
Edit, Details and Delete. A Stage filter narrows the list to one stage
or to the streams with none. A banner says when the catalogue cannot be written, when a move of the
catalogue to another batch is waiting, and when its batch is under 48 hours from expiry or 90% full.

A test stream (`docs/architecture/test-streams.md`) carries a "Test" mark and has no Edit, as it
stays as it was created. A live one shows "Test live" with how long it has been live, read again
every 30 seconds, and "Left running" beside it once that is more than an hour
(`TEST_STREAM_LEFT_RUNNING_SECONDS`), which says on hover that a broadcast is stopped at the encoder
or from the manager. A Show filter narrows the list to the test streams or to the event streams.
Create New Stream makes a test stream too, with its Test stream box.

The archive badge (`components/archive/ArchiveBadge.tsx`) says the stream's archive in the words of
`ARCHIVE_BADGE_TEXT`: Archived, Archived, reduced protection, Archive stamp not listed, Archive
incomplete, Archive outdated or Archive expired, and nothing for a stream with nothing copied. On hover it names the archived
qualities, and says when the catalogue lists only those. A recording the latest check of the
recordings could not read is marked Lost on Swarm, or Partly lost, with when that check ended on
hover.

**Recordings on Swarm** (`components/recordings/RecordingCheckPanel.tsx`), above the list, is the
check of the recordings and the removal of the lost ones (`docs/architecture/web2-admin.md`, "Lost
recordings"). Check recordings starts one; a person starts it, and nothing runs it in the
background. Where the admin refuses one now, the button is disabled with the reason under it. A
running check shows its round of three and what it has read, and is read again every 15 seconds.
A stopped one says why. A finished one says "N recordings lost" and "N partly lost", each a link to
its stream, a partly lost one with the qualities that failed, and how many streams it left
unjudged. Remove lost recordings, or the reason it cannot be used now, opens a confirm with the
common `LOST_RECORDINGS_REMOVAL_CONFIRM` and every recording it removes, a stream with an export
file marked as kept as a draft; it sends that list, then says what was removed, kept as a draft or
left, and reads the list again. A refused removal closes the confirm, says why, and reads the check
again, so Remove follows what the admin says now. A read of the check that fails keeps the check
last read, and its timer, and says it could not be read again. An admin that answers no checks
shows nothing of them.

### Archive, `#/archive`

Only the streams that have an archive, newest copy first, from `GET /api/archive/streams`: the
title, linked to the stream's page, with its badge and how its image stands ("Thumbnail archived",
"Thumbnail not archived" or "The thumbnail changed since the archive", and nothing for a stream with
no published image), the date, every copy of each quality, the best first as `orderArchiveCopies`
orders them, with its state, the size archived, the stamp each copy is on, by its label or its
short id, with its time left, in amber under `ARCHIVE_TTL_WARNING_DAYS`, under a copy on a stamp the
manager no longer lists the sentence that it cannot be topped up here and stays on Swarm until the
stamp expires, and when and by whom the newest copy was completed.

The Stamp filter above the list offers every stamp that holds a copy, from the same answer, with
All stamps first. A stamp chosen lists the streams that have a copy on it, with those copies alone
and the size the archived ones hold: the stamp as a collection. It filters in the console; there is
no route for it.

Archive more qualities opens the archive panel on the stream, and Archive again opens it with the
outdated qualities ticked. Copy onto another stamp, on a stream with an archived quality, opens it
with the stream's archived qualities, for a further copy onto another stamp; the copies already made
stay on their stamps. A further copy starts from this page alone. Nothing is removed from a stamp,
so there is no un-archive.

### Create and edit, `#/create` and `#/edit/:id`

- Stream Name (up to 100 characters), Description (up to 500), Tags (Enter or Add, at most 10 of up
  to 20 characters), and a thumbnail of up to 5 MB with a preview.
- Scheduled Start Time takes any day and time, past ones included. It is only shown to viewers and
  starts nothing. It is locked once the stream has gone live.
- Stage lists the stages that are not retired and are supported, and preselects the only one on a
  new stream. It is locked once the stream is published, or while it holds a recording. A stage
  whose readiness is not ready shows the manager's verdict, its reasons and when the manager last
  confirmed it, as a warning that does not block the save.
- A recorded draft with no stage is warned that its first stage is final and must be the one the
  recording was made on, and the save asks once more.
- There is no media type choice: every stream is saved as a video stream. An audio-only stream
  keeps its type once it is published or has gone live, where the API locks it.

#### The Test stream box

On Create New Stream alone, never on Edit Stream, a Test stream box sits under Stream Name,
unchecked, with a line saying a test stream goes live on its stage like any stream and stays off the
catalogue. Checked, it disables Description, Tags, Scheduled Date and Time with its shortcuts, and
the thumbnail picker, and their required checks no longer apply; Stream Name and Stage stay, and a
stage is required ("Pick the stage the test runs on."). Create Stream then sends the title, `video`
and the stage to `POST /api/streams/test`, uploads no image, and opens the test stream's page. A
refusal shows the API's sentence. Unchecked, the fields are enabled again with their values as they
were, and Create Stream makes a stream as before.

"Test this setup" on a stream's page opens `#/create?test=1&stageId=<id>`: Create New Stream with
the box checked and that stream's stage filled in, an audio-only stream's included. A `mediaType` in
the address is not read.

### Stream details, `#/streams/:id`

- The stream's details and its stage. Publish stays disabled on a draft with no stage, with a link
  to the form.
- Publish and Unpublish, with what the catalogue write did. Republish stays disabled while the
  catalogue already carries the latest edit and the last attempt did not fail. Unpublish asks
  first, and for a recording says the recording stays with the stream and is listed again on the
  next publish. An "Edited since it was published" notice shows while the catalogue entry lacks an
  edit.
- A link to the viewer's catalogue, the copyable route of this stream in the viewer, and the last
  publish error.
- Once the stream has gone live, a status notice under the title says where it stands, with
  Finalize beside it, outlined in the warning colour. Its tooltip, "Finalize streaming", shows
  while it is disabled too. Times read DD/MM/YYYY HH:mm.
  - Live: "Live since <time>" and "Finalize is enabled once live streaming has ended." Finalize is
    disabled, as on a live row that carries a finalized time.
  - Ended, while its restart window runs: "Ended — can go live again until <time>" and "Finalize
    will rotate the SRT key to protect this stream." Finalize is enabled.
  - Ended, once that time has passed and until the admin finalizes the stream, up to a minute
    later: "Ended — its restart window has run out", with the same line. Finalize is enabled.
  - Finalized: "Finalized — the SRT key has changed" and "The old SRT line is refused. To go live
    on purpose, copy the new one." Finalize is disabled.
  - A stream that never went live has no notice.
- Finalize asks first, under the title "Finalize this stream?": "Its key changes now, so no encoder
  can start it again on the old key. To go live on it later on purpose, copy the new SRT line." It
  then changes the key at once, the OBS panel shows the new SRT line, and a snackbar says "Stream
  finalized. Its key has changed." The API refuses it on a live stream as `stream_live`, which the
  page answers "Stop the broadcast first.", on a stream that never went live as
  `stream_not_started`, and on one already finalized as `stream_finished`. Each means the stream has
  moved on since the page read it, so the snackbar gives the sentence, the dialog closes, and the
  page reads the stream and its OBS details again. After any other failure the dialog stays open.
- On a finished recording, published or not, **Download** in the row under the title opens the
  Download panel, described below. Above the OBS panel, the file exported from this stream and kept
  on the server, with Save file and, under it, Clear, which asks first and deletes the kept file from
  the server for everyone; when its export started and finished, and how long it took, pauses
  included; or the export of it while it runs, with when it started. Both times are in UTC, to the
  second. A kept file that is out of date says so in an orange chip, as the panel and the header's
  indicator do: the stream is live again, or it recorded again after the export.
- On a finished recording, or a stream with an archive, the archive card, above the downloaded file:
  each quality with its state, "Archived", "Archived, reduced protection", "Archive stamp not
  listed", "Archive incomplete", "Archive outdated", "Archive expired" or "Not archived", and under
  it every copy, the best first as `orderArchiveCopies` orders them, as the Archive page lists
  them: its state, what it holds, on which stamp, completed when and by whom, and that stamp's time
  left; or, with no copy, its estimate. A copy on a stamp the manager no longer lists also says it
  cannot be topped up here and stays on Swarm until the stamp expires. Under the qualities, how the
  stream's image stands, in the Archive page's words, and nothing for a stream with no published
  image. Every stamp that holds a copy and runs out soon, a full one included, is named
  with its time left and where it is topped up: on the Funding page's Stamps tab, or outside the
  admin for a stamp left on a node that is the catalogue node no longer. A stamp that has run out
  is not, as its copy says it expired. "Archive this recording", "Archive more qualities" or "Archive again"
  opens the archive panel on the stream, described below. Once one quality plays from an archive
  stamp, the "List only archived qualities" switch: on, the catalogue lists only those qualities,
  and turning it on or off writes the catalogue entry again. When the stage batch of a quality with
  no archive has expired, the card says so beside the switch. While an archive of the stream runs,
  the card says where it stands, with a button that opens it.
- The OBS panel, with Rotate key, described below.
- Test this setup, in the row under the title, opens Create New Stream with the Test stream box
  checked and this stream's stage.
- While a test stream is live on this stream's stage, a note names it. A stage takes several
  broadcasts at once and the two share its transcoding and upload, so the note is information and
  blocks nothing. The page reads `GET /api/streams` for it, and a list that cannot be read leaves
  the note out.

#### A test stream's page

A test stream has no catalogue entry, so its page has no Publish, no Unpublish, no image, no
archive card and no Edit. Under its title, with the "Test" mark and, while it is live, the time it
has been live and "Left running" after an hour:

- The status notice and Finalize, and Download on a finished recording, as on any stream.
- A note naming any other stream live on its stage, as information.
- The OBS panel at once, from its creation: the server line with the stream id and the key.
- Watching the test. "Deploying a viewer" gives the catalogue's owner as the Feed owner, with `0x`
  in front as the manager takes it, and the catalogue's topic as the Feed topic, from
  `GET /api/config`, to deploy a viewer with in the manager's "Watch a stream"; both are the same
  for every test stream. Viewer address gives and
  changes the deployed viewer's address, any `http://` or `https://` one (`viewerUrlProblem` is
  checked before it is sent), with `PUT /api/streams/:id/viewer-url`; Clear address clears it.
  While the stream holds none, the field starts with the admin's viewer, `viewerBaseUrl` from
  `GET /api/config` (`VIEWER_BASE_URL`), to be saved as it is. A
  refused address says why under the field. Once an address is given, Watch test stream is a plain
  link to `watchPageUrl(viewerUrl, stream)`, opened in a new tab with `rel="noopener noreferrer"`.
  The console never asks the viewer whether it answers.
- The media type, the stage, when it was created, and when it was live, ended and how long it ran.

### Stages, `#/stages`

Every stage as the manager last pushed it: name and kind, the manager's readiness with its reasons,
status and the uploader's state, the ingest host and SRT port, and whether there is an SRT
passphrase (never the passphrase). Per rung, the stamp's state, its time left (aged from the
manager's reading to the API's answer) and fill, and the chequebook's health. Which token the
stage's uploader presents: its own, or `shared` in the error colour, with the fix (rotate the
uploader's admin token in the manager and redeploy the stage). Retired stages and OvenMediaEngine
ones ("Not supported yet") are marked. Under the uploader's state, each test stream live on the
stage: "Test live" with how long it has been live, "Left running" after an hour, and its title. The
page reads `GET /api/streams` for it, and leaves it out when the list cannot be read.

A card above the table shows the catalogue stamp, or says the manager has not designated one. A
batch under 48 hours left shows in the warning colour. One that is expired or gone shows in the
error colour, as does one whose last reading's time to live has run out since, which reads "Expired
by the clock". When the catalogue's history has to move to the designated batch, the catalogue move
card offers the move and follows it, or says the move is not enabled on this installation
(`CATALOGUE_MOVE_ENABLED` in the backend's settings). A move the admin started by itself for a
catalogue batch bought on the Stamps tab says so, and that its purchase releases the previous
batch. The streams whose thumbnail a move cleared, after the batch it moved from had lapsed, are
listed with a link to each, where it takes a new one. With no stages, the page says they appear
once the manager's admin link points at this admin.

### Funding, `#/funding`

Four tabs. Each keeps what is ticked and typed in it while the page stays open, and reads the
view again when it is shown. Without the manager's funding settings, the page says funding is not
set up. What the API does behind each tab is in the backend's [Funding](../backend/README.md#funding).

**Balance** sends xDAI and xBZZ from the brand wallet to the nodes' wallets.

- The brand wallet's address with Copy and a QR code, its balances, and a line saying to fund it
  from any wallet.
- Every node, the catalogue node on top and each stage's below, as a card of its name, stage and
  role, and its wallet address with whether it is confirmed, new or changed (the old address on
  hover). Beside each, its xDAI and xBZZ to three decimals (the exact amount on hover), the amount
  to send, and what it will hold after.
- Typing an amount ticks the node, and clearing both unticks it. Amounts take digits and one dot.
  Clear all empties every amount. A node two stages share is listed under both and sent to once.
- Confirm addresses asks for the password and confirms every new and changed address.
- Send stays disabled while a total is over the wallet's balance, a ticked node's address is not
  confirmed, an amount cannot be read, nothing is entered, or a send is on its way. Send shows what
  goes where and asks for the password, then reads each transfer every 3 seconds, with its
  transaction on the block explorer, for ten minutes at most before it offers Check again. Send is
  free again once the API says every transfer is `settled`, and the page keeps reading while any
  is `watched`.
- Amounts are exact both ways, as wei (18 decimals) and PLUR (16).

**Stamps** tops up or dilutes the batches the nodes upload with. Each node pays from its own
wallet, so there is no password, only a confirm dialog.

- A row per batch, the catalogue's on top, then the archive stamps, then each stage's: a tick box,
  the batch's short id with Copy and an Immutable chip, the node's card, its depth, time left and
  fill. A node with no batch has a row only when the manager recommends one, as for Buy new, and a
  gateway has none. Only a batch read whole, usable, not expired and whose node's wallet was read
  has a tick box. The others say why.
- **Buy new** (`docs/architecture/funding.md`, "Buying a new batch") is on each row whose batch no
  longer pays, expired or gone from its node, and on a node with no batch, as the common
  `batchOffersPurchase` says. It opens a dialog (`components/funding/BatchBuyDialog.tsx`) on the
  manager's recommendation, the depth and kind of the batch it replaces and 30 days, with Use it to
  go back to it. The calculator is the tab's own days, a slider, presets and a field from 2, and the
  buy dialogs' depth rows (`DepthRows.tsx`, which the archive stamp's dialog shares), from 17, or 18
  for the catalogue, to 40, each with what it holds before its fullest bucket fills, Swarm's
  effective volume as the archive stamp's dialog shows it, with its chunks as the title, and what it
  costs. Under them the picked depth's life at today's price, the node's wallet, and what it is
  short of, with Fund it, which opens Balance with that entered. A rung's batch is mutable or immutable; the catalogue's is immutable. A confirm
  step names the batch, the exact cost and what follows, and there is no password: the node pays. A
  refusal shows in the dialog, and the view is read again; the dialog's offer is built from that
  reading, so a moved price is quoted anew and a batch that changed on the row is named as it is
  now. Once the row offers no purchase, the dialog closes and the tab says why. The catalogue's row
  says the move is switched off instead, while it is.
- Under a node's row comes its latest purchase: what was bought, where it stands, and for a rung a
  line per stage whose uploader takes the batch, in the common `BATCH_PURCHASE_APPLY_TEXT`. Restart
  now, on a stage that waits for a broadcast, asks first with `BATCH_PURCHASE_RESTART_CONFIRM`. Check
  again takes up what stopped, and buys nothing. A catalogue purchase shows its move, the slots
  done, and the thumbnails it cleared. While a purchase is under way, or waits for Check again with
  its bought batch still on the node, its row offers no other (the common `batchPurchaseHoldsNode`).
  Once that batch has expired or left the node, Check again goes, the line says a new one can be
  bought, and the row offers Buy new again. The purchases are read again every 10 seconds while one is under way, and
  the view once one ends.
- **Archive stamps** are the immutable batches that recordings are archived onto, from
  `GET /api/archive/stamps`. Each row shows the stamp's label in place of a node's card, the node
  that holds it, its room and the qualities on it, and a warning when its time left is under
  `ARCHIVE_TTL_WARNING_DAYS`. The holding node pays for it, the catalogue node for every stamp
  bought here, so that node's one wallet pays for its stamps and for the catalogue batch, and its
  xBZZ after counts them all. A stamp that is not written any more, such as one left on a stage's
  node that was the catalogue node, is marked Top-ups only and has no tick box on Dilute. A stamp on
  a node the Funding view lists nowhere, which is the catalogue node no longer and no stage's, has no
  tick box and no such mark: its row says that node's wallet is funded outside the admin, so the
  admin does not top it up or dilute it. One whose node the manager did not name says its node's
  wallet could not be read. With no stamp, the group says "No archive stamps yet." With no
  catalogue node designated, the group comes first.
- **Buy archive stamp**, under the group, opens the buy dialog
  (`components/archive/BuyStampDialog.tsx`, which the archive panel shares): a row per depth from
  17 to 41, each with what it holds and costs for the days typed, 30 by default and 2 at least, an
  optional label, the catalogue node's wallet, and a confirm step with the exact cost. The choice
  goes to `POST /api/archive/stamp-purchases` with its depth, days, label and that cost. There is no
  password: the node pays. A purchase still running is listed under the group as being bought, then
  waiting to be usable, read again every 10 seconds, and the batches are read again once it is
  done. When no stamp can be priced the button says why. The dialog shows the API's refusal, such as
  a manager that offers no purchases, or the new cost when the price moved. After a refusal the
  stamps are read again, so the dialog, still open, prices the stamp at the new terms, and the next
  confirm sends the new cost.
- **Auto top-up** is a switch under the batch of every row that has a tick box for Top up, and of
  every marked row, so a batch that cannot be topped up any more can be unmarked. It marks or
  unmarks that one batch at once, with no password (`components/funding/AutoTopUpMarks.tsx`). A
  marked row says when it was last topped up automatically and by how many days, about when its
  next top-up falls due and what it costs (the alert job's figure, or worked out at today's price
  with the common `autoTopUpStampPlan`), and in red what stopped its last attempt. Under the
  tables, Auto top-up on and Auto top-up off act on the ticked batches, as Select all and the group
  tick boxes tick them. Marking a batch that is already due says at once what its top-up costs,
  whether its node holds that, and when the brand wallet sends the rest. A refusal, such as the 409
  `not_markable`, shows its sentence, and nothing is marked. When the marks cannot be read, the tab
  says so with Retry and shows no switch.
- Select all, Clear, and a tick box per group. Switching between Top up and Dilute clears the ticks.
- Top up takes days on a slider from 1 to 365, presets of 7, 30 and 90, or any whole number from 1.
  Each ticked row shows its time left after, its cost in xBZZ, and its node's xBZZ after. Dilute
  takes 1 or 2 steps, and each row shows its new depth and time left after.
- A row shows in red what its node lacks, and a dilution that would leave its batch under 7 days or
  take it past depth 40 is refused there. Fund all opens Balance with every short node ticked and
  the amount it lacks filled in.
- The dialog reads the view again and lists each batch with its days and cost, or its new depth.
  Each top-up carries the price the page quoted, and the API refuses it if postage costs more by
  then, so a top-up never costs more than the dialog said.

**Chequebooks** brings the chequebooks of the catalogue node and the stages' nodes to a target
balance. Each node pays from its own wallet, so there is no password, only a confirm dialog.

- A row per chequebook, the catalogue node's first, since it pays its peers for every recording it
  copies onto an archive stamp, then each stage's under its name: a tick box, the node's card, the
  chequebook's available balance, its total and its uncashed cheques, then the node's xBZZ and
  xDAI. A gateway's is shown read-only.
- The target is in xBZZ, at least 1. Each ticked row then shows its move: a deposit from the node's
  wallet when it is under the target, a withdrawal into the node's wallet when it is over, or no
  change. Fund all works as on the Stamps tab.
- The dialog lists each move with every digit, and says each move is worked out again from the
  balance read when it is sent and never moves more than listed. A busy node keeps paying its
  peers, so its balance lands near the target, not on it.
- The page follows each move through Sent, Mined and Confirmed. A move is confirmed once its block
  is final, about 3 minutes after it is mined.

**Auto top-up** holds the settings of stamp auto top-up and shows what its three jobs are doing
(`docs/architecture/funding.md`, "Auto top-up"). It reads `GET /api/funding/auto-top-up`, and each
write answers the whole view, which the tab then shows (`components/funding/AutoTopUpTab.tsx`).

- **Where things stand:** the monthly estimate for the marked stamps beside the brand wallet's xBZZ
  and xDAI, the daily ceiling in force (said to be half the estimate while the field is empty), and
  what the wallet job sent in the last 24 hours; the top-ups coming up, the soonest first, with each
  one's cost, the cost with the margin, what the brand wallet sends its node, and when the alert
  went out and the send may go; the warnings that stand, with since when and when a notice last
  told of each, or that nobody gets its notice and it shows here alone; and the stamps not on auto
  top-up that are running low, the one with the least time left first, from
  `GET /api/funding/auto-top-up/unmarked`: what the alert job said of each, its topic, node and
  batch, since when it has been under Top up when under and under 2 days, or since when it
  expired, and when a notice told of it, or that nobody gets its topic.
- **Notices:** beside each kind of notice, in the groups of the Notifications page, how many people
  get it, or that nobody does and it shows here alone; each service, whether it is set up and on,
  when it last took a notice, how many destinations on it are on and how many of those failed their
  last notice, and its latest failure; and the viewer's own destinations whose last notice failed,
  with why. It reads `GET /api/notifications`, as the [Notifications](#notifications-notifications)
  page does, with a link to it. When it or the list of stamps cannot be read, it says so with
  Retry.
- **Jobs:** the alert, wallet and stamp jobs, each with a pause switch that is on while it runs, who
  paused it and when, and its last run with its outcome, in red when it failed.
- **Numbers:** Top up when under, Top up to, Look ahead, Margin, the xDAI warning and the daily
  ceiling, which is empty while it follows half the monthly estimate. Every reason they cannot be
  saved, the common `autoTopUpSettingsProblems`, shows under them as they are typed, and Save
  numbers asks for the password. Undo changes goes back to the saved numbers.
- What is typed in the numbers stays while another tab is shown.

### Notifications, `#/notifications`

Where the admin's notices go, in two parts (`docs/architecture/notifications.md`). The page reads
`GET /api/notifications`, and each write answers the whole view, which the page then shows
(`pages/NotificationsPage.tsx`, `components/notifications/`). Of the other users it shows numbers
alone.

**Shared services:** email by Brevo and a Telegram bot, through which every user's notices go out.

- A user with the admin role has a card for each: how it stands (who saved it and when, when it last
  took a notice, its latest failure, how many destinations on it are on and how many of those failed
  their last notice, and how many notices wait for them), its switch, and its form: the email
  service, the sender's address and name and the API key, or for Telegram the bot token alone.
  Every reason the form cannot be saved shows under it as it is typed, in the shared package's
  sentences (`serviceSettingsProblems` and `serviceSecretProblem`). The secret is write-only: its
  field starts empty and says whether one is set; left empty, a save keeps the stored one. Save asks
  for the password, and Undo changes goes back to the saved service. The switch, and Remove, which
  asks first, need no password (`components/notifications/ServiceCard.tsx`).
- **The ?** beside a service's name shows and hides how to set it up: what to make at the service,
  with a link to it that opens in a new tab, and what to enter on the card
  (`components/notifications/ServiceSetup.tsx`).
- Every other user sees of each service whether it is set up and on, and nothing more.

**My notifications:** the signed-in user's own, which no other user sees.

- **My email address** and **My Telegram chat**, a card each: how it stands (when it was saved, when
  it last took a notice, why its last one failed, how many notices wait for it, and how its last
  test went), a line while its service is not set up or is switched off, its switch, and its field,
  checked as it is typed with the package's `destinationAddressProblem`. Save asks for your
  password. The switch, Remove, which asks first, and **Send me a test notice** need none; a second
  test within the minute shows how long is left (`test_too_soon`)
  (`components/notifications/DestinationCard.tsx`).
- **Find my chat**, under My Telegram chat, starts a code with
  `POST /api/notifications/me/telegram/code` and shows it with the bot to send it to and the three
  ways to send it: the bot's link, which sends it from your own chat once you press Start; the
  command `/start@` with the bot's name and the code, ready to copy, sent as one message in a group
  the bot is in; or the code posted in a channel the bot administers. **I sent it** asks
  `POST /api/notifications/me/telegram/chat` for the chat that sent it and fills it in, for you to
  save behind your password. It says when the code is over, when none of the bot's latest messages
  holds it yet, and why Telegram or the bot could not be read, and it is off until an admin has set
  up the Telegram service (`components/notifications/TelegramChatFinder.tsx`).
- **The notices I get:** a tick per topic, in the groups of `NOTICE_TOPIC_GROUPS`, each with what it
  tells of and how many people get it, saved at once with no password
  (`components/notifications/TopicsCard.tsx`). The card says when your first saved address will
  tick the four notices of stamp auto top-up, and when none of your destinations is on, on a service
  that is on, so no notice reaches you.
- With the admin's `BRAND_WALLET_SECRET` unset the page says no service can be saved and no notice
  sent, and the services' Save, the tests and Find my chat stay off.

### Access, `#/access`

Who can sign in. An admin adds and removes users, signs anyone out, and sets up the notification
services on the [Notifications](#notifications-notifications) page. Everyone else sees the list.
Everyone can change their own password. `#/account` redirects here.

## How the console behaves

### Downloading a recording

One export runs at a time for the whole admin, and every signed-in user sees it
([Exporting a recording](../backend/README.md#exporting-a-recording)).

- **The panel.** Opened with Download on a stream's page, it shows the recording's day and length
  and each quality with its resolution and estimated size, highest first, and Start export. When
  the file kept on the server is this stream at the chosen quality, it offers Save file instead,
  and Clear, which asks first and deletes the kept file for everyone, so that quality can be
  exported again, a partial file included. When that file is out of date, its note turns orange and
  says so first. Starting another export replaces the kept file, and the
  panel says so. While an export holds the
  slot, the panel follows that export, whichever stream it is, and says one runs at a time.
- **Following an export.** Where it stands, with a progress bar, who started it and when, in UTC to
  the second, and the buttons
  for what it allows now: Pause; after a pause, Resume, or Try them again when segments could not
  be read, and Try again after another problem; Save what's read, or Save without them; Wait until
  it finishes, when the stream went live again; and Cancel export, which asks first, since
  everything read so far is deleted. Once it is done, how long it took from start to finish, pauses
  included, or "0 s from cache" under half a second, when the node had every segment already, with
  Save file and Clear, and Archive this quality, which opens the archive panel on that stream with
  the exported quality ticked: the catalogue node has just read the recording whole.
  The panel's title links to the stream's page with ↗, which closes the panel.
- **The indicator.** From the moment an export starts, it shows in the header of every page for
  every signed-in user, before or after the archive's, the panel open or not: its stream and
  quality, where it stands, and a thin bar while it runs. Clicking it opens the panel, and so does
  its icon, a button a keyboard reaches. It turns orange and says "Paused: needs a decision" when a
  pause asks for one. A finished export turns green and says it is ready to save, with Save file
  and a close button, and each user closes it for themselves. On a screen narrower than a tablet it
  is its icon, with an orange dot when it needs a decision and a green one when it is ready; a
  finished export keeps its close button beside the icon, and Save file is in the panel.
- **Coming to front.** When an export pauses for a decision, the panel opens by itself for the user
  who started it, if they are signed in, once per pause. Everyone else sees its indicator say so.
- **Saving.** Save file is a plain link to the file, which the browser saves under the name the API
  gives it, such as `opening-keynote-2026-11-05-1080p.mp4`. Saving reads nothing from Swarm.

The console reads the export every two seconds while one runs, and every ten seconds otherwise.

### Archiving a recording

One archive exists at a time for the whole admin, it shares the place a job has with the export,
and every signed-in user sees it
([Archiving a recording](../../../docs/architecture/web2-admin.md#archiving-a-recording)).

- **The panel.** Opened from a stream's archive card, from the Archive page, or with Archive this
  quality on a finished export, it shows the recording's day and each quality with its state and
  its estimate: the bytes, the chunks, what the copy costs the catalogue node's chequebook and how
  long it takes. The qualities it was opened with are ticked, or else the best one not archived
  yet, and an archived quality cannot be ticked. When every quality that finished recording is
  archived, nothing can be ticked, and the panel says so, and that a further copy starts from the
  Archive page. When the high end of what the ticked qualities may
  cost is above what the catalogue node's chequebook can pay now, a warning says the chequebook may
  run out and the archive would then pause for funds; Start archive stays enabled, and with no
  reading of the chequebook there is no warning. Under them, where the copy goes: an archive stamp
  with room for what is ticked, a stamp without it greyed out with why, or "Buy a new archive
  stamp", sized once the recording is measured. Start archive starts it, and the panel follows it.
  While an archive is unfinished, the panel follows that archive, whichever stream it is, and says
  one exists at a time.
- **A further copy.** The Archive page's Copy onto another stamp opens the panel in its copy mode,
  the third argument of `openPanel`; every other opener keeps the archive mode. It offers the
  stream's archived qualities alone, every one ticked, so the whole recording moves, each with the
  stamps its copies are on and what a copy holds; a quality not archived is archived first from the
  stream's card or the download panel. A stamp that holds an archived copy of a ticked quality is
  greyed out with why, and "Buy a new archive stamp" is offered as for a first archive. Before Start
  copy it says the room the copy takes on the stamp chosen, counted from what the archived copies
  hold, what its bandwidth costs the catalogue node's chequebook, as a first copy's does, and, for
  each stamp a copy is on now, that the copy there stays until that stamp runs out. The start is
  the request a first archive sends.
- **Following an archive.** Where it stands, with a bar for the whole and one for each quality as it
  copies and verifies, the rate and the time left, what it is expected to cost the chequebook and
  what the chequebook can pay, with a warning when it holds less, who started it and when, in UTC,
  and the buttons for what it allows now: Pause; Resume, or Try again and Try again after
  funding it, after the pauses that ask for them; Wait until it finishes, when
  the stream went live again; Use another stamp, which lists the other stamps that can be written,
  one that holds an archived copy of a quality the archive copies greyed out with why,
  and Buy a new archive stamp, when the stamp lacks room; and Cancel archive, which asks first,
  since what was copied stays on Swarm and its qualities show as "Archive incomplete". Once it is
  done, each quality's result, how long it took and what the chequebook went down by.
  The panel's title links to the stream's page with ↗, which closes the panel.
- **A new stamp.** Once the recording is measured, the panel shows the stamp it proposes, its depth,
  days and cost, and what the catalogue node's wallet lacks, with Choose the stamp, which opens the
  buy dialog. The dialog's confirm goes to the archive, which buys the stamp, waits until it is
  usable, then copies onto it. A cost that moved since the dialog priced the stamp is refused, and
  the dialog says the cost now.
- **The indicators.** The export's and the archive's sit side by side in the header, which stays at
  the top of every page, the one that holds the place first, so a paused archive shows after a
  running export. The archive's shows its stream, its qualities and where it stands, with a thin
  bar while it moves. It turns orange with "Paused: needs a decision" when a pause asks for one,
  and with "Confirm the new archive stamp" while a new stamp waits for its confirm. A finished
  archive turns green and stays until each user closes it for themselves. On a screen
  narrower than a tablet each is its icon, with an orange dot when it needs a decision and a
  green one when it is done, and a finished job keeps its close button beside the icon.
- **Coming to front.** When the archive pauses for a decision, or waits for a new stamp to be
  confirmed, the panel opens by itself for the user who started it, once each time, and with a new
  stamp to confirm the buy dialog opens with it. Everyone else sees its indicator say so.

The console reads the archive every two seconds while one is unfinished, and every ten seconds
otherwise.

### The OBS panel

The panel on a stream's details page tells an operator what to type into OBS's Server and Stream
Key boxes. It is built from the stream's stage, as the manager pushed it, and offers SRT first, under
the heading SRT Connection. Its Stream Key line says to leave that box empty. On a stage that also
takes RTMP, an SRS stage, the API answers the RTMP server and stream key too, and the panel keeps them
under Other protocols, after SRT, with one sentence in its intro saying so. That section starts
folded each time the panel opens and renders nothing until it is opened, so no RTMP key is in the
page before then. Opened, it shows the RTMP section: a warning that RTMP is not encrypted, the RTMP
Server as it is, and the RTMP Stream Key. The port is the stack's, see
[RTMP](../../hls-stream/deploy/README.md#rtmp) in its deploy guide. The SRT Server line carries the
stream's `key=` and, where OBS can read it there, the SRT passphrase, and the RTMP Stream Key carries
the same `key=`, so the panel hides those values, and the SRT Password field when there is one,
until the operator reveals them. Copy always copies the real value. `navigator.clipboard` exists
only in a secure context, so on a console served over plain http Copy falls back to
`document.execCommand('copy')` and, failing that, selects the value for a manual copy. Rotate key
asks first. Without a stage the panel says to pick one.

A stage on a Mac whose public ingest address is the Mac's `<name>.local` gives an SRT Server line
that OBS cannot dial. OBS on that Mac uses `127.0.0.1` in place of the name, and another device on
the LAN uses the Mac's LAN IPv4 address.
[The manager's stages page](../../infra-manager/docs/features/stages.md#the-public-ingest-address)
says why.

Rotate key refuses the old key from the next connection on. It does not end a broadcast that is
already live on the old key. A stream takes one encoder at a time. Two encoders with the same
details push each other off every few seconds, because a stage lets an encoder with the right key
take over a live stream and OBS reconnects by itself. The stream then carries only some of its
segments and shows as Live throughout. To end such a fight, press Rotate key and put the new details
into the one encoder that should broadcast. Its next connection takes the stream over, and the
other encoder's reconnects with the old key are refused.

To go live on a finalized stream on purpose, copy the new SRT line into OBS, as after Rotate key.
Finalize itself sits in the stream's status notice, [above](#stream-details-streamsid).

### Sessions

Every fetch is relative (`/api/...`) and carries `credentials: 'same-origin'`. Any unexpected 401
clears the user, and the route guard sends the operator to `#/login`.

An idle tab finds out too. While someone is signed in, the console asks `GET /api/auth/me` again on
window focus and when the tab becomes visible, at most once every five seconds, so a session revoked
from another browser shows "Your session ended. Log in again." the next time the operator looks at
the tab. There is no timer, because every request keeps the session's idle clock running. The export
widget's look at the export is the one timer, and it sends its reads with `x-background-read: 1`,
which the API checks without moving the idle clock. Other tabs
of the same browser are told at once over a `BroadcastChannel`, and a reload after a revoke shows
the same notice. On the change-password form, a 401 `unauthenticated` signs out too, and only
`invalid_credentials` means the current password was wrong.

### The build line

Beside the signed-in account, a small muted line names the build the API runs:
`Version <label> (<short commit>)`, the label alone when it already starts with the short commit,
or `Version development build` when the API carries no version. The full commit is the line's
title. It is asked once after each sign-in, from `GET /api/version`, which answers signed-in users
only. An API that cannot say shows no line, and neither does a screen narrower than a tablet.
`versionText` in `src/format.ts` is the rule.

## Themes

The console has two looks:

- **Swarm**, the Swarm brand as the event viewer wears it: near-black, the Swarm orange, Geist.
- **Web3Privacy**, web3privacy.info's own: black, the neon green, Archivo with Domine headings.

A browser wears the first of these that applies:

1. **The user's own pick in this browser.** Anyone signed in picks one under Theme in the user
   menu, which stays open so the looks can be compared. The pick is kept in this browser under
   `web2-admin-theme`, through reloads and sign-outs, so the login page wears it too. The menu has
   no item that forgets it.
2. **This host's default.** `GET /api/config` answers it as `defaultTheme`.
3. **The host's default as this browser last heard it**, while `/api/config` has not answered yet,
   so a returning visitor sees no flash of another look. It is kept under `web2-admin-theme-host`
   and refreshed on every answer. A config that cannot be read, or one naming a look this console
   does not carry, leaves it as it is.
4. **Swarm**, `DEFAULT_ADMIN_THEME` of web2-admin-common.

The host's default is read from the admin's database and applies to every browser that opens this
host. The admin has no route or page that sets it, so it is Swarm unless an older version of the
admin stored another ([the backend's README](../backend/README.md#the-consoles-look)).

### Adding or changing a look

A look is one record in `src/theme/tokens.ts`: its colours, three typefaces, the heading weight, the
corner radius, the button lettering, whether surfaces stay flat, and the shades of each colour when
they must be written out rather than worked out by MUI. `src/theme/createAdminTheme.ts` is the one
place a record becomes a MUI theme. It also centres every chip's label on its capital letters, in
every look: CSS `text-box` trims the label's line box where the browser has it, and a 1px nudge
stands in where it does not.

- Components read only the MUI theme, such as `text.secondary` or `primary.main`, and set a
  monospace value with `sx={{ fontFamily: monoFont }}`. `src/test/theme.test.tsx` fails on a colour
  or a typeface a component writes out, and on a look whose text reads below 4.5:1 against its
  background.
- A new look is a new record and a name in `ADMIN_THEME_NAMES` of web2-admin-common, which
  `src/theme/themeNames.ts` re-exports, so the API checks and stores the host's default by the same
  names.
- The fonts are bundled from `@fontsource`, only the weights used, in `src/theme/fonts.ts`, and a
  browser downloads one only when text on the page is set in it.

## Checks

```bash
pnpm --filter @streaming-monorepo/web2-admin-frontend test       # vitest and jsdom
pnpm --filter @streaming-monorepo/web2-admin-frontend typecheck  # tsc --noEmit
pnpm --filter @streaming-monorepo/web2-admin-frontend lint       # oxlint
pnpm --filter @streaming-monorepo/web2-admin-frontend build      # builds common, typechecks, then vite build
```

`build` builds `../common` first, because its package `exports` map to the TypeScript source only
under the `development` condition, which Vite applies while serving and testing but not in a
production build.

## Production image

`Dockerfile` builds the app and serves it from nginx, with `nginx.conf` doing what the dev proxy
does (`/api` to `api:9877`). Build it from a copy of `apps/web2-admin` made outside the checkout by
`tools/app-workspace/in-copy.mjs`, which carries the admin's own lockfile, cut out of the
repository's root one:

```bash
node ../../tools/app-workspace/in-copy.mjs --app apps/web2-admin -- docker build -f frontend/Dockerfile -t web2-admin-frontend .
```

On a host, `deploy/deploy.sh` builds it for you ([the deploy guide](../deploy/README.md)).

## Layout

```
src/
  main.tsx      the providers: the theme switcher's, the date pickers', the app
  App.tsx       routes
  auth.tsx      session context, re-checks on focus, drops the user on any 401
  api.ts        one function per endpoint
  http.ts       getJson, sendJson, sendBytes, extractApiError
  errors.ts     the API's error codes as sentences
  format.ts     dates, datetime-local conversion, hex elision, the build line
  theme/        the looks as tokens, the MUI theme built from them, the switcher, its saved pick and the host's default
  components/   app shell, build line, route guard, snackbar, chips, copy button, form fields, OBS panel
  pages/        one file per page
  test/         vitest suites and their helpers
```
