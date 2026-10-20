# Stages

A stage is a deployment that runs a stream uploader, of kind `abr-uploader` or
`streamer`, with the Bee nodes behind it. The admin (`apps/web2-admin`) serves every
stage of a brand, and it learns each one from the manager: for every stage the
manager builds a **stage record** and pushes it into the admin its admin link
names. The manager also pushes one **catalogue stamp record**, which tells the admin
which Bee node and which batch to write the brand's stream list (the catalogue)
with. This is a feature page of the manager, the web console and API in
`apps/infra-manager` that deploys the streaming stack (`apps/hls-stream`) onto
hosts.

The design is `docs/architecture/stages.md` at the repository root. The record
shapes are `stageRecordSchema` and `catalogueStampRecordSchema` in
`packages/contracts/src/stage.ts`. The link itself, and the token each uploader
presents, are on [web2-admin-link.md](web2-admin-link.md). The admin calls the
manager for nothing else than its funding API (the "Funding API" section of
[the API reference](../../manager/README.md)).

## What it does

- **Stage.** A deployment of a stage kind (`STAGE_KINDS` in the contracts
  package). Its id is the deployment's `instance_id`, so a deployment removed and
  created again under the same name is another stage.
- **Stage record.** What the admin knows about a stage: where encoders send its
  streams, which address its feeds are signed as, its batches and chequebooks,
  its uploader's health, its readiness and the hash of its uploader's token.
- **Owner.** The address a stage's feeds are signed as. Every stage has a
  `STREAM_KEY` of its own, generated in the new-deployment wizard, and the record
  carries the address of that key, never the key. The admin writes the owner into
  every catalogue entry of the stage's streams, and signs the catalogue itself
  with the brand key alone.
- **Registrar token.** The token the manager's admin link stores. It is the
  admin's `INTERNAL_API_TOKEN`, and every push presents it. No uploader is given
  it.
- **Catalogue node.** A Bee-only deployment of this manager, with one immutable
  batch of its own pinned by id. The admin writes the catalogue through it, so no
  stage's segments fill the batch the catalogue's slots live in.

