# web2-admin backend

The admin API behind the brand console: server-side login, stream drafts in
PostgreSQL, publishing a draft to the stream list feed on Swarm, and the OBS
connection details for a stream. It replaces the deprecated msrs-client, which
kept no draft to recover when a write failed. Here a stream is a row first and
a feed entry second.

## Stack

- **Express 5** + ESM + **TypeScript**, conventions shared with
  streaming-infra-manager (`.js` import suffixes, exact-pinned versions)
- **PostgreSQL 16** — users, sessions, stream drafts, feed-write log, audit log
- **Yup** — body and params validation at the API edge, limits from
  `@streaming-monorepo/web2-admin-common`
- **@ethersphere/bee-js** — the only Swarm dependency, behind a `FeedGateway`
  interface (`src/domain/FeedGateway.ts`)
- **node:crypto** — scrypt passwords, random session tokens stored as sha256.
  No auth, session, CSRF or rate-limit dependency

## Quick start

```bash
cp .env.sample .env       # then set FEED_PRIVATE_KEY
pnpm database:start       # postgres:16-alpine on 127.0.0.1:5433
pnpm user:add alice        # the first user: prompts twice, echoes nothing
pnpm dev                  # API on :9877
curl localhost:9877/api/health                   # {"status":"ok"}
```

**There is no seeded account and no sign-up route.** A fresh database has no
users: the API boots, logs a warning, serves `/api/health`, `/api/config` and
`/api/internal`, and answers every sign-in with `401 no_users` until a user is
made with the CLI. In the image that is

```bash
docker compose exec -it api node dist/cli.js user:add alice
# or, with the password never landing in a file or an argv:
op read "op://<vault>/<item>/password" \
  | docker compose exec -T api node dist/cli.js user:add alice --password-stdin
```

The first user ever added can manage users whatever the flags said; later ones
are plain unless `--admin` is given. See
[docs/architecture/web2-admin-auth.md](../../../docs/architecture/web2-admin-auth.md)
for the whole design.

## Scripts

| Script                                  | What                                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                              | `tsx watch` against `src/index.ts`                                                                       |
| `pnpm build`                            | builds the shared packages and common, then `tsc` + copies `src/migrations` into `dist`                  |
| `pnpm start`                            | `node --conditions=compiled dist/index.js`, which loads the shared packages' built `dist`                |
| `pnpm user:add <name> [--admin]`        | add a user; `--password-stdin` reads it from a pipe. The only way to make the first one                  |
| `pnpm test`                             | unit tests (`test/unit`), no database or network                                                         |
| `pnpm test:integration`                 | starts a backend of its own and drives it over HTTP — see [test/integration](test/integration/README.md) |
| `pnpm typecheck`                        | `tsc -p tsconfig.typecheck.json`, which includes `test/`                                                 |
| `pnpm database:start` / `database:stop` | the Postgres container                                                                                   |

The API runs in Docker too (two-stage `pnpm deploy` image, `Dockerfile`). Its
image builds from a copy of `apps/web2-admin` made outside the checkout by
`tools/app-workspace/in-copy.mjs`, which carries the admin's own lockfile, cut
out of the repository's root one when the root keeps it, and leaves every `.env`
behind. The tag is the name compose gives the `api` service, so `up` runs it
without building again:

```bash
node ../../../tools/app-workspace/in-copy.mjs --app apps/web2-admin -- docker build --file backend/Dockerfile --tag web2-admin-api .
docker compose -p web2-admin --profile full up -d
```

Deploying to a server is a different compose file and a script:
[deploy/README.md](../deploy/README.md).

## Configuration

Every variable is documented in [.env.sample](.env.sample), which is the
reference; the summary:

| Var                                   | Default            | Meaning                                                                                                                                        |
| ------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEB2_ADMIN_PORT` / `WEB2_ADMIN_HOST` | `9877` / `0.0.0.0` | where to listen (the manager API uses 9876)                                                                                                    |
| `DATABASE_URL`                        | required           | `postgres://web2admin:web2admin@127.0.0.1:5433/web2admin`                                                                                      |
| `FEED_GATEWAY`                        | `bee`              | `fake` swaps in an in-memory gateway (see below)                                                                                               |
| `FEED_PRIVATE_KEY`                    | required           | 0x + 64 hex. The brand key: signs the stream list feed, and is `owner` on a stream with no stage; a stream on a stage has its stage's          |
| `FEED_TOPIC`                          | `swarm-stream`     | raw topic of that feed                                                                                                                         |
| `VIEWER_BASE_URL`                     | empty              | branded viewer built for this feed, for "open player catalogue" links                                                                          |
| `INTERNAL_API_TOKEN`                  | required           | 32+ chars. The registrar token the manager pushes stages with on `/api/internal`. No uploader is given it, and the uploader's routes refuse it |
| `CATALOGUE_MOVE_ENABLED`              | `false`            | `true` lets an operator move the catalogue's history onto another batch from the Stages page. Off until tried on a real node                   |

