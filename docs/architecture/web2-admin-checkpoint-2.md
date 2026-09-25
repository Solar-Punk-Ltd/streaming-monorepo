# web2-admin, checkpoint 2: first working slice

> This is the design as it was written for checkpoint 2, kept for the reasoning
> behind each decision. It is not a description of the code today: the schema
> has moved on, and authentication was later replaced by the port described in
> [web2-admin-auth.md](web2-admin-auth.md). Read the package READMEs for what
> is actually there.

Goal, in a team member's words: an MSRS-like admin frontend in this repo, working end
to end for four features, improved later. The four features:

1. Authentication. A sample user with a sample password exists after first
   start; the password can be changed in the UI.
2. Stream drafts saved in Postgres. msrs-client wrote straight to Swarm and
   that had caveats (see below); the draft fixes them.
3. Publish a draft to the stream list feed on Swarm.
4. Show the OBS connection details for a stream, protected by a passphrase or
   a stream key.

Research behind every decision here is in [docs/research/](../research/)
(msrs-client, streaming-infra-manager, swarm-hls-stream ingest and feed). The
short version of what they found:

- msrs-client (deprecated) creates a stream by uploading the thumbnail, then
  writing one GSOC chunk carrying an encrypted token; an off-client aggregator
  rewrites the list feed. Private keys and shared server secrets live in the
  browser. Failure loses the stream, success is inferred by polling.
- swarm-hls-stream (the stack the test infra runs) has no draft concept. OBS
  pushes to SRS, the uploader mints a random topic on `on_publish`, and the
  catalog feed entry it writes has only a date for a title. Its `main` is
  hundreds of commits behind the branches that add a per-stream publish key.
- streaming-infra-manager models deployments, not streams, has no auth, and
  computes the SRT ingest URL in its frontend from `port_slot` arithmetic.

## Packages

| Package | Name | Role |
|---|---|---|
| `web2-admin/common` | `@streaming-monorepo/web2-admin-common` | The API contract: types and the ingest URL builders. Written by the orchestrator; agents extend it only when the contract changes and say so. |
| `web2-admin/backend` | `@streaming-monorepo/web2-admin-backend` | Express 5 + pg API. |
| `web2-admin/frontend` | `@streaming-monorepo/web2-admin-frontend` | React 18 + MUI + Vite console. |

Conventions are streaming-infra-manager's, listed in the manager research
report: ESM with `.js` import suffixes, exact-pinned versions (typescript
5.6.3, tsx 4.19.2, express 5.2.1, pg 8.13.1, yup 1.7.0, dotenv 16.4.7, react
18.3.1, @mui/material 6.1.10, vite 5.4.11), `node:test` through tsx, one error
class per file, yup schemas with `validateBody`/`validateParams`, hand-rolled
Logger singleton, `Database.migrate()` running `NNN_name.sql` files in a
transaction, repositories with a shared column list and `RETURNING`, routers
as `createXRouter(deps)` factories, manual constructor injection in
`index.ts`, `notFound` then `errorHandler` last.

## Backend

### Configuration (`src/utils/config.ts`, `required`/`optional` helpers, `.env.sample` documented)

| Var | Default | Meaning |
|---|---|---|
| `WEB2_ADMIN_PORT` | `9877` | listen port (manager uses 9876) |
| `WEB2_ADMIN_HOST` | `0.0.0.0` | bind address |
| `DATABASE_URL` | required | e.g. `postgres://web2admin:web2admin@127.0.0.1:5433/web2admin` |
| `SESSION_TTL_HOURS` | `24` | session lifetime |
| `COOKIE_SECURE` | `false` | set true behind TLS |
| `SEED_ADMIN_USERNAME` | `admin` | created at first start if the users table is empty |
| `SEED_ADMIN_PASSWORD` | `admin1234` | same; logged as a warning at startup while it is unchanged |
| `BEE_URL` | required | Bee API used for feed writes and thumbnail uploads |
| `POSTAGE_BATCH_ID` | required | batch for feed writes and thumbnails |
| `FEED_PRIVATE_KEY` | required | 0x + 64 hex. Signs the stream list feed. Its address is `owner` on every stream |
| `FEED_TOPIC` | `swarm-stream` | raw topic of the stream list feed |
| `VIEWER_BASE_URL` | empty | e.g. `https://player.example.com`, the brand's player built for this backend's feed owner and topic, for "open player catalogue" links |
| `INGEST_HOST` | required | host the encoder connects to |
| `INGEST_SRT_PORT` | `10061` | SRS SRT port (10001 + slot*10; slot 6 on the test host) |
| `INGEST_RTMP_PORT` | `10062` | SRS RTMP port |
| `INGEST_SRT_PASSPHRASE` | empty | the server-wide SRT passphrase, shown to the operator |
| `INGEST_KEY_VERIFIED` | `false` | true once the deployed uploader verifies `key=` |

