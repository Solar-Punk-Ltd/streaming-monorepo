# SRS reconnect and continuation verification

Status: active. The admin source checkpoint described here is
`c2419e4f6ff15bfa10e135a3649d4a9780f662b6`, tested on 2026-09-21. Final
whole-repository verification of this exact checkpoint is still pending on the
verification box.

## What this repository now does

Managed streams have versioned runs with an assigned uploader, immutable claim
identity, ordered state reports, immutable completed recordings, and a closed
permission boundary. An uploader can reconcile an accepted report by its
canonical SHA-256 digest after losing the HTTP response. All claim, report,
rendition, preparation, and managed-run reads are bound to the assigned uploader
and claim where a claim exists.

The owner can continue a completed managed recording. Preparation runs through
authenticated uploader polling, retains the previous replay, and allocates run
numbers monotonically across failures and cancellations. The console restores
the current operation after reload, keeps one request ID across a lost response,
polls pending work, reports conflicts and failures in plain language, and allows
cancellation only before claim.

An existing legacy VOD first receives a one-time recording check. The uploader
must prove that every frozen topic is readable, that its durable journals have
no pending writes, and that its canonical MPEG-TS format fingerprint matches.
The final database transaction compares the unchanged legacy recording and the
current supported uploader profile before enrolling it. The old replay metadata
remains exact. A successful check then exposes the normal Continue control.

Enrollment remains disabled unless all of these facts are current and valid:

- the configured managed lifecycle version is 1
- a fresh matching uploader capability receipt exists
- the uploader advertises exactly one compatible profile per media type
- external release-guard receipts exist for manager, admin, viewer, and the
  configured uploader
- the running admin artifact exactly matches the immutable admin guard receipt

The release-only admin coordinator builds immutable API and web images, preserves
the installed Postgres volume, stops the old API before migration, mounts the
active artifact descriptor read-only, waits for database-backed health, and
publishes only the web service on a required loopback port. The ordinary
development Compose path is unchanged.

Managed catalogue writes use one coherent database snapshot. Run-scoped ABR
reports refuse the legacy rendition route and cannot mutate another run. Hiding
a completed replay preserves its checkpoint and recording rows. If a delayed
unpublish overlaps a transition to an active run, the final database hide is
refused and the newest active catalogue entry is restored at the next feed
index.

## TDD evidence

Every implementation slice began with a focused regression. The most recent
observable red results were:

| Regression | Red result | Green result |
| --- | --- | --- |
| owner preparation panel and reload recovery | 2 new failures with 24 existing passes because `Prepare to continue` and the pending status did not exist | 27 of 27 passed after the owner flow was added |
| retry after failed preparation | failed attempt A at revision 2 remained visible when attempt B returned pending at revision 1 | 29 of 29 passed after revisions were scoped to one operation identity and delayed A responses were fenced |
| active run during delayed unpublish | `Missing expected rejection (StreamLiveError)` after the stale unpublish hid the new Live state | the controlled overlap passed after conditional hide and catalogue repair |
| real Postgres failed-operation reload | the owner stream read returned only pending preparation | 7 of 7 legacy adoption tests passed with latest pending or failed reconciliation and cancelled-attempt hiding |
| TypeScript lint negative control | an unawaited `assert.rejects(...)` was rejected by `no-floating-promises` | ordinary `node:test` registration remained accepted |

The focused commands used during the final local iteration were:

```sh
corepack pnpm@10.29.3 --dir web2-admin/frontend exec vitest run src/test/streamDetails.test.tsx --reporter=dot
```

Result: 29 tests passed in one file.

```sh
corepack pnpm@10.29.3 --dir web2-admin/backend exec tsx --conditions=development --test test/unit/publishService.test.ts
```

Result: 58 tests passed in nine suites.

```sh
DATABASE_URL=<isolated-postgres> corepack pnpm@10.29.3 --dir web2-admin/backend exec tsx --conditions=development --test test/integration/legacyAdoptionDatabase.test.ts
```

Result: 7 tests passed. These cover exact create and acknowledgement retries,
changed-candidate refusal, cancellation versus preparation in both lock orders,
an old legacy write queued behind enrollment, measured legacy bitrate retention,
audio proof policy, and failed-operation reload reconciliation.

```sh
DATABASE_URL=<isolated-postgres> corepack pnpm@10.29.3 --dir web2-admin/backend exec tsx --conditions=development --test test/integration/managedVisibilityDatabase.test.ts
```

Result: 4 tests passed. These cover closed recording hide and restore, refusal to
hide an active run, an actual hide statement blocked behind the stream transition
lock, and coherent stream, run, and rendition projection.

Changed-file ESLint passed after each final source change. Earlier focused checks
also passed 8 common contract tests and 52 backend schema and privacy tests. The
verification box passed the full standard and Postgres jobs at checkpoint
`e8058860d6be3e512bd4cd5cc3b86ffd21b54ea8` in run `35522864856`.

## Remaining verification limits

- No full suite, workspace typecheck, build, Docker test, or browser test was run
  on the laptop. Those jobs belong on the verification box.
- The exact `c2419e4` source checkpoint still needs the full standard and
  PostgreSQL verification-box jobs. The earlier complete green checkpoint does
  not cover the later enrollment, run-scoped rendition, release coordinator,
  legacy recording check, or active-unpublish repair commits.
- Release coordinator tests use a fake Docker executable. No guard was installed,
  no live configuration was created, and no candidate was activated on a host.
- The cross-repository SRS, uploader, manager, viewer, and private media-chain
  test is outside this repository and remains the release integration proof.
- Managed enrollment is disabled by default. Legacy rows keep their prior
  behavior until the negotiated capability and all release-readiness evidence
  are present.