There is no ingest setting. Each stream's OBS details come from the stage it
is broadcast on, as the manager pushed it: see [A stream's stage](#a-streams-stage).
`INGEST_HOST`, `INGEST_SRT_PORT`, `INGEST_RTMP_PORT`, `INGEST_RTMP_PUBLIC`,
`INGEST_SRT_PASSPHRASE` and `INGEST_KEY_VERIFIED` are no longer read. An env
file that still sets them starts as it did, and the boot log names each one it
sets.

There is no Bee node and no postage batch among these either. The catalogue
is written through the catalogue node and batch the manager pushes (see
[Where the catalogue is written](#where-the-catalogue-is-written)). `BEE_URL`
and `POSTAGE_BATCH_ID` are no longer read; an env file that still sets them
starts as it did, and the boot log names them with the ingest keys.

Startup logs the resolved configuration with the feed key and the internal API
token redacted.

### FEED_GATEWAY=fake

`fake` keeps feed writes and thumbnail uploads in memory: nothing reaches
Swarm, no Bee node or usable postage batch is needed, and references look like
references. It is how to work on the console, and what
`pnpm test:integration` expects. Startup warns when it is on.

It needs no catalogue stamp either: with none designated it writes with no
target, and records the write with no batch. A designation the manager does
push is followed as under `bee`, the pin, a waiting move and the refusal of an
expired or gone batch included.

It forgets every write on restart while `feed_writes` — which decides the next
index — does not, so the first write after a restart continues from whatever
the database says and the in-memory feed adopts that index. The boot check then
reports a network head of `none` behind a recorded one, which under `fake` is
normal and not a divergence.

## Sign in

`docs/architecture/web2-admin-auth.md` is the design; the short version:

- A password is scrypt (`N=2^15, r=8, p=3`) in `scrypt$N$r$p$salt$hash`, so the
  cost can be raised without invalidating what is stored. Minimum 12
  characters, must not contain the username.
- A session is 32 random bytes in an httpOnly SameSite=Lax cookie with **no
  expiry of its own**; the row is the clock. Twelve hours of inactivity,
  fourteen days at most, `last_seen_at` written at most once a minute. Only the
  sha256 of the cookie value is stored. `Secure` is decided per request from
  `X-Forwarded-Proto`, never from configuration.
- Four free sign-in attempts per username and per client address, then a minute
  that doubles to an hour; attempts still waiting on scrypt count, so a burst
  sent together buys no extra guesses. Changing a password is throttled on a
  key of its own.
- Every non-GET request must carry `x-requested-with: web2-admin` and must not
  look cross-site, or it is `403 cross_site_request` before its body is read.
  **`/api/internal` is exempt** — it is a machine caller with a bearer token,
  and it is mounted ahead of the check for that reason.
- `GET /api/auth/users`, `POST /api/auth/users` (admin),
  `DELETE /api/auth/users/:id` (admin, never yourself, never the last user or
  the last admin; the user's streams stay, with `user_id` set to null) and
  `POST /api/auth/users/:id/revoke` (admin, or anyone for themselves) are the
  Access page.

## Publishing

One writer, one feed, payload is the whole JSON array rewritten each time
(`src/domain/PublishService.ts`). A publish claims the row into `publishing`,
uploads the thumbnail if it has no reference yet, takes the current list and
index from `feed_writes`, and replaces or appends this stream's entry by
`(owner, topic)`, keeping entries written by anyone else verbatim. It writes at
the next index, logs it in `feed_writes`, and only then marks the row
`published`, or `vod` when the draft still holds the recording of an earlier
broadcast, so the row says what its entry says. Any failure puts the previous
status back with `publish_error` set and answers `502 publish_failed`. Publish
and unpublish are serialised through one in-process mutex.

`POST /streams/:id/publish` and `POST /streams/:id/unpublish` answer
`PublishResult`: `{ stream, feed: { owner, topic, topicHex, index, entryCount },
written }`. `written` is whether the call wrote the catalogue, and `index` is
the index it wrote at, or, when it wrote nothing, the one the feed already
stands at.

**A republish with nothing to write writes nothing.** Every write takes a slot
on the catalogue batch and lengthens the history a viewer walks, so a publish
of a stream already on the catalogue (`published`, `live` or `vod`) whose entry
the head, the list the write would start from, already carries exactly as it
would be written, apart from its `timestamp`, spends none. The publish still
finishes: the claim is released, the row records which edit its entry carries
and keeps the image it has, a live or recorded stream stays in its state, and
the answer has `written: false` with the index the feed stands at.
`published_at` and `published_feed_index` do not move, since nothing was
published: they stay with the stream's first announcement and with the write
that last carried its entry, which the head need not be. The log line says
nothing was written, and so does the audit row. A draft's publish, a publish
after an unpublish, a changed entry and a retry after a failed attempt
(`publish_error` set, which may have left the catalogue behind the row) write
as before. So does every state and rendition report. An unpublish of a stream
that was not on the feed answers `written: false` too. The console keeps
Republish disabled while the stream holds no edit its entry lacks and its last
attempt did not fail.

### A stream's stage

Every stream is broadcast on a stage, a deployment the manager runs and pushes
into the admin (`docs/architecture/stages.md` at the repository root).
`streams.stage_id` (migration 011) names it, `Stream.stageId` carries it, and
`StreamInput.stageId` sets it on `POST` and `PUT /api/streams`: a stage's id,
`null` for none, or absent to leave the stream's as it is.

- **Which stages take a stream.** One the admin holds, that the manager has not
  retired, on an engine the admin takes streams on (SRS only). Any
  other is `409 stage_unavailable` with `reason` `unknown`, `retired` or
  `unsupported`. A stream already on a stage the manager retires later keeps
  it, and a save naming the stage it has is not a change.
- **When the stage changes.** Only while the stream is a `draft`, because
  publishing fixes it: the catalogue entry and every viewer link carry the
  stage's owner. A change to a stream in any other status is
  `409 stage_locked` with `reason: 'published'`: unpublish, change it, publish
  again. A draft that holds a recording (`manifest_index` set) keeps its
  stage, `409 stage_locked` with `reason: 'recording'`, since the recording
  lives under that stage's owner; a recorded draft from before stages, which
  has none, may be given its first, and only one that signs as the
  recording's owner, the brand key's address when it was made: any other is
  `409 stage_locked` with `reason: 'owner'`. The conditional `UPDATE` holds these rules
  again, and moves a stream only to a stage the `stages` table holds, not
  retired and on a supported engine, so an edit racing a publish or a
  retirement cannot move a stream where the service would not. The stage is
  read by `findSummary`, the columns a list reads, so the passphrase is never
  selected for it. A stage
  is not on the catalogue entry, so a change does not count as an edit the
  entry lacks.
- **Publishing needs one.** `POST /streams/:id/publish` on a draft with no
  stage is `409 stage_required` ("Pick the stage this stream is broadcast on
  before publishing."), and the claim refuses it too. A draft without a
  recording whose stage no longer takes streams (retired since it was picked,
  or not supported) is `409 stage_unavailable`; a draft that holds a recording
  is published as that recording whatever became of its stage. A stream already on the
  catalogue is republished as it is, so one published before stages existed
  keeps working, with no stage until it is unpublished.
- **The OBS details are the stage's.** `GET /streams/:id/ingest` builds the SRT
  line from the stage's public ingest address and SRT port, adds the RTMP
  server and stream key only where the stage's record says `rtmpPublic`,
  which the manager says of every SRS stage and of no OvenMediaEngine one, and
  answers
  the stage's SRT passphrase, read from the `stages` table's own column for
  this one answer. RTMP has no passphrase, so its stream key crosses the
  network as readable text, and the console's OBS panel says so beside it. It names the stage (`stage: { stageId, name, retiredAt }`). With
  no stage, `stage`, `srt` and `rtmp` are null and only the stream id and key
  are answered. Every uploader that takes streams from this admin verifies the
  `key=` they carry, so the answer no longer says whether it does.
- **A stream signs as its stage.** Every stage signs with a key of its own,
  and the stage record names its address as `owner`. A stream takes its
  stage's owner, lower case and without `0x`, when it is created on a stage
  and whenever its stage is set or changed; one with no stage has the brand
  key's. The publish claim of a draft that holds no recording reads it from
  the stage again, in the same statement, since a key rotated in the manager
  is pushed as a new owner. A row that holds a recording never changes owner,
  because the recording's feeds resolve only under the key they were signed
  with, and publishing one whose stage now signs as another address is
  `409 feed_owner_mismatch` ("The recording was made under another key: …"),
  with the stream's `id` and its `stageId`; the publish claim itself refuses
  it, so a rotation that lands between the read and the claim is refused too.
  A publish of a draft whose last publish failed first takes off any entry of
  ours for its topic under another owner, which the failed write may have left
  under the owner the row had then. A stream already on the catalogue
  keeps the owner publishing fixed. The catalogue itself is still signed by
  `FEED_PRIVATE_KEY`, and `GET /api/config` still names that address, for the
  viewer build; every entry names its own stream's owner.
- **Audited.** A change is its own `stream.stage` row, `details: { from, to }`,
  with `ownerFrom` and `ownerTo` when the stream's owner moved with it,
  beside the `stream.update` row of any field the same save changed, and the
  `stream.create` row carries the stage the stream was created on.

### Where the catalogue is written

Every write, the feed and every thumbnail it uploads, goes through the Bee API
address and the batch of the catalogue stamp the manager pushed
(`PUT /api/internal/catalogue-stamp`), read from the database on every write
(`src/domain/CatalogueBatch.ts`). Nothing about the node or the batch is in the
env file or held in memory, so a new designation or a moved node takes effect on
the next write.

Each version of the list is uploaded direct, so a write returns on the storer's
receipt rather than once the admin's node alone holds it. The admin does not
write the list's window notes yet, which the uploader's own list writer does
when it runs without an admin (`docs/architecture/overview.md`, "The stream
list's notes").

The admin keeps the batch it actually writes with, since a batch stamps the
chunks it wrote and the feed's history is those chunks. Migration `013` adds
`active_batch_id`, `active_record` and `active_pinned_at` to `catalogue_stamp`:

- The first write under a designation pins its batch, and `active_record`
  keeps the last record the manager pushed for it: its node address and its
  readings, refreshed by every push for that batch. The pin takes the stored
  designated record when it is for that batch, which is never older than the
  copy the write read. The pin is audited as
  `catalogue.batch.pin`, with the writer as the actor.
- When the manager designates another batch and this feed has a write in
  `feed_writes`, the admin keeps writing with the pinned one, at its node, and
  says a move to the designated one is waiting. Moving the catalogue, stamping
  the history again under the new batch, is its own job
  ([Moving the catalogue](#moving-the-catalogue-to-another-batch)). With no write
  recorded for the feed (the feed key changed) there is nothing to move, and
  the designated batch is pinned in its place.
- The pinned batch's readings are then the ones the manager pushes of the
  batch its move is from, as the record's `previous`, while that move is
  pending in the manager: a record whose `previous.batchId` is the pinned batch
  replaces `active_record`'s node, address and readings, as of the record's
  `observedAt`, unless the reading it holds was observed later. So a top-up of
  the pinned batch reaches the admin. Without one, a manager older than the
  field, one that could not read the node, or a move already released, they are
  the last ones the manager pushed while it was the designated batch. They are
  kept and shown with the moment they were read, not treated as unknown: an
  expired or gone among them is still a refusal worth making, and so is a time
  to live that has run out since, and they only age.
- The first write after an upgrade from `POSTAGE_BATCH_ID` pins the designated
  batch; the feed's earlier writes were stamped by the env file's batch, which
  the admin never recorded, and the log says so. Their rows keep a null
  `batch_id`, which is how the move finds them. While any is left, My Streams
  says how many and that a move is waiting, pin or no pin: the batch that
  stamped them is unknown, so it cannot be told apart from the pinned one.
- A clear of the designation leaves the pin as it is: the history is still
  stamped by that batch, and a designation that comes back finds it.

A publish, an unpublish or a reconcile is refused before it claims a row or
writes anything, with `503 catalogue_stamp_unavailable`, `problem` and the
sentence in `message`, when there is nothing to write with:

| `problem` | `message`                                                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none`    | The manager has not designated a catalogue batch yet. Nothing is written to the catalogue until it does.                                                            |
| `cleared` | The manager cleared the catalogue batch designation. Nothing is written to the catalogue until it designates one again.                                             |
| `expired` | The catalogue batch `ab12cd34…` is expired. Nothing can be written to the catalogue with it.                                                                        |
| `gone`    | The catalogue batch `ab12cd34…` is gone. Nothing can be written to the catalogue with it.                                                                           |
| `mutable` | The catalogue batch `ab12cd34…` is mutable, and a mutable batch overwrites the catalogue's oldest slots once it fills. Nothing is written to the catalogue with it. |

`expired`, `gone` and `mutable` name the batch the admin writes with, by the
last record it holds for it. A batch is also `expired` once the time to live
that record gave it has run out, `observedAt` plus `ttlSeconds` before the
admin's clock, whatever its state says: a pinned batch the manager no longer
reads keeps its last reading, and that reading only ages. A time to live counts
only when it is positive, and a clock a few seconds off cannot change an answer
measured in hours. The console is shown every batch reading aged by the same
rule (`src/domain/stampAge.ts`), so it never shows time left on a batch the
admin refuses. `mutable` holds on the admin's side the rule the manager
already keeps when it designates a batch. The uploader's state and rendition reports store their state first
and are refused the same way when their rewrite of the catalogue comes, with
the sentence recorded as the stream's `publish_error`; 503 is a 5xx, so the
uploader retries them. A reason a failed write stores or answers never
carries the catalogue node's address: bee-js and Node print it, as a URL or as
`host:port` after `ECONNREFUSED` and the like, and it is replaced with "the
catalogue node" (`src/domain/catalogueNodeText.ts`); the log keeps the error as
it was. `GET /api/catalogue-stamp` tells the console the rest:
`catalogueWrite` holds the batch the catalogue is written with, the refusal, a
waiting move and `unrecordedHistory`, the count of this feed's writes with no
batch recorded, and My Streams shows them as a banner, with a warning under 48
hours left (`STAMP_EXPIRY_WARNING_SECONDS`), by the batch's `remainingSeconds`
aged to the request, or at 90% full (`CATALOGUE_FILL_WARNING_RATIO`).

Every write records the exact string it uploaded as the payload in
`feed_writes.payload_text`, next to `payload`, which holds it parsed, and the
batch that stamped it in `feed_writes.batch_id` (migration `013`). bee-js puts
a payload straight into the feed's chunk with no timestamp, so the same bytes at
the same index make the same chunk: these are what moving the catalogue uploads
again. Rows from before the migration have neither; a head adopted at boot has
the text the node gave and no batch.

### Moving the catalogue to another batch

The viewer walks the catalogue feed's slots from 0 and stops at the first it
cannot read, so every slot has to stay retrievable. A top-up keeps the batch
id and needs nothing here. Another batch means stamping every slot again under
it before the old one lapses: `src/domain/CatalogueMove.ts`, with its progress
in `catalogue_moves` (migration `014`).

**Off by default.** `CATALOGUE_MOVE_ENABLED=true` turns it on. Try it on a
scratch node first (`docs/architecture/stages.md`, "Trying the move on a real
node"). While it is off, the Stages page says the move is not yet enabled on
this installation, and a start is refused with `problem: disabled` before
anything else, a move left running included.

**When a move waits.** When the feed has history and the pinned batch is not the
designated one (another designated, `moveWaitingTo`, or a move back to one that
still holds every slot, which needs the switch alone), or some slot from 0 to the
head is not under the designated batch by the admin's record (written with
another batch, or with one the admin never recorded: `unrecordedHistory`, the env
file's; rows a move uploaded again under the pinned batch no longer count there),
or the latest move to it has not finished (a failure after its last slot, at the
thumbnails, is retried). Nothing waits only when the pinned batch is the
designated one and every slot is under it. The Stages page then shows the
catalogue move card, with "Move the catalogue to batch …" and a confirmation. It
says the previous batch can be released in the manager only while the finished
move's batch is both pinned and designated.

**What the job does**, for slots 0 to the head, in order:

- Each slot's single-owner chunk is uploaded again under the new batch through
  the catalogue node, byte for byte. From `payload_text` where the row has it:
  the chunk is built as bee-js's `updateFeedWithPayload` built it, and signed
  again with the feed key, which gives the same signature (secp256k1 with RFC
  6979 nonces; `test/unit/catalogueRestamp.test.ts` holds both to it). A row
  without it, or a slot with no row at all (written before migration `003`),
  is read from the network through the catalogue node, checked against its
  address, and uploaded with the signature it carries. A payload over 4096
  bytes is a wrapped chunk: its content-addressed data is uploaded again first,
  and has to come to the root the slot wraps. A head adopted from the network at
  boot (no reference, no batch) takes the network path too: its text is what a
  node answered, not a write of this admin's.
- A slot already under the new batch by the record (written with it, uploaded
  again under it, or covered by a move to it that finished) is left as it is.
- Then every thumbnail a stream names (`streams.thumbnail_ref`, published or
  not, since a draft published again names the same reference) and every one
  the latest entry names, from `streams.thumbnail` where the row still holds
  the bytes, otherwise read from the network. One the entry names has to come
  out at that reference, and an upload that fails stops the move, to be
  retried. Each is recorded as under the new batch on its streams
  (`streams.thumbnail_batch_id`, migration `014`), and a publish uploads a
  thumbnail again whenever that batch is not the one it writes with.
- Then the admin writes with the new batch: the pin moves to it.

**Publishing goes on.** The history goes in slices of 20 slots outside the
publish mutex, with the designation checked again between slices. The last
step holds the mutex: the slots written meanwhile, the thumbnails of the entry
written last, and the switch, so no slot is ever left under the old batch alone.

**Resumable.** After every slot `catalogue_moves.next_index` moves on and the
row's `feed_writes.restamped_batch_id` and `restamped_at` are set, in one
transaction. A process that stops resumes a running move at boot; a shutdown
pauses it after the slot it is on. A failure stops with its reason in
`catalogue_moves.error`, without the catalogue node's address, and the same
start retries it from there. With the move turned off since, a move left
running is failed at boot with that reason.

**Refused**, with `409 catalogue_move_refused` and `problem`: `disabled`,
`none` or `cleared` (no batch to move to), `nothing` (every slot is under it
already), `target` (the designated batch is expired, gone or mutable), `lapsed`
(the batch the catalogue is written with has lapsed and some slot has no
recorded bytes, which only the network could give), and `changed` (the page
named another batch than the designated one).

**Audited** as `catalogue.move.start`, `catalogue.move.done` and
`catalogue.move.failed`, with the move's id and both batches; the log lines,
`[CatalogueMove]`, shorten batch ids. Once the page says the move is done, the
previous batch is released in the manager's Catalogue node card, which is what
lets its node be removed and its batch lapse.

### Where the next index comes from

**`feed_writes` is the source of truth for the next index and the base payload;
the network is a cross-check at boot.** The invariant this rests on is that
**exactly one backend process writes a given feed key**.

It used to read the head from Bee and write at `head + 1`. That assumed a
node's feed lookup reflects an update that node itself made. It does not: on
the test node the head lagged this backend's own write by up to ~30 s. Writes
3-4 s apart through the mutex therefore computed the same index, and since a
feed update's chunk address is `f(owner, topic, index)`, the later chunk simply
replaced the earlier one — silently, three times in 55 writes. The stale head
came with a stale _payload_, which made it worse: a publish rebuilt the list
from a snapshot taken before the previous unpublish, so a stream that had been
unpublished and then deleted came back onto the catalogue with no row left to
remove it; and an unpublish that read a snapshot from before its own publish
found no entry to remove, skipped the write, and left the entry there while the
row went back to `draft`.

So the database leads. It is written in the same step as the feed, under the
mutex, by the process holding the key, and migration `003` gave `feed_writes`
the `feed_owner` / `feed_topic` / `reference` columns plus a partial unique
index on `(feed_owner, feed_topic, feed_index)` so a repeat of an index fails
loudly instead of overwriting a chunk. `readLatest()` is now used for two
things only:

- **Fallback.** A feed with no recorded write — a fresh install, or rows that
  predate migration `003` — takes its first base from the network, and says so
  in the log. From the write after that, the log leads.
- **Boot check.** Startup compares the network head against the last recorded
  write. Behind is normal (the node lagging itself) and is an info line. Ahead
  is a WARN — another writer under this key, or the wrong database — and the
  network head and its payload are adopted as the base by recording them, so
  the next write goes _after_ what is out there rather than over it. Bee being
  unreachable here is a warning, not a failed boot. The head is read through
  the catalogue node; an admin that starts before the manager designated a
  batch has none, so the check is skipped with a warning and runs once, as
  soon as a push stores a designation (`src/domain/feedBootCheck.ts`).

Boot also dry-runs the reconcile diff and WARNs with the topics of any
catalogue entry that has no stream row behind it.

### POST /api/feed/reconcile

The repair path for exactly that: an entry no request can name, because
`unpublish` needs a row and topics are server-minted. Session auth, no body.
Under the publish mutex it takes the authoritative base and rewrites the list
from the database — "ours" being every entry whose owner is the brand key's,
any stage's the admin holds, retired stages included, since their streams and
old entries still name them, or any row's on the catalogue, which keeps a
stream published under a stage's key from before a rotation — drops entries of ours whose topic has no row in
`published`/`live`/`vod`, rebuilds entries that no longer match their row,
appends published rows that are missing, and copies everything written by
anyone else through untouched. It writes only if something changed, so running
it on a clean catalogue costs no index and no stamp. The answer is
`FeedReconcileResult`: the index written (or `null`), and the topics
`removed` / `added` / `updated`. Each stream whose entry it rewrote or added
takes that index as its `publishedFeedIndex`, which is always the index the
stream's own entry was last written at: by its publish, a republish, a state or
rendition report, or a reconcile. A write for another stream copies the entry
and leaves it, and a reconcile leaves `publishedAt` alone.

A stored `thumbnail_ref` is reused only when `thumbnail_batch_id` (migration
`014`) says it was uploaded under the batch the write goes with, and the
gateway still holds it; otherwise the same bytes are uploaded again under that
batch, which comes to the same reference, and the batch is recorded. An image
only an older batch holds would lapse with it. The gateway is asked whether it
still holds that reference, and only then is it carried onto the feed. A reference the gateway does not have is re-uploaded and the new one
persisted, with a warning naming the stream and the stale reference. This is
what makes the `fake`/`bee` switch safe — `fake` mints references that exist
nowhere, and without the check a stream published under `fake` would keep
advertising one after the switch, giving every viewer a 404. The same applies
when the catalogue stamp names a node that never saw the chunks. A gateway that
cannot answer (node unreachable, timeout, an unexpected status) fails the
publish with `502 publish_failed` instead of re-uploading: "unreachable" is not
"missing", and guessing would spend a stamp on every hiccup. A check that
times out (30 s; a missing reference makes Bee try the network first, 5-10 s
on the test node) is treated as missing and the image is re-uploaded, which is
content-addressed and so costs no new chunks; a node that cannot be reached at
all fails the publish with `publish_failed`.

A restart that interrupts a publish leaves the row claimed; boot repairs it
(`resetOrphanedPublishing`), sending a first-time publish back to `draft` and
an interrupted republish back to `published`, since that one's entry is still
on the feed and only an unpublish may remove it. Publishing also refuses with
`409 feed_owner_mismatch` a draft that holds a recording whose stage now signs
as another key, as above. Unpublishing is always allowed, by the owner stored
on the row.

**Do not give `FEED_PRIVATE_KEY` to a running swarm-hls-stream uploader.** It
caches the feed's next index; two writers at one index fork the feed.
The uploader reports into this API instead (`POST /streams/:id/state` and
`/renditions`).

## The internal API

`/api/internal` is what the swarm-hls-stream uploader and the manager call, and
nothing else. It is authenticated by `Authorization: Bearer <token>` — never by
a session cookie — and it is mounted before the console's routes on a path of
its own, so the two authentications cover disjoint surfaces. Each route names
the token it takes (`src/api/routes/internal.ts`). A wrong or missing token is
`401 unauthenticated`, the same answer the console's routes give. The manager's
four stage routes are described in
[The manager's stage routes](#the-managers-stage-routes) below, and
`GET /registrar`, the manager's proof of its token, answers `204` and nothing
else.

| Method | Path                              | Token     | Answer                                                                                                            |
| ------ | --------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| GET    | `/streams/by-ingest/:app/:stream` | uploader  | `IngestLookupResponse` — id, topic, owner, mediaType, title, status and the `publishKey` the encoder must present |
| POST   | `/streams/:id/state`              | uploader  | `StreamStateReport` in, `PublishResult` out (200)                                                                 |
| POST   | `/streams/:id/renditions`         | uploader  | `RenditionReport` in, `RenditionReportResponse` out (200) — one rung of an ABR ladder                             |
| GET    | `/stages/self`                    | uploader  | `stageSelfAnswerSchema`, `{ stageId, owner }`: the stage the caller's token is on, and the owner it signs as      |
| PUT    | `/stages/:stageId`                | registrar | the manager: a stage record in, `{ stored }` out                                                                  |
| DELETE | `/stages/:stageId`                | registrar | the manager: retires the stage, `{ retired }` out                                                                 |
| PUT    | `/catalogue-stamp`                | registrar | the manager: the catalogue stamp record in, `{ stored }` out                                                      |
| DELETE | `/catalogue-stamp`                | registrar | the manager: clears the catalogue stamp, `{ cleared }` out                                                        |
| GET    | `/registrar`                      | registrar | the manager's Test connection on its link: `204`, no body                                                         |

**The two tokens.** The manager's routes take the **registrar token**,
`INTERNAL_API_TOKEN`, and nothing else: a stage's own uploader token is `401`
there. The uploader's routes take **a stage's own token** alone
(`src/api/middleware/requireUploaderToken.ts`). The manager generates a token
for every deployment that runs an uploader and pushes its sha256 on the stage
record, with `adminToken.kind: 'own'`; any token it did not generate is
`shared`. The token is 64 hex characters, and a bearer of any other shape is
`401` without a query. The admin hashes the presented token and looks it up
among the stages it holds (migration 012): the one active stage whose record
names that hash as its own is the caller. A retired stage's token is `401`, and
so is a token that is no stage's own, a hash a `shared` record carries
included. A token that is the own token of several active stages is `401` too,
since it cannot say which stage calls, with a warning in the log naming the
stages.

**The registrar token on an uploader's route** is `401 unauthenticated`, like
any other token that is not a stage's own, on the lookup, both reports and
`GET /stages/self`, and nothing is written for it. An admin from before stages
and the upgrade's intermediate admin (`docs/self-hosting.md`) still take it
there, as an unattributed caller answered about every stream. A stage whose
uploader still presents it, or any other `shared` token, is refused until its
token is rotated in the manager (**Rotate the uploader's admin token**) and the
stage redeployed, and the Stages page says so.

Neither token nor its hash is logged at any level, audited or answered.

**A stage's token is answered only about its stage's streams.** The lookup,
the state report and the rendition report treat a stream on another stage, and
a stream with no stage (a row older than stages), as one that does not exist:
the same `404 stream_not_found`, answered before anything is written, so no
status moves, no rung is stored, no feed is written and no audit row is added.
A stream with no stage is reached by no uploader: unpublish it, give it a
stage and publish it again before its next broadcast.

**`GET /stages/self`** answers a stage's own token with the stage's id and
the owner the manager pushed for it, which the uploader compares with the
address it signs as. Any other token is `401`. An admin older than stages
answers `404` there, and the uploader falls back to its older check.

**`GET /registrar`** answers the registrar token `204` with no body, and any
other `401`. It does nothing: the manager's Test connection on its admin link
proves its stored token with it, since the uploader's routes refuse that token.

A path or a method no route names is `401` without a token either door takes,
and `404` with one, as it was when one token opened the whole of
`/api/internal`.

**The lookup** resolves the ingest stream id `<mediaType>/<topic>` to a stream.
Both halves must match, and only `published`, `live` and `vod` resolve: a
`draft` has been announced to nobody, and a `publishing` row has a feed write
in flight that may still fail back to `draft`. Every refusal is the same
`404 stream_not_found`, so a token holder probing ingest addresses learns
nothing from the difference. A malformed app or topic is `400`.

**The state report** is `{state:'live'}` or `{state:'vod', index, duration}` —
both numbers required with `vod`, refused with `live`. An uploader on time
windows sends `{state:'vod', recording, duration}` instead, `recording` being
the reference of the recording playlist it uploaded once at the end, 64
lowercase hex digits, and never sent with `index`. `live` sets `status`,
stamps `live_since` (kept as it is when the stream is already live, because the
uploader retries) and clears `ended_at`; `vod` sets `status`, `manifest_index`
or `recording_ref` (the other one cleared), `duration_seconds` and `ended_at`. Allowed: `published → live`, `live → live`,
`live → vod`, `vod → vod`, `published → vod` for a broadcast that ended before
its `live` report ever got through, and `vod → live` for a broadcast that goes
live again. Every feed of a declared stream outlives the sessions written to
it, so a reconnected encoder continues them above the previous head; that
`live` therefore clears `manifest_index`, `recording_ref` and
`duration_seconds` on the row and on every rung in the same statement, and the entry lists the latest recording
once the next `vod` arrives. Anything else is
`409 invalid_state_transition` with `from` and `to`. The rule is enforced twice
— once to answer the 409, once as the `WHERE status = ANY(...)` of the UPDATE
itself, so two reports racing cannot both win.

Each accepted report then rewrites the catalogue entry through the same
single-writer publish path, with `state` set accordingly and `index` or
`recording`, and `duration`, on a `vod` entry. **The state is persisted first and the feed
written second**, deliberately: a feed write can fail for reasons that have
nothing to do with this stream, and the uploader retries. A failure answers
`502 publish_failed` with `publish_error` recorded and the state intact, so the
retry has only the write left to do.

**The rendition report** is how an ABR ladder reaches the catalogue. With
`ABR_ENABLED` the uploader publishes a master playlist plus one feed per rung,
and in admin mode the master's topic _is_ the stream's declared topic — so the
ladder's merge state, which swarm-hls-stream keeps inside the catalogue feed it
writes for itself, has to live here instead. Each rung POSTs its own
`Rendition` (`name`, `width`, `height`, `topic`, `bandwidth`, `avgBandwidth`,
plus `index` and `duration` — both or neither — once it finalizes, or
`recording` and `duration` from an uploader on time windows) and gets
back the merged ladder, ascending by height, with `ladder { finished,
flippedToFinished, duration }`.

The merge keeps one record per `(stream, name)`. The incoming report replaces
the stored one, except that a rung which already reported an `index` or a
`recording` keeps it and its `duration` when the incoming report has neither
**and arrives on the same `topic`**, taking only geometry and bandwidths from it. A rung's topic is
derived from the stream's declared topic and the rung name, so every report for
a rung arrives on the feed that rung's recordings already sit on, and an
indexless one is that rung delivering again — recovered from a crash, or a new
session above the previous head. Either way the recording it finished last
stays addressable until that rung's next final report replaces it, which is
what keeps the master playlist a viewer seeks with on the entry. The rule is
`StreamCatalog.keepingWhatFinished` from the uploader, where it was learned;
the topic test is true for every rung of a well-formed ladder, and a report
naming some other feed is taken as it arrived. Un-finishing a ladder is the
`live` state report's job, not the merge's.

**A rendition report never moves the status.** It stores the rung and rewrites
the entry, adding `renditions` and `group` (= the stream's topic) whenever the
stream has at least one rung — an entry for a single-rendition stream is
exactly what it was before ABR existed. `live` and `vod` still come from the
state route, and `vod.index` for a ladder is the _master's_ feed index, not a
rung's; the rung indexes ride inside `renditions`. `flippedToFinished` is what
tells the uploader to send that one `vod`. The ladder, `finished` and
`flippedToFinished` in the answer are all read from the catalogue write itself,
under the publish mutex — the ladder the write put on the entry, judged against
the one the entry carried before — so two reports that overlap answer in the
order their entries landed and only one of them flips. Refused with
`409 invalid_state` for `draft` (nothing has been announced) and `publishing`
(a feed write is in flight); the row is stored before the feed is written, like
a state report, so a failed write is `502 publish_failed` and the retry has
only the write left to do — the merge is idempotent.

Migration 004 adds `stream_renditions`, one row per `(stream_id, name)`. An
unpublish keeps a stream's rungs with the rest of its recording, and deleting
the stream takes them with it through the foreign key.

### What that changes for the console

- A stream that is `live` or `vod` is still editable — title, description, tags
  and thumbnail — and `GET /streams/:id/ingest` still answers, so an encoder
  that dropped can reconnect. The media type stays refused with
  `409 media_type_locked`, and the schedule joins it with `409 stream_locked`:
  it is a promise viewers have already read off the entry.
- `POST /streams/:id/publish` on a live or recorded stream republishes it _as
  it is_ — the entry keeps its state and its index and duration — rather than
  claiming the row into `publishing` and returning it as `published`, which
  would quietly tell every viewer the broadcast had stopped. One whose entry
  the catalogue already carries writes nothing, as for a published stream
  ([Publishing](#publishing)).
- Every stream the API returns carries `hasUnpublishedEdits`, which drives the
  console's "Edited since it was published" notice. It is true while the
  console holds an edit the catalogue entry does not carry, and `updatedAt` is
  no longer read for it, because the uploader's reports move that too.
  Migration 006 adds the two columns behind it: `content_edited_at`, moved
  only by an edit that changes something the entry carries, and
  `entry_content_edited_at`, the edit the entry was last rebuilt from, written
  by a publish, a republish, a state or rendition report and a reconcile.
- `POST /streams/:id/unpublish` and `DELETE /streams/:id` on a live stream are
  `409 stream_live` ("Stop the broadcast first."): nothing here can stop the
  encoder that is still pushing to it. On a recording both work as they do on a
  published stream, and the unpublish keeps everything the uploader reported:
  where the recording is, how long it runs, when it was live and the ABR
  ladder. `POST /streams/:id/publish` on a draft that holds a recording lists
  it as that recording again (`vod`), never as a stream that has not started.

### The manager's stage routes

The manager pushes every stage it runs for the brand into the admin, and the
brand's catalogue stamp (`docs/architecture/stages.md` at the repository root
is the design, `packages/contracts/src/stage.ts` the records). It calls with
the registrar token, which is `INTERNAL_API_TOKEN`, the one the manager's admin
link stores; a stage's own uploader token is refused here. The console's Stages page lists the records, and the stream form
and the OBS panel read them ([A stream's stage](#a-streams-stage)), and the
catalogue is written through the catalogue stamp
([Where the catalogue is written](#where-the-catalogue-is-written)).

Every moment these routes order things by is the manager's: a record's
`observedAt`, and the `observedAt` a `DELETE` carries, the moment the manager
saw the deployment or the designation gone. The admin's clock only records
when something arrived, so the two hosts' clocks never need to agree.

- **`PUT /stages/:stageId`** takes a `stageRecordSchema` record and answers
  `{ stored }`. The path id must be the record's `stageId` (either case), or
  it is `400`. A record observed before the stored one is kept out and answers
  `{ stored: false }`; one observed at the same moment is a repeat and stores.
  The manager pushes every 30 seconds per stage, so this is mostly repeats.
  The last manager to push a stage wins: `managerId` is taken from each stored
  record, so a manager reinstalled with a new id takes its stages back, and
  the move is audited as a `stage.change`.
- **`DELETE /stages/:stageId`** takes `stageRetireRequestSchema`,
  `{ observedAt }` (`400` without it), retires the stage as of that moment and
  answers `{ retired }` (`stageRetireAnswerSchema`). The row is never deleted:
  streams and old catalogue entries name its owner. A later `PUT` brings the
  stage back only when its record was observed after the retirement's moment,
  and otherwise stores it and leaves the stage retired, so a push already on
  its way when the deployment was deleted does not undo the delete. The answer
  is `true` only when this call retired an active stage, and `false` when:
  - the stage was retired already (the later of the two moments is kept);
  - the admin holds a record observed after the retirement's moment, so the
    manager has seen the deployment since and the retirement is not taken;
  - the admin never stored the stage. The retirement is still kept, in
    `stage_retirements`, and a `PUT` for that id is stored only when its
    record was observed after it, so a first push that arrives late does not
    register a deployment that is gone.
- **`PUT /catalogue-stamp`** takes a `catalogueStampRecordSchema` record and
  answers `{ stored }`, with the same ordering rule.
- **`DELETE /catalogue-stamp`** takes `catalogueStampClearRequestSchema`,
  `{ observedAt }`, and answers `{ cleared }`
  (`catalogueStampClearAnswerSchema`) under the same rules as a retirement:
  the row stays, a later `PUT` sets the stamp again only when observed after
  the clear, and a clear that arrives before any record is kept on the row, so
  a late first record does not set a stamp that is gone.

A body the contract refuses is `400 validation_error` with the reasons, never
the values it refused. The SRT passphrase and the sha256 of the uploader's
token are kept in columns of their own (migration 009) that no list selects;
neither is logged, audited or answered to anyone. The console reads the
records back behind the session:

| Method | Path                   | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/stages`          | `StageListResponse`: every stage, retired ones last, with `supported` (the engine is SRS), its status, owner, ingest host and ports, `hasSrtPassphrase`, rung stamp and chequebook readings, uploader, readiness, `adminTokenKind` (`own`, `shared`, or `null` when the manager pushed no token) and when it was observed. Each rung stamp carries `remainingSeconds` and `expiredByClock`, aged at request time from the stage's `observedAt`                                                        |
| GET    | `/api/catalogue-stamp` | `CatalogueStampResponse`: `catalogueStamp`, the designated batch's node name, batch id, immutable, depth, state, time to live and fill, or null; `catalogueWrite`, the batch the catalogue is written with, the refusal and a waiting move; and `catalogueMove`, the move of the history ([Moving the catalogue](#moving-the-catalogue-to-another-batch)). Both batch readings carry `remainingSeconds` and `expiredByClock`, aged at request time from their `observedAt`. Never the Bee API address |

`POST /api/catalogue-stamp/move`, behind the session and the same-site check,
takes `{ targetBatchId }` and starts the move, or retries a failed one, and
answers `202` with the move's status; `409 catalogue_move_refused`, with
`problem` and the sentence, when it cannot start.

To register a stage by hand in local development, with `INTERNAL_API_TOKEN`
exported from your `.env` and example values:

```bash
curl -sS -X PUT http://127.0.0.1:9877/api/internal/stages/5f0c2a8e-1b2c-4d3e-8f40-0a1b2c3d4e5f \
  -H "Authorization: Bearer $INTERNAL_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "schemaVersion": 1,
    "stageId": "5f0c2a8e-1b2c-4d3e-8f40-0a1b2c3d4e5f",
    "managerId": "0d9e8f7a-6b5c-4d3e-9f21-a0b1c2d3e4f5",
    "name": "Main stage",
    "kind": "abr-uploader",
    "engine": "srs",
    "stackVersion": null,
    "status": "running",
    "observedAt": "2026-09-28T10:00:00.000Z",
    "ingest": { "host": "ingest.example.org", "srtPort": 10061, "rtmpPort": 10062, "rtmpPublic": true, "srtPassphrase": null },
    "owner": "0x3f1a9c2b4d5e6f708192a3b4c5d6e7f809a1b2c3",
    "rungs": [],
    "uploader": null,
    "readiness": { "tone": "unknown", "reasons": ["registered by hand"] },
    "adminToken": null
  }'
# {"stored":true}

curl -sS -X DELETE http://127.0.0.1:9877/api/internal/stages/5f0c2a8e-1b2c-4d3e-8f40-0a1b2c3d4e5f \
  -H "Authorization: Bearer $INTERNAL_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{ "observedAt": "2026-09-28T10:05:00.000Z" }'
# {"retired":true}
```

## Migrations

`src/migrations/NNN_name.sql`, applied in order inside a transaction at every
boot and recorded in `_migrations` (`src/domain/Database.ts`) by file name
alone, so a database that already applied a file never runs it again. Add a
file for a change, and never change an applied one's SQL; a corrected comment
is harmless. `001_init.sql` carries the rationale for each table in its
header. `pnpm build` copies the directory into `dist`. `007_audit_log.sql` is
the audit log below, and `008_streams_user_id_set_null.sql` stops removing a
user from deleting the streams they drafted. The latest six are
`009_stages.sql`, the `stages` table (the record without the passphrase and
the token, the passphrase and the token hash in columns of their own, when the
record was observed and received, and the retirement's moment and arrival) and
`stage_retirements` (retirements of stages never stored), which also lets the
audit log name the manager, `010_catalogue_stamp.sql`, the single-row
`catalogue_stamp`, `011_streams_stage.sql`, `streams.stage_id`, the stage
a stream is broadcast on, with a foreign key to `stages` and an index,
`012_stages_admin_token_index.sql`, the partial index an uploader's own token
is looked up by, `013_catalogue_writes.sql`, the batch the catalogue is
written with on `catalogue_stamp` and the exact bytes and batch of every write
on `feed_writes` ([Where the catalogue is written](#where-the-catalogue-is-written)),
`014_catalogue_moves.sql`, a move's progress in `catalogue_moves` and the
batch each write and each thumbnail was last uploaded under
([Moving the catalogue to another batch](#moving-the-catalogue-to-another-batch)),
and `015_recording_reference.sql`, `recording_ref` on `streams` and on
`stream_renditions`, a recording named by reference beside the feed index,
never both ([The internal API](#the-internal-api)).

## Audit log

Every signed-in user can act on every stream, so each mutation leaves a row in
`audit_log` (migration 007) saying who did it, and the same fact as a line in
the log, actor first (`[Publish] alice published "Opening keynote" (topic …):
draft → published at feed index 12 (3 entries)`). A state or rendition report
logs two lines, its own and the republish it caused (`[Publish] the uploader
republished …`); a rendition report whose write failed logs only the failure.
The line is at info, except a reconcile that wrote and the boot repair, which
are at warn, and failures, which are at error. Titles are written as JSON
strings, with U+2028 and U+2029, DEL and the C1 controls, and the
bidirectional controls escaped as well, all of which JSON leaves as they are
(`quoteForLog` in `src/utils/logText.ts`). A title cannot carry a line break
into the log for any reader, nor reorder what its line appears to say.

| Column                          | What it holds                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `at`                            | when the row was written, just after the mutation                                                                                                                                                                                                                                                                                              |
| `actor_kind`                    | `operator` (a signed-in user), `uploader` (the uploader's internal routes), `manager` (the manager's stage routes, since migration 009) or `system` (the boot repair, the CLI)                                                                                                                                                                 |
| `actor_user_id`, `actor_name`   | the operator's id and username at the time; the id goes null if the user is removed, the name stays. For `system`, `actor_name` is the reason (`boot`, `cli`); for the uploader and the manager it is null                                                                                                                                     |
| `action`                        | see below                                                                                                                                                                                                                                                                                                                                      |
| `stream_id`, `topic`            | the stream, with no foreign key so a deleted stream's history stays                                                                                                                                                                                                                                                                            |
| `status_before`, `status_after` | the stream's status before and after the action. Every stream action fills both, with the same status on both sides when nothing moved (an edit, a thumbnail, a key rotation, a republish, a rendition report), except that `stream.create` has no before and `stream.delete` no after. `feed.reconcile` and the `user.*` rows leave both null |
| `details`                       | JSON: changed fields, feed index and what that write published, rung, error message, target username. Never a key, hash or token                                                                                                                                                                                                               |

The actions: `stream.create`, `stream.update` (only when a field actually
changed; a save of an unchanged form is logged, not audited), `stream.stage`
(a draft moved to another stage, or on or off one, `details: { from, to }`),
`stream.delete`, `stream.thumbnail.set`, `stream.thumbnail.clear` (only when
there was an image to remove), `stream.key.rotate`, `stream.publish`,
`stream.republish` (only a publish of a live or recorded stream; publishing one
that is already `published` records `stream.publish` with
`published → published`), `stream.unpublish`, `stream.publish.failed`,
`stream.unpublish.failed`, `stream.state.live`, `stream.state.vod`,
`stream.rendition.report`, `feed.reconcile` (only when it wrote),
`stream.publishing.reset` (boot), `user.add`, `user.remove`,
`user.sessions.revoke`, `user.password.change`. A `stream.publish` or
`stream.republish` row carries `feedIndex`, `entryCount` and `written`, which
is false for a republish whose entry the catalogue already carried: nothing
was written, and `feedIndex` is the index the feed stood at. A state or
rendition report is one row, carrying the feed index of the republish it
caused, or the publish error when that write failed; the republish adds none
of its own. That republish reads the row and the ladder again when its turn at the
publish mutex comes, so a later report stored in the meantime is what it
publishes, as it should be. Beside `feedIndex` the row therefore says what
the write published. A state report's row has `entryStatus`, the status the
entry was written with, and `entryRecording`, the `index` and `duration` the
entry lists, with `recording` when the entry names its recording by reference,
null unless it is `vod`. A report that sent `recording` records it where an
index report records `index`. A rendition report's row has
`entryRung`, the report's rung as the write carried it. Where these differ
from what the report itself carried (`status_after`, or `index` and
`duration`), the write published something stored after the report, with one
exception: a finished rung that reports again without an index, on the same
topic, keeps the index and duration it finished with (the merge above), so
its row shows `index` and `duration` null beside a finished `entryRung`
although nothing came after it. A rendition report never moves the status,
so its row names one status on both sides: the one its write saw, or, when
the write failed, the one the row had when the report arrived. A repeated
`live` report (the uploader retries) writes one row per report, deliberately:
each is a report the row accepted. A failed publish or unpublish carries the
error, and `feedIndex` when the gateway had already taken the write, which
means the entry is on the catalogue although the row says it is not. A failed
hand republish of a live or recorded stream is recorded as
`stream.publish.failed` with `{ error, republish: true }` and the status it
stayed in on both sides, and never carries a `feedIndex`. Refusals (404, 409)
are not recorded: nothing moved.

The manager's pushes are audited only when something that matters moved,
since one arrives every 30 seconds per stage: `stage.register` (a stage first
stored), `stage.change` (its manager, owner, ingest host, ports or RTMP flag,
SRT passphrase, uploader token or token kind changed; `details.changes` has
`{ from, to }` for each, and `"set"`, `"removed"` or `"changed"` for the
passphrase and the token, never their values), `stage.retire`,
`stage.unretire` (a retired stage pushed again after its retirement),
`catalogue.stamp.set`, `catalogue.stamp.change` (another batch, node, Bee API
address or manager; the address only as `"changed"`) and
`catalogue.stamp.clear`. Each is also a line at info (`[Stages] the manager
registered stage "Main stage" (stage 5f0c…): …`). `stage.retire` and
`catalogue.stamp.clear` carry the manager's `observedAt`. A push that changes
nothing else, a record kept out as older and a second retirement or clear log
at debug and write no row. A retirement or clear the admin does not take
because it holds a newer record, and one kept for a stage or stamp it never
stored, log at info and write no row either: nothing it held moved. The stage
is in `details.stageId`; the rows have no `stream_id`.

**A failed audit write never fails the operation.** The row is written after
the mutation it describes, which has already happened by then; the failure is
logged as `[Audit] could not record …` and the request answers as it would
have.

Nothing in the API reads it. With `psql`:

```sql
-- the last fifty things anyone did
SELECT at, actor_kind, actor_name, action, topic, status_before, status_after, details
  FROM audit_log ORDER BY at DESC LIMIT 50;

-- the history of one stream, deleted or not
SELECT at, actor_name, action, status_before, status_after, details
  FROM audit_log WHERE stream_id = '<stream id>' ORDER BY at;
```

`feed.reconcile` rows are not about one stream and have no `stream_id`; the
topics they removed, added and updated are in `details`. Nor are the manager's:

```sql
-- the history of one stage
SELECT at, action, details FROM audit_log
 WHERE actor_kind = 'manager' AND details ->> 'stageId' = '<stage id>' ORDER BY at;
```

## Limitations (intentional)

- **A stream belongs to the installation.** Every signed-in user sees and can
  edit, publish, unpublish and delete every stream. `streams.user_id` records
  who drafted a row and scopes no query; the audit log records who acted on it
  since. Removing a user keeps their streams and sets `user_id` to null
  (migration 008). For a stream created since migration 007 its `stream.create`
  audit row still names them. For an older one nothing in the database does:
  the audit log started empty and nothing backfills it. There is no separation
  between brands yet.
- **The audit log is never pruned.** Nothing deletes from `audit_log`, so it
  grows for the life of the database.
- **The fields an edit changed are read, not locked.** `stream.update` compares
  the row read before the UPDATE with the one it returns, so two edits racing
  can each be recorded against the other's starting point.
- **Nothing polls.** A state report is the only thing that moves a stream to
  `live` or `vod`; an uploader that dies without reporting leaves the stream
  live on the catalogue until someone republishes or unpublishes it by hand.
- **A stage on a token the manager did not generate reports nothing** until
  its token is rotated in the manager and it is redeployed, and a published
  stream with no stage takes no broadcast until it is given one. The access
  log still writes
  one `[HTTP]` line at info for every push, although the stage service logs an
  unchanged one at debug.
- **Sessions are unbounded per user** and pruned on sign-in and by a daily
  sweep.
