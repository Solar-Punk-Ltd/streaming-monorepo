# Integration tests

End-to-end tests against a **live** stack. The API suites drive the running
backend over HTTP — the same requests the console makes, nothing imported from
`src`; the two others exercise `BeeFeedGateway` and `StreamRepository`
directly, because a Bee node and Postgres are exactly what a fake cannot
stand in for.

## Prerequisites

```bash
# from web2-admin/backend/
cp .env.sample .env        # FEED_GATEWAY=fake, set FEED_PRIVATE_KEY and INGEST_HOST
pnpm database:start        # Postgres on 127.0.0.1:5433
pnpm dev                   # API on :9877
```

Never point this suite at an instance running `FEED_GATEWAY=bee` against a real
Bee node and a real catalogue: it publishes, reports state and unpublishes. If
one is already running on :9877, start a second instance on a port of its own —
`WEB2_ADMIN_PORT=9879 FEED_GATEWAY=fake pnpm dev`, its own `DATABASE_URL` if
the admin password of the first is not the seed one — and run with
`WEB2_ADMIN_URL=http://localhost:9879`.

`FEED_GATEWAY=fake` matters: the publish steps expect feed writes to succeed
without a Bee node or a usable postage batch.

## Run

```bash
pnpm test:integration
```

| Env | Default | |
| --- | --- | --- |
| `WEB2_ADMIN_URL` | `http://localhost:9877` | API under test |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / `admin1234` | the login to use |
| `DATABASE_URL` | `postgres://web2admin:web2admin@127.0.0.1:5433/web2admin` | database for the repository suite |
| `BEE_URL` + `POSTAGE_BATCH_ID` | unset | when both are set, the bee-js suite runs too |
| `INTERNAL_API_TOKEN` | `web2-admin-integration-internal-token-000000` | must equal the token the API under test booted with |

## What it covers

| Suite | Asserts |
| --- | --- |
| unauthenticated surface | `/api/health` and `/api/config` need no session; every stream route and `/api/auth/{me,password}` answer `401 unauthenticated`; unknown paths `404` with the path echoed |
| login | wrong password `401 invalid_credentials`, malformed body `400`, success sets an httpOnly SameSite=Lax cookie that `/api/auth/me` reads back |
| stream lifecycle | create → list → edit → media type editable as a draft → thumbnail stored and served byte-identical → non-image `415` → publish (entry on the feed, thumbnail uploaded, status `published`) → ingest details and key rotation → delete refused `409 stream_published` → edit keeps it published → media type change refused `409 media_type_locked` → unpublish back to `draft` → delete → `404` |
| logout | clears the cookie and the session |
| internal API authentication | every `/api/internal` route answers `401 unauthenticated` without a bearer token, with a wrong one, and with a valid console session cookie instead |
| internal lookup by ingest stream id | a published stream resolves with its `publishKey`; a draft, the right topic under the wrong app and an unknown topic are all the same `404 stream_not_found`; a malformed topic is `400` |
| internal state reports | a `live` report for a stream that was never published is `409 invalid_state_transition`; a body the contract forbids (`vod` without the numbers, `live` with them, a state this backend owns) is `400`; `live` flips the row and the **catalogue entry** read back out of `feed_writes`; a repeated `live` does not move `liveSince`; delete and unpublish are `409 stream_live` while it is live; the title stays editable and the schedule is `409 stream_locked`; a manual republish keeps it live; `vod` puts `index` and `duration` on the entry; `live` afterwards is refused; unpublishing the recording clears everything the uploader reported |
| feed reconcile | not covered here. `POST /api/feed/reconcile` needs a catalogue that disagrees with the database, which only a stale feed read produces; the diff itself is unit-tested against `FakeFeedGateway`. Calling it by hand against a `fake` instance is safe and answers `FeedReconcileResult` |
| resetOrphanedPublishing | the boot repair of rows left claimed by a process that died mid-publish, against real SQL: a first-time publish goes back to `draft`, an interrupted *re*publish back to `published` (so DELETE cannot orphan its feed entry), and a second boot has nothing to repair |
| BeeFeedGateway | the real bee-js calls: an unwritten feed reads as "no index", a payload round trips, the head advances, a thumbnail downloads byte-identical. **Skipped** unless `BEE_URL` and `POSTAGE_BATCH_ID` are set; it signs a fresh random key and topic every run, so it can never touch the catalog this backend publishes |

## Notes

- Publish and unpublish now take the list and the next index from
  `feed_writes`, not from the gateway, so the index a publish reports continues
  the database's sequence rather than restarting at 0 after the backend is
  restarted. Nothing in the suite asserts an absolute index, and the in-memory
  gateway adopts whatever index it is handed for a feed it has not written.
- The internal API suite reads the catalogue entry back from `feed_writes`
  rather than from the API: that a row says `live` is not the same claim as
  that the entry a viewer reads says it, and only the second one matters.
- Everything created is removed in `after`, including after a failed test; no
  other row is touched (the repository suite creates its own user and deletes
  it, streams cascading). The suite does not change the admin password.
- The stream lifecycle is one ordered scenario sharing a stream, so a failure
  early in it will cascade — read the first failure, not the last.
