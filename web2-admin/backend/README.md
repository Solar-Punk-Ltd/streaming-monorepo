# web2-admin backend

The admin API behind the brand console: server-side login, stream drafts in
PostgreSQL, publishing a draft to the stream list feed on Swarm, and the OBS
connection details for a stream. msrs-client did all of this in the browser,
with the Swarm key and the shared server secrets in localStorage and no draft
to recover when a write failed; here a stream is a row first and a feed entry
second.

## Stack

- **Express 5** + ESM + **TypeScript**, conventions shared with
  streaming-infra-manager (`.js` import suffixes, exact-pinned versions)
- **PostgreSQL 16** — users, sessions, stream drafts, feed-write log
- **Yup** — body and params validation at the API edge, limits from
  `@streaming-monorepo/web2-admin-common`
- **@ethersphere/bee-js** — the only Swarm dependency, behind a `FeedGateway`
  interface (`src/domain/FeedGateway.ts`)
- **node:crypto** — scrypt passwords, random session tokens stored as sha256.
  No auth, session or rate-limit dependency

## Quick start

```bash
cp .env.sample .env       # then set FEED_PRIVATE_KEY and INGEST_HOST
pnpm database:start       # postgres:16-alpine on 127.0.0.1:5433
pnpm dev                  # API on :9877
curl localhost:9877/api/health                   # {"status":"ok"}
```

First start creates `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD`
(`admin` / `admin1234`) while the users table is empty, and logs a warning at
every boot until that password is changed in the UI.

## Scripts

| Script | What |
| --- | --- |
| `pnpm dev` | `tsx watch` against `src/index.ts` |
| `pnpm build` | builds common, then `tsc` + copies `src/migrations` into `dist` |
| `pnpm start` | `node dist/index.js` |
| `pnpm test` | unit tests (`test/unit`), no database or network |
| `pnpm test:integration` | drives a **running** API over HTTP — see [test/integration](test/integration/README.md) |
| `pnpm typecheck` | `tsc -p tsconfig.typecheck.json`, which includes `test/` |
| `pnpm database:start` / `database:stop` | the Postgres container |

`docker compose -p web2-admin --profile full up -d --build` runs the API in
Docker too (two-stage `pnpm deploy` image, `Dockerfile`).

## Configuration

Every variable is documented in [.env.sample](.env.sample), which is the
reference; the summary:

| Var | Default | Meaning |
| --- | --- | --- |
| `WEB2_ADMIN_PORT` / `WEB2_ADMIN_HOST` | `9877` / `0.0.0.0` | where to listen (the manager API uses 9876) |
| `DATABASE_URL` | required | `postgres://web2admin:web2admin@127.0.0.1:5433/web2admin` |
| `SESSION_TTL_HOURS` / `COOKIE_SECURE` | `24` / `false` | session lifetime; set `COOKIE_SECURE=true` behind TLS |
| `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` | `admin` / `admin1234` | the first-start user |
| `FEED_GATEWAY` | `bee` | `fake` swaps in an in-memory gateway (see below) |
| `BEE_URL` / `POSTAGE_BATCH_ID` | required | node and batch used for feed writes and thumbnails |
| `FEED_PRIVATE_KEY` | required | 0x + 64 hex. Signs the stream list feed; its address is `owner` on every stream |
| `FEED_TOPIC` | `swarm-stream` | raw topic of that feed |
| `VIEWER_BASE_URL` | empty | branded viewer built for this feed, for "open player catalogue" links |
| `INTERNAL_API_TOKEN` | required | 32+ chars. Bearer token for `/api/internal`, the routes the uploader calls |
| `INGEST_HOST` | required | host the encoder connects to |
| `INGEST_SRT_PORT` / `INGEST_RTMP_PORT` | `10061` / `10062` | SRS ports (`10001`/`10002` + slot×10; the test host is slot 6) |
| `INGEST_SRT_PASSPHRASE` | empty | the server-wide SRT passphrase, shown to the operator |
| `INGEST_KEY_VERIFIED` | `false` | `true` once the deployed uploader verifies `key=` |

Startup logs the resolved configuration with the feed key, the batch id, the
SRT passphrase and the internal API token redacted.