A key rotated in the manager reaches the admin as a new `owner` on the next push.
A draft that holds no recording takes the new owner when it is published. A
recording made under the old key keeps the old owner, so the admin refuses to
publish that recording on the stage again. Test connection on the deployment's
card compares the stream key's address with the owner the admin knows for the
stage ([web2-admin-link.md](web2-admin-link.md#test-connection)).

## What is pushed

One record per stage, checked against `stageRecordSchema` before it leaves.
`StageRecordBuilder` (`manager/src/domain/stages/StageRecordBuilder.ts`) builds
it:

| Field                               | Where the manager reads it                                                                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stageId`                           | the deployment's `instance_id`                                                                                                                                                                                                                                |
| `managerId`                         | the manager's own id, the one row of `manager_identity`, read at start                                                                                                                                                                                        |
| `name`, `kind`, `status`            | the deployment's row                                                                                                                                                                                                                                          |
| `engine`, `stackVersion`            | the deployment's components, `ome` when it runs OvenMediaEngine and `srs` otherwise, and its version's name                                                                                                                                                   |
| `observedAt`                        | the moment the manager read the deployment's row, before the slower readings of nodes and the uploader                                                                                                                                                        |
| `ingest.host`                       | the deployment's public ingest address, below                                                                                                                                                                                                                 |
| `ingest.srtPort`, `ingest.rtmpPort` | `SRS_SRT_PORT` and `SRS_RTMP_PORT` of the environment the next deploy gives, which is the version's port table shifted by the slot. An OME stage takes `OME_SRT_PORT`                                                                                         |
| `ingest.rtmpPublic`                 | true where the engine takes RTMP, which SRS does and OvenMediaEngine does not. Which ports are reachable is the operator's firewall, so the port policy does not decide it                                                                                    |
| `ingest.srtPassphrase`              | `SRT_PASSPHRASE` of that environment: the deployment's own passphrase, else the version's host-wide one, else null                                                                                                                                            |
| `owner`                             | `addressOfStreamKey` of the `STREAM_KEY` the next deploy gives the uploader                                                                                                                                                                                   |
| `rungs[]`                           | a pool's rungs from its `BEE_PUBLISHERS`, lowest first, each read on the deployment of this manager whose `stamp_id` is that rung's batch: its batch health and its chequebook. Any other stage has one rung, `source`, read on its own node when it runs one |
| `uploader`                          | `UploaderHealthService`'s reading, its state and reasons alone, or null when it could not be read                                                                                                                                                             |
| `readiness`                         | the console's own readiness, below                                                                                                                                                                                                                            |
| `adminToken`                        | the sha256 of the deployment's effective `ADMIN_API_TOKEN`, and its kind: `own` for the token the manager generated for the deployment, `shared` for any other (typed, copied or set by the version), or null when the uploader is given none                 |

A chequebook's `availableBzz` is its available PLUR written exactly in BZZ with
`plurToBzzExact`. A rung whose node this manager does not run has no reading, and
a node that did not answer reads `unknown`.

No signing key, wallet key, RPC endpoint, token or node address has a field on
the record. The schema drops any field it does not name, and
`manager/test/unit/stageRecordBuilder.test.ts` checks that none of them reaches
the JSON that is sent.

### The uploader's token

A deploy gives an uploader linked to the manager's admin a token of its own,
generated the first time and never replaced
([web2-admin-link.md](web2-admin-link.md#a-token-of-its-own)). The admin knows it
by the sha256 on the record alone. That is why the push before the uploader
starts matters: it registers a new token. Until a push carrying it has been
stored, the admin refuses the token, and the deployment's Test connection
answers `token-not-registered`.

**Rotate the uploader's admin token**, on the stage card, takes the token out.
The next push carries no token, so the admin stops taking the old one. The next
deploy generates a new one, and its push before the uploader starts registers
it. A deployment on a `shared` token, which the admin refuses, gets a token of
its own this way and no other. Its Test connection answers `token-not-own` until
it has.

### Readiness

`common/src/readiness.ts` works out the readiness the console shows on every row,
with its checklist. The record carries the verdict in the admin's four words
(`STAGE_READINESS_OF_TONE`), and the problem of every step that is not ok as a
reason, in the list's order, so the first reason is the console's own label:

| Console tone | Record    | Steps that come to it                                                  |
| ------------ | --------- | ---------------------------------------------------------------------- |
| `ok`         | `ready`   | every step is ok                                                       |
| `warn`       | `warning` | a batch that ends soon, an uploader waiting for its node               |
| `err`        | `blocked` | a full or expired batch, an empty chequebook, an uploader that refuses |
| `gray`       | `blocked` | a step that is off: a stopped deployment, a batch still to buy         |
| `info`       | `unknown` | a step under way or a reading not in yet: a deploy, a batch settling   |

For a stage with its own node the verdict reads that node's batch and
chequebook. For a pool it reads the pool string and the uploader, as the console
does, and each rung's own readings are on `rungs[]`.

### The public ingest address

The address encoders dial, which the admin's OBS panel shows. The address the
manager's ssh dials can be a private one, so the public address is a setting of
the deployment, `profiles.ingest_host`. Without one it is the host the manager
resolved for the deployment, or `PUBLIC_HOST` for a deployment on the manager's
own host (`resolvedIngestHost` in `common/src/ingestHost.ts`).

It is a host name, an IPv4 address or a bracketed IPv6 one, with no scheme, port
or path, at most `INGEST_HOST_MAX` (253) characters. It is never one that reaches
the dialling host alone (`isLoopbackIngestHost`): `localhost` and any
`*.localhost`, `127.0.0.0/8`, `0.0.0.0`, `[::1]`, `[::]` and their IPv4-mapped
forms. It is saved on its own, from the stage card or
`PATCH /profiles/:name/ingest-host`, and deploys nothing, since no container
reads it.

A stage whose address comes to a loopback one or to none is not pushed. That is
a deployment on the manager's host with no address of its own while
`PUBLIC_HOST` is unset. Its outcome is `skipped-no-record`, and the log and
`GET /stages` say "set the deployment's public ingest address or PUBLIC_HOST".

## When

`StagePublisher` (`manager/src/domain/stages/StagePublisher.ts`) pushes a
stage's record:

- **when the deployment changes**, on its `profile.changed` event, gathered per
  deployment for `STAGE_PUSH_DEBOUNCE_MS` (one second) from the first event,
- **every `STAGE_PUSH_INTERVAL_MS` (30 seconds)** for each stage whose status is
  `RUNNING`,
- **before a deploy starts its uploader**, once the deployment's env file is
  written, so the uploader's first call finds its token known. The deploy waits
  for it at most `STAGE_PUSH_BEFORE_START_MS` (ten seconds). A push that fails
  there is a warning in the log, and the deploy goes on.

A push already in flight is never doubled. A change or the push before the
uploader starts waits for it and then pushes once more with what changed since.
The 30-second pass leaves it to answer.

Every moment the admin orders records by is the manager's own. A record's
`observedAt` is taken as its deployment's row is read, before the node and
uploader readings, so the admin keeps the newest reading whichever push arrives
last.

## When a deployment goes

A removed deployment's stage is retired with `DELETE`, carrying
`{ observedAt }`, the moment the manager saw the deployment gone
(`stageRetireRequestSchema`). That moment is taken as the deployment's row is
deleted, so a record read before the removal and arriving after it cannot bring
the stage back. A push in flight is waited for first, since it may be the
stage's first.

A retirement is kept until the admin answers it. The removal writes it into
`pending_stage_retirements` in the transaction that deletes the deployment's
row. The publisher sends it, then sends it again every 30 seconds and when the
manager starts, until the admin answers `retired` or `not-retired`. Then the row
is deleted. A retirement that keeps failing is logged once with its outcome, and
again only when the outcome changes. A retirement sent again carries the same
moment. One the manager wrote and never sent, because it stopped between the
deletion and the event, is sent when it starts again, as of that moment, which is
later than every record of the stage.

Which retirements are sent:

- A deployment whose records went to the link is retired at the link they went
  to, while the link is still on that origin. One whose link has moved to another
  origin since is dropped, and the log says so.
- A deployment never pushed since the manager started is retired at the current
  link as well, by the `instance_id` the removal carries. The admin retires the
  stage it holds, or keeps a tombstone of one it never stored, so a retirement it
  did not need changes nothing there.
- A deployment whose pushes stopped at the manager's own link is retired all the
  same, since the admin may hold its stage from before: a link in plain http to
  another host (`refused-plain-http`), or one with no token
  (`skipped-no-link`). Its retirement waits until the link takes it.
- A deployment the manager skipped since it started, linked to another admin or
  to none, is not retired.

While the link stores no address or no token, a retirement waits for one.

## To whom

To the manager's admin link, `PUT <link>/api/internal/stages/<stageId>`, with
the link's stored token as the bearer. `<link>` is the address the link stores.
Only a deployment whose effective `ADMIN_API_URL` is on the link's origin is
pushed (`sameAdminOrigin`), though a path may differ. A deployment linked to
another admin, one not linked at all, or any while the link stores no token, is
skipped with an outcome saying which.

The client (`manager/src/domain/stages/stageRequest.ts`) takes http and https
alone, plain http only to the manager's own host
([web2-admin-link.md](web2-admin-link.md#plain-http-and-the-managers-own-host)),
follows no redirect, gives up after five seconds a call and reads at most 64 KiB
of an answer.

## Outcomes

Every push comes to one code, `STAGE_PUSH_OUTCOMES` in `common/src/stagePush.ts`.
The code is what the log and the deployment page say, never what the admin
answered, its address or a token.

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
| `refused-plain-http`   | the link is plain http to another host than the manager's own: nothing is sent                             |
| `skipped-not-linked`   | the deployment's next deploy gives its uploader no `ADMIN_API_URL`                                         |
| `skipped-other-origin` | its `ADMIN_API_URL` is on another origin than the link's                                                   |
| `skipped-no-record`    | the record could not be put together: no stream key, no port, no environment yet, no public ingest address |

The last outcome of each deployment and its time are kept in memory. The log
says a deployment's outcome when it changes, and why its record could not be put
together once.

## In the console

- **The Web2 admin stage card** on a stage's deployment page. It shows the public
  ingest address and where it comes from, edited in place with the sentence "The
  address encoders dial. The address ssh uses can be a private one." It shows the
  line "Web2 admin registration: <outcome> <N> s ago", read every ten seconds
  from `GET /stages/:name/registration`. It offers **Rotate the uploader's admin
  token**, which asks first.
- **The Stages page**, `#/stages`, in the navigation under Deployments. One row
  per stage, by name, from `GET /stages`, read when the page opens, every 30
  seconds after (`STAGES_REFRESH_MS`) and on **Refresh**. Each row shows:
  - the stage's name, which opens its deployment page, with its kind, its engine
    and its stack version,
  - the deployment's status, in the words and tone of every other row,
  - the record's readiness: Ready, Warning, Blocked or Unknown, on the console's
    green, amber, red and blue, with every reason beneath it in the manager's
    order,
  - the owner, shortened, with a copy button for the whole address,
  - the public ingest host, with the SRT port and whether a passphrase goes with
    it, and the RTMP port marked unencrypted, or "RTMP not offered" on a stage
    that takes no RTMP,
  - the uploader's token: Own, None, or Shared, which is red and says to rotate
    the uploader's admin token on the deployment page and redeploy,
  - the last push, in the stage card's words, with how long ago it ended: seconds
    for the first minute, then minutes, hours and days.

  A stage whose record could not be put together shows the manager's reason in
  place of the record's columns, and its last push. A manager that runs no stage
  says so and offers **New stream**. A read that fails keeps the last answer on
  screen, says how old it is, and offers **Try again**. The page changes nothing.
  The ingest address and the token are changed on the deployment page.

`pnpm -C frontend dev:mock` shows the card and the Stages page against a mock
manager. A mock stage whose name carries `legacy` has a shared token, and one
whose name carries `standalone` has none.

## Routes

All behind the session. The full reference is
[the API reference](../../manager/README.md).

| Method | Path                                       | Body                                                | Answer                                                                                                                                                                  |
| ------ | ------------------------------------------ | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/stages`                                  |                                                     | every record the manager would push now, built afresh, each with its last push. The SRT passphrase is answered only as `hasSrtPassphrase`, the token only by its `kind` |
| GET    | `/stages/:name/registration`               |                                                     | `{ registration }`, the deployment's last push from memory, or null                                                                                                     |
| PATCH  | `/profiles/:name/ingest-host`              | `{ ingest_host }`                                   | the deployment. Null or empty clears the setting                                                                                                                        |
| POST   | `/profiles/:name/admin-token/rotate`       |                                                     | `{ message }`, the sentence the card shows ([web2-admin-link.md](web2-admin-link.md#rotating-an-uploaders-token))                                                       |
| GET    | `/manager-settings/catalogue-node`         |                                                     | the designation, the pinned batch, a pending move, the last release, the revision, the last reading and the last push                                                   |
| PUT    | `/manager-settings/catalogue-node`         | `{ expectedRevision, profileName, batchId, move? }` | the same answer after the save                                                                                                                                          |
| DELETE | `/manager-settings/catalogue-node`         | `{ expectedRevision }`                              | the same answer after the clear                                                                                                                                         |
| POST   | `/manager-settings/catalogue-node/release` | `{ expectedRevision }`                              | the same answer after the release                                                                                                                                       |

## The catalogue node

The admin writes the brand's catalogue through one Bee node and one batch of
their own, so that no stage's segments fill the batch the catalogue's slots live
in (`docs/architecture/stages.md`, "Why these"). You designate them on the
**Manager settings** page, in the **Catalogue node** card beside the admin link.
The manager then pushes the catalogue stamp record to the admin its link names.

### The designation

One row, `catalogue_designation`, holds the deployment's name, the pinned batch
id (64 hex digits, lower case, no `0x`), the depth the node reported at
designation, when and by whom it was designated, when it was last cleared, and a
revision. A clear only sets `cleared_at`, so the deployment and the batch stay
recorded after it. A designation is in force while `cleared_at` is null. A save,
a clear and a release name the revision the page read, so two operators cannot
overwrite each other unseen.

`CatalogueDesignationService` refuses, with one sentence each
(`common/src/catalogueNode.ts`):

| Refused                                                                | Why                                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| a deployment that runs more than a Bee node (`isBeeNodeOnly` is false) | the catalogue node shares its node with no stage                                           |
| a rung of an ABR node pool                                             | a rung's batches pay for a stream's segments                                               |
| a deployment that is being removed                                     | the node is going away                                                                     |
| a batch the node does not hold, or a node that does not answer         | the kind of the batch cannot be checked                                                    |
| a batch whose kind the node does not report                            | the kind that fails is the one it might be                                                 |
| a mutable batch                                                        | once a bucket fills it overwrites its oldest chunks, which are the catalogue's first slots |
| an expired batch                                                       | nothing written with it stays                                                              |
| a new batch shallower than `MIN_CATALOGUE_DEPTH`, 18                   | its buckets fill soon, and the first slot refused freezes the catalogue for every stage    |
| a batch any deployment of this manager names in its `BEE_PUBLISHERS`   | segments would fill it                                                                     |
| another batch than the pinned one, without `move: true`                | the catalogue's slots are stamped by the pinned batch, and moving them is its own action   |
| a third batch while a move is pending, `move: true` or not             | the batch moved from still holds the history until the admin reports the move done         |

The node is asked about the batch afresh, `GET /stamps/{id}` on its own Bee API,
when the designation is saved.

The minimum depth holds a new batch alone (`catalogueShallowBatchRefusal`). The
pinned batch designated again after a clear, and a move back to the batch moved
from, are taken at the depth they have, since their slots are already stamped.

Once a batch has been designated, the catalogue stays on it. The same batch can
be designated again after a clear, which puts it in force once more. Another
batch is a move, through a clear as well, and is refused without `move: true`
with `catalogueMoveRefusal`. `move: true` for the pinned batch itself, or before
any designation, changes nothing.

### Moving the catalogue

A move is a designation of another batch with `move: true`, on the same Bee-only
deployment or another one, and it passes every check above. The move pins the new
batch, puts the designation in force (a cleared one included), and records the
batch pinned before, its node and its depth as `moving_from_*`, with
`move_started_at` and `move_started_by`, in one statement at the revision the
page read. The record the manager pushes is the new batch's, so the admin sees
another batch designated and stamps every slot of the catalogue again under it
before it writes with it. That runs in the admin, which says there when it is
done.

While the move is pending:

- the batch moved to can be designated again after a clear, and a clear keeps the
  move as it is,
- a move back to the batch moved from, `move: true` again, swaps the two, so
  whichever still holds history is the one recorded as moved from,
- any third batch is refused with `catalogueReleaseFirstRefusal`.

`POST /manager-settings/catalogue-node/release` ends the move. It takes the
`moving_from_*` and `move_started_*` columns out, records `released_at` and
`released_by`, which stay until the next release, and tells the publisher. With
no move pending it is refused with "No move of the catalogue is pending, so there
is no previous batch to release." You press it once the admin reports the move
done. The manager cannot tell that itself.

The manager keeps no audit table. A designation, a move, a move back, a clear and
a release are each logged with the user, and the row records who made the last of
each and when.

### What the manager keeps

The deployment the catalogue is pinned to is not removed, whether designated or
cleared since. While a move is pending, neither is the deployment of the batch
moved from. Their removal, from the page or the Clean action, answers 409
`catalogue_node_designated` with a sentence saying which batch keeps it. The
guard is asked before the deployment is claimed and once more before the clean
script runs, so a designation saved in between is caught. After the release, the
deployment moved from can be removed, and its batch may lapse.

A pool string may not name the catalogue either. A create or an update of a
deployment whose `BEE_PUBLISHERS` has an entry with the pinned batch, or at the
catalogue node's Bee API (the address the control host dials, or the one a
container on this host does), is refused with `CATALOGUE_SEGMENT_BATCH_REFUSAL`,
cleared or not. While a move is pending the batch moved from and its node's Bee
API are refused the same way.

### The catalogue stamp record

`CataloguePublisher` (`manager/src/domain/stages/CataloguePublisher.ts`) builds
it, and `catalogueRequest.ts` checks it against `catalogueStampRecordSchema`
before it leaves:

| Field                                           | Where the manager reads it                                                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `managerId`                                     | the manager's own id                                                                                                                       |
| `nodeName`                                      | the designated deployment's name                                                                                                           |
| `beeApiUrl`                                     | the node's Bee API as the control host reaches it, `beeApiUrlFor`, the address the Storage card reads, not a container's pool URL          |
| `batchId`, `designatedAt`                       | the designation row                                                                                                                        |
| `state`, `ttlSeconds`, `fillRatio`, `immutable` | `StampService.batchReadingFor`, the node's `GET /stamps/{id}` read as `stampHealthFrom` reads it. A node that does not answer is `unknown` |
| `depth`                                         | the same reading, or the last one the node gave, or the depth at designation while the node does not answer                                |
| `observedAt`                                    | the moment the designation row was read, before the node is asked                                                                          |
| `previous`                                      | while a move is pending, the batch moved from: its node's name and Bee API, and the same readings of it. Null otherwise                    |

`previous` is there because the admin keeps writing with the batch moved from
until its own move runs. Without it the admin would hold readings of that batch
that only age, so a top-up of it would not reach the admin and a time to live
that ran out on paper would refuse its writes. It is null when no move is
pending, and also when the node of the batch moved from did not answer, reported
no depth or has a loopback Bee API. The admin then keeps the last reading it had.

A node whose Bee API reaches the dialling host alone (`localhost`, `127.0.0.0/8`,
`0.0.0.0`, `[::1]`) is no address for the admin. The record is not sent, the
outcome is `skipped-no-record`, and the log says why once.

`immutable` is what the node says, and `true` while it says nothing, since the
designation refused a batch whose kind was not reported and a batch's kind never
changes.

### When and to whom the catalogue record goes

To the manager's admin link, `PUT <link>/api/internal/catalogue-stamp`, with
the link's stored token, on the stage client's bounds. It is pushed:

- **when the designation changes**, at once after the save,
- **when the designated deployment changes**, on its `profile.changed` event,
- **when a reading changes**. The pinned batch is read every
  `CATALOGUE_CHECK_MS` (ten seconds), and a record goes when its state, depth,
  fill or kind moved, or its life moved more than `CATALOGUE_TTL_DRIFT_SECONDS`
  (five minutes) off the clock, as a top-up or a dilution moves it. While a move
  is pending the batch moved from is read on the same round and judged the same
  way,
- **every 30 seconds** since the last push the admin answered, and at start.

Both nodes are read at once, so the push waits for the slower of the two, whose
read is bounded. Once a designation is cleared its batch is read no more.

A clear goes to the same link as `DELETE` with `{ observedAt }`, the moment the
designation was taken out, stored as `cleared_at`, so a retry and a restarted
manager send the same moment. It is sent until the admin answers it, and not
after. One call is in flight at a time. A trigger that comes during one makes one
more after it, so a clear never overtakes the push before it.

Each call comes to one of `CATALOGUE_PUSH_OUTCOMES`: the codes of the stage
outcomes above, with `cleared` and `not-cleared` in place of `retired` and
`not-retired`, `skipped-no-node` (the designated deployment does not exist), and no
`skipped-not-linked` or `skipped-other-origin`. `skipped-no-record` here means a
record the contract refuses, no depth known, or a loopback Bee API address. The
card shows the last one, as in "Web2 admin: stored 12 s ago", and the log says it
when it changes.

### The card and the node's page

The **Catalogue node** card lists the deployments that are nothing but a Bee
node, then the batches the chosen one holds, each with its depth, life, fill and
kind. It refuses, before any save and with the manager's own sentence, what the
manager would refuse. Designated, it shows the node, the batch, its last reading
and the last push, with **Move to another batch** and **Clear the designation**.
Cleared, it says which batch and node the catalogue stays pinned to, and offers
**Designate again** for that batch. The card reads the designation every
`CATALOGUE_NODE_POLL_MS` (ten seconds).

Once a batch is pinned, choosing another one on a Bee-only node turns the button
into **Move the catalogue to batch …**, which asks first. While the move is
pending the card shows "Moving from batch … on …" with that batch's last reading
and who started the move, and the steps:

1. In the admin, on its Stages page, start "Move the catalogue to batch …".
   This needs `CATALOGUE_MOVE_ENABLED` on that admin.
2. Wait until the admin says the move is done.
3. Press **Release the previous batch** here. It asks first, since the node moved
   from can then be removed and its batch may lapse.

A third batch is refused on the card with the manager's sentence while the move
is pending. After a release the card says when and by whom the last one was made.

On the node's own page the pinned batch carries a **catalogue** chip. The
Storage and funding card says that Buy and Use leave the catalogue on the pinned
batch, and that moving it is its own action. Top up stays offered on it
([postage-stamps.md](postage-stamps.md)).

`pnpm -C frontend dev:mock` seeds a `catalogue-node` deployment with two
immutable batches and a mutable one, so a designation, a move and a release can
be tried.

## Settings

| Setting                                         | Where                         | What it does                                                                                                         |
| ----------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_HOST`                                   | the manager                   | the public ingest address of a deployment on the manager's own host that has no address of its own. Empty by default |
| `STREAM_KEY`                                    | the deployment                | the key the stage signs with. The record carries its address as `owner`                                              |
| `ADMIN_API_URL`, `ADMIN_API_TOKEN`              | the deployment                | the admin the uploader reports to and its token ([web2-admin-link.md](web2-admin-link.md))                           |
| `SRS_SRT_PORT`, `SRS_RTMP_PORT`, `OME_SRT_PORT` | the version's port table      | the ingest ports, shifted by the deployment's slot                                                                   |
| `SRT_PASSPHRASE`                                | the deployment or the version | the SRT passphrase the record carries                                                                                |

## Limits

- One admin link per manager. A stage on another admin's origin is not pushed.
- A deployment whose `ADMIN_API_URL` moves to another origin is not pushed any
  more, and its stage stays at the admin it left until that admin retires it.
- A deployment whose record could not be put together since the manager started
  (`skipped-no-record`) is not retired when it is removed. A stage the admin
  stored from a push before a restart then stays active there.
- The push outcomes and the last catalogue reading and push are kept in memory. A
  restarted manager says "not pushed yet" or "not sent yet" until its first push.
  A running stage is pushed within 30 seconds of the start, and the catalogue
  record at start. Retirements are kept in the database and survive a restart.
- The catalogue stamp record goes to the link as it is now. A link moved to
  another admin leaves the old one holding the last record it was sent.
- When the manager shuts down the publishers stop first, and no push starts after
  that.
- A rung under another manager has no reading, and a pool's verdict does not read
  its rungs.
- The stage card estimates the ingest address from the page's own host for a
  deployment on the manager's host. The record uses `PUBLIC_HOST`.
- Between a rotation and the redeploy, the running uploader's token is refused
  once the next push lands, so the uploader cannot report until it is redeployed.
  The card says so before it asks.