Startup: `import 'dotenv/config'`, log config with the private key, batch id
and passphrase redacted, migrate, seed the admin user, listen. SIGTERM and
SIGINT close the server and the pool.

### Data model (`src/migrations/001_init.sql`)

```
users            id UUID PK DEFAULT gen_random_uuid(), username TEXT UNIQUE NOT NULL,
                 password_hash TEXT NOT NULL (scrypt, "scrypt$N$r$p$saltb64$hashb64"),
                 password_changed_at TIMESTAMPTZ, created_at, updated_at
sessions         id UUID PK, user_id UUID FK users ON DELETE CASCADE, token_hash TEXT UNIQUE NOT NULL
                 (sha256 of the cookie value), created_at, expires_at TIMESTAMPTZ NOT NULL, index on expires_at
streams          id UUID PK, user_id UUID FK users, topic UUID UNIQUE NOT NULL, owner TEXT NOT NULL,
                 title TEXT NOT NULL CHECK (length <= 100), description TEXT NOT NULL CHECK (length <= 500),
                 tags TEXT[] NOT NULL DEFAULT '{}', media_type TEXT NOT NULL CHECK IN ('video','audio'),
                 scheduled_start_time TIMESTAMPTZ, thumbnail BYTEA, thumbnail_mime TEXT, thumbnail_ref TEXT,
                 status TEXT NOT NULL DEFAULT 'draft' CHECK IN ('draft','publishing','published','live','vod'),
                 published_at TIMESTAMPTZ, published_feed_index BIGINT, publish_error TEXT,
                 publish_key TEXT NOT NULL (32 hex), publish_key_rotated_at TIMESTAMPTZ,
                 created_at, updated_at; indexes on status and user_id
feed_writes      id BIGSERIAL PK, feed_index BIGINT NOT NULL, entry_count INT NOT NULL,
                 payload JSONB NOT NULL, written_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

`updated_at` is set explicitly in every UPDATE, as the manager does. Passwords
use `node:crypto` scrypt, no dependency. Migration files carry a `--` header
explaining why.

### Routes (all under `/api`; JSON unless stated)

Auth. Session cookie `web2_admin_session`, httpOnly, sameSite lax, `secure`
from config, path `/`. `requireAuth` middleware loads the session, rejects with
`401 {error:'unauthenticated'}`, and puts `req.user` in place. Login is rate
limited in memory to 10 attempts per username per 15 minutes
(`429 {error:'too_many_attempts'}`), no dependency.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/auth/login` | `LoginRequest` | `MeResponse`, sets cookie. `401 {error:'invalid_credentials'}` |
| POST | `/auth/logout` | | 204, deletes session, clears cookie |
| GET | `/auth/me` | | `MeResponse` |
| POST | `/auth/password` | `ChangePasswordRequest` (new ≥ 8 chars) | `MeResponse`; `400 {error:'invalid_password'}` when current is wrong; all other sessions of the user are deleted |

