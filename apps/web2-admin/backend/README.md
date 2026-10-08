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
- **node:crypto** — scrypt passwords, random session tokens stored as sha256,
  and AES-256-GCM for the brand wallet's key. No auth, session, CSRF or
  rate-limit dependency
- **viem** — the brand wallet's key and the transfers it signs
  ([Funding](#funding))

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
| `pnpm wallet:export --i-understand`     | print the brand wallet's private key once, for the backup handed to the brand. Refuses without the flag  |
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
| `BRAND_WALLET_SECRET`                 | empty              | 64 hex (32 bytes). The brand wallet's key is encrypted under it; the first start creates the wallet. Required with `MANAGER_FUNDING_URL`       |
| `MANAGER_FUNDING_URL`                 | empty              | the manager's address for its funding API: https, or plain http to this host only. Empty: funding is not set up                                |
| `MANAGER_FUNDING_TOKEN`               | with the URL       | 32+ chars, printable ASCII, no space: the manager's `FUNDING_API_TOKEN`. Refused without the URL. Never logged                                 |
| `WEB2_ADMIN_VERSION`                  | unset              | the build's label, which `deploy/deploy.sh` builds into the image. Never in the env file: [The build it runs](#the-build-it-runs)              |
| `WEB2_ADMIN_COMMIT`                   | unset              | the build's commit, built in the same way. `GET /api/version` answers both                                                                     |

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
token redacted. The brand wallet secret and the manager funding token are not
logged at all, not even in part: the log says only whether each is set. A
funding key set wrong stops the start with a sentence that names the key and
never the value.

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

## The build it runs

`GET /api/version` answers `VersionInfo`, `{ label, commit }`, for signed-in
users only: behind the session like every console route, and never on
`/api/config` or `/api/health`, which anyone can read. The console shows it
beside the signed-in account. It is sent `no-store`, as the manager's
`GET /version` is, because a redeploy replaces the answer and a page should
never show the build it was loaded with.

The values are `WEB2_ADMIN_VERSION` and `WEB2_ADMIN_COMMIT`, read once at
boot. `deploy/deploy.sh` names the build with `tools/release/version.mjs` and
builds both into the image's environment, so a container that was not
replaced goes on answering the build it runs ([deploy/README.md](../deploy/README.md#the-version)).
A label is the tag the build was deployed from, `<tag>+<commits past it>`, or
the short commit, with `-dirty` for changes that were not committed. A label
that is not 1 to 96 letters, digits and `. _ + / -`, or a commit that is not
40 lowercase hex characters, is answered as `null`, and so is an unset one:
an image built by hand or `pnpm dev` answers `{ "label": null, "commit": null }`,
which the console calls a development build. The boot log names the build on
its `[Boot]   version:` line.

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
both numbers required with `vod`, refused with `live`. `live` sets `status`,
stamps `live_since` (kept as it is when the stream is already live, because the
uploader retries) and clears `ended_at`; `vod` sets `status`, `manifest_index`,
`duration_seconds` and `ended_at`. Allowed: `published → live`, `live → live`,
`live → vod`, `vod → vod`, `published → vod` for a broadcast that ended before
its `live` report ever got through, and `vod → live` for a broadcast that goes
live again. Every feed of a declared stream outlives the sessions written to
it, so a reconnected encoder continues them above the previous head; that
`live` therefore clears `manifest_index` and `duration_seconds` on the row and
on every rung in the same statement, and the entry lists the latest recording
once the next `vod` arrives. Anything else is
`409 invalid_state_transition` with `from` and `to`. The rule is enforced twice
— once to answer the 409, once as the `WHERE status = ANY(...)` of the UPDATE
itself, so two reports racing cannot both win.

Each accepted report then rewrites the catalogue entry through the same
single-writer publish path, with `state` set accordingly and `index` /
`duration` on a `vod` entry. **The state is persisted first and the feed
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
plus `index` and `duration` — both or neither — once it finalizes) and gets
back the merged ladder, ascending by height, with `ladder { finished,
flippedToFinished, duration }`.

The merge keeps one record per `(stream, name)`. The incoming report replaces
the stored one, except that a rung which already reported an `index` keeps its
`index` and `duration` when the incoming report has none **and arrives on the
same `topic`**, taking only geometry and bandwidths from it. A rung's topic is
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

## Funding

The Funding page sends xDAI and xBZZ from the brand wallet to the wallets of
the brand's nodes, through the infra manager's funding API
([docs/architecture/funding.md](../../../docs/architecture/funding.md)). The
admin signs each transfer and the manager sends it, so the admin needs no
chain connection of its own and the wallet's key never leaves it.

### The brand wallet

- **Created once.** The first start with `BRAND_WALLET_SECRET` set creates the
  wallet: a new key from viem's `generatePrivateKey`, stored in `brand_wallet`
  (migration `015`) encrypted with AES-256-GCM under the secret, with a random
  12-byte IV and GCM's 16-byte tag. The address is stored in clear, in lower
  case, for the page to show. The creation is logged, and every start logs the
  address (`[Boot] brand wallet: 0x…`).
- **Opened at every start.** A start decrypts the key once, checks it is the
  key of the stored address, drops it and keeps the address alone. A secret
  that does not open it, or a row changed outside the admin, stops the start
  with a sentence that carries neither the key nor the secret. Keep the secret
  with the env file: a wallet created under one secret opens under no other.
  There is no way yet to change the secret of an existing wallet. A secret
  that leaked, or the sample's that a test install kept, means exporting the
  key with `wallet:export` and storing it, then moving the funds to a wallet
  made under a new secret. Before anything is deleted, import the exported key
  into a wallet app and check that the address it shows is the Funding page's:
  once the row is gone, that key is the only way to the funds. Then delete the
  row of `brand_wallet`, start the API with the new secret, which makes the new
  wallet, and send the funds to it from the wallet app. A rekey command can
  come later.
- **Decrypted only to sign.** `signTransaction` reads the row, decrypts the key
  for that one signature, an EIP-1559 transaction serialized as
  `eth_sendRawTransaction` takes it, and drops it when it returns. It refuses
  a transaction that is not one before it reads the key. Nothing holds the key
  between calls, and neither the key nor the secret is logged, answered or put
  in an error.
- **Without the secret** there is no wallet: nothing is created, and a wallet
  already stored is left as it is, not shown, and named in a warning at boot.
  Nor can funding be set up: the API refuses to start with
  `MANAGER_FUNDING_URL` and no secret.

`src/domain/funding/BrandWallet.ts` is the module. The funding service uses
`BrandWallet.start`, which `src/index.ts` calls right after the migrations,
and the wallet's `address()` and `signTransaction()`.

### The backup at handover

The brand's backup of the wallet is its private key. At handover it is printed
once and handed to the brand, who can then move the funds from any wallet app,
without this admin. It is also the way back to the funds should the secret be
lost, since the wallet opens under no other.

```bash
pnpm wallet:export --i-understand
docker compose exec -T api node dist/cli.js wallet:export --i-understand
```

The command refuses without `--i-understand`, since anyone who holds the key
can move everything the wallet holds. It needs `BRAND_WALLET_SECRET` and the
database, as the API does, and changes neither. The key goes to standard
output alone, one line, so it can be piped straight into a password manager;
the warning and the wallet's address go to standard error. Nothing is logged,
and a wallet that cannot be opened prints nothing. The command for a server
deployment is in [deploy/README.md](../deploy/README.md).

### The manager's address and token

`MANAGER_FUNDING_URL` and `MANAGER_FUNDING_TOKEN` come together or not at all;
with neither, funding is not set up. With them, `BRAND_WALLET_SECRET` is
required as well, since funding signs every transfer with the brand wallet:
the API refuses to start with the address and no secret. Every request
carries the token, so the address is https, or plain http only to this
host: a loopback address (`127.0.0.0/8`, `[::1]`, `localhost`),
`host.docker.internal`, which the deploy compose file maps to the host for
the api, or a Docker service name with no dot, such as `manager`. It is the
idea of the rule the manager holds its web2 admin link to, judged here by
the text alone, with nothing resolved, so plain http to a name with no dot is
taken as a Docker service on this host. The container's DNS search domains
could still resolve such a name to another host, so give the https address of
any manager that is not on this host. Plain http anywhere else, a user
name or password, or a `?` or `#` part stops the
start. The token is the manager's `FUNDING_API_TOKEN`: 32 characters or more,
printable ASCII with no space, since it travels in a header.

### The client of the manager's funding API

`src/domain/funding/ManagerFundingClient.ts` calls the manager's funding API
(`packages/contracts/src/funding.ts`), typed and parsed by the contract:
`inventory()`, `account(address)`, `relay(transfer)` and `status(requestId)`,
which the funding service uses, and `stampOperation(operation)` and
`stampOperationStatus(requestId)`, for the top-ups and dilutions of the nodes'
batches.

- Every request carries `Authorization: Bearer <MANAGER_FUNDING_TOKEN>`, to the
  manager's address alone: the client holds the address to the rule above as
  well, and follows no redirect. It logs nothing, and no error carries the
  token.
- Each call has a deadline, 10 seconds by default, which covers the answer
  read whole, and reads at most 2 MiB of it. A stamp operation has a deadline
  of its own, 200 seconds by default (`MANAGER_FUNDING_STAMP_TIMEOUT_MS`): the
  manager answers it once the node has, and a node answers a top-up once its
  approval and its top-up are mined, a dilution once it is mined. The manager
  gives a node 180 seconds for such a call. A stamp operation's status read
  keeps the 10 seconds.
- Every answer is parsed by the contract's schema, so a field the contract
  does not name is dropped, and an answer that does not parse is an error,
  never a crash. A relay sends the contract's fields of the transfer and
  nothing else, and a stamp operation the contract's fields of its kind: an
  amount per chunk for a top-up, a new depth for a dilution.
- Every failure is a `ManagerFundingError` with a `code` and a `status`. When
  the manager refused, the code is the contract's (`funding_off`,
  `unauthorized`, `unknown_node`, `bad_transaction`, `chain_unreachable`,
  `conflict`, `unknown_request`, `stamp_refused`, `node_unreachable`), with
  the status it answered and its sentence. Otherwise it is `unreachable` or
  `timeout`, with no status,
  `not_json`, or `bad_answer`: JSON that is not the route's answer, an error
  without one of the contract's codes, an answer over the limit, or a
  redirect. After a relay, `unreachable` and `timeout` leave it unknown whether
  the manager took the transfer; relayed again under the same request id, it
  answers its state, and the manager never sends it twice. A status read that
  answers `unknown_request` (404) says the manager journalled no transfer under
  the id: the relay never reached it, so relaying again under the same request
  id is safe, while `unknown_node` refuses the node. A stamp operation's status
  read answers `unknown_request` in the same way, when the manager journalled
  no stamp operation under the id.

### Funding transfers

The funding service reads the nodes, the wallet's balances, nonce and fees and
every transfer's state from the manager through the client above, and signs
with the brand wallet. `src/index.ts` builds it with the wallet it started and
with the client, or with none while `MANAGER_FUNDING_URL` is unset.
`src/domain/funding/FundingService.ts` is the service, and
`src/api/routes/funding.ts` its routes, behind the session; the writes are
behind the same-site check as well. The answers are the types of
`web2-admin-common`'s `funding.ts`.

| Method | Path                                 | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/funding`                       | `FundingView`: `configured` (false while the manager funding settings are unset, and then the manager is not asked), the brand wallet's address and balances or null while there is none, `chainId` 100, every stage's nodes and the catalogue node, each with `pin` and `pinnedAddress` (below) and the `batch` the manager uses for its uploads as the manager read it (null for a gateway, a node with no batch, and from a manager that reads none; every reading of it null, with `readError`, when the node could not be read about it), `postage`, what postage costs now as the manager read it from a node (the price per chunk per block in PLUR, the block time and the contract's floor in blocks, or null when no node answered), `observedAt`, and `openBulkId`, the latest send that still has an item holding up a new one (`queued`, `submitted`, or `unknown` within the manager's 30 minutes), or null, so the page resumes it after a reload or in another tab. It first refreshes the latest sends with an item still asked about, three at most ([Settling](#settling)). When the manager cannot be read, `managerError` says why in a sentence of the admin's own, never the manager's address or token, and the balances, the nodes, `postage` and `observedAt` are empty |
| POST   | `/api/funding/pins`                  | `{ password, nodeIds }` in: pins the address each node answers now, read from the manager's inventory, and answers `{ pinned }`. A node the inventory does not hold is `409 funding_refused`, `problem: "node"`; a node whose address could not be read is `400 validation_error` with the sentence, since there is no address to pin. Either way nothing is pinned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| POST   | `/api/funding/transfers`             | `{ password, items: [{ nodeId, kind, amount }] }` in, `202` with `{ bulkId, items }` out: each item's `requestId`, `nodeId`, `kind`, `amount`, `state`, `txHash`, `blockNumber` (null until it is mined), `error`, and the flags `settled` (it no longer holds up a new send) and `watched` (it is still asked about) ([Settling](#settling)). The refusals below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| GET    | `/api/funding/transfers?bulkId=<id>` | `{ items }` of that send, as above, each refreshed from the manager first ([Settling](#settling)). `400` without a UUID, `404 bulk_not_found` for a send the admin never journalled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

A node's `pin` is `pinned` when its pin is the address it answers now, `new`
when it has none, and `changed` when it answers another. A node whose wallet
could not be read keeps the state its pin gives it, `pinned` or `new`, never
`changed`, and its `readError` says why; it takes no send until it is read.

Both writes ask for the operator's password again, checked exactly as a
password change checks the current one (`AuthService.confirmPassword`), behind
the same limiter and on the same count: `401 invalid_credentials` when it is
wrong, `429 too_many_attempts` with `Retry-After` and `retryAfterSeconds` once
locked out. A guess spent on a send is a guess less for the password change.

A send's body is checked first, `400 validation_error`: at least one item and
at most 200, a node id as the contract takes it, `kind` `xdai` or `xbzz`, and
an amount that is a string of base units (wei, PLUR) above 0 and at most
2^256 - 1. Then it is refused, in this order, nothing signed:

1. a wrong password: `401` or `429`, as above;
2. a node named twice for one kind: `400 validation_error` with the sentence;
3. funding not set up (no manager settings or no brand wallet), or a manager
   on another chain than Gnosis Chain: `409 funding_refused`, `problem`
   `not_set_up` or `chain`;
4. a node not in the manager's inventory, never pinned, answering another
   address than its pin, or whose address could not be read, so it cannot be
   checked against the pin: `409 funding_refused`, `problem: "node"`, with the
   sentence;
5. an item of an earlier send still `queued` or `submitted`, or `unknown`
   within the manager's 30 minutes, after that send was refreshed
   ([Settling](#settling)), or another send being signed at that moment:
   `409 { "error": "conflict" }`;
6. a fee or gas limit over the admin's own ceilings: `409 funding_refused`,
   `problem: "fee"`, with the sentence (below);
7. a wallet that cannot pay for it: the account is read once from the manager,
   and the xDAI sent plus, for every item, its gas limit (`gasNative` for xDAI,
   `gasBzzTransfer` for xBZZ) at `maxFeePerGasWei` must fit the xDAI balance,
   and the xBZZ sent the xBZZ balance. Otherwise `409 funding_refused`,
   `problem: "insufficient_funds"`, with a sentence naming each shortfall in
   xDAI and xBZZ. 409 rather than 422: the balance is a state that changes, as
   the admin's other refusals of a state are 409.

**The admin's ceilings.** The manager suggests the fees and the gas limits,
and holds a transfer to three times its own suggestion, which guards it
against a hostile admin. Only the admin's own ceilings guard the brand wallet
against a hostile or broken manager, so nothing is signed over them
(`FundingService.ts`, `checkCeilings`):

| Ceiling                     | Constant                       | Value                    |
| --------------------------- | ------------------------------ | ------------------------ |
| fee cap, `maxFeePerGas`     | `FUNDING_MAX_FEE_PER_GAS_WEI`  | at most 100 gwei         |
| tip, `maxPriorityFeePerGas` |                                | at most the fee cap      |
| gas of an xDAI transfer     | `FUNDING_GAS_NATIVE`           | exactly 21000            |
| gas of an xBZZ transfer     | `FUNDING_MAX_GAS_BZZ_TRANSFER` | from 1 to at most 100000 |

The gas of a kind is held to its ceiling only when the send carries that kind.

A manager that cannot be read for the inventory or the account is
`502 manager_unavailable` with the admin's own sentence.

**One send at a time.** Checks 5 to 7, the signatures and the journal run
under a Postgres advisory lock taken with `pg_try_advisory_lock` on a
connection of its own and released when they are over: a second send at the
same moment, in this process or another, is refused at once with the same
`409 conflict`, and once the first is journalled its items are `queued`, so
check 5 refuses every later one until none holds it up any more. Check 5
first refreshes the latest sends with an open or watched item, three at most,
and the open ones, three at most, then looks: a send whose page was closed
never holds the wallet for good, and an `unknown` item past its 30 minutes is
asked about before a new send may reuse its nonce, since the manager answers it
`submitted` if the chain's pool holds it after all. A client of the API that
never reads the page gets the same check.

**Signed, journalled, then relayed.** The items are signed in turn, chain id
100, with consecutive nonces from the account's pending one and its fees: an
xDAI item is a plain transfer of the amount to the node's pinned wallet with
`gasNative`; an xBZZ item is a call of the BZZ token the inventory names,
`transfer(wallet, amount)` with no value and `gasBzzTransfer`. Every item is
written to `funding_transfers`, `queued`, with its request id, the send's
bulk id, the signed transaction and its hash, before any is relayed. Then they
are relayed in nonce order, and the manager's answer recorded. A relay the
manager refuses for good (`bad_transaction`, `unknown_node`, `conflict`) fails
its item with the manager's sentence, and the items after it are not relayed
and fail as well, since their nonces would wait behind one never used. Any
other failure (the manager or the chain out of reach, the funding API off, the
token refused, an answer that cannot be read) leaves the item and those after
it `queued`, as journalled: the refresh relays them.

#### Settling

`queued` and `submitted` items are open: they hold up a new send, which would
sign over their nonces, whatever their age. So does an `unknown` item for 30
minutes counted from when the manager answered the relay
(`FUNDING_UNKNOWN_SETTLES_AFTER_MS`,
which mirrors the manager's `FUNDING_UNKNOWN_AFTER_MS` in
`apps/infra-manager/manager/src/domain/funding/FundingChainService.ts` and must
stay equal to it). The manager answers `unknown` in two cases: when the answer
of `eth_sendRawTransaction` was lost, and the transaction may well sit in the
chain's pool at its nonce; and when it has no receipt and the chain has not
held the transaction for those 30 minutes. In the first case a send let
through at once would read the next pending nonce, both would be mined, and the
node would be paid twice; so a young `unknown` item counts as open until the
manager finds it (`submitted`, then `confirmed` or `failed`) or the 30 minutes
pass. The manager counts its 30 minutes from its own journal row, written when
the relay reaches it, which may be long after the admin journalled the item
(the manager was out of reach, or never received it and it was relayed again).
So the admin counts from `relayed_at`, which it writes from the service's clock
when it records the manager's first answer for an item: to a relay, whatever
the state, the relay again after `unknown_request` included, or, when the
answer of a relay was lost but the manager journalled it, to the status read
that finds it while the item is still `queued`. Written once the answer is
back, it is at or after the manager's own moment, so the admin's window never
ends before the manager's: the safe side. A `submitted` item that the
manager's 30-minute rule later turns `unknown` was answered more than 30
minutes before, so it settles at once. `relayed_at` is null while an item is
`queued`, and on one failed before the manager ever answered for it; the
service never writes an `unknown` item without it, and `created_at` stands in
only as a backstop for a row written otherwise, so that no item holds a send
for good. Every other item is settled for that gate:

- `confirmed`, and `failed` in a block (the transaction reverted): settled for
  good, never asked about again;
- `failed` with no block: the chain's node refused it when the manager sent it.
  The manager still reads such a transfer for a late receipt and for the
  chain's pool, so it is watched: asked about again, turned `submitted`, open
  again, if the chain holds it, and `confirmed` if the receipt comes. Its
  sentence says the chain's node refused it, that the row will say so if it is
  mined anyway, and to check the node's balance before sending to it again;
- `unknown` for longer than the 30 minutes: the manager has no receipt and the
  chain no longer holds it. It is watched, as a young one is. Letting a new
  send past it is safe: the chain does not hold it, so the next send reuses its
  nonce, and at most one of the two can ever be mined;
- `failed` by the admin or the manager before the chain saw it (a refusal at
  the relay, or never sent after one before it failed): settled for good.

`blockNumber` tells the page a failure in a block (final) from one with no
block (watched). Only open and watched items are written to: a late receipt
moves a watched item, and nothing moves one settled for good. The journal's
`watched` column says which items are watched. The check of an item that holds
up a send asks for `state IN ('queued', 'submitted') OR (state = 'unknown' AND
COALESCE(relayed_at, created_at) >= <now - 30 minutes>)`. A partial index cannot hold that cutoff,
since its predicate cannot call `now()`, so migration 016's
`funding_transfers_unsettled_idx` covers every `queued`, `submitted` and
`unknown` row by `COALESCE(relayed_at, created_at)`: the check's predicate
implies the index's, and the rows of those states are few, one open send and
its watched items.

Each item the API answers carries two flags, worked out in one place
(`toFundingTransferItem`) from its state, block, `watched` column and the age
of its relay's answer:

| State                                        | `settled` | `watched` |
| -------------------------------------------- | --------- | --------- |
| `queued`, `submitted`                        | false     | false     |
| `unknown`, relay answered at most 30 min ago | false     | true      |
| `unknown`, older                             | true      | true      |
| `failed` with no block, refused at the relay | true      | true      |
| `confirmed`, `failed` in a block             | true      | false     |
| `failed` before the chain saw it             | true      | false     |

`settled` false holds up a new send; `watched` true says the item is still
asked about and may still change. The page frees Send once every item is
settled, and reads a send on while any item is not settled or is watched.

**The refresh** reads, in nonce order, where each open or watched item of a
send stands on the manager, and records it. An open item the manager never
received (`unknown_request`) is relayed again: the journalled bytes, byte for
byte, under the same request id, never signed again; unless an item before it
failed or was lost, and then it fails as never sent. A watched item is only
read, never relayed again, and a failed one is never sent again: the operator
sends anew. The refresh stops at the first item the manager cannot answer for
and leaves it, and those after it, as they are. It runs:

- for `GET /api/funding/transfers?bulkId=`, on that send;
- for `GET /api/funding`, on the latest sends with an open or watched item (a
  young `unknown` one is both),
  three at most (`FUNDING_REFRESH_LIMIT`); an older watched item is refreshed
  when its send is read by its id;
- for every send, before check 5: on the latest sends with an open or watched
  item, three at most, and on the open sends, three at most.

Overlapping refreshes of one send in the process share one run (a map of the
refresh running per bulk id), so two polls at once relay nothing twice and
write no audit row twice. A `funding.transfer.confirmed` or `.failed` row is
written once, when the item first comes to that state.

The signed transaction is kept for that relay alone: no route answers it, and
nothing logs or audits it.

| Table               | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `funding_transfers` | migration 016: one row per item of a send, by `request_id`, with `bulk_id`, the node's id and label, the address, kind, amount, nonce, the signed transaction, its hash, `state`, `error`, `block_number`, `watched` (only an `unknown` item, or a `failed` one with no block), `relayed_at` (when the manager's answer to its last relay came back, by the service's clock), the operator's id and name, and when. One item of each kind per node and one per nonce in a send |
| `funding_node_pins` | migration 017: one row per pinned node, its address in lower case, when and by whom                                                                                                                                                                                                                                                                                                                                                                                            |

Without `MANAGER_FUNDING_URL` and `MANAGER_FUNDING_TOKEN` the page answers
`configured: false`, and without `BRAND_WALLET_SECRET` it shows no wallet;
either way every send is refused as not set up, and a pin needs the manager.

## Migrations

`src/migrations/NNN_name.sql`, applied in order inside a transaction at every
boot and recorded in `_migrations` (`src/domain/Database.ts`) by file name
alone, so a database that already applied a file never runs it again. Add a
file for a change, and never change an applied one's SQL; a corrected comment
is harmless. `001_init.sql` carries the rationale for each table in its
header. `pnpm build` copies the directory into `dist`. `007_audit_log.sql` is
the audit log below, and `008_streams_user_id_set_null.sql` stops removing a
user from deleting the streams they drafted. The latest seven are
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
and `015_brand_wallet.sql`, the single-row `brand_wallet`: the wallet's address
and its key, encrypted ([The brand wallet](#the-brand-wallet)).

`016_funding_transfers.sql` is the journal of the sends from the brand wallet,
`funding_transfers`, and `017_funding_node_pins.sql` the node wallets an
operator confirmed, `funding_node_pins` ([Funding transfers](#funding-transfers)).

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
| `actor_kind`                    | `operator` (a signed-in user), `uploader` (the uploader's internal routes), `manager` (the manager's stage routes, since migration 009) or `system` (the boot repair, the CLI, a funding refresh)                                                                                                                                              |
| `actor_user_id`, `actor_name`   | the operator's id and username at the time; the id goes null if the user is removed, the name stays. For `system`, `actor_name` is the reason (`boot`, `cli`, `funding`); for the uploader and the manager it is null                                                                                                                          |
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
entry lists, null unless it is `vod`. A rendition report's row has
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

The Funding page's actions ([Funding transfers](#funding-transfers)):
`funding.pin` (one row per pin request, `details.pins` with each node's id,
label, the address pinned and the one it replaced), `funding.transfer.request`
(one row per send, with its `bulkId`, the wallet it is sent from and each
item's request id, node, label, kind, amount, address, nonce and hash),
`funding.transfer.sent` (an item the manager took), `funding.transfer.confirmed`
and `funding.transfer.failed`, each with the item's send, request id, node,
label, kind, amount, address, nonce, hash, state, error and block. The operator
is the actor of a pin, a request, and of whatever their send's relays learned;
`system` with the reason `funding` is the actor of what a refresh learned. No
row carries the password, a signed transaction or a key.

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
