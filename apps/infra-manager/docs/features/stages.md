# Stages: the manager pushes each stage's record into the web2 admin

A stage is a deployment that runs a stream uploader, of kind `abr-uploader` or
`streamer`, with the node pool behind it. The web2 admin serves every stage of
the brand, and learns each one from the manager: for every such deployment the
manager builds a **stage record** and pushes it into the admin its web2 admin
link names. The admin never calls the manager. The design is `docs/architecture/stages.md`
at the repository root; the record's shape is `stageRecordSchema` in
`packages/contracts/src/stage.ts`.

Status, 2026-09-29. Phase 3 of the brief, phase 5, which gives every
uploader linked to the manager's admin a token of its own, phase 6, where every
stage signs with a key of its own, phases 7 and 8, the catalogue node and its
move, and phase 9, where the admin stops taking any other token from an
uploader. Not deployed. A deployment created before phase 5 still presents the
link's own token, reported as `shared`, which the admin refuses since phase 9:
its token has to be rotated.

**A key per stage.** Every stage's `STREAM_KEY` is its own, generated in the
new-deployment wizard, and nothing asks for the admin's brand key: the admin
signs the catalogue with it alone. The record's `owner` is how the admin learns
the stage's address, and it writes that owner into every catalogue entry of the
stage's streams. A key rotated in the manager is pushed as a new `owner`: a
draft that holds no recording takes it when it is published, and a recording
made under the old key keeps it, so the admin refuses to publish that recording
on the stage again. Test connection on the deployment's card compares the
stream key's address with the owner the admin knows for the stage, see
`web2-admin-link.md`.

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
| `adminToken`                        | the sha256 of the deployment's effective `ADMIN_API_TOKEN`, and where it came from: `own` for the token the manager generated for the deployment, below, `shared` for any other (copied, typed, or the version's), or null when the uploader is given none         |

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
deployment on any token the manager did not generate, `shared`, which the admin
refuses since phase 9, gets one of its own this way and no other: its Test
connection answers `token-not-own` until it has. The link's token is the
registrar token these pushes present, and no uploader is given it.

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
arriving after it cannot bring the stage back. The event carries that moment,
taken as the deployment's row is deleted, with the deployment's `instance_id`
and kind. A push in flight is waited for first, since it may be the stage's
first.

A retirement is kept until the admin answers it. The removal writes it into the
manager's database in the transaction that deletes the deployment's row
(`pending_stage_retirements`, migration 049), and the publisher sends it, then
sends it again every 30 seconds and when the manager starts, until the admin
answers `retired` or `not-retired`. Then the row is deleted. A retirement that
keeps failing is logged once, with its outcome, and again only when the outcome
changes. One the manager stopped before sending, between the deletion and the
event, is sent when it starts again, as of that moment.

Every moment the admin orders by is the manager's own: a record's `observedAt`
is taken as its deployment's row is read, before the node and uploader
readings, and a retirement's as the row is deleted, so a 30-second pass that
starts before a removal and ends after it still carries the earlier moment. A
retirement sent again carries the same moment. One found at start with no
moment takes the moment it is found, which is later than every record of the
stage, since none is read once the row is gone.

## To whom

To the manager's web2 admin link, `PUT <link>/api/internal/stages/<stageId>`
with the link's stored token as the bearer, the admin's `INTERNAL_API_TOKEN`,
which registers stages. `<link>` is the address the link stores, as Test
connection asks it. Only a deployment whose effective `ADMIN_API_URL` is on the
link's origin is pushed (`sameAdminOrigin`); a path may differ. A deployment
linked to another admin, one not linked at all, or any while the link stores no
token, is skipped with an outcome saying which.

