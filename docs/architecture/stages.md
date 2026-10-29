# Stages: how the admin learns them from the manager

This is a concepts page. A stage is one place a brand can broadcast to: a manager deployment that
runs a stream uploader (kind `abr-uploader` or `streamer`), with the Bee node pool behind it. Its id
is the deployment's `instance_id`. The manager runs the stages, and the admin, the brand console,
needs to know each of them to show encoder settings, check uploaders and write the catalogue. This
page explains how the manager tells the admin about every stage, how the admin trusts the uploaders,
how keys are split, and how the catalogue gets a batch of its own.

## The shape in one table

| Topic           | How it works                                                                                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direction       | The manager pushes a record per stage into the admin. The admin keeps what it was told in its own database. The admin's one call to the manager is the funding API ([funding.md](funding.md)). |
| Catalogue       | One per brand, signed by the brand key, listing the streams of every stage. One viewer per brand reads it.                                                                                     |
| Binding         | A stream goes live only on its own stage. Every uploader presents a token of its own, and the admin answers a token only about its own stage's streams.                                        |
| Keys            | Every stage signs its feeds with its own key. The brand key signs the catalogue alone and never leaves the admin.                                                                              |
| Catalogue stamp | The catalogue is written with a batch of its own, immutable and deep, on a dedicated catalogue node the manager runs, pinned by id. It never shares a batch a rung stamps segments with.       |
| Funding         | The admin reads stages, funds the node wallets, tops up and dilutes batches and moves chequebooks, every operation through the manager's funding API. Buying batches stays in the manager.     |
| Engines         | SRS stages only. An OvenMediaEngine stage is listed and marked as not supported.                                                                                                               |

## Why it is shaped this way

- **The manager pushes.** The manager already holds the admin's address and a token for it, the
  admin link on its Manager settings page. Pushing needs no manager address or credential in the
  admin's env file, and scopes itself: each deployment is pushed to the admin it is linked to.
- **The admin caches.** During a broadcast the uploader's live and vod reports make the admin
  rewrite the catalogue. Every fact the admin needs for that sits in its own database, so the
  manager and the admin are not on the media path. A manager that is down stops fresh readings and
  nothing else, until the catalogue batch's last reading runs out: once the `observedAt` of the last
  catalogue stamp record plus its `ttlSeconds` has passed, the admin refuses every catalogue write as
  expired (`expiredByClock`), until the manager pushes a fresh reading.
- **One key per stage.** The viewer reads the catalogue under the owner it is built for, and
  resolves each entry under that entry's own `owner` and `topic`, so Swarm never needs a stage's key
  and the brand's key to be one. A stage host is the most exposed machine of the platform. With one
  key per stage its compromise leaks that stage's key, not the brand's.
- **One catalogue batch, of its own.** A batch that expires drops the chunks it stamped, and the
  viewer walks the catalogue's slots until the first one it cannot find, so one missing slot hides
  every entry after it. A batch shared with a rung fills with segments. A mutable batch then
  overwrites its oldest chunks, which are the catalogue's first slots, and an immutable one refuses
  the catalogue's next write. A dedicated node with one immutable batch keeps the catalogue's life
  apart from any stage's.

## The records

The shapes live in `packages/contracts/src/stage.ts`, one zod schema each, checked by the side
that receives them.

**A stage record**, pushed by the manager for one deployment:

| Field                                    | What it is                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                          | 1                                                                                                                                           |
| `stageId`                                | the deployment's `instance_id`                                                                                                              |
| `managerId`                              | the manager's own generated id, which names the manager a record came from                                                                  |
| `name`, `kind`, `engine`, `stackVersion` | for display. `kind` is `abr-uploader` or `streamer`, `engine` `srs` or `ome`                                                                |
| `status`                                 | the deployment's status as the manager reports it                                                                                           |
| `observedAt`                             | when the manager read what the record says. An older record never replaces a newer one                                                      |
| `ingest`                                 | `host` (the public address encoders dial), `srtPort`, `rtmpPort`, `rtmpPublic`, `srtPassphrase` (or null)                                   |
| `owner`                                  | the address of the stage's `STREAM_KEY`, never the key                                                                                      |
| `rungs[]`                                | per rung: its name, its stamp (`batchId`, `state`, `ttlSeconds`, `fillRatio`, `immutable`) and its chequebook's health, and no node address |
| `uploader`                               | the uploader's health reading, or null when it could not be read                                                                            |
| `readiness`                              | the manager's verdict (`ready`, `warning`, `blocked`, `unknown`) with its reasons, worked out in the manager and shown as it is             |
| `adminToken`                             | the sha256 of the token the deployment's uploader presents to the admin, and its kind: `own` or `shared`, below                             |

