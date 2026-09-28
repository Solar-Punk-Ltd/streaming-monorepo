# Stages: the admin learns them from the manager

This page is the design for turning the web2 admin from a console tied to one stage into one that
serves every stage the manager runs for the brand. It was decided with the owner on 2026-09-28,
after a second opinion that read the code of all three apps. The decisions are at the top; the
rest says what each part does and in which order it is built.

**Status, 2026-09-29.** All nine phases are built on the feature branch `feat/stages`, pull
requests #56 to #63 and the phase 9 one listed in [the roadmap](../ROADMAP.md). Each part below
says how it was built. Nothing has reached a host, and the move of the catalogue to another batch
stays off until the owner has tried it on a real node.

## The problem

The admin carries one stage in its env file: `INGEST_HOST`, the SRT and RTMP ports and
`INGEST_SRT_PASSPHRASE` for the OBS panel, `BEE_URL` and `POSTAGE_BATCH_ID` for the catalogue,
one `INTERNAL_API_TOKEN` every uploader shares, and a `FEED_PRIVATE_KEY` every uploader's
`STREAM_KEY` must equal. The manager already knows every one of these facts, so a second stage
means copying them by hand, and a batch that is topped up or replaced leaves the admin's copy
stale. The admin cannot even be deployed before a stage exists, since its deploy refuses to run
without `BEE_URL`, `POSTAGE_BATCH_ID` and `INGEST_HOST`.

## Decisions

| Topic           | Decision                                                                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What a stage is | A manager deployment that runs a stream uploader (kind `abr-uploader`, or `streamer`), with the node pool behind it. No new entity in the manager. Its id is the deployment's `instance_id`. |
| Catalogue       | One per brand, signed by the brand key, listing the streams of every stage. One viewer per brand.                                                                                            |
| Direction       | The manager **pushes** each stage's record into the admin. The admin never calls the manager, and the manager grows no machine login.                                                        |
| Binding         | A stream goes live only on its own stage. Every uploader gets a token of its own, and the admin answers a token only about its own stage's streams.                                          |
| Keys            | Every stage signs its feeds with its own key. The brand key signs the catalogue alone and never leaves the admin.                                                                            |
| Catalogue stamp | A batch of its own, immutable and deep, on a dedicated catalogue node the manager runs, pinned by id. Never a batch a rung stamps segments with.                                             |
| Scope           | The admin reads. Top-ups, purchases and chequebooks stay in the manager's console.                                                                                                           |
| Engines         | SRS stages only in this round. An OvenMediaEngine stage is listed and marked as not supported.                                                                                               |

## Why these

- **Push.** The manager already holds the admin's address and a token for it (the admin link,
  migrations 041 and 042) and already calls the admin with them (Test connection). Pushing needs
  nothing new on the manager's side of the door, puts no manager address or credential in the
  admin's env file, and scopes itself: each deployment is pushed to the admin it is linked to.
- **The admin caches.** The uploader's live and vod reports rewrite the catalogue during a
  broadcast. Every fact the admin needs to do that sits in its own database, so a manager that is
  down stops nothing but fresh readiness readings. The overview's promise holds: the manager and
  the admin are not on the media path.
- **One key per stage.** The viewer reads the catalogue under the owner it was built for, and
  resolves each entry under that entry's own `owner` and `topic`, so Swarm never needed the two
  keys to be one. Only three checks in code tie them: the uploader's boot check, the admin's
  publish check and the manager's Test connection. A stage host is the most exposed machine of
  the platform; with one key per stage its compromise leaks that stage's key, not the brand's.
- **One catalogue batch, of its own.** A batch that expires drops the chunks it stamped, and the
  viewer walks the catalogue's slots until the first 404, so one missing slot hides every entry
  after it. That happened on 2026-09-13. A batch shared with a rung fills with segments, and then
  a mutable batch overwrites its oldest chunks, which are the catalogue's first slots, while an
  immutable one refuses the catalogue's next write. A dedicated node with one immutable batch
  keeps the catalogue's life apart from any stage's.

## The records

The shapes live in `packages/contracts` (`stage.ts`), one zod schema each, checked by the side
that receives them.

**A stage record**, pushed by the manager for one deployment:

| Field                                    | What it is                                                                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                          | 1                                                                                                                                       |
| `stageId`                                | the deployment's `instance_id`                                                                                                          |
| `managerId`                              | the manager's own generated id, so two managers linked to one admin cannot collide                                                      |
| `name`, `kind`, `engine`, `stackVersion` | for display; `kind` is `abr-uploader` or `streamer`, `engine` `srs` or `ome`                                                            |
| `status`                                 | the deployment's status as the manager reports it                                                                                       |
| `observedAt`                             | when the manager read what the record says; an older record never replaces a newer one                                                  |
| `ingest`                                 | `host` (the public address encoders dial), `srtPort`, `rtmpPort`, `rtmpPublic`, `srtPassphrase` (or null)                               |
| `owner`                                  | the address of the stage's `STREAM_KEY`, never the key                                                                                  |
| `rungs[]`                                | per rung: its name, its stamp (`batchId`, `state`, `ttlSeconds`, `fillRatio`, `immutable`) and its chequebook's health; no node address |
| `uploader`                               | the uploader's health reading, or null when it could not be read                                                                        |
| `readiness`                              | the manager's verdict (`ready`, `warning`, `blocked`, `unknown`) with its reasons, worked out in the manager and shown as it is         |
| `adminToken`                             | the sha256 of the token the deployment's uploader presents to the admin, and where it came from: `own` or `shared`, below               |

**A catalogue stamp record**, pushed by the manager for the brand: the catalogue node's name, its
Bee API address as the control host reaches it, the pinned `batchId`, whether the batch is
`immutable`, its `depth`, its stamp `state`, `ttlSeconds` and `fillRatio`, when it was designated,
and `observedAt`.

Neither record ever carries a signing key, a wallet key, an RPC endpoint, a token or a rung's
node address.

## The admin's side

New routes under `/api/internal`, which is mounted ahead of the cross-site check and takes a
bearer token and no session:

| Route                                  | Who calls it | What it does                                                                                                                                                    |
| -------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /api/internal/stages/:stageId`    | the manager  | stores a stage record, unless the stored one is newer; answers whether it stored it                                                                             |
| `DELETE /api/internal/stages/:stageId` | the manager  | retires the stage as of the `observedAt` its body carries: its row stays, because streams and old catalogue entries name its owner, and it takes no new streams |
| `PUT /api/internal/catalogue-stamp`    | the manager  | stores the catalogue stamp record                                                                                                                               |
| `DELETE /api/internal/catalogue-stamp` | the manager  | clears it as of the `observedAt` its body carries; the admin then refuses to publish, with a sentence saying why                                                |
| `GET /api/internal/stages/self`        | an uploader  | answers the stage its token belongs to, and the owner that stage signs as                                                                                       |
| `GET /api/internal/registrar`          | the manager  | answers 204 and does nothing else: the manager's Test connection proves its stored token with it                                                                |

The manager's routes take the **registrar token**: the admin's `INTERNAL_API_TOKEN`, which the
manager's admin link already stores. An uploader's routes take that uploader's own token, known
to the admin by its sha256 on the stage record, and nothing else.

As built in phases 5 and 9:

- Only a record whose `adminToken.kind` is `own` attributes a call, and the manager says `own` only
  for the token it generated for that deployment. Any other token, one copied from the link by an
  older manager, typed, or set by the version's env files, is `shared`.
- The registrar token is the manager's alone. From phase 5 to phase 8 an uploader's routes still
  took it, as an unattributed caller answered about every stream; phase 9 stopped that. It is now
  refused on the by-ingest lookup, the state and rendition reports and `GET /stages/self` with the
  same `401 unauthenticated` as any other token, and nothing is written for it. A stage whose
  record says `shared` is refused the same way, whatever token it presents, and the one way back is
  **Rotate the uploader's admin token** in the manager, whose next deploy generates one of its own.
- The admin asks its database only for a bearer of 64 hex characters, the shape the manager
  generates. Any other token is refused without a query.
- A retired stage's token is refused. A token that is the own token of more than one active stage
  is refused as well, since it cannot say which stage calls, and the admin logs a warning naming
  the stages. Neither a token nor its hash is logged.
- A stage's token is answered only about its stage's streams. A stream on another stage, or with no
  stage, is the same 404 as a stream that does not exist, and nothing is written for it. A stream
  with no stage, a row older than stages, is reached by no uploader: it takes a broadcast again
  once it is unpublished, given a stage and published.
- `GET /api/internal/registrar` answers 204 on the registrar token and 401 on any other. A path no
  route names is 404 on either token and 401 without one.
- The console's Stages page says per stage whether its uploader is on its own token, on a `shared`
  one, which is refused until the token is rotated in the manager and the stage redeployed, or on
  none the manager pushed.

**Every moment the admin orders by is the manager's.** A record carries `observedAt`, and each
`DELETE` carries a body `{ observedAt }` (`stageRetireRequestSchema`,
`catalogueStampClearRequestSchema`): the moment the manager saw the deployment, or the catalogue
designation, gone. The admin compares only these with each other, never with its own clock, which
records only when something arrived. So the two hosts' clocks never need to agree.

- An older record never replaces a newer one. Two records observed at one moment are a repeat,
  and the second is stored.
- A retirement is taken unless the admin holds a record observed after it: the manager has seen
  the deployment since. A second retirement keeps the later moment.
- A `PUT` for a retired stage stores its record and brings the stage back only when the record
  was observed after the retirement's moment, so a push already on its way when the deployment
  was deleted does not undo the `DELETE`.
- A retirement of a stage the admin never stored is kept as a tombstone, and a record for that id
  is stored only when it was observed after it, so a first push that arrives late does not
  register a deployment that is gone.
- The catalogue stamp's clear follows the same rules, the tombstone included.
- The `PUT`s answer `{ stored }`. The `DELETE`s answer `{ retired }` and `{ cleared }`
  (`stageRetireAnswerSchema`, `catalogueStampClearAnswerSchema`), true only when the call
  retired or cleared something the admin held, and false otherwise, a kept tombstone included.
- The last manager to push a stage wins. A stage record's `managerId` replaces the stored one, so
  a manager reinstalled with a new id takes its stages back. The move is audited as a
  `stage.change`.

The console gets `GET /api/stages`: every stage with its readiness and stamp readings and when
the manager last confirmed them, without the passphrase or the token hash, and
`GET /api/catalogue-stamp`: the catalogue batch without the Bee API address.

In the database: a `stages` table (the record, the passphrase in a column no list selects, the
token hash, the owner, when it was observed and received, when it was retired by the manager's
clock and when that arrived), `stage_retirements` for retirements of stages never stored, a
single-row `catalogue_stamp`, and `streams.stage_id`.

A stream's stage is picked in the stream form, is required before publish, and shows as a column
and a filter in My Streams. It can change while the stream is a draft. Publishing fixes it,
because the catalogue entry and every viewer link carry the stage's owner; to move a published
stream, unpublish it, change it, publish again. A stream that holds a recording keeps its stage,
since the recording lives under that stage's owner. The OBS panel shows the stream's stage's
ingest details. The admin warns before a stream is scheduled on a stage whose readiness is not
`ready`, and says when the manager last confirmed it.

Two rows older than stages are let through, since each has no stage to keep: a draft that holds a
recording may be given its first stage, and a stream already on the catalogue is republished as it
is, with no stage until it is unpublished. Only a draft is refused at publish for having none, and
a draft without a recording is refused as well when its stage no longer takes streams. The console
warns that the first stage of such a recorded draft is final and asks before saving it. Their
recordings are signed by the brand key, so since phase 6 the picker offers them only stages whose
owner is the recording's, and the admin refuses any other with `409 stage_locked`, reason `owner`. The
admin no longer asks whether the ingest verifies the per-stream `key=`: every uploader that takes
streams from it does, so `INGEST_KEY_VERIFIED` leaves the env with the other `INGEST_*` keys.

The catalogue is written through the catalogue stamp record's node and batch, read from the
admin's own database on every write. The admin warns on My Streams when that batch has less than
48 hours left or is 90% full, and refuses to publish with a clear error when it is expired or gone.
Every write also records the exact bytes it uploaded, so the history can be stamped again under a
new batch.

As built (phase 7), in `apps/web2-admin/backend/src/domain/CatalogueBatch.ts`:

- The admin pins the batch its first write goes through (`catalogue_stamp.active_batch_id`, with
  the last record pushed for it), and keeps writing with it. When the manager designates another
  batch and the feed has a recorded write, the admin keeps the pinned one, at its node, and My
  Streams says a move is waiting. With no recorded write (the feed key changed) the designated batch
  is pinned in its place. The first write after the upgrade from `POSTAGE_BATCH_ID` pins the
  designated batch; the writes before it keep a null batch in `feed_writes`, which is how the move
  finds them.
- The pinned batch's readings, once the manager designates another, are the last ones pushed while
  it was the designated batch, kept with the moment they were read. An expired or gone among them
  is a refusal, and so is a time to live that has run out since that moment, whatever the state
  says. A mutable batch is refused as well.
- The writes from before the catalogue stamp have no batch recorded. While any is left, My Streams
  counts them and says a move is waiting, since the batch that stamped them will expire.
- A publish, an unpublish or a reconcile is refused before it moves anything, as `503` with the
  reason: no designation, a cleared one, or the pinned batch expired, gone or mutable. A clear
  leaves the pin, so a designation that comes back finds the history where it was. The uploader's
  reports store their state first and are refused the same way when their rewrite comes; `503` is
  a failure it retries. A failed write's reason never carries the catalogue node's address.
- `feed_writes.payload_text` holds the exact string uploaded and `feed_writes.batch_id` the batch
  that stamped it (migration 013).
- The boot's feed check reads the head through the catalogue node, so an admin started with no
  designation skips it and runs it once the first designation arrives.

## The manager's side

- **The stage publisher.** For every deployment that runs a stream uploader and whose effective
  `ADMIN_API_URL` is on the origin of the manager's admin link, the manager builds the stage
  record and pushes it to the link's stored address with the link's stored token: when the
  deployment changes (its `profile.changed` event, coalesced per deployment), every 30 seconds while
  it runs, and before a deploy starts its uploader, so the uploader's first call finds its token
  known. A deleted deployment is retired the same way. The client is bounded like the Test
  connection probe: http and https alone, no redirects, five seconds, a small answer read, and an
  outcome code, never what the far end said, in the log and on the deployment page. A pool's rungs
  are read on the deployments of this manager that stamp with each rung's batch, and a rung under
  another manager has no reading. `apps/infra-manager/docs/features/stages.md` is the page.
- **The moments it stamps.** The admin orders everything by these, so they must be true:
  - A record's `observedAt` is the moment the manager read the deployment row. It is stamped
    before the slower readings (stamps, chequebooks, the uploader's health), not after them. A
    record that takes seconds to build then never claims a moment later than a deletion that
    happened while it was being built.
  - A `DELETE /api/internal/stages/:stageId` carries `{ observedAt }`: the moment the manager
    saw the deployment gone, which is when its row was deleted, not when the call is sent or
    retried. A `DELETE /api/internal/catalogue-stamp` carries the moment the designation was
    removed, by the same rule.
  - A retry resends the same moments. The admin keeps the latest of each and answers a repeat as
    a repeat.
- **The public ingest address.** A setting per deployment, defaulting to the host address the
  manager resolved for it. The address ssh dials can be a private one, and an encoder has to
  reach this one.
- **Per-deployment uploader tokens.** `ADMIN_API_TOKEN` joins the secrets the manager generates
  for a deployment that stores none, and it is no longer copied from the admin link. The stage
  record carries its sha256.
- **The catalogue node.** A Bee-only deployment designated as the brand's catalogue node on the
  Manager settings page, next to the admin link, with its batch pinned by id. The manager refuses
  a mutable batch or one whose kind the node did not report. Buying or using another batch on that
  node leaves the catalogue on the pinned one, and the page says so; moving the catalogue is its
  own action. As built (phase 7): once a batch has been designated the manager refuses any other,
  through a clear as well, and the same batch can be designated again. A clear keeps the node and
  the batch recorded; that node is not removed, and a pool string that names its batch or its Bee
  API is refused on create and update. Since phase 8 another batch is designated as a move, which
  keeps the previous one guarded until it is released ([Moving the catalogue to another
  batch](#moving-the-catalogue-to-another-batch)).
- **A read of the stages** for the manager's own console, `GET /stages`, behind the session like
  every other route, and `GET /stages/:name/registration`, the last push of one deployment, which
  the deployment page reads.

## The uploader's side

With one key per stage, the uploader's boot check asks the admin `GET /api/internal/stages/self`
with its own token and compares its signer with the owner the admin names. An admin that answers
404 there, one older than stages (or, from phase 5 to 8, a caller on the shared token), falls back
to the comparison with the admin's public `/api/config`. Since phase 9 an uploader on any token but
its own is answered 401 there, which it logs as an owner it could not confirm, and every lookup and
report it makes is refused the same way until its token is rotated. The uploader itself did not
change in phase 9. The per-declaration owner check is unchanged: the declaration names the stage's
owner, and a stream of another stage is refused at the gate.

## A key per stage, as built in phase 6

- **The admin.** A stream's `owner` is its stage's, kept as the brand key's is, lower case and
  without `0x`. It is set when the stream is created on a stage and whenever its stage is set or
  changed, which only a draft allows, and a stream with no stage has the brand key's. The publish
  claim of a draft that holds no recording reads it from the stage again in the same statement, so
  a key rotated in the manager, which is pushed as a new `owner`, is what the entry names. A row
  that holds a recording never changes owner: a publish of one whose stage now signs as another
  address is refused, `409 feed_owner_mismatch`, "the recording was made under another key". A
  stream already on the catalogue keeps the owner publishing fixed, and so does a state report's
  write; the check that every row's owner is the brand key's is gone from both. The catalogue is
  still signed by `FEED_PRIVATE_KEY`, and `/api/config` still names that address for the viewer
  build. A reconcile, and the boot's dry run of it, count as ours every entry whose owner is the
  brand key's or any stage's the admin holds, retired stages included.
- **The uploader.** `assertAdminSignsAsThisService`, now in
  `apps/hls-stream/packages/stream-uploader/src/libs/AdminOwnerCheck.ts`, asks `stages/self` first.
  A mismatch refuses to start with both addresses and says to fix the deployment's `STREAM_KEY` in
  the manager, or the stage the admin holds. A 404 falls back to `/api/config`, where a refusal
  says to give the deployment a token of its own. A stage read that fails otherwise only warns,
  and is not followed by the config, whose owner is not a stage's.
- **The manager.** Test connection on a deployment asks `stages/self` with the deployment's token
  wherever there is a stream address to compare, and asks `/api/config` only on its 404. The
  wizard's test with a token of its own compares no owner, since the admin learns the stage's
  address at the first deploy. Nothing tells an operator to give a stage the admin's key. (Phase 9
  changed the rest of the wizard's test, below.)
- **A rotated key.** A reconcile counts as ours, besides the brand key and every stage's owner,
  the owner of every row on the catalogue, so a stream published under a key its stage signed
  with before the manager rotated it is still rebuilt, or added again, under that key. A publish
  of a draft whose last publish failed first takes off any entry of ours for its topic under
  another owner, one the failed write may have left under the owner the row had then, so a
  failure and a rotation cannot list the stream twice. A stream that was published, and not yet
  live, when its stage's key was rotated keeps the old owner until it is unpublished and published
  again, and its broadcast is refused at the gate until then.
- **The redeploy window.** The manager pushes the stage's new owner as soon as the key changes,
  before the uploader is redeployed with it. A draft published in that window names the new owner,
  while the running uploader still signs with the old key, so the gate refuses its broadcast until
  the uploader is redeployed. Redeploy the stage right after rotating its key.

## The shared token stops, as built in phase 9

- **The admin.** The uploader's door takes a stage's own token alone, as the admin's side above
  says, and `GET /api/internal/registrar` is the manager's proof of its token.
  `REGISTRAR_CHECK_PATH` in `packages/contracts/src/stage.ts` names it.
- **Test connection on Manager settings**, the link card, proves the typed or stored token on the
  registrar check: 204 is `token-accepted` and the admin's own 401 `token-refused`. It no longer
  asks the uploader's lookup, which refuses that token. An admin older than the check answers its
  own 404 there only past its door, so that 404 is followed by the lookup, which such an admin
  still takes the token on. The origin rules are unchanged: the stored token goes only to the
  origin it was stored for.
- **The wizard's Web2 admin group.** A token of its own is tested as the manager's stored token,
  on the registrar check. A token typed here is an uploader's (`tokenFor: 'uploader'` on the test
  request), tested on the lookup and `stages/self` as the uploader asks, and it is held, with a
  sentence and a button back to a token of its own, at the address of the manager's link while
  the link stores a token: that admin takes no typed token from an uploader.
- **Test connection on a deployment** keeps presenting the deployment's own token on the lookup
  and `stages/self`. At the link's address, a token the manager did not generate for the
  deployment is `token-not-own` whether the admin refused it or, being older than phase 9, took
  it: rotate the uploader's admin token and redeploy. At another address a refusal is
  `token-refused`.
- **A stored token at the link's address is refused by the manager.** A save of a deployment's
  settings or a create that leaves a stored `ADMIN_API_TOKEN` at an address on the origin of the
  manager's link, while the link stores a token, is refused with the wizard's sentence
  (`TYPED_TOKEN_AT_LINK`, `typedTokenAtLinkProblem` in `common/src/adminLink.ts`). Clearing the
  token, or resetting it to the version's, takes it; the first deploy then generates one of its
  own.
- **The registrar token is never an uploader's.** The uploader's door compares the presented
  token with `INTERNAL_API_TOKEN` itself before any lookup, and the admin refuses a pushed record
  whose own-token hash is that token's, with a 400 that names neither.
- **Leftovers taken out.** `use_manager_admin_token` is gone from `POST /profiles` and
  `POST /groups`; a create drops it as any key it does not name. The rotation's sentences and the
  pages no longer say a shared token keeps being taken.

**Rolling out phase 9**, decided 2026-09-29, on a host that runs today's admin and manager from
before stages. It is not "admin first", which was phase 5's rule (below, kept as history):

1. **Deploy the admin at the phase 8 tip**, commit `d29616851` on `feat/stages`. It takes both the
   shared token and a stage's own.
2. **Deploy the phase 9 manager.** It works in front of the phase 8 admin: its Manager settings
   Test connection falls back from the registrar check's 404 to the lookup, and each deployment's
   Test connection answers `token-not-own` for every stage still to rotate.
3. **Rotate and redeploy every stage** (**Rotate the uploader's admin token** on its deployment
   page, then deploy) until the admin's Stages page reads "Its own token" for all of them.
4. **Deploy the phase 9 admin.**

Skipping steps 1 to 3 means every running uploader gets 401 from the phase 9 admin until its stage
is rotated and redeployed. A fresh installation needs none of this: every stage it creates has a
token of its own from its first deploy.

## Moving the catalogue to another batch

A top-up keeps the batch id and extends the life of every chunk it stamped, the history
included; nothing changes in the admin but the readings. Moving to another batch means stamping
the history again: the admin rewrites every slot of the feed, in order, with the exact bytes
it recorded, under the new batch, re-uploads the thumbnails the latest entry names, then writes
with the new batch. bee-js puts a payload straight into the feed's chunk with no timestamp, so
the same bytes make the same chunks at the same addresses. The job is resumable and runs while
the old batch still has days of life.

**The move is off by default.** `CATALOGUE_MOVE_ENABLED` in the admin's env file turns it on,
and it stays off on every installation until the owner has tried it on a real node, by
[Trying the move on a real node](#trying-the-move-on-a-real-node) below. Until then the Stages
page says the move is not yet enabled on this installation, and the manager's move and release
work as built: they only change which batch is pinned and which is guarded.

As built (phase 8), on the manager's side (`CatalogueDesignationService`, migration 048;
`apps/infra-manager/docs/features/stages.md` is the page):

- Designating another batch than the pinned one is a move, saved only when the request says
  `move: true` (the card's "Move the catalogue to batch …", confirmed). The new batch passes
  every check a designation does. The row keeps the previous node and batch as "moving from",
  and the catalogue stamp record pushed is the new batch's: the contract is unchanged.
- While a move is pending, both nodes are guarded against removal, no pool string may name
  either batch or node, the previous batch is still read every ten seconds for the card, a third
  batch is refused (release the previous one first), and moving back to the previous batch
  swaps the two.
- **Release the previous batch**, `POST /manager-settings/catalogue-node/release`, revisioned,
  behind the session and the same-site check, takes the previous batch out once the admin
  reports the move done; only then does the guard lift. It is logged with the user and
  recorded in the row, like a designation. The manager cannot see the admin's progress, so the
  card says the steps and asks before it releases.

As built (phase 8), on the admin's side (`apps/web2-admin/backend/src/domain/CatalogueMove.ts`,
migration 014; the admin backend's README has the detail):

- A move waits when the feed has history and the pinned batch is not the designated one (another
  designated, or a move back to one that still holds every slot, which needs the switch alone),
  some slot is not under the designated batch by the admin's record (written with another batch,
  or with one the admin never recorded, the env file's: that case needs no release in the
  manager), or the latest move to it has not finished. Nothing waits only when the pinned batch is
  the designated one and every slot is under it.
- For slots 0 to the head, in order, the job uploads each slot's single-owner chunk again under
  the new batch through the catalogue node. From `payload_text` where there is one: the chunk
  is built as `updateFeedWithPayload` built it, and signed again with the brand key. secp256k1
  signing with RFC 6979 nonces is deterministic, so the chunk is the one first uploaded, byte for
  byte; `test/unit/catalogueRestamp.test.ts` holds the job to the bytes bee-js's own write
  produced. A slot with no recorded bytes, a row from before migration 013 or a slot with no
  row at all (before 003), is read from the network through the catalogue node, checked against
  its address, and uploaded with its own signature. A payload over 4096 bytes has its
  content-addressed data uploaded again first. A slot already under the new batch by the record
  is left as it is.
- Then every thumbnail a stream names, published or not, and every one the latest entry names,
  from `streams.thumbnail` where the row holds the bytes and otherwise from the network; one an
  entry names has to come out at the same reference. Each is recorded on its streams as under the
  new batch (`streams.thumbnail_batch_id`), and a publish uploads a thumbnail again whenever that
  batch is not the one it writes with, so a draft published after the move names an image the
  new batch holds. Then the admin pins the new batch and writes with it.
- It goes in slices of 20 slots outside the publish mutex, so publishing goes on with the
  pinned batch, and checks the designation between slices. The last step holds the mutex: the
  slots written meanwhile, the thumbnails of the entry written last, and the switch, so no slot
  is left under the old batch alone.
- Progress is recorded after every slot (`catalogue_moves.next_index`, and
  `feed_writes.restamped_batch_id` and `restamped_at`), so a restart resumes a running move at
  boot and a shutdown pauses it. A failure stops with its reason, without the node's address,
  and the same start retries it from there.
- A start is refused when the move is off, there is no batch to move to or nothing to move, the
  designated batch is expired, gone or mutable, or the batch the catalogue is written with has
  lapsed while some slot has no recorded bytes: the network drops a chunk once its batch lapses,
  so those slots cannot be read any more, and the page says so.
- The start, the end and a failure are audited (`catalogue.move.start`, `.done`, `.failed`) and
  logged with batch ids shortened. The Stages page shows N of M slots while it runs, the reason
  when it failed, and, once done, that the previous batch can now be released in the manager.

### Trying the move on a real node

For the owner, once, before `CATALOGUE_MOVE_ENABLED` is turned on anywhere. Nothing in the
repository runs this; every unit and integration test uses a fake Bee.

1. **Set up a scratch installation.** A testnet or scratch Bee node as a Bee-only deployment of
   a scratch manager, and a scratch admin with its own `FEED_PRIVATE_KEY` and `FEED_TOPIC`, so no
   brand's catalogue is touched. Buy two small immutable batches on the node, A and B (depth 17
   or 18 is plenty: a catalogue slot is one chunk, or a few for a long list). Link the admin
   and designate the node with batch A.
2. **Make history.** Create a few streams, give some a thumbnail, publish and unpublish them
   until the feed has a dozen slots or more. Make at least one catalogue longer than 4096 bytes
   (a long description on several published streams does it), so a wrapped slot is in the
   history. Open the viewer built for the scratch feed and note what it lists.
3. **Move.** In the manager, choose batch B on the catalogue node's card and confirm the move.
   In the admin's env file set `CATALOGUE_MOVE_ENABLED=true` and restart the admin. On the
   Stages page, "Move the catalogue to batch B…", confirm, and publish a stream while it runs.
   Wait for "The catalogue was moved to batch B".
4. **Check each slot under B.** For every index 0 to the head, `GET /chunks/<slot address>` on
   the node answers the same bytes as before the move, and `GET /stamps/<B>` shows its
   utilisation grown by about the number of slots and data chunks. The admin's log has one
   `Restamped feed index=` line per slot, and none failed. A slot's address is
   keccak256(identifier, owner); the `ref=` of each `Wrote feed index=` line in the log is it.
5. **Check the viewer.** Dilute or let batch A lapse (on a testnet, a batch bought with the
   smallest amount lapses in hours), or point the viewer at a node that never held A's chunks.
   The viewer still lists every entry it listed in step 2, with its thumbnail, and the stream
   published during the move.
6. **Release.** Press "Release the previous batch" in the manager, and remove batch A's node
   if it was another deployment.

If every step holds, record the date in the roadmap and turn the move on where it is needed. If
a slot or a thumbnail came out at another reference, the move stops before the switch, the
admin keeps writing with A, and the log and the Stages page say which.

## The flow for a brand

| #   | Where            | Step                                                                                                                                                                      |
| --- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Terraform        | The hosts, DNS names for both consoles, the provider's firewall                                                                                                           |
| 2   | The hosts        | The manager's ssh key authorised on the stage and Bee hosts                                                                                                               |
| 3   | The control host | The manager, the admin and the edge. The admin needs its database, a generated brand key and a generated `INTERNAL_API_TOKEN`, and no stage                               |
| 4   | Both consoles    | The first user from the command line, then the other users; the two consoles keep separate users                                                                          |
| 5   | Manager          | Manager settings: the admin link, with the admin's public address and its `INTERNAL_API_TOKEN`; Test connection                                                           |
| 6   | Manager          | The ABR node pool and the catalogue node: fund their wallets from outside, buy the batches (the catalogue's immutable), fill the chequebooks, set the Bee host's firewall |
| 7   | Manager          | Manager settings: designate the catalogue node and its batch                                                                                                              |
| 8   | Manager          | The ABR uploader, the stage, with its own generated key, linked by default. It registers itself with the admin                                                            |
| 9   | Manager          | A viewer built for the brand's catalogue owner and topic, and its address into the admin's `VIEWER_BASE_URL`                                                              |
| 10  | Admin            | My Streams: create a stream, pick its stage, schedule, publish. The OBS panel shows that stage's ingest details                                                           |

## The phases

Each phase is one pull request into the feature branch `feat/stages`, with its tests and the
pages it changes. The feature branch reaches `main` only once the owner has tried it whole, and
nothing reaches a host without the owner's word.

| #   | Phase                                                                                                                        | Apps                       | Size |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---- |
| 1   | This brief, the roadmap entry, the records in `packages/contracts`                                                           | docs, contracts            | S    |
| 2   | The admin takes stage and catalogue stamp records and lists stages in the console                                            | admin                      | M    |
| 3   | The manager pushes stage records, with readiness, and the public ingest address setting                                      | manager                    | L    |
| 4   | A stage per stream: picker, column and filter, the OBS panel from the stage; `INGEST_*` leaves the env                       | admin                      | L    |
| 5   | A token per uploader, the shared one still taken while the stages move over                                                  | manager, admin             | M    |
| 6   | A key per stage: owners come from the stage; the boot check, publish, reconcile and Test connection follow                   | hls-stream, manager, admin | M    |
| 7   | The catalogue node: designation, the immutable-only rule and the exact bytes; `BEE_URL` and `POSTAGE_BATCH_ID` leave the env | manager, admin             | M    |
| 8   | Moving the catalogue to another batch                                                                                        | manager, admin             | M    |
| 9   | The shared token stops on an uploader's routes; the pages close checkpoint 3                                                 | manager, admin, docs       | S    |

Phases 2 to 5 reach a host together, because until phase 5 every uploader holds the token that
registers stages.

**Rolling out phase 5** (history: phases 2 to 8 reached no host, and the phase 9 sequence above
replaces this for a host that upgrades now). The admin is upgraded before the manager, and no uploader deployment is
redeployed in between. An admin older than phase 5 takes nothing but its `INTERNAL_API_TOKEN` from
an uploader, so an uploader that a phase 5 manager redeploys with a token of its own would be
refused by it. The upgraded admin still takes every uploader's shared token and learns each own
token from the pushes, so every running uploader keeps working across both upgrades. Once both run
phase 5, each uploader moves to a token of its own at its next deploy, or when it is rotated.

## Limits

- One admin link per manager: stages whose `ADMIN_API_URL` is on another origin are not pushed,
  and the deployment page says so. A second brand is a second link, not built here. Since phase 9
  such a stage can report only to an admin older than phase 9, which still takes its
  `INTERNAL_API_TOKEN` from an uploader: an admin of this version takes a stage's own token alone,
  and learns it only from the manager linked to it.
- The admin reaches the catalogue node's Bee API, which asks for no password, so the Bee host's
  firewall admits the control host. The dedicated node keeps that door to one node.
- Brand separation inside one admin, and top-ups from the admin, stay open decisions.