### FEED_GATEWAY=fake

`fake` keeps feed writes and thumbnail uploads in memory: nothing reaches
Swarm, no Bee node or usable postage batch is needed, and references look like
references. It is how to work on the console, and what
`pnpm test:integration` expects. Startup warns when it is on.

It forgets every write on restart while `feed_writes` — which decides the next
index — does not, so the first write after a restart continues from whatever
the database says and the in-memory feed adopts that index. The boot check then
reports a network head of `none` behind a recorded one, which under `fake` is
normal and not a divergence.

## Publishing

One writer, one feed, payload is the whole JSON array rewritten each time
(`src/domain/PublishService.ts`). A publish claims the row into `publishing`,
uploads the thumbnail if it has no reference yet, takes the current list and
index from `feed_writes`, replaces or appends this stream's entry by
`(owner, topic)` — entries written by anyone else are kept verbatim — writes at
the next index, logs it in `feed_writes`, and only then marks the row
`published`. Any failure puts the previous status back with `publish_error` set
and answers `502 publish_failed`. Publish and unpublish are serialised through
one in-process mutex.

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
came with a stale *payload*, which made it worse: a publish rebuilt the list
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
  the next write goes *after* what is out there rather than over it. Bee being
  unreachable here is a warning, not a failed boot.

Boot also dry-runs the reconcile diff and WARNs with the topics of any
catalogue entry that has no stream row behind it.

### POST /api/feed/reconcile

The repair path for exactly that: an entry no request can name, because
`unpublish` needs a row and topics are server-minted. Session auth, no body.
Under the publish mutex it takes the authoritative base and rewrites the list
from the database — drops entries of ours whose topic has no row in
`published`/`live`/`vod`, rebuilds entries that no longer match their row,
appends published rows that are missing, and copies everything written by
anyone else through untouched. It writes only if something changed, so running
it on a clean catalogue costs no index and no stamp. The answer is
`FeedReconcileResult`: the index written (or `null`), and the topics
`removed` / `added` / `updated`.

A stored `thumbnail_ref` is verified before it is reused: the gateway is asked
whether it still holds that reference, and only then is it carried onto the
feed. A reference the gateway does not have is re-uploaded and the new one
persisted, with a warning naming the stream and the stale reference. This is
what makes the `fake`/`bee` switch safe — `fake` mints references that exist
nowhere, and without the check a stream published under `fake` would keep
advertising one after the switch, giving every viewer a 404. The same applies
when `BEE_URL` is repointed at a node that never saw the chunks. A gateway that
cannot answer (node unreachable, timeout, an unexpected status) fails the
publish with `502 publish_failed` instead of re-uploading: "unreachable" is not
"missing", and guessing would spend a stamp on every hiccup. A check that times out (30 s; a missing reference makes Bee try the network first, 5-10 s on the test node) is treated as missing and the image is re-uploaded, which is content-addressed and so costs no new chunks; a node that cannot be reached at all fails the publish with `publish_failed`.

A restart that interrupts a publish leaves the row claimed; boot repairs it
(`resetOrphanedPublishing`), sending a first-time publish back to `draft` and
an interrupted republish back to `published`, since that one's entry is still
on the feed and only an unpublish may remove it. Publishing also refuses with
`409 feed_owner_mismatch` when a stream was created under a different feed key
than the one now configured — its entry would advertise an owner the feed is
not published under. Unpublishing such a stream is still allowed, by the owner
stored on the row.

**Do not give `FEED_PRIVATE_KEY` to a running swarm-hls-stream uploader.** It
caches the feed's next index; two writers at one index fork the feed.
Checkpoint 3 turns this around and has the uploader report into this API.

## The internal API

`/api/internal` is what the swarm-hls-stream uploader calls, and nothing else.
It is authenticated by `Authorization: Bearer <INTERNAL_API_TOKEN>` — never by
a session cookie — and it is mounted before the console's routes on a path of
its own, so the two authentications cover disjoint surfaces. A wrong or missing
token is `401 unauthenticated`, the same answer the console's routes give.