Streams, all behind `requireAuth`. A user sees only their own streams in
checkpoint 2 (single tenant, but the column is there).

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/streams` | | `StreamListResponse` newest first |
| POST | `/streams` | `StreamInput` | 201 `Stream`; mints `topic` (uuid v4), `owner` (from feed key), `publish_key` (16 random bytes hex) |
| GET | `/streams/:id` | | `Stream` |
| PUT | `/streams/:id` | `StreamInput` | `Stream`. Allowed in `draft` and `published`; a published stream keeps status `published` and the response carries no feed write, the operator republishes explicitly. `409 {error:'stream_busy'}` while `publishing` |
| DELETE | `/streams/:id` | | 204. `409 {error:'stream_published'}` if published; unpublish first |
| PUT | `/streams/:id/thumbnail` | raw body, `Content-Type: image/png|jpeg|webp|gif`, `express.raw({type:'image/*', limit:'5mb'})` | `Stream`. `413` over the limit, `415 {error:'unsupported_media_type'}` otherwise |
| GET | `/streams/:id/thumbnail` | | the image bytes with its mime, 404 when none |
| DELETE | `/streams/:id/thumbnail` | | `Stream` |
| POST | `/streams/:id/publish` | | `PublishResult`. See publish semantics |
| POST | `/streams/:id/unpublish` | | `PublishResult` with the stream back in `draft` |
| GET | `/streams/:id/ingest` | | `IngestDetails` |
| POST | `/streams/:id/ingest/rotate-key` | | `IngestDetails` with a new key |
| GET | `/config` | unauthenticated | `PublicConfig` |
| GET | `/health` | unauthenticated | `{status:'ok'}` after `SELECT 1` |

Validation is yup, `.noUnknown(true)` bodies, `.strict()` params, limits from
`STREAM_LIMITS` in common: title 1..100, description 1..500, tags ≤10 each
1..20 trimmed and deduplicated, `mediaType` in `MEDIA_TYPES`,
`scheduledStartTime` ISO date or null. Ids are UUIDs.

### Publish semantics (`domain/PublishService.ts`)

Publishing is a single writer on one feed the backend owns. Do not share the
feed key with a running swarm-hls-stream uploader; two writers at one index
fork the feed. Checkpoint 3 makes the uploader report state into this API
instead.

1. `UPDATE streams SET status='publishing' WHERE id=$1 AND status IN ('draft','published') RETURNING ...`.
   Null result means busy, `409 {error:'stream_busy'}`.
2. If a thumbnail is stored and `thumbnail_ref` is null or the image changed
   since (compare a sha256 kept in memory of the row, or simply re-upload when
   `thumbnail_ref` is null after any thumbnail PUT clears it): `bee.uploadFile(batch, bytes, name, {contentType})`,
   store the hex reference.
3. Read the current feed: `bee.makeFeedReader(Topic.fromString(FEED_TOPIC), ownerAddress).downloadPayload()`.
   404 means never written, start at index 0 with an empty list. Parse the
   payload as a JSON array of `FeedStreamEntry`; entries that fail to parse are
   kept verbatim so a foreign entry is never dropped.
4. Replace or append this stream's entry by `(owner, topic)`. Entry state is
   `scheduled`, `timestamp` is now in ms, field names as in `FeedStreamEntry`.
5. Write at `latestIndex.next()` (index 0 when the feed was empty):
   `bee.makeFeedWriter(topic, new PrivateKey(FEED_PRIVATE_KEY)).uploadPayload(batch, JSON.stringify(entries), { index })`.
   Serialise publish and unpublish through one in-process async mutex so two
   requests cannot race for the same index.
6. Record `feed_writes`, then `UPDATE streams SET status='published', published_at=NOW(), published_feed_index=$2, publish_error=NULL, thumbnail_ref=$3`.
7. On any failure: `UPDATE ... SET status = previous status, publish_error = message`, and respond `502 {error:'publish_failed', message}`.

Unpublish removes the entry and writes the next index the same way, then sets
`draft`, keeps `thumbnail_ref`.

The Bee client is behind an interface (`FeedGateway`: `readLatest`, `write`,
`uploadThumbnail`) so unit tests use an in-memory fake; the bee-js
implementation is exercised by an integration test that is skipped unless
`BEE_URL` and `POSTAGE_BATCH_ID` are set. Pin `@ethersphere/bee-js` to the
version swarm-hls-stream's `packages/stream-uploader` uses; read it from the
clone at `scratchpad/repos/swarm-hls-stream/packages/stream-uploader/package.json`.

### Ingest details (`domain/IngestService.ts`)

Pure function of the stream row and config, built with the helpers in common:
`streamId = buildIngestStreamId(mediaType, topic)`, SRT URL, RTMP server and
stream key, the server-wide passphrase, `keyVerified` from config. Rotating
the key writes a fresh 16 random bytes hex and `publish_key_rotated_at`.

### Tests

Unit (`test/unit`): password hashing round trip, session token hashing and
expiry, yup schemas accept and reject, `PublishService` against the fake
gateway (append, replace, unpublish, failure restores status and records
error, foreign entries preserved, index progression), ingest URL assembly.
Integration (`test/integration`): drive the running API over HTTP with a
fresh database: login, create, thumbnail, publish (fake gateway selected by
`FEED_GATEWAY=fake` env), unpublish, delete, 401 without cookie. Runnable with
`pnpm database:start` then `pnpm dev`.

### Local dev

`docker-compose.yml` with `postgres:16-alpine`, db `web2admin`, user
`web2admin`, published on `127.0.0.1:5433` so it does not collide with the
manager's 5432, healthcheck, named volume. Scripts `database:start`,
`database:stop`, `dev`, `build`, `start`, `test`, `test:integration`,
`typecheck`. A `Dockerfile` following the manager's two-stage pnpm pattern.

## Frontend

Modelled on the msrs-client screens observed live at example-stream.eth.limo and
on the manager's MUI conventions. Dark MUI theme, `CssBaseline`, `HashRouter`
from react-router-dom (pinned exact, latest 6.x line), fetch wrappers in
`src/http.ts` (`getJson`, `sendJson`, `extractApiError`) with
`credentials: 'same-origin'`, one function per endpoint in `src/api.ts`, types
from common. Vite dev server on `5081`, proxy `/api` to
`http://localhost:9877` (env `VITE_WEB2_ADMIN_URL` override like the
manager's). `nginx.conf` for production mirroring the proxy.