A retirement goes to the link its records went to, and only while the link is
still on that origin: one whose link has moved to another origin since is
dropped, and the log says so. While the link stores no address or no token, a
retirement waits for one. A deployment removed before its first push since the
manager started is retired at the current link as well, by the `instance_id`
the removal event carries, and with the link's token: one whose push was not
made yet, and one this manager pushed before a restart and not since. The admin
retires the stage it holds, or keeps a tombstone of one it never stored, so a
retirement it did not need changes nothing there. A deployment the manager
skipped since it started, linked to another admin or to none, is not retired,
and its row is deleted. A deployment whose pushes stopped at the manager's own
link is retired all the same, since the admin may hold its stage from before: a
link in plain http to another host (`refused-plain-http`), or one with no token,
as while a token is cleared to rotate it (`skipped-no-link`). Its retirement
waits until the link takes it.

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
- **The Stages page**, `#/stages`, in the navigation under Deployments. Built
  2026-10-01, not deployed. One row per stage, by name, from `GET /stages`,
  read when the page opens and every 30 seconds after, the cadence a running
  stage is pushed on, and again on Refresh. Each row shows:
  - the stage's name, which opens its deployment page, with its kind, its
    engine and its stack version;
  - the deployment's status, in the words and tone of every other row;
  - the record's readiness: its verdict in the web2 admin's four words, Ready,
    Warning, Blocked or Unknown, on the console's green, amber, red and blue,
    with every reason beneath it in the manager's order, so the first is the
    console's own label;
  - the owner, shortened, with a copy button for the whole address;
  - the public ingest host, with the SRT port and whether a passphrase goes
    with it, and the RTMP port and whether it is public;
  - the uploader's token: Own, None, or Shared, which is red and says to rotate
    the uploader's admin token on the deployment page and redeploy, since the
    admin refuses it;
  - the last push, in the stage card's words, with how long ago it ended:
    seconds for the first minute, then minutes, hours and days.

  A stage whose record could not be put together shows the manager's reason in
  place of the record's columns, and its last push. A manager that runs no
  stage says so and offers New stream. A read that fails keeps the last answer
  on screen, says how old it is, and offers Try again. The page changes
  nothing: the ingest address and the token are changed on the deployment
  page. What each row says is `frontend/src/stages/stagesView.ts`, with its
  unit test beside it.

- **`GET /stages`**, behind the session: every record the manager would push
  now, built afresh, each with its last push and without the SRT passphrase,
  which is answered only as `hasSrtPassphrase`, or the admin token's sha256,
  which is answered only by its `kind`. The Stages page reads it.

`pnpm -C frontend dev:mock` shows the card and the Stages page. The mock's
records carry the readiness the manager works out from the deployment alone,
and its own token, but for a stage whose name carries `legacy`, a shared one,
or `standalone`, none. `frontend/test/stage-card-browser.test.mjs` drives the
card in Chrome; no browser suite drives the Stages page yet.

## The catalogue node

Built on `stages/p7-catalogue-node`, phase 7 of the brief, 2026-09-28, and
moving the catalogue to another batch on `stages/p8-catalogue-move`, phase 8,
2026-09-28. Neither is deployed.

The web2 admin writes the brand's catalogue through one Bee node and one batch
of their own, so that no stage's segments fill the batch the catalogue's slots
live in (`docs/architecture/stages.md`, "Why these"). The operator designates
them on the **Manager settings** page, in the **Catalogue node** card beside the
admin link, and the manager pushes the **catalogue stamp record** to the admin
its link names.

### The designation

One row, `catalogue_designation`, migration 047: the deployment's name, the
pinned batch id (64 hex digits, lower case, no `0x`), the depth the node
reported at designation, when and by whom it was designated, when it was last
cleared, and a revision. The deployment and the batch stay recorded after a
clear, which only sets `cleared_at`; a designation is in force while
`cleared_at` is NULL. A save and a clear name the revision the page
read, so two operators cannot overwrite each other unseen, as the admin link's
save does. `CatalogueDesignationService` refuses, with one sentence each
(`common/src/catalogueNode.ts`):