**A catalogue stamp record**, pushed by the manager for the brand: the catalogue node's name, its
Bee API address as the control host reaches it, the pinned `batchId`, whether the batch is
`immutable`, its `depth`, its stamp `state`, `ttlSeconds` and `fillRatio`, when it was designated,
and `observedAt`. While a move is pending in the manager, `previous` carries the batch moved from,
its node's name and Bee API and the same readings (`catalogueStampPreviousSchema`). It is null or
absent otherwise.

Neither record ever carries a signing key, a wallet key, an RPC endpoint, a token or a rung's
node address.

## The admin's side

The admin reaches the catalogue node's Bee API, which asks for no password, so the Bee host's
firewall admits the control host to that one node.

A stage on OvenMediaEngine is listed and cannot take streams from the admin.

### The internal routes

These routes live under `/api/internal`, which is mounted ahead of the admin's cross-site check
and takes a bearer token and no session:

| Route                                  | Who calls it | What it does                                                                                                                                                    |
| -------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /api/internal/stages/:stageId`    | the manager  | stores a stage record, unless the stored one is newer, and answers whether it stored it                                                                         |
| `DELETE /api/internal/stages/:stageId` | the manager  | retires the stage as of the `observedAt` its body carries: its row stays, because streams and old catalogue entries name its owner, and it takes no new streams |
| `PUT /api/internal/catalogue-stamp`    | the manager  | stores the catalogue stamp record                                                                                                                               |
| `DELETE /api/internal/catalogue-stamp` | the manager  | clears it as of the `observedAt` its body carries. The admin then refuses to publish, with a sentence saying why                                                |
| `GET /api/internal/stages/self`        | an uploader  | answers the stage its token belongs to, and the owner that stage signs as                                                                                       |
| `GET /api/internal/registrar`          | the manager  | answers 204 and does nothing else. The manager's Test connection proves its stored token with it                                                                |

The manager's routes take the registrar token: the admin's `INTERNAL_API_TOKEN`, which the
manager's admin link stores. An uploader's routes take that uploader's own token, known to the
admin by its sha256 on the stage record, and nothing else.

### Tokens

- Only a record whose `adminToken.kind` is `own` attributes a call. The manager says `own` only for
  the token it generated for that deployment. Any other token, one typed in or set by the stack
  version's env files, is `shared`.
- The registrar token is the manager's alone. It is refused on the uploader's routes, the
  by-ingest lookup, the state and rendition reports and `GET /stages/self`, with the same
  `401 unauthenticated` as any other wrong token, and nothing is written for it. The admin also
  refuses a pushed record whose own-token hash is the registrar token's, with a 400 that names
  neither.
- A stage whose record says `shared` is refused the same way, whatever token it presents. The way
  back is **Rotate the uploader's admin token** on the deployment in the manager, whose next deploy
  generates a token of its own.
- The admin looks a token up only when it is 64 hex characters, the shape the manager generates.
  Any other token is refused without a query.
- A retired stage's token is refused. A token that is the own token of more than one active stage
  is refused as well, since it cannot say which stage calls, and the admin logs a warning naming
  the stages. Neither a token nor its hash is ever logged.
- A stage's token is answered only about its stage's streams. A stream on another stage, or with no
  stage, is the same 404 as a stream that does not exist, and nothing is written for it.
- `GET /api/internal/registrar` answers 204 on the registrar token and 401 on any other. A path no
  route names is 404 on either token and 401 without one.
- The console's Stages page says per stage whether its uploader is on its own token, on a `shared`
  one, which is refused until the token is rotated and the stage redeployed, or on none the
  manager pushed.

### Ordering by the manager's clock

Every moment the admin orders by is the manager's. A record carries `observedAt`, and each `DELETE`
carries a body `{ observedAt }` (`stageRetireRequestSchema`, `catalogueStampClearRequestSchema`): the
moment the manager saw the deployment, or the catalogue designation, gone. The admin compares only
these with each other, never with its own clock, which records only when something arrived. So the
two hosts' clocks never need to agree.

- An older record never replaces a newer one. Two records observed at one moment are a repeat, and
  the second is stored.
- A retirement is taken unless the admin holds a record observed after it, which means the manager
  has seen the deployment since. A second retirement keeps the later moment.
- A `PUT` for a retired stage stores its record and brings the stage back only when the record was
  observed after the retirement, so a push already on its way when the deployment was deleted does
  not undo the `DELETE`.
- A retirement of a stage the admin never stored is kept as a tombstone, and a record for that id is
  stored only when it was observed after it, so a first push that arrives late does not register a
  deployment that is gone.
- The catalogue stamp's clear follows the same rules, the tombstone included.
- The `PUT`s answer `{ stored }`. The `DELETE`s answer `{ retired }` and `{ cleared }`
  (`stageRetireAnswerSchema`, `catalogueStampClearAnswerSchema`), true only when the call retired or
  cleared something the admin held.
- The newest record of a stage wins, whichever manager pushed it. Its `managerId` then replaces the
  stored one, so a manager reinstalled with a new id takes its stages back, and the change is
  audited as a `stage.change`.

### What the console shows

The console reads `GET /api/stages`, every stage with its readiness and stamp readings and when the
manager last confirmed them, without the passphrase or the token hash, and `GET /api/catalogue-stamp`,
the catalogue batch without the Bee API address.

A stream's stage is picked in the stream form, from the stages that are not retired and run SRS. It
is required before publish and shows as a column and a filter in My Streams. It can change while the
stream is a draft. Publishing fixes it, because the catalogue entry and every viewer link carry the
stage's owner. To move a published stream, unpublish it, change the stage and publish again. A
stream that holds a recording keeps its stage, since the recording lives under that stage's owner.
The OBS panel shows the ingest details of the stream's stage. The admin warns before a stream is
scheduled on a stage whose readiness is not `ready`, and says when the manager last confirmed it.

The database holds a `stages` table (the record, the passphrase in a column no list selects, the
token hash, the owner, and when each record was observed, received and retired), `stage_retirements`
for retirements of stages never stored, a single-row `catalogue_stamp`, and `streams.stage_id`.

### Writing the catalogue

The admin writes the catalogue through the catalogue stamp record's node and batch, read from its
own database on every write. My Streams warns when that batch has less than 48 hours left or is 90%
full (`CATALOGUE_FILL_WARNING_RATIO`), and the admin refuses to publish, with a clear error, when the
batch is expired or gone. The warning, the time left and the refusal are all aged from the reading's
`observedAt`: the API answers each batch reading with `remainingSeconds` and `expiredByClock` worked
out at request time, and the Stages page says "Expired by the clock" of a batch whose last reading's
time to live has run out.

`apps/web2-admin/backend/src/domain/CatalogueBatch.ts` holds the rules:

- The admin pins the batch its first write goes through (`catalogue_stamp.active_batch_id`, with the
  last record pushed for it), and keeps writing with it. When the manager designates another batch
  and the feed has a recorded write, the admin keeps the pinned one, at its node, and My Streams
  says a move is waiting. With no recorded write the designated batch is pinned in its place.
- Once the manager designates another batch, the pinned batch's readings are the last ones pushed
  while it was designated, and the ones a record's `previous` carries of it while the manager's move
  is pending. An expired or gone reading is a refusal, and so is a time to live that has run out since
  the reading, whatever the state says. A mutable batch is refused as well.
- A slot written without a recorded batch is counted on My Streams, which says a move is waiting.
- A publish, an unpublish or a reconcile is refused before it moves anything, as `503` with the
  reason: no designation, a cleared one, or a pinned batch that is expired, gone or mutable. A clear
  leaves the pin, so a designation that comes back finds the history where it was. The uploader's
  reports store their state first and are refused the same way when their rewrite comes, and the
  uploader retries a `503`. A failed write's reason never carries the catalogue node's address.
- Every write records the exact bytes it uploaded (`feed_writes.payload_text`) and the batch that
  stamped them (`feed_writes.batch_id`), so the history can be stamped again under a new batch.
- The boot's feed check reads the head through the catalogue node, so an admin started with no
  designation skips it and runs it once the first designation arrives.

## The manager's side

- **The stage publisher.** For every deployment that runs a stream uploader and whose effective
  `ADMIN_API_URL` is on the origin of the manager's admin link, the manager builds the stage record
  and pushes it to the link's address with the link's token. It pushes when the deployment changes,
  every 30 seconds while it runs (`STAGE_PUSH_INTERVAL_MS`), and before a deploy starts its uploader,
  so the uploader's first call finds its token known.
- **Retirements.** A deleted deployment is retired the same way, by its `instance_id` and the
  moment of deletion. The retirement is written into the manager's database with the deletion and
  sent again every 30 seconds, and when the manager starts, until the admin answers it.
- **The client.** Every push is bounded like the Test connection probe: http and https alone, no
  redirects, a 5 second timeout, a small answer read, and an outcome code, never what the far end
  said, in the log and on the deployment page. Every push carries the registrar token, each stage's
  SRT passphrase and its token hash, so the link is https in production, which the edge provides.
  The manager takes plain http only to its own host: a loopback address, `host.docker.internal` or
  the bridge address it resolves to, or a name that resolves into a Docker network of its container.
  It refuses to save any other plain http address, and sends nothing to one saved earlier, which
  shows as `refused-plain-http`, unless `ADMIN_LINK_ALLOW_PLAIN_HTTP=true` is set for a test setup.
- **The moments it stamps.** The admin orders everything by them, so they must be true. A record's
  `observedAt` is the moment the manager read the deployment row, stamped before the slower readings
  (stamps, chequebooks, the uploader's health), so a record that takes seconds to build never claims
  a moment later than a deletion that happened meanwhile. A retirement carries the moment the row
  was deleted, and a catalogue clear the moment the designation was removed, never when the call is
  sent or retried. A retry resends the same moments.
- **The public ingest address.** A setting per deployment, defaulting to the host address the
  manager resolved for it. The address ssh dials can be a private one, and an encoder has to reach
  this one.
- **Uploader tokens.** The manager generates an `ADMIN_API_TOKEN` of 64 hex characters for every
  deployment that stores none, and the stage record carries its sha256. A save or a create that
  leaves a typed `ADMIN_API_TOKEN` at an address on the origin of the manager's link, while the link
  stores a token, is refused (`typedTokenAtLinkProblem` in `apps/infra-manager/common/src/adminLink.ts`).
  Clearing the token, or resetting it to the version's, takes it, and the first deploy then
  generates one of its own. No create copies the link's token.
- **The rung readings.** A pool's rungs are read on the deployments of this manager that stamp with
  each rung's batch. A rung under another manager has no reading.
- **The catalogue node.** A Bee-only deployment designated as the brand's catalogue node on the
  Manager settings page, next to the admin link, with its batch pinned by id. The manager refuses a
  mutable batch, one whose kind the node did not report, and a new batch shallower than depth 18
  (`MIN_CATALOGUE_DEPTH`): an immutable batch refuses a chunk whose bucket is full, and a slot is
  written again at the same address, so the first slot refused freezes the catalogue for every stage.
  Buying or using another batch on that node leaves the catalogue on the pinned one, and the page
  says so. Once a batch has been designated, the manager takes another only as a move. A clear keeps
  the node and the batch recorded. The node cannot be removed, and a pool string that names its
  batch or its Bee API is refused on create and update.
- **The stages in the manager's console.** `GET /stages`, behind the session like every other route,
  and `GET /stages/:name/registration`, the last push of one deployment, which the deployment page
  reads. The Stages page, beside Deployments in the navigation, reads `GET /stages` every 30 seconds,
  one row per stage with its readiness, owner, ingest, token kind and last push, or the reason its
  record could not be built. `apps/infra-manager/docs/features/stages.md` is the manager's page.

One admin link per manager. Stages whose `ADMIN_API_URL` is on another origin are not pushed, and
the deployment page says so. Such a stage's uploader is refused by the admin it names, since the
admin takes a stage's own token alone and learns it only from the manager linked to it.

## The uploader's side

The uploader's boot check, `assertAdminSignsAsThisService` in
`apps/hls-stream/packages/stream-uploader/src/libs/AdminOwnerCheck.ts`, asks the admin
`GET /api/internal/stages/self` with its own token and compares its signer with the owner the admin
names. A mismatch refuses to start, naming both addresses and saying to fix the deployment's
`STREAM_KEY` in the manager or the stage the admin holds. When the admin answers 404 there, the
uploader compares with the owner of the admin's public `/api/config` instead, and a refusal then says
to give the deployment a token of its own. A stage read that fails any other way only warns.

An uploader on any token but its own is answered 401, which it logs as an owner it could not
confirm, and every lookup and report it makes is refused the same way until its token is rotated.
The per-stream owner check holds too: a stream's declaration names its stage's owner, and a stream
of another stage is refused at the gate.

## A key per stage

- **In the admin.** A stream's `owner` is its stage's, lower case and without `0x`. It is set when
  the stream is created on a stage and whenever its stage is set or changed, which only a draft
  allows. The publish of a draft that holds no recording reads the owner from the stage again in the
  same statement, so a key rotated in the manager, which is pushed as a new `owner`, is what the
  entry names. A row that holds a recording never changes owner: publishing one whose stage now
  signs as another address is refused, `409 feed_owner_mismatch`, "the recording was made under
  another key". A stream already on the catalogue keeps the owner publishing fixed, and so does a
  state report's write.
- **The brand key.** The catalogue is signed by `FEED_PRIVATE_KEY` alone, and `/api/config` names
  that address for the viewer build. A reconcile, and the boot's dry run of it, count as the admin's
  every entry whose owner is the brand key's or any stage's the admin holds, retired stages
  included, and the owner of every row on the catalogue. A stream published under a key its stage
  signed with before a rotation is still rebuilt under that key.
- **A failed publish.** Publishing a draft whose last publish failed first takes off any entry of
  the admin's for its topic under another owner, so a failure and a rotation cannot list the stream
  twice.
- **In the manager.** Test connection on a deployment asks `stages/self` with the deployment's token
  wherever there is a stream address to compare, and asks `/api/config` only on its 404. The
  wizard's test of a token of its own compares no owner, since the admin learns the stage's address
  at the first deploy. Test connection on Manager settings proves the stored token on the registrar
  check: 204 is `token-accepted`, the admin's own 401 `token-refused`.
- **A rotated key.** The manager pushes the stage's new owner as soon as the key changes, before the
  uploader is redeployed with it. A draft published in that window names the new owner while the
  running uploader still signs with the old key, so the gate refuses its broadcast until the uploader
  is redeployed. Redeploy a stage right after rotating its key. A stream that was published, and not
  yet live, when its stage's key was rotated keeps the old owner until it is unpublished and
  published again, and its broadcast is refused at the gate until then.

## Moving the catalogue to another batch

A top-up keeps the batch id and extends the life of every chunk it stamped, the history included.
Nothing changes in the admin but the readings. Moving to another batch means stamping the history
again: the admin rewrites every slot of the feed, in order, with the exact bytes it recorded, under
the new batch, then every thumbnail a stream names, published or not, and every one the latest entry
names, and then writes with the new batch. bee-js puts a payload straight into the feed's chunk with
no timestamp, so the same bytes make the same chunks at the same addresses. The job is resumable and
runs while the old batch still has days of life.

The move is off by default. `CATALOGUE_MOVE_ENABLED=true` in the admin's env file turns it on, and it
stays off on an installation until the move has been tried on a real node, by
[Trying the move on a real node](#trying-the-move-on-a-real-node) below. Until then the Stages page
says the move is not enabled on this installation. The manager's move and release work with the
admin's move off: they change which batch is designated and which is guarded, and while a move is
pending the manager pushes the batch moved from as the record's `previous`, so the admin, which keeps
writing with it, keeps its readings fresh.

### In the manager

`CatalogueDesignationService` holds the rules, and `apps/infra-manager/docs/features/stages.md` is
the manager's page.

- Designating another batch than the pinned one is a move, saved only when the request says
  `move: true` (the card's "Move the catalogue to batch …", confirmed). The new batch passes every
  check a designation does. The row keeps the previous node and batch as "moving from", and the
  catalogue stamp record pushed is the new batch's, with the previous one as `previous`.
- While a move is pending, both nodes are guarded against removal, no pool string may name either
  batch or node, the previous batch is still read every ten seconds (`CATALOGUE_CHECK_MS`) for the
  card and for `previous`, a change in its readings is pushed, a third batch is refused until the
  previous one is released, and moving back to the previous batch swaps the two.
- **Release the previous batch**, `POST /manager-settings/catalogue-node/release`, behind the session
  and the same-site check, takes the previous batch out once the admin reports the move done, and
  only then does the guard lift. It is logged with the user and recorded in the row. The manager
  cannot see the admin's progress, so the card lists the steps and asks before it releases.

### In the admin

`apps/web2-admin/backend/src/domain/CatalogueMove.ts` holds the rules, and the admin backend's
README has the detail.

- A move waits when the feed has history and either the pinned batch is not the designated one, or
  some slot is not under the designated batch by the admin's record, or the latest move to it has
  not finished. Nothing waits only when the pinned batch is the designated one and every slot is
  under it.
- For slots 0 to the head, in order, the job uploads each slot's single-owner chunk again under the
  new batch through the catalogue node. Where the slot's bytes are recorded, the chunk is built as
  the original write built it and signed again with the brand key. secp256k1 signing with RFC 6979
  nonces is deterministic, so the chunk is the one first uploaded, byte for byte.
  `test/unit/catalogueRestamp.test.ts` holds the job to the bytes bee-js's own write produced. A slot
  with no recorded bytes is read from the network through the catalogue node, checked against its
  address, and uploaded with its own signature. A payload over 4096 bytes has its content-addressed
  data uploaded again first. A slot already under the new batch is left as it is.
- Then every thumbnail a stream names, published or not, and every one the latest entry names, from
  `streams.thumbnail` where the row holds the bytes and otherwise from the network. One an entry
  names has to come out at the same reference. Each is recorded as under the new batch
  (`streams.thumbnail_batch_id`), and a publish uploads a thumbnail again whenever that batch is not
  the one it writes with. Then the admin pins the new batch and writes with it.
- It runs in slices of 20 slots (`MOVE_SLICE_SLOTS`) outside the publish lock, so publishing goes on
  with the pinned batch, and checks the designation between slices. The last step holds the lock:
  the slots written meanwhile, the thumbnails of the entry written last, and the switch, so no slot
  is left under the old batch alone.
- Progress is recorded after every slot (`catalogue_moves.next_index`, and
  `feed_writes.restamped_batch_id` and `restamped_at`), so a restart resumes a running move at boot
  and a shutdown pauses it. A failure stops with its reason, without the node's address, and the
  same start retries it from there.
- A start is refused when the move is off, there is no batch to move to or nothing to move, the
  designated batch is expired, gone or mutable, or the batch the catalogue is written with has lapsed
  while some slot has no recorded bytes. The network drops a chunk once its batch lapses, so those
  slots cannot be read any more, and the page says so.
- The start, the end and a failure are audited (`catalogue.move.start`, `.done`, `.failed`) and
  logged with batch ids shortened. The Stages page shows N of M slots while it runs, the reason when
  it failed, and, once done, that the previous batch can now be released in the manager.

### Trying the move on a real node

Do this once, before you turn `CATALOGUE_MOVE_ENABLED` on anywhere. Every unit and integration test
of the move uses a fake Bee, so only this proves it against a real node.

1. **Set up a scratch installation.** A testnet or scratch Bee node as a Bee-only deployment of a
   scratch manager, and a scratch admin with its own `FEED_PRIVATE_KEY` and `FEED_TOPIC`, so no
   brand's catalogue is touched. Buy two small immutable batches on the node, A and B, of depth 18 or
   more. Link the admin and designate the node with batch A.
2. **Make history.** Create a few streams, give some a thumbnail, and publish and unpublish them
   until the feed has a dozen slots or more. Make at least one catalogue longer than 4096 bytes (a
   long description on several published streams does it), so a wrapped slot is in the history.
   Open the viewer built for the scratch feed and note what it lists.
3. **Move.** In the manager, choose batch B on the catalogue node's card and confirm the move. In
   the admin's env file set `CATALOGUE_MOVE_ENABLED=true` and restart the admin. On the Stages page,
   choose "Move the catalogue to batch B…", confirm, and publish a stream while it runs. Wait for
   "The catalogue was moved to batch B".
4. **Check each slot under B.** For every index from 0 to the head, `GET /chunks/<slot address>` on
   the node answers the same bytes as before the move, and `GET /stamps/<B>` shows its utilisation
   grown by about the number of slots and data chunks. The admin's log has one
   `Restamped feed index=` line per slot, and none failed. A slot's address is
   keccak256(identifier, owner), and the `ref=` of each `Wrote feed index=` line in the log is it.
5. **Check the viewer.** Dilute batch A or let it lapse (on a testnet, a batch bought with the
   smallest amount lapses in hours), or point the viewer at a node that never held A's chunks. The
   viewer still lists every entry it listed in step 2, with its thumbnail, and the stream published
   during the move.
6. **Release.** Press "Release the previous batch" in the manager, and remove batch A's node if it
   was another deployment.

If every step holds, the move can be turned on where it is needed. If a slot or a thumbnail came out
at another reference, the move stops before the switch, the admin keeps writing with A, and the log
and the Stages page say which.
