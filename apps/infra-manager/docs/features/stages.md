# Stages: the manager pushes each stage's record into the web2 admin

A stage is a deployment that runs a stream uploader, of kind `abr-uploader` or
`streamer`, with the node pool behind it. The web2 admin serves every stage of
the brand, and learns each one from the manager: for every such deployment the
manager builds a **stage record** and pushes it into the admin its web2 admin
link names. The admin never calls the manager. The design, and the phases it is
built in, is `docs/architecture/stages.md` at the repository root; the record's
shape is `stageRecordSchema` in `packages/contracts/src/stage.ts`.

Status, 2026-09-28. Built on `stages/p3-manager-pushes-stages`, branched from
`feat/stages` at `90def834`, phase 3 of the brief, and on
`stages/p5-uploader-tokens`, phase 5, which gives every uploader linked to the
manager's admin a token of its own. Not deployed. A deployment created before
phase 5 still presents the link's own token, reported as `shared`, until it is
rotated, and every stage still signs with the brand's key until phase 6.

## What is pushed

One record per stage, checked against `stageRecordSchema` before it leaves:

| Field                               | Where the manager reads it                                                                                                                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stageId`                           | the deployment's `instance_id`, so a removed and recreated name is another stage                                                                                                                                                                                   |
| `managerId`                         | the manager's own id, generated once by migration 045 and read at boot                                                                                                                                                                                             |
| `name`, `kind`, `status`            | the deployment's row                                                                                                                                                                                                                                               |
| `engine`, `stackVersion`            | the deployment's components, `ome` when it runs OvenMediaEngine and `srs` otherwise, and its version's name                                                                                                                                                        |
| `observedAt`                        | the moment the manager read the deployment's row, before the slower readings of nodes and the uploader                                                                                                                                                             |
| `ingest.host`                       | the deployment's public ingest address, below                                                                                                                                                                                                                      |
| `ingest.srtPort`, `ingest.rtmpPort` | `SRS_SRT_PORT` and `SRS_RTMP_PORT` of the environment the next deploy gives, which is the version's port table shifted by the slot; an OME stage takes `OME_SRT_PORT`                                                                                              |
| `ingest.rtmpPublic`                 | whether the port policy in `common/src/portPolicy.js` opens `SRS_RTMP_PORT`. It opens no RTMP band, so this is false, and no deployment setting says otherwise                                                                                                     |
| `ingest.srtPassphrase`              | `SRT_PASSPHRASE` of that environment: the deployment's own passphrase, else the version's host-wide one, else null                                                                                                                                                 |
| `owner`                             | `addressOfStreamKey` of the `STREAM_KEY` the next deploy gives the uploader. The key goes nowhere                                                                                                                                                                  |
| `rungs[]`                           | a pool's rungs from its `BEE_PUBLISHERS`, lowest first, each read on the deployment of this manager whose `stamp_id` is that rung's batch: its stamp health and its chequebook. A stage with a node of its own has one rung, `source`, read there. No node address |
| `uploader`                          | `UploaderHealthService`'s reading, its state and reasons alone, or null when it could not be read                                                                                                                                                                  |
| `readiness`                         | the console's own readiness, below                                                                                                                                                                                                                                 |
| `adminToken`                        | the sha256 of the deployment's effective `ADMIN_API_TOKEN`, `shared` when it equals the link's stored token and `own` otherwise, or null when the uploader is given none. A token the manager generated for the deployment is `own`, below                         |

A chequebook's `availableBzz` is its available PLUR written exactly in BZZ
with `plurToBzzExact`. A rung whose node this manager does not run, a pool
under another manager, has no reading, and a node that did not answer reads
`unknown`.

No signing key, wallet key, RPC endpoint, token or node address has a field on
the record, and `test/unit/stageRecordBuilder.test.ts` checks that none of
them reaches the JSON that is sent.

### The uploader's token

Since phase 5 a deploy gives an uploader linked to the manager's admin a token
of its own, generated the first time, kept with the deployment's generated
secrets and never replaced (`manager/src/domain/adminLink/ownAdminToken.ts`;
[web2-admin-link.md](web2-admin-link.md) has the rule). The admin knows it by
the sha256 on the record alone, which is why the push before the uploader
starts matters: that push is the one that registers a new token. Until a push
carrying it has been stored, the admin refuses the token, and the
deployment's Test connection answers `token-not-registered` rather than
`token-refused`.

**Rotate the uploader's admin token**, on the stage card, takes the token out.
The next push carries no token, so the admin stops taking the old one; the
next deploy generates a new one and its pre-start push registers it. A
deployment still on the link's token, `shared`, moves to one of its own this
way. The link's token keeps being the registrar token these pushes present.

### Readiness

`common/src/readiness.ts` holds the readiness composition the console shows on
every row and page, moved out of the console on 2026-09-28 with its checklist,
so the manager works it out the same way. The record carries its verdict in the
admin's four words, and the problem of every step that is not ok as a reason,
in the list's order, so the first reason is the console's own label:

| Console tone | Record    | Steps that come to it                                                  |
| ------------ | --------- | ---------------------------------------------------------------------- |
| `ok`         | `ready`   | every step is ok                                                       |
| `warn`       | `warning` | a batch that ends soon, an uploader waiting for its node               |
| `err`        | `blocked` | a full or expired batch, an empty chequebook, an uploader that refuses |
| `gray`       | `blocked` | a step that is off: a stopped deployment, a batch still to buy         |
| `info`       | `unknown` | a step under way or a reading not in yet: a deploy, a batch settling   |

For a stage with its own node the verdict reads that node's batch and
chequebook. For a pool, as on the console, it reads the pool string and the
uploader, and each rung's own readings are on `rungs[]`.

### The public ingest address

The address encoders dial, which the admin's OBS panel shows. The address the
manager's ssh dials can be a private one, so it is a setting of the deployment,
`profiles.ingest_host`, migration 046. Without one it is the host the manager
resolved for the deployment, `network_host`, or `PUBLIC_HOST` for one on the
manager's own host (`resolvedIngestHost` in `common/src/ingestHost.ts`). It is
held to the record's own rule, a host name, an IPv4 address or a bracketed IPv6
one with no scheme, port or path, and never one that reaches the dialling host
alone: `localhost`, `127.0.0.0/8`, `0.0.0.0`, `[::1]` (`isLoopbackIngestHost`).
It is saved on its own, from the stage card on the deployment page or
`PATCH /profiles/:name/ingest-host`, and deploys nothing, since no container
reads it.

A stage whose address comes to a loopback one or to none, a deployment on the
manager's host with no address of its own while `PUBLIC_HOST` is unset, is not
pushed: its outcome is `skipped-no-record`, and the log and `GET /stages` say
"set the deployment's public ingest address or PUBLIC_HOST". The `localhost`
fallback the console's component links use never reaches a record.

## When

`manager/src/domain/stages/StagePublisher.ts` pushes a stage's record:

- **when the deployment changes**, on its `profile.changed` event, gathered
  per deployment for one second from the first event;
- **every 30 seconds while it runs**, for each stage whose status is `RUNNING`;
- **before a deploy starts its uploader**, once the deployment's env file is
  written, so the uploader's first call finds its token known. The deploy waits
  for it at most ten seconds, and a push that fails there is a warning in the
  log: the deploy goes on.

A push already in flight is never doubled. A change or the pre-start push
waits for it and then pushes once more with what changed since; the 30-second
pass leaves it to answer. A removed deployment, on its `profile.deleted` event,
is retired with `DELETE`, carrying `{ observedAt }`, the moment the manager saw
it gone (`stageRetireRequestSchema`), so a record read before the removal and
arriving after it cannot bring the stage back. A push in flight is waited for
first, since it may be the stage's first.

Every moment the admin orders by is the manager's own: a record's `observedAt`
is taken as its deployment's row is read, before the node and uploader
readings, and a retirement's as the removal is seen, so a 30-second pass that
starts before a removal and ends after it still carries the earlier moment.

## To whom

To the manager's web2 admin link, `PUT <link>/api/internal/stages/<stageId>`
with the link's stored token as the bearer, the admin's `INTERNAL_API_TOKEN`,
which registers stages. `<link>` is the address the link stores, as Test
connection asks it. Only a deployment whose effective `ADMIN_API_URL` is on the
link's origin is pushed (`sameAdminOrigin`); a path may differ. A deployment
linked to another admin, one not linked at all, or any while the link stores no
token, is skipped with an outcome saying which.

A retirement goes to the link its records went to, and only while the link is
still on that origin. A deployment removed before its first push, one whose
change event the manager saw and whose push it had not made yet, is retired at
the link as well, which the admin keeps as a tombstone of a stage it never
stored.

## Outcomes

Every push comes to one code, `STAGE_PUSH_OUTCOMES` in
`common/src/stagePush.ts`. The code is what the log and the deployment page
say, never what the admin answered, its address or a token.

| Outcome                | What it means                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `stored`               | the admin stored the record                                                                                |
| `older-ignored`        | the admin holds a record read later than this one and kept it                                              |
| `retired`              | the admin retired the stage                                                                                |
| `not-retired`          | the admin had no such stage to retire                                                                      |
| `refused-token`        | 401 with the admin's `unauthenticated` code: the link's token is not the admin's                           |
| `refused-record`       | 400 or 422: the admin refused the record, as one of another contract version would                         |
| `unreachable`          | nothing answered within five seconds, or the answer stopped arriving                                       |
| `redirected`           | a redirect, which is not followed                                                                          |
| `not-admin`            | any other answer, or one that is not the admin's JSON                                                      |
| `skipped-no-link`      | the manager's link has no address or no token                                                              |
| `skipped-not-linked`   | the deployment's next deploy gives its uploader no `ADMIN_API_URL`                                         |
| `skipped-other-origin` | its `ADMIN_API_URL` is on another origin than the link's                                                   |
| `skipped-no-record`    | the record could not be put together: no stream key, no port, no environment yet, no public ingest address |

The client is bounded like Test connection: http and https alone, no redirect
followed, five seconds a call, at most 64 KiB of an answer read. The last
outcome of each deployment and its time are kept in memory; the log says a
deployment's outcome when it changes, and why its record could not be put
together once.

## Where it is seen

- **The stage card** on a stage's deployment page: the public ingest address
  and where it comes from, edited in place with the sentence "The address
  encoders dial. The address ssh uses can be a private one.", and the line
  "Web2 admin registration: <outcome> <N> s ago", read every ten seconds from
  `GET /stages/:name/registration`, and Rotate the uploader's admin token,
  `POST /profiles/:name/admin-token/rotate`, asked for first.
- **`GET /stages`**, behind the session: every record the manager would push
  now, built afresh, each with its last push and without the SRT passphrase,
  which is answered only as `hasSrtPassphrase`.

`pnpm -C frontend dev:mock` shows the card, and
`frontend/test/stage-card-browser.test.mjs` drives it in Chrome.

## Limits

- One admin link per manager: a stage on another admin's origin is not pushed.
- When the manager shuts down the publisher stops first: no push starts after
  that, not a change, the cadence, a follow-up or the pre-start push. A
  deployment that is gone and was never pushed or seen is dropped from memory.
- The outcomes are in memory. A restarted manager says "not pushed yet" until
  its first push, and it retires only a deployment it has seen since it started.
  A running stage is pushed within 30 seconds of the start.
- A deployment whose `ADMIN_API_URL` moves to another origin is no longer
  pushed, and the stage it was stays at the admin it left until that admin
  retires it.
- A rung under another manager has no reading, and a pool's verdict does not
  read its rungs.
- The console's card estimates the ingest address from the page's own host
  for a deployment on the manager's host. The record uses `PUBLIC_HOST`.
- Between a rotation and the redeploy, the running uploader's own token is
  refused once the next push lands, so it cannot report until it is redeployed.
  The card says so before it asks.