| Refused                                                                | Why                                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| a deployment that runs more than a Bee node (`isBeeNodeOnly` is false) | the catalogue node shares its node with no stage                                           |
| a rung of an ABR node pool                                             | a rung's batches pay for a stream's segments                                               |
| a batch the node does not hold, or a node that does not answer         | the kind of the batch cannot be checked                                                    |
| a mutable batch                                                        | once a bucket fills it overwrites its oldest chunks, which are the catalogue's first slots |
| a batch whose kind the node does not report                            | the kind that fails is the one it might be                                                 |
| an expired batch                                                       | nothing written with it stays                                                              |
| a new batch shallower than `MIN_CATALOGUE_DEPTH`, 18                   | its buckets fill soon, and the first slot refused freezes the catalogue                    |
| a batch an ABR uploader of this manager names in its `BEE_PUBLISHERS`  | segments would fill it                                                                     |
| another batch than the pinned one, without `move: true`                | the catalogue's slots are stamped by the pinned batch, and moving them is its own action   |
| a third batch while a move is pending, `move: true` or not             | the batch moved from still holds the history until the admin reports the move done         |

The node is asked about the batch fresh, `GET /stamps/{id}` on its own Bee API,
when the designation is saved.

The minimum depth holds a new batch alone, `catalogueShallowBatchRefusal`: the
pinned batch designated again after a clear, and a move back to the batch moved
from, are taken at the depth they have, so a designation made before the
minimum keeps working. The card does not mark a shallow batch in its list; the
save says why it is refused.

Once a batch has been designated, the catalogue stays on it. The same batch can
be designated again after a clear, which puts it in force once more. Another
batch is a move, through a clear as well, and is refused without `move: true`
with `catalogueMoveRefusal`: "Batch … would move the catalogue off batch …,
whose slots the web2 admin then stamps again under the new batch, so it is
saved only when confirmed as a move." `move: true` for the pinned batch itself,
or before any designation, changes nothing.

### Moving the catalogue

A move is a designation of another batch with `move: true`, on the same
Bee-only deployment or another one, and it passes every check above. Migration
048 adds the batch moved from to the row. The move pins the new batch, puts the
designation in force (a cleared one included), and records the batch pinned
before, its node and its depth as `moving_from_*`, with `move_started_at` and
`move_started_by`, in one statement at the revision the page read. The record
the manager pushes is the new batch's (the contract does not change), so the
web2 admin sees another batch designated and stamps every slot of the catalogue
again under it before it writes with it. That is started in the admin, and it
says there when it is done.

While the move is pending:

- the batch moved to can be designated again after a clear, and a clear keeps
  the move as it is;
- a move back to the batch moved from, `move: true` again, swaps the two, so
  whichever still holds history is the one recorded as moved from;
- any third batch is refused with `catalogueReleaseFirstRefusal`, "The
  catalogue is still moving off batch …, so release the previous batch first,
  once the web2 admin reports the move done, before moving it to another."

`POST /manager-settings/catalogue-node/release`, with `{ expectedRevision }`,
ends the move: it takes the `moving_from_*` and `move_started_*` columns out,
records `released_at` and `released_by`, which stay until the next release, and
tells the publisher. It is refused with "No move of the catalogue is pending, so
there is no previous batch to release." when none is. The operator presses it
once the admin reports the move done; the manager cannot tell that itself.

There is no audit table. A designation, a move, a move back, a clear and a
release are each logged with the user, the batches shortened, as in
`[Catalogue] operator released batch abababab…ababab on catalogue-node after
the move to cdcdcdcd…cdcdcd`, and the row records who made the last of each and
when.

### What the manager keeps

The deployment the catalogue is pinned to is not removed, designated or
cleared since, and while a move is pending neither is the deployment of the
batch moved from. Their removal, from the page or the Clean action, answers
409 `catalogue_node_designated`, asked before the deployment is claimed and
once more before the clean script runs, so a designation saved in between is
caught. The one moved from says to release the previous batch first; after the
release it can be removed, and its batch may lapse.