Routes and screens:

| Route | Screen |
|---|---|
| `/login` | Username, password, Log in. Error text from the API. Redirect to `/` when already logged in. |
| `/` | My Streams: cards or a table with thumbnail, title, media type chip, status chip (draft grey, published green, publishing spinner, error red with tooltip), scheduled time, buttons Edit, Details, Delete (confirm dialog), and a Create New Stream button. Empty state text. |
| `/create` and `/edit/:id` | Form with the msrs-client fields and limits: Stream Name with n/100 counter, Description n/500, Tags (add on Enter or button, chips, n/10), Media Type radio Video Stream or Audio Only, Upload Thumbnail (max 5MB, preview, remove), Scheduled Start Time (datetime-local, min now). Preview step is optional; Save creates or updates, thumbnail is PUT separately after save. |
| `/streams/:id` | Details: all metadata, status, publish and unpublish buttons with result feedback (feed index and owner/topic shown, "open player catalogue" link to the viewer's root when the viewer base URL is configured, since the viewer lists the catalogue feed it was built for; the per-stream route `#/watch/<mediatype>/<owner>/<topic>` is shown as copyable text and only plays once the uploader has written a manifest), last publish error, and the OBS panel, which says for SRT and for RTMP separately what goes in OBS's Server box and its Stream Key box: for SRT the URL with `&passphrase=` on the end and an empty Stream Key (a passphrase with characters that line cannot carry goes in OBS's Use authentication Password instead), for RTMP the server and the stream key. Secrets are masked with show/hide, each value has a copy button that copies the real value, Rotate key asks first, and a note shows when `keyVerified` is false: "The ingest does not verify this key yet. Anyone with the SRT passphrase can publish under this name until the uploader is upgraded." Unpublish asks first, and for a recording it says the recording stops being listed and loses its recording details here. An "Edited since it was published" notice shows while the catalogue entry does not carry the latest console edit. |
| `/account` | Change password form. |

App shell: top bar with the app name, username menu (My Streams, Account, Log
out), same as msrs-client's menu. Route guard redirects to `/login` on 401.
Snackbar for errors and success. Component tests with Vitest and Testing
Library for the form validation and the streams list states, exact-pinned.

## Linking the uploader to a draft

Goal: press Start in an encoder and watch the stream that was drafted in the
console play in the viewer.

### Why the pieces cannot simply be pointed at each other

- The uploader mints a random topic when an encoder connects and writes its
  own catalogue entry titled with the date. The draft's topic, title and
  thumbnail never reach the feed.
- The uploader and the admin API would be two writers on one catalogue feed.
  The uploader keeps its own cached feed index and rewrites the whole list
  from it, so entries written by the other side are lost.
- The uploader's publish key is an HMAC of a master secret. The console's key
  is random and stored per stream.

### The split

The admin API is the only writer of the catalogue feed. The uploader is the
only writer of each stream's manifest feed. Both sign with the same key, so
the owner in the catalogue entry matches the owner of the manifest feed the
viewer plays.

#### Admin API, internal routes (`/api/internal`, bearer `INTERNAL_API_TOKEN`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/streams/by-ingest/:app/:stream` | Resolve a draft from the ingest stream id `<mediaType>/<topic>`. Returns `IngestLookupResponse` or 404. Only streams in `published`, `live` or `vod` resolve; a `draft` is not announced and is refused. |
| POST | `/streams/:id/state` | `StreamStateReport`. `live` sets status `live` and `liveSince`, `vod` sets status `vod`, `manifestIndex`, `durationSeconds`, `endedAt`. `vod → live` is allowed: a broadcast may go live again, because its feeds continue, and the `live` clears the finished recording from the row and from every rung. Each report rewrites the catalogue entry with the new state (and `index`, `duration` for vod), through the same single-writer publish path. |

Config: `INTERNAL_API_TOKEN` (required, 32+ chars). Migration 002 adds
`manifest_index BIGINT`, `duration_seconds DOUBLE PRECISION`,
`live_since TIMESTAMPTZ`, `ended_at TIMESTAMPTZ`.

The console's status chips already know `live` and `vod`; the details page
shows the new fields when present. A stream in `live` or `vod` cannot be
edited except title, description, tags and thumbnail, and a republish keeps
its state.

#### Uploader, "admin mode" (`ADMIN_API_URL` + `ADMIN_API_TOKEN` set)

- On `on_publish`, `GET <ADMIN_API_URL>/api/internal/streams/by-ingest/<app>/<stream>`.
  404 or unreachable: refuse the publish, log why. Otherwise the session's
  raw topic is the draft's `topic`, not a random UUID.
- Publish key: the `key=` the encoder presented must equal the draft's
  `publishKey` (constant-time compare). Missing or wrong: refuse. In admin
  mode `PUBLISH_KEY_SECRET` is not consulted.
- No catalogue writes. On the first successful manifest publish, `POST
  .../state {state:'live'}`; on stop, `{state:'vod', index, duration}`. Failed
  reports are retried a few times and logged; they never stop the stream.
- Without `ADMIN_API_URL` everything behaves as on `main-v3` today.
- ABR ladder in admin mode was out of scope for the first step (single
  rendition only); the section below is what lifted that, 2026-09-15.

#### ABR ladder in admin mode

With `ABR_ENABLED=true` the uploader publishes not one manifest feed but five:
a **master playlist** and one **rung feed** per rendition, each under its own
topic and all signed by the same key. Standalone it mints a random group id for
the master and merges the rungs together inside the catalogue feed it writes
itself. In admin mode it writes no catalogue at all, so two things move:

- **The declared topic is the master feed's topic.** The group id *is* the
  stream's `topic`, the one the admin minted and the one every player link
  already points at. Each rung feed's topic is derived from that declared topic
  and the rung name, so it is stable across sessions too. The viewer needs no
  change: it plays a ladder whenever the feed at the topic in the link holds a
  master playlist.
- **The merge state moves into the admin's database.** Each rung reports its
  own record; the admin merges it, stores it, and writes the merged ladder onto
  the catalogue entry.

| Method | Path | Purpose |
|---|---|---|
| POST | `/streams/:id/renditions` | `RenditionReport` (= `Rendition`: `name`, `width`, `height`, `topic`, `bandwidth`, `avgBandwidth`, and `index` + `duration` once the rung finalizes — both or neither). Answers `RenditionReportResponse`: the stream, the merged ladder ascending by height, `ladder { finished, flippedToFinished, duration }`, and the catalogue write it caused. |

The merge, one record per `(stream, name)`: the incoming report replaces the
stored one, **except** that a stored rung which already has an `index` keeps
its `index` and `duration` when the incoming report has none **and arrives on
the same `topic`**, taking only geometry and bandwidths from it. The rule is
copied from `StreamCatalog.keepingWhatFinished` in the uploader, where it was
learned.

A rung's topic is derived from the stream's declared topic and the rung name,
so it does not change between sessions: every report for a rung arrives on the
feed that rung's recordings already sit on, and an indexless one is that rung
delivering again — recovered from a crash, or a **new session** above the
previous head. Either way the recording it finished last stays addressable
until that rung's next final report replaces it, which is what keeps the master
playlist a viewer seeks a recording with on the entry. Un-finishing a ladder is
the `live` state report's job: it clears every rung's `manifest_index` and
`duration_seconds` in the same statement that takes the row out of `vod`.

Semantics worth stating plainly:

- **Status still comes from the state reports.** A rendition report never moves
  a stream to `live` or `vod`; it only rewrites the entry. `live` is sent once
  the first master playlist has been written to the declared topic, and `vod`
  once, by the rung whose report came back `flippedToFinished: true`. That flag
  is judged against the entry the report's own write replaced on the catalogue,
  so overlapping final reports flip exactly one of them, and a report whose
  write failed flips on its retry.
- **`vod.index` for a ladder is the master's feed index**, not a rung's — it is
  what a viewer opens. Each rung carries its own `index` inside `renditions`.
- The entry gains `renditions: Rendition[]` and `group: string` (= the stream's
  `topic`) whenever the stream has at least one rung, and neither otherwise, so
  a single-rendition entry is exactly what it was before.
- Refused: `404 stream_not_found`, `409 invalid_state` for `draft` (nothing
  announced) and `publishing` (a feed write in flight), `400 validation_error`,
  `502 publish_failed` when the row was stored but the catalogue write failed —
  the uploader retries the whole report, and the merge is idempotent.

Migration 004 adds `stream_renditions`, one row per `(stream_id, name)`;
`finishUnpublish` deletes them alongside the state columns it already clears.

## Out of scope for checkpoint 2, tracked in the roadmap

- Deriving the ingest host and ports from a manager profile instead of env.
- Stamps and cheques views, multi-tenant brands, OIDC or wallet login.
