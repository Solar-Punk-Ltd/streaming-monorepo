# Stages: the admin learns them from the manager

This page is the design for turning the web2 admin from a console tied to one stage into one that
serves every stage the manager runs for the brand. It was decided with the owner on 2026-09-28,
after a second opinion that read the code of all three apps. The decisions are at the top; the
rest says what each part does and in which order it is built.

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

| Field                                    | What it is                                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                          | 1                                                                                                                                            |
| `stageId`                                | the deployment's `instance_id`                                                                                                               |
| `managerId`                              | the manager's own generated id, so two managers linked to one admin cannot collide                                                           |
| `name`, `kind`, `engine`, `stackVersion` | for display; `kind` is `abr-uploader` or `streamer`, `engine` `srs` or `ome`                                                                 |
| `status`                                 | the deployment's status as the manager reports it                                                                                            |
| `observedAt`                             | when the manager read what the record says; an older record never replaces a newer one                                                       |
| `ingest`                                 | `host` (the public address encoders dial), `srtPort`, `rtmpPort`, `rtmpPublic`, `srtPassphrase` (or null)                                    |
| `owner`                                  | the address of the stage's `STREAM_KEY`, never the key                                                                                       |
| `rungs[]`                                | per rung: its name, its stamp (`batchId`, `state`, `ttlSeconds`, `fillRatio`, `immutable`) and its chequebook's health; no node address      |
| `uploader`                               | the uploader's health reading, or null when it could not be read                                                                             |
| `readiness`                              | the manager's verdict (`ready`, `warning`, `blocked`, `unknown`) with its reasons, worked out in the manager and shown as it is              |
| `adminToken`                             | the sha256 of the token the deployment's uploader presents to the admin, and whether it is the deployment's `own` or the link's `shared` one |

**A catalogue stamp record**, pushed by the manager for the brand: the catalogue node's name, its
Bee API address as the control host reaches it, the pinned `batchId`, whether the batch is
`immutable`, its `depth`, its stamp `state`, `ttlSeconds` and `fillRatio`, when it was designated,
and `observedAt`.

Neither record ever carries a signing key, a wallet key, an RPC endpoint, a token or a rung's
node address.

## The admin's side

New routes under `/api/internal`, which is mounted ahead of the cross-site check and takes a
bearer token and no session:

| Route                                  | Who calls it | What it does                                                                                                            |
| -------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `PUT /api/internal/stages/:stageId`    | the manager  | stores a stage record, unless the stored one is newer; answers whether it stored it                                     |
| `DELETE /api/internal/stages/:stageId` | the manager  | retires the stage: its row stays, because streams and old catalogue entries name its owner, and it takes no new streams |
| `PUT /api/internal/catalogue-stamp`    | the manager  | stores the catalogue stamp record                                                                                       |
| `DELETE /api/internal/catalogue-stamp` | the manager  | clears it; the admin then refuses to publish, with a sentence saying why                                                |
| `GET /api/internal/stages/self`        | an uploader  | answers the stage its token belongs to, and the owner that stage signs as                                               |

The manager's routes take the **registrar token**: the admin's `INTERNAL_API_TOKEN`, which the
manager's admin link already stores. An uploader's routes take that uploader's own token, known
to the admin by its sha256 on the stage record. While the stages move over, the shared token is
still taken on an uploader's routes, as an unattributed caller; the last phase stops that.

The console gets `GET /api/stages`: every stage with its readiness and stamp readings and when
the manager last confirmed them, without the passphrase or the token hash.

In the database: a `stages` table (the record, the passphrase in a column no list selects, the
token hash, the owner, when it was observed and received, when it was retired), a single-row
`catalogue_stamp`, and `streams.stage_id`.

A stream's stage is picked in the stream form, is required before publish, and shows as a column
and a filter in My Streams. It can change while the stream is a draft. Publishing fixes it,
because the catalogue entry and every viewer link carry the stage's owner; to move a published
stream, unpublish it, change it, publish again. A stream that holds a recording keeps its stage,
since the recording lives under that stage's owner. The OBS panel shows the stream's stage's
ingest details. The admin warns before a stream is scheduled on a stage whose readiness is not
`ready`, and says when the manager last confirmed it.

The catalogue is written through the catalogue stamp record's node and batch, read from the
admin's own database on every write. The admin warns on My Streams when that batch has less than
48 hours left, and refuses to publish with a clear error when it is expired or gone. Every write
also records the exact bytes it uploaded, so the history can be stamped again under a new batch.

## The manager's side

- **The stage publisher.** For every deployment that runs a stream uploader and whose effective
  `ADMIN_API_URL` is on the origin of the manager's admin link, the manager builds the stage
  record and pushes it there with the link's stored token: when the deployment changes (its
  `profile.changed` event, coalesced per deployment), every 30 seconds while it runs, and before a
  deploy starts its uploader, so the uploader's first call finds its token known. A deleted
  deployment is retired the same way. The client is bounded like the Test connection probe:
  http and https alone, no redirects, five seconds, a small answer read, and an outcome code, never
  what the far end said, in the log and on the deployment page.
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
  own action.
- **A read of the stages** for the manager's own console, `GET /stages`, behind the session like
  every other route.

## The uploader's side

With one key per stage, the uploader's boot check asks the admin `GET /api/internal/stages/self`
with its own token and compares its signer with the owner the admin names. An admin that answers
404 there, or a caller still on the shared token, falls back to today's comparison with the
admin's public `/api/config`. The per-declaration owner check is unchanged: the declaration names
the stage's owner, and a stream of another stage is refused at the gate.

## Moving the catalogue to another batch

A top-up keeps the batch id and extends the life of every chunk it stamped, the history
included; nothing changes in the admin but the readings. Moving to another batch means stamping
the history again: the admin rewrites every slot of the feed, in order, with the exact bytes
it recorded, under the new batch, re-uploads the thumbnails the latest entry names, then writes
with the new batch. bee-js puts a payload straight into the feed's chunk with no timestamp, so
the same bytes make the same chunks at the same addresses. The job is resumable and runs while
the old batch still has days of life. Until it exists, the admin keeps writing with the batch it
has and says a move is waiting.

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
| 8   | Moving the catalogue to another batch                                                                                        | admin                      | M    |
| 9   | The shared token stops on an uploader's routes; the pages close checkpoint 3                                                 | manager, admin, docs       | S    |

Phases 2 to 5 reach a host together, because until phase 5 every uploader holds the token that
registers stages.

## Limits

- One admin link per manager: stages whose `ADMIN_API_URL` is on another origin are not pushed,
  and the deployment page says so. A second brand is a second link, not built here.
- The admin reaches the catalogue node's Bee API, which asks for no password, so the Bee host's
  firewall admits the control host. The dedicated node keeps that door to one node.
- Brand separation inside one admin, and top-ups from the admin, stay open decisions.