A pool string may not name the catalogue either. A create or an update of a
deployment whose `BEE_PUBLISHERS` has an entry with the pinned batch, or at the
catalogue node's Bee API (the address the control host dials, or the one a
container here does), is refused with the same sentence a designation of a
segment batch is, `CATALOGUE_SEGMENT_BATCH_REFUSAL`, cleared or not. While a
move is pending the batch moved from and its node's Bee API are refused the
same way.

### The record

`CataloguePublisher` (`manager/src/domain/stages/CataloguePublisher.ts`)
builds it, and `catalogueRequest.ts` checks it against
`catalogueStampRecordSchema` before it leaves:

| Field                                           | Where the manager reads it                                                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `managerId`                                     | the manager's own id, migration 045                                                                                                        |
| `nodeName`                                      | the designated deployment's name                                                                                                           |
| `beeApiUrl`                                     | the node's Bee API as the control host reaches it, `beeApiUrlFor`, the address the Storage card reads, not a container's pool URL          |
| `batchId`, `designatedAt`                       | the designation row                                                                                                                        |
| `state`, `ttlSeconds`, `fillRatio`, `immutable` | `StampService.batchReadingFor`, the node's `GET /stamps/{id}` read as `stampHealthFrom` reads it; a node that does not answer is `unknown` |
| `depth`                                         | the same reading, or the last one the node gave, or the depth at designation while the node does not answer                                |
| `observedAt`                                    | the moment the designation row was read, before the node is asked                                                                          |
| `previous`                                      | while a move is pending, the batch moved from: its node's name and Bee API, and the same readings of it; null otherwise                    |

`previous` is there because the admin keeps writing with the batch moved from
until its own move runs, and would otherwise hold readings of it that only age,
so a top-up of it would not reach the admin and a time to live that ran out on
paper would refuse its writes. It is null when no move is pending, and also when
the node of the batch moved from did not answer, reported no depth or has a
loopback Bee API: the admin then keeps the last reading it had.

A node whose Bee API reaches the dialling host alone (`localhost`,
`127.0.0.0/8`, `0.0.0.0`, `[::1]`) is no address for the admin: the record is
not sent, the outcome is `skipped-no-record`, and the log says why once.

`immutable` is what the node says, and `true` while it says nothing, since the
designation refused a batch whose kind was not reported and a batch's kind never
changes.

### When and to whom

To the manager's web2 admin link, `PUT <link>/api/internal/catalogue-stamp`,
with the link's stored token, the registrar's, on the stage client's bounds:
http and https alone, no redirect followed, five seconds, 64 KiB of an answer
read. It is pushed:

- **when the designation changes**, at once after the save;
- **when the designated deployment changes**, on its `profile.changed` event;
- **when the pinned batch's readings change**: the batch is read every ten
  seconds, and a record goes when its state, depth, fill or kind moved, or its
  life moved more than five minutes off the clock, as a top-up or a dilution
  moves it. The same holds for the batch moved from, while a move is pending;
- **every 30 seconds** otherwise, and at start.

While a designation is in force its batch is read and pushed; once cleared it
is read no more. While a move is pending, the batch moved from is read on its
node on the same ten-second round, cleared or not, for the card and for the
record's `previous`. Both nodes are read at once, so the push waits for the
slower of the two, whose read is bounded. A clear goes to the same link as `DELETE` with `{ observedAt }`, the moment the
designation was taken out, stored as `cleared_at`, so a retry and a restarted
manager resend the same moment. It is sent until the admin answers it, and not
after. One call is in flight at a time: a trigger that comes during one makes
one more after it, so a clear never overtakes the push before it.

Each call comes to one of `CATALOGUE_PUSH_OUTCOMES`: `stored`, `older-ignored`,
`cleared`, `not-cleared`, `refused-token`, `refused-record`, `unreachable`,
`redirected`, `not-admin`, `skipped-no-link`, `skipped-no-node` (the designated
deployment is gone) and `skipped-no-record` (a record the contract refuses, no
depth known, or a loopback Bee API address). The card shows the last one, "Web2 admin: stored 12 s ago",
and the log says it when it changes.

