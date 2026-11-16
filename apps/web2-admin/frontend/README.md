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

| Variable              | Default                  | What it does                                                                                                                        |
| --------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `MOCK_API_PORT`       | `9877`                   | the port it listens on                                                                                                              |
| `SEED_ADMIN_USERNAME` | `admin`                  | the user it starts with                                                                                                             |
| `SEED_ADMIN_PASSWORD` | `admin1234`              | that user's password, which the console can change                                                                                  |
| `MOCK_NO_USERS`       | unset                    | `true` starts with no users, the only way to see the console's "no users yet" screen                                                |
| `MOCK_NO_STAGES`      | unset                    | `true` starts with no stages: the Stages page's empty state, and a stage picker with nothing to pick                                |
| `MOCK_RECORDING`      | unset                    | `true` adds one more recording, which ended on 2026-09-11 and is finalized at start, beside the [seeded streams](#the-mock-streams) |
| `MOCK_FUNDING`        | unset                    | `off` shows the Funding page's "not set up" state. `refuse` and `lost` play the two failures, as [below](#the-mock-funding)         |
| `MOCK_ARCHIVE`        | `off`                    | the archive seeded at start, as [below](#the-mock-archive): `off`, or a job state such as `copying` or `paused_batch`               |
| `MOCK_EXPORT`         | `running`                | the export seeded at start, as [below](#the-mock-export): `running`, `paused`, `done` or `off`                                      |
| `MOCK_ARCHIVE_STAMPS` | `some`                   | the archive stamps, as [below](#the-mock-funding): `some`, `none`, `buying`, `left` or `unoffered`                                  |
| `MOCK_DEFAULT_THEME`  | `swarm`                  | the host's default look `GET /api/config` answers. The mock checks no name. Set `web3privacy` to see a host's default at work       |
| `VIEWER_BASE_URL`     | `http://localhost:10074` | the "open player catalogue" link. It must be a viewer built for this catalogue                                                      |

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
- **Chequebooks.** The catalogue node's chequebook holds 1 xBZZ. Against a target of 2 xBZZ, the
  stage nodes hold a chequebook under it (whose node
  cannot pay a deposit to a target over 5.4 xBZZ), one over it, one at it (whose node holds no xDAI
  for gas), one whose node could not be read, a light gateway's shown read-only, and an ultra-light
  gateway with none. A chequebook bulk is checked as the API checks it, sends its moves two seconds
  apart, reports each `mined` two seconds after it is sent and confirms it six seconds after that.

With `MOCK_FUNDING=refuse`, every transfer fails at the relay with no block and is then mined
anyway six seconds later, and every stamp and chequebook operation is refused. With
`MOCK_FUNDING=lost`, every operation is first not known, as when the manager loses the chain's
answer, then sent three seconds later and confirmed.

#### The mock export

The mock exports as the API does, one export at a time: it reads for 45 seconds, joins for 5, and
keeps the file until the next export starts. Every quality is offered, 1080p to 360p, with sizes
estimated from the recording's length. `MOCK_EXPORT` decides the export seeded at start, of the first
seeded recording:

- `running`, unset: a 720p export another user started, so the widget shows one moving at once.
- `paused`: one the seeded user started, which pauses on segments it could not read, so the panel
  comes to front. Every export started from the panel then pauses the same way part-way.
- `done`: a kept file, above the OBS panel of its stream and in the widget.
- `off`: none.

Save file answers a stand-in file under the export's name, not a video.

#### The mock archive

The mock archives as the API does, one archive at a time, sharing the place a job has with the
export: it measures for 6 seconds, copies for 60 and verifies for 8, and a new stamp is bought in 6
seconds and is usable 6 seconds later. The archive panel offers the catalogue node's archive stamps:
"Archive 2026", depth 22, with room; "Short talks", depth 20, nearly full and under the 30-day
warning; and "Old archive", expired, which is not offered. A new stamp is priced at the funding
mock's price of postage, from a catalogue node wallet of 10 xBZZ, and a confirm at another cost is
refused as `price_moved`, with the cost now.

The recordings carry an archive each, whichever `MOCK_ARCHIVE` is:

- "Ended a few minutes ago": none. The seeded archive is of this one.
- "Ended days ago": 1080p and 720p archived on "Archive 2026", with the hint that the stage batch of
  its other qualities has expired.
- "Workshop recording": 1080p archived with reduced protection, 12 parity chunks left out.
- "Panel discussion": 720p partly copied onto "Short talks".
- "Keynote, recorded twice": 1080p, outdated.
- "Last year's meetup": 1080p on "Old archive", expired.

`MOCK_ARCHIVE` decides the archive seeded at start, of the first seeded recording:

- `off`, unset: none.
- `measuring`, `copying`, `verifying`: one another user started, moving.
- `awaiting_purchase`: one the seeded user started, waiting on the buy dialog, which comes to front.
- `buying`: one whose new stamp is being bought, which turns usable, then copies.
- `paused_user`, `paused_unreadable`, `paused_batch`, `paused_funds`, `paused_node`: one the seeded
  user started, paused for that reason. The panel comes to front for every reason but the first.
- `waiting`: one whose stream went live again.
- `done`, `done_reduced`: a finished one, the second with 12 parity chunks of 1080p left out.

`GET /api/archive/streams` answers the Archive page, and the stream answers carry each stream's
`archive`. With the default `MOCK_EXPORT` an export runs at start, and a new archive is refused
until it is done, as the API keeps one job at a time: set `MOCK_EXPORT=off` to start one at once.

## Pages

The router is a `HashRouter`, so every route starts with `#/`.

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

The archive badge (`components/archive/ArchiveBadge.tsx`) says the stream's archive in the words of
`ARCHIVE_BADGE_TEXT`: Archived, Archived, reduced protection, Archive incomplete, Archive outdated or
Archive expired, and nothing for a stream with nothing copied. On hover it names the archived
qualities, and says when the catalogue lists only those.

### Archive, `#/archive`

Only the streams that have an archive, newest copy first, from `GET /api/archive/streams`: the
title, linked to the stream's page, with its badge, the date, each copied quality with its state,
the size archived, the stamp each copy is on with its time left, in amber under
`ARCHIVE_TTL_WARNING_DAYS`, and when and by whom the newest copy was completed. Archive more
qualities opens the archive panel on the stream, and Archive again opens it with the outdated
qualities ticked. Nothing is removed from a stamp, so there is no un-archive.

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
  second.
- On a finished recording, or a stream with an archive, the archive card, above the downloaded file:
  each quality with its state, "Archived", "Archived, reduced protection", "Archive incomplete",
  "Archive outdated", "Archive expired" or "Not archived", and what its copy holds, on which stamp,
  completed when and by whom, or else its estimate. A stamp that holds a copy and runs out soon is
  named with its time left. "Archive this recording", "Archive more qualities" or "Archive again"
  opens the archive panel on the stream, described below. Once one quality plays from an archive
  stamp, the "List only archived qualities" switch: on, the catalogue lists only those qualities,
  and turning it on or off writes the catalogue entry again. When the stage batch of a quality with
  no archive has expired, the card says so beside the switch. While an archive of the stream runs,
  the card says where it stands, with a button that opens it.
- The OBS panel, with Rotate key, described below.

### Stages, `#/stages`

Every stage as the manager last pushed it: name and kind, the manager's readiness with its reasons,
status and the uploader's state, the ingest host and SRT port, and whether there is an SRT
passphrase (never the passphrase). Per rung, the stamp's state, its time left (aged from the
manager's reading to the API's answer) and fill, and the chequebook's health. Which token the
stage's uploader presents: its own, or `shared` in the error colour, with the fix (rotate the
uploader's admin token in the manager and redeploy the stage). Retired stages and OvenMediaEngine
ones ("Not supported yet") are marked.

A card above the table shows the catalogue stamp, or says the manager has not designated one. A
batch under 48 hours left shows in the warning colour. One that is expired or gone shows in the
error colour, as does one whose last reading's time to live has run out since, which reads "Expired
by the clock". When the catalogue's history has to move to the designated batch, the catalogue move
card offers the move and follows it, or says the move is not enabled on this installation
(`CATALOGUE_MOVE_ENABLED` in the backend's settings). With no stages, the page says they appear once the
manager's admin link points at this admin.

### Funding, `#/funding`

Three tabs. Each keeps what is ticked and typed in it while the page stays open, and reads the
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
  fill. A gateway has no batch and no row. Only a batch read whole, usable, not expired and whose
  node's wallet was read has a tick box. The others say why.
- **Archive stamps** are the immutable batches that recordings are archived onto, from
  `GET /api/archive/stamps`. Each row shows the stamp's label in place of a node's card, the node
  that holds it, its room and the qualities on it, and a warning when its time left is under
  `ARCHIVE_TTL_WARNING_DAYS`. The holding node pays for it, the catalogue node for every stamp
  bought here, so that node's one wallet pays for its stamps and for the catalogue batch, and its
  xBZZ after counts them all. A stamp that is not written any more, such as one left on a node that
  is the catalogue node no longer, is marked Top-ups only and has no tick box on Dilute. A stamp on a
  node the Funding view lists nowhere has no tick box, since its wallet is not known. With no stamp,
  the group says "No archive stamps yet." With no catalogue node designated, the group comes first.
- **Buy archive stamp**, under the group, opens the buy dialog
  (`components/archive/BuyStampDialog.tsx`, which the archive panel shares): a row per depth from
  17 to 41, each with what it holds and costs for the days typed, 30 by default and 2 at least, an
  optional label, the catalogue node's wallet, and a confirm step with the exact cost. The choice
  goes to `POST /api/archive/stamp-purchases` with its depth, days, label and that cost. There is no
  password: the node pays. A purchase still running is listed under the group as being bought, then
  waiting to be usable, read again every 10 seconds, and the batches are read again once it is
  done. When no stamp can be priced the button says why. The dialog shows the API's refusal, such as
  a manager that offers no purchases, or the new cost when the price moved.
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

### Access, `#/access`

Who can sign in. An admin adds and removes users and signs anyone out. Everyone else sees the list.
Everyone can change their own password. `#/account` redirects here.

## How the console behaves

### Downloading a recording

One export runs at a time for the whole admin, and every signed-in user sees it
([Exporting a recording](../backend/README.md#exporting-a-recording)).

- **The panel.** Opened with Download on a stream's page, it shows the recording's day and length
  and each quality with its resolution and estimated size, highest first, and Start export. When
  the file kept on the server is this stream at the chosen quality, it offers Save file instead,
  and Clear, which asks first and deletes the kept file for everyone, so that quality can be
  exported again, a partial file included. Starting another export replaces the kept file, and the
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
- **The widget.** From the moment an export starts, it floats in the top right of every page for
  every signed-in user, above or under the archive's, the panel open or not, with its stream,
  quality and progress. Clicking it
  opens the panel, and so does its open button, which a keyboard reaches. It says "Paused: needs a
  decision" when a pause asks for one. A finished export
  shows that it is ready, with Save file and a close button, and each user closes it for
  themselves.
- **Coming to front.** When an export pauses for a decision, the panel opens by itself for the user
  who started it, if they are signed in, once per pause. Everyone else sees the widget say so.
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
  yet, and an archived quality cannot be ticked. Under them, where the copy goes: an archive stamp
  with room for what is ticked, a stamp without it greyed out with why, or "Buy a new archive
  stamp", sized once the recording is measured. Start archive starts it, and the panel follows it.
  While an archive is unfinished, the panel follows that archive, whichever stream it is, and says
  one exists at a time.
- **Following an archive.** Where it stands, with a bar for the whole and one for each quality as it
  copies and verifies, the rate and the time left, what it is expected to cost the chequebook and
  what the chequebook can pay, with a warning when it holds less, who started it and when, in UTC,
  and the buttons for what it allows now: Pause; Resume, or Try again, Try again after a dilution
  and Try again after funding it, after the pauses that ask for them; Wait until it finishes, when
  the stream went live again; Use another stamp, which lists the other stamps that can be written,
  and Buy a new archive stamp, when the stamp lacks room; and Cancel archive, which asks first,
  since what was copied stays on Swarm and its qualities show as "Archive incomplete". Once it is
  done, each quality's result, how long it took and what the chequebook went down by.
- **A new stamp.** Once the recording is measured, the panel shows the stamp it proposes, its depth,
  days and cost, and what the catalogue node's wallet lacks, with Choose the stamp, which opens the
  buy dialog. The dialog's confirm goes to the archive, which buys the stamp, waits until it is
  usable, then copies onto it. A cost that moved since the dialog priced the stamp is refused, and
  the dialog says the cost now.
- **The widgets.** The export's and the archive's float one under the other in the top right of
  every page, the one that holds the place first, so a paused archive shows under a running export.
  The archive's shows its stream, its qualities and where it stands, with "Paused: needs a decision"
  when a pause asks for one. A finished archive stays until each user closes it for themselves.
- **Coming to front.** When the archive pauses for a decision, or waits for a new stamp to be
  confirmed, the panel opens by itself for the user who started it, once each time, and with a new
  stamp to confirm the buy dialog opens with it. Everyone else sees the widget say so.

The console reads the archive every two seconds while one is unfinished, and every ten seconds
otherwise.

### The OBS panel

The panel on a stream's details page tells an operator what to type into OBS's Server and Stream
Key boxes. It is built from the stream's stage, as the manager pushed it, and offers SRT only, under
the heading SRT Connection. Its Stream Key line says to leave that box empty. On a
stage that also takes RTMP the API still answers the RTMP server and stream key, and the panel
leaves them out. The SRT Server line carries the stream's `key=` and, where OBS can read it there,
the SRT passphrase, so the panel hides those values, and the SRT Password field when there is one,
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