| Method | Path | Answer |
| --- | --- | --- |
| GET | `/streams/by-ingest/:app/:stream` | `IngestLookupResponse` — id, topic, owner, mediaType, title, status and the `publishKey` the encoder must present |
| POST | `/streams/:id/state` | `StreamStateReport` in, `PublishResult` out (200) |
| POST | `/streams/:id/renditions` | `RenditionReport` in, `RenditionReportResponse` out (200) — one rung of an ABR ladder |

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
`live → vod`, `vod → vod`, and `published → vod` for a broadcast that ended
before its `live` report ever got through. Anything else is
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
and in admin mode the master's topic *is* the stream's declared topic — so the
ladder's merge state, which swarm-hls-stream keeps inside the catalogue feed it
writes for itself, has to live here instead. Each rung POSTs its own
`Rendition` (`name`, `width`, `height`, `topic`, `bandwidth`, `avgBandwidth`,
plus `index` and `duration` — both or neither — once it finalizes) and gets
back the merged ladder, ascending by height, with `ladder { finished,
flippedToFinished, duration }`.

The merge keeps one record per `(stream, name)`. The incoming report replaces
the stored one, except that a rung which already reported an `index` keeps its
`index` and `duration` when the incoming report has none **and arrives on the
same `topic`**, taking only geometry and bandwidths from it: a rung recovered
from a crash resumes writing the feed it was already writing and announces
itself before it finalizes again, so a wholesale replace would flip a finished
ladder back to unfinished. The rule is `StreamCatalog.keepingWhatFinished` from
the uploader, where it was learned.

The topic is what separates that recovery from a new session of the same rung.
A rung that starts again — the encoder reconnected after the ladder finished,
or one transcode restarted while its siblings kept going — mints a fresh random
topic, so an indexless report on a *different* topic is a rung that is live
again and replaces the finished record. Without the test, a reconnect after a
finished broadcast would leave the master advertising the recording's rung
feeds while the feeds now being written went unadvertised.

**A rendition report never moves the status.** It stores the rung and rewrites
the entry, adding `renditions` and `group` (= the stream's topic) whenever the
stream has at least one rung — an entry for a single-rendition stream is
exactly what it was before ABR existed. `live` and `vod` still come from the
state route, and `vod.index` for a ladder is the *master's* feed index, not a
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

Migration 004 adds `stream_renditions`, one row per `(stream_id, name)`, and
`finishUnpublish` deletes a stream's rungs in the same statement that clears
its state columns.

### What that changes for the console

- A stream that is `live` or `vod` is still editable — title, description, tags
  and thumbnail — and `GET /streams/:id/ingest` still answers, so an encoder
  that dropped can reconnect. The media type stays refused with
  `409 media_type_locked`, and the schedule joins it with `409 stream_locked`:
  it is a promise viewers have already read off the entry.
- `POST /streams/:id/publish` on a live or recorded stream republishes it *as
  it is* — the entry keeps its state and its index and duration — rather than
  claiming the row into `publishing` and returning it as `published`, which
  would quietly tell every viewer the broadcast had stopped.
- `POST /streams/:id/unpublish` and `DELETE /streams/:id` on a live stream are
  `409 stream_live` ("Stop the broadcast first."): nothing here can stop the
  encoder that is still pushing to it. On a recording both work as they do on a
  published stream, and the unpublish clears everything the uploader reported,
  because the row is a draft again — the ABR ladder included.

## Migrations

`src/migrations/NNN_name.sql`, applied in order inside a transaction at every
boot and recorded in `_migrations` (`src/domain/Database.ts`). Add a file, never
edit an applied one; `001_init.sql` carries the rationale for each table in its
header. `pnpm build` copies the directory into `dist`.

## Limitations (intentional, checkpoint 3 step 1)

- **Single tenant.** `streams.user_id` exists and every query is scoped by it,
  but nothing creates a second user.
- **Nothing polls.** A state report is the only thing that moves a stream to
  `live` or `vod`; an uploader that dies without reporting leaves the stream
  live on the catalogue until someone republishes or unpublishes it by hand.
- **The ingest does not verify `key=`** until the deployed uploader carries
  publisher auth, which is what `INGEST_KEY_VERIFIED` admits to the UI.
- **Sessions are unbounded per user** and pruned at boot and on login.