### The card and the node's page

The card lists the deployments that are nothing but a Bee node, then the
batches the chosen one holds, each with its depth, life, fill and kind, and
refuses before any save, with the manager's own sentence, what the manager
would refuse. Designated, it shows the node, the batch, its last reading and
the last push, with Move to another batch and Clear the designation. Cleared,
it says which batch and node the catalogue stays pinned to, and offers
Designate again for that batch.

The card warns when Docker publishes the pinned node's Bee API on every address
of its host, since that API asks for no password and the catalogue's batch is
behind it. `GET /manager-settings/catalogue-node` answers it as
`apiOnEveryAddress`, read from Docker's own record of the node's container on
the daemon it runs on, local or over ssh (`stages/beeApiExposure.ts`), at most
once a minute: true when a binding of the API port is `0.0.0.0` or `::`, or,
under host networking, when the node's `--api-addr` names no address; false
when it is bound to one; null when nothing is pinned or Docker could not be
read. It is not a probe of the host's public address, which hairpin NAT answers
from inside and a provider firewall hides. A node on this host is bound to the
Docker bridge at its next deploy where the manager confirmed the bridge, and
otherwise takes `BEE_UPLOADER_API_BIND`, or `BEE_UPLOADER_API_LISTEN` under host
networking (`deploy/README.md`, step 2 of opening the manager); a node on another host has to answer the control host, so there the
warning means its firewall must admit the control host alone.

Once a batch is pinned, choosing another one on a Bee-only node turns the
button into **Move the catalogue to batch …**, which asks first: the web2 admin
stamps every slot of the catalogue again under the new batch, then switches to
it, and until its console says the move is done the previous batch has to stay
alive. While the move is pending the card shows "Moving from batch … on …" with
that batch's last reading and who started the move, the steps (in the web2
admin, on the Stages page, start "Move the catalogue to batch …", which needs
`CATALOGUE_MOVE_ENABLED` on that installation; wait until it says the move is
done; press Release the previous batch here), and **Release the previous
batch**, which asks first as well: the node moved from can then be removed and
its batch may lapse, so it is pressed only once the admin reports the move
done. A third batch is refused on the card with the manager's sentence while
the move is pending. After a release the card says when and by whom the last
one was made.

On the node's own page the pinned batch carries a **catalogue** chip, and the
Storage and funding card says that Buy and Use leave the catalogue on the
pinned batch, and that moving it is its own action. Top up stays offered on it
(`postage-stamps.md`).

`pnpm -C frontend dev:mock` seeds a `catalogue-node` deployment with two
immutable batches and a mutable one, so a designation, a move and a release can
be tried, and `frontend/test/catalogue-node-browser.test.mjs` drives the card
in Chrome through all three.

## Limits

- One admin link per manager: a stage on another admin's origin is not pushed.
- A deployment whose record could not be put together since the manager
  started (`skipped-no-record`) is not retired when it is removed, so a stage
  the admin stored from a push before a restart stays active there.
- The catalogue stamp record goes to the link as it is now. A link moved to
  another admin leaves the old one holding the last record it was sent.
- The last catalogue reading and push are in memory, and a restarted manager
  says "not sent yet" until its first push, which it makes at start.
- When the manager shuts down the publisher stops first: no push starts after
  that, not a change, the cadence, a follow-up or the pre-start push. A
  deployment that is gone and was never pushed or seen is dropped from memory.
- The outcomes are in memory. A restarted manager says "not pushed yet" until
  its first push. A running stage is pushed within 30 seconds of the start, and
  one removed before that is retired at the current link by its id. A
  retirement is not in memory: it is kept in the database until the admin
  answers it, and a restarted manager sends it at start.
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
