# Roadmap

Checkpoints are the unit of work. Each one ends with something verifiable and a
short note here on what was decided.

## Checkpoint 1: repo skeleton (done 2026-09-11)

- MIT license, copyright Solar Punk Ltd.
- pnpm workspace at the root, `web2-admin` as the first package.
- Design brief for the admin layer copied out of the interactive model.

## Checkpoint 2: first working slice (merged 2026-09-18, PRs 1 to 5)

Spec: docs/architecture/web2-admin-checkpoint-2.md. Decided: same stack as
streaming-infra-manager, packages `web2-admin/{common,backend,frontend}`,
scope `@streaming-monorepo/`.

- Authentication with a seeded admin user and password change in the UI.
- Stream drafts in Postgres with the msrs-client form fields.
- Publish a draft to a stream list feed the backend owns (single writer).
- OBS connection details per stream: SRT URL carrying a per-stream `key=`, the
  server-wide SRT passphrase shown alongside. The RTMP server and stream key were
  shown only where the deployment opened RTMP ingest (`INGEST_RTMP_PUBLIC`), which
  was off by default, since ingest was SRT only then. That key left the admin's
  env with phase 4 of the stages work. RTMP stays closed by default, so the
  admin offers SRT alone, as the RTMP section below says.
- A real stream for a draft: the uploader (swarm-hls-stream `main-v3`) resolves
  the draft by ingest stream id through the admin's internal API, checks the
  key, publishes under the draft's topic and reports live and vod; the admin
  API stays the only writer of the stream list feed. Done on both sides
  (uploader on branch `feat/catalogue-thumbnails` in swarm-hls-stream) and
  run end to end on 2026-09-13: OBS to local SRS to the uploader to Swarm,
  console flipped to Live, viewer played it.

Lesson from that run: when the postage batch expired, the catalogue feed lost
indexes 3 to 5 and Bee's lookup stopped at 2, hiding the live entry at 6. The
backend now takes the index and the base payload from its own `feed_writes`
rows rather than from a Bee lookup. Still open: warn in the console when the
batch is near expiry.

Verified 2026-09-11 with the real backend on Postgres and the real frontend in
a browser: login, create, edit with tags, publish (feed index 0), republish
with thumbnail (index 1, reference recorded), rotate key, unpublish (index 2,
empty list), password change signing out other sessions, logout. The Bee
gateway ran in `fake` mode; the bee-js integration test is skipped until
`BEE_URL` and `POSTAGE_BATCH_ID` (`ITEST_BEE_URL` and `ITEST_BATCH_ID` since
phase 7 of stages) point at a real node. Docker image builds are unverified on
this machine (no registry access).

Real-Swarm test, same day: a colleague pointed the backend at their Bee node,
published two streams with thumbnails, and deployed a viewer built for the feed
owner. Two defects came out of it. Publish reused a thumbnail reference minted
by the fake gateway, so the real feed pointed at an image the node never had;
publish now verifies a stored reference on the gateway before reusing it and
re-uploads a missing one. The viewer ignored the catalogue's `thumbnail` field
and probed each stream's manifest feed, which does not exist before the first
segment; fixed on swarm-hls-stream branch `feat/catalogue-thumbnails` off
`main-v3` (cards render the catalogue thumbnail, scheduled streams show
"Upcoming", the watch page says the stream has not started). The viewer must be
rebuilt from that branch. The player link in the console now opens the viewer
catalogue, not the per-stream route, for the same reason.

Decided 2026-09-15, ABR ladder in admin mode (spec: the "ABR ladder in admin
mode" section of docs/architecture/web2-admin-checkpoint-2.md). The declared
topic becomes the master playlist's feed, so the group id the uploader used to
mint at random is now the stream's own topic and every existing player link
keeps working; a rung feed's topic is derived from that topic and the rung
name, so it is the same feed every session. The ladder's merge state
moves out of the catalogue feed and into the admin's database — migration 004
`stream_renditions`, `POST /api/internal/streams/:id/renditions`, one record
per rung — because in admin mode the uploader writes no catalogue to merge
into. The admin merges each report — a finished rung keeps its index when it
reports again without one, which is that rung delivering onto the feed it was
already writing, so the recording it closed last stays addressable until its
next final report replaces it, while a report naming some other feed is taken
as it arrived — then writes `renditions` and `group` onto the entry and answers
with the merged ladder the uploader builds its master from. A broadcast that
goes live again un-finishes the row and every rung with it, so an encoder
reconnecting after a finished broadcast does not leave the master pointing at
the previous recording. Status is otherwise untouched by these reports: `live`
and `vod` still come from the state route, and a `vod` for a ladder carries the
**master's** feed index, not a rung's.
Admin side done on `feat/web2admin-abr`; the uploader half is the same branch
name in swarm-hls-stream.

## Operator authentication (2026-09-18)

streaming-infra-manager grew a full auth stack on its `main-v2` line, and this
repo now runs a port of it rather than a second design. Spec:
[web2-admin-auth.md](architecture/web2-admin-auth.md).

- scrypt at the manager's cost, a password policy, and a decoy hash so an
  unknown username costs the same as a real one.
- No seeded account. The first user is created on the host with
  `pnpm user:add`, and is an admin because somebody has to make the second.
- Users, an admin role, add, remove and sign-out-everywhere, refusing to
  remove the last user or the last admin.
- Sessions on two clocks, idle and absolute, with a daily sweep.
- A login limiter keyed on the username, the client address and the
  password-change path, counting attempts before the hash rather than after,
  with nginx refusing a flood in front of it.
- A cross-site check on every write. `/api/internal` is mounted ahead of it,
  because the uploader is a machine caller with no Origin and no header.

Not ported: the manager's `OpenStreams` and stream revalidator, which exist to
kill live server-sent event connections on revoke and expiry. This service has
no SSE, so nothing outlives its request.

## Deploy script (2026-09-23)

`deploy/deploy.sh` with host parameters lands, with its own production compose
file (`deploy/docker-compose.yml`) and [deploy/README.md](../apps/web2-admin/deploy/README.md).
Manager-driven deploy is next.

- The grammar is swarm-hls-stream's (`--host`, `--profile`, `--portSlot`,
  services), because the manager already runs that stack's script that way,
  with standard input closed. `--host` is required; `localhost` deploys on the
  machine running the script.
- One checkout per host, one compose project per profile
  (`web2-admin-<profile>`), one env file per profile in `web2-admin/backend/`,
  as the manager keeps its profiles. Only the deploying profile's env file is
  synced, so one laptop cannot delete another profile's.
- Console port with a slot: `11009 + N*10`, slots 1 to 99. The stack owns every
  digit of 10000 to 10009 (10009 is its SRS HTTP API) and digits 1 to 6 of the
  1100x block, so digit 9 there collides with no stack service at any slot.
  Without a slot, `WEB2_ADMIN_WEB_PORT` or 9090.
- The env file is checked for the keys the API refuses to start without before
  anything leaves the machine; sample values warn.

Verified 2026-09-23 with `--host=localhost` on a laptop: build, migrations,
health through nginx, `user:add`, sign-in through nginx on the slot port, a
service-scoped redeploy, and a crash-looping API caught by the health timeout.
Deployed to a server on 2026-09-24 at the first try. On another host the
tunnel connected but nothing answered: a persisted firewall there accepted
Docker's default bridge range and not the custom address pool its daemon hands
out. A host matter, written up in the README. Nothing in this repo changes for
it. The 2026-09-23 run found two defects that had never
been hit because the images had never been built: the backend image's
`pnpm deploy` fails under pnpm 10 (now `--legacy`), and nginx forwarded `Host`
without the port, so the API's cross-site check refused every write, sign-in
included, on any port but 80 (now `$http_host`, as in the manager).

## Shared HTTPS edge (2026-09-24)

`deploy/edge.sh` and `deploy/edge/`: one Caddy per host, its own compose
project (`edge`) on the host's network, serving each console the host
publishes on its loopback under its own name, web2-admin's on 9090 and
streaming-infra-manager's on 8080. See "Public HTTPS: the host's edge" in
[deploy/README.md](../apps/web2-admin/deploy/README.md).

- Decided: one edge per host, not one per compose project. Ports 80 and 443
  belong to one process per host, so the per-project edge on the
  `deploy-edge-wip` branch could not coexist with a second profile's or the
  manager's own `public` edge. That branch is abandoned. On a host that runs
  this edge, the manager's `MANAGER_DOMAIN` stays empty and its name goes in
  `deploy/edge/.env` instead.
- The names are per deployment and live in the gitignored
  `deploy/edge/.env`. Either site is optional, at least one is required, and
  the Caddyfile is rendered from the file, one site per name set, because
  Caddy cannot take an empty site address.
- `deploy.sh` now leaves `deploy/edge/` out of its rsync, so a web2-admin
  deploy can never delete or replace the rendered Caddyfile on the host.
- Caddy's admin API is off, since on the host's network it would listen on the
  host's loopback, and every run recreates the container so the new Caddyfile
  is read; the certificates survive in the volumes.

Verified locally on 2026-09-24, with no host involved: the Caddyfile for both
names, for each alone, and from a CRLF env file, all accepted by `caddy
validate` in the pinned image; `docker compose config`; every refusal before
ssh; the generated host script's paths (a conflicting container or listener on
80/443, a crash-looping Caddy, a console that refuses, times out or drops the
connection) against stubbed docker, curl and ss; the certificate probe's
reports against stubbed curl and dig; and deploy.sh's rsync filter in dry runs
with macOS openrsync, GNU rsync 3.5, and the two together. Not yet run against
a real host, DNS or Let's Encrypt. First real host (2026-09-24): its ports 80
and 443 already belong to a production nginx, so the console goes behind that
server as one more name; the README's "A host that already has a web server"
section is the recipe, and edge.sh stays for hosts with no front door yet.

First real run on a control host: both consoles deployed to loopback (the
manager on 8080, the admin on another port because something else already held
9090 there), then `edge.sh --host=<control host>` twice, first with the
manager's name alone, then with both. Each run validated the Caddyfile,
recreated Caddy, proved both upstreams from the host, and saw valid
certificates from outside within the probe window. The certificate obtained in
the first run survived the second in the volume, as designed. What the host
needed besides: tcp 80 and 443 open from the internet, and the manager's
address and deploy key admitted on the stage and Bee hosts.

Since then the edge's sources live in `infra/edge/`, and the manager's own
edge is gone: `infra/edge` is the one edge on every host, a host that runs the
manager alone included, and the manager's domain goes in its env file like the
admin's. [self-hosting.md](self-hosting.md) has the recipe.

## Ingest panel and unpublish (2026-09-26)

Decided by the owner after a tester could not go live on the test host on
2026-09-25. Nothing there was broken: every SRT attempt carried no passphrase,
because the panel sent OBS users to an "OBS Passphrase field" that OBS does
not have.

- The OBS panel says, for SRT and, where it is offered, for RTMP, what goes
  in OBS's Server box and its Stream Key box. For SRT the passphrase rides on the Server
  line as `&passphrase=`, which OBS reads after its Use authentication Password
  and so wins, and the Stream Key stays empty, because OBS hands that box to
  SRT as the stream id and the URL's own `streamid=` replaces it. OBS ends a
  value on that line at `&`, turns `+` into a space and never percent-decodes,
  so a passphrase outside RFC 3986's unreserved characters goes in the Use
  authentication Password instead, which OBS 29.1 and later hands to SRT. All
  of it read from OBS 31's source.
- Unpublish keeps the recording. It still takes the entry off the catalogue
  and puts the stream back to draft, but the row keeps where the recording is,
  how long it runs, when it was live and its ABR rungs, where it used to wipe
  them and leave a republish announcing a stream that had not started.
  Publishing a draft that holds a recording lists it as that recording (`vod`,
  with its index, duration and ladder). No database constraint ties those
  columns to a status, so nothing in the schema changed.

## Streams belong to the installation; actor logging and audit log (2026-09-28)

Decided with the owner. A stream is the installation's, not the drafter's:
every signed-in operator lists, edits, publishes, unpublishes and deletes
every stream, and `streams.user_id` only records who drafted the row. No
query in the backend scopes by user any more (sessions aside). Brand
separation is not this; it stays an open decision below.

With every operator able to act on every stream, who did what has to be
recorded somewhere else:

- Every mutation logs a line naming the actor first, the way the manager's
  lines do:
  `[Publish] alice published "Opening keynote" (topic …): draft → published at feed index 12 (3 entries)`.
  Most are info; a reconcile that wrote and the boot repair warn, and failures
  are errors. The actor is the signed-in operator, `the uploader` for the
  internal API (the services say so themselves; the route has no session to
  name anyone by) or `system (boot)` / `system (cli)`.
- Migration 007 adds `audit_log`, one row per mutation: actor, dotted action,
  stream id and topic (no foreign key, so a deleted stream keeps its
  history), status before and after, and a JSON `details`. Failed publishes
  and unpublishes are recorded with the reason; refusals are not. A failed
  audit write is logged and never fails the operation, which has already
  happened. Read with `psql` for now; the backend README has the queries.

Migration 008 follows from the same decision: `streams.user_id` was
`ON DELETE CASCADE`, so removing a user deleted every stream they had drafted,
published and live ones included, and left their entries on the catalogue. It
is nullable now and set to null instead; the `stream.create` audit row keeps
the drafter's username for every stream created since migration 007. Nothing
is backfilled for older streams: decided with the owner, since the
installations start from a new database.

Verified 2026-09-28 with the unit and integration suites, nothing deployed:
each service's audit entries, a failed audit write, the actor on the routes
(the unit suite checks create, publish, reconcile and the user routes; the
integration suite's audit query checks the other stream writes), a second
operator through a whole stream lifecycle, the Postgres audit writer, and a
removed user's streams kept with `user_id` set to null. Migrations 007 and 008
also applied cleanly by hand over a database at 006 seeded with users, a
session and draft, published and live streams.

## Stages from the manager (decided 2026-09-28, built on `feat/stages`)

Spec: [stages.md](architecture/stages.md). Decided with the owner: the admin
stops carrying one stage in its env file and learns every stage from the
manager.

- The manager pushes a record per stage into the admin over the admin link it
  already holds. The admin never calls the manager, so the manager grows no
  machine login, and the admin keeps what it was told in its own database.
- One catalogue per brand, signed by the brand key. A stream's stage is picked
  per stream and fixed at publish.
- Every stage signs with its own key and presents its own token. The admin
  answers a token only about its own stage's streams.
- The catalogue has a batch of its own, immutable, on a dedicated catalogue
  node, pinned by id. It never shares a batch a rung stamps segments with.
- The admin reads stamps and chequebooks; spending stays in the manager.

Built in nine phases, each a pull request into `feat/stages`: phases 1 to 8
merged there on 2026-09-28, and the fix and phase 9 below opened for review on
2026-09-29. Nothing has been deployed; the feature branch goes to `main` once
the owner has tried it whole.

- Phase 1, the brief and the records (#56, 2026-09-28): the spec, this entry,
  and the stage and catalogue stamp records as zod schemas in
  `packages/contracts`.
- Phase 2, the admin takes stage records (#57, 2026-09-28): the manager's
  routes under `/api/internal` on the registrar token, the ordering by the
  manager's `observedAt`, retirements and their tombstones, and a Stages page
  in the console.
- Phase 3, the manager pushes stage records (#58, 2026-09-28): the stage
  publisher, on a change, every 30 seconds and before a deploy starts its
  uploader, with the manager's readiness verdict, and a public ingest address
  per deployment.
- Phase 4, a stage per stream (#59, 2026-09-28): a stream's stage is picked in
  the stream form from the stages that are not retired and run SRS, fixed at
  publish and kept by a stream that holds a recording, and a draft with none
  is refused at publish. My Streams has a Stage column and filter, the OBS
  panel is built from the stage, and `INGEST_HOST`, the ingest ports,
  `INGEST_RTMP_PUBLIC`, `INGEST_SRT_PASSPHRASE` and `INGEST_KEY_VERIFIED`
  leave the admin's env: every uploader that takes streams from the admin
  verifies the per-stream `key=`, so the console no longer warns that it
  might not.
- Phase 5, a token per uploader (#60, 2026-09-28): the manager generates an
  `ADMIN_API_TOKEN` of its own for every uploader linked to its admin and
  pushes its sha256, and the admin answers that token only about its stage's
  streams. The shared token was still taken while the stages moved over.
- Phase 6, a key per stage (#62, 2026-09-28): a stream's owner is its stage's,
  read again at the publish claim of a draft with no recording, and a
  recording keeps the owner it was made under. The brand key signs the
  catalogue alone. The uploader's boot check and the manager's Test
  connection compare with the owner the admin knows for the token's stage.
- Phase 7, the catalogue node (#61, 2026-09-28): the manager designates a
  Bee-only deployment and an immutable batch on it as the brand's catalogue
  stamp and guards both; the admin writes the catalogue through them, pins
  the batch of its first write and records the exact bytes of every write.
  `BEE_URL` and `POSTAGE_BATCH_ID` leave the admin's env.
- Phase 8, moving the catalogue to another batch (#63, 2026-09-28): the
  manager designates another batch as a move and keeps guarding the previous
  one until the operator releases it; the admin stamps every slot again under
  the new batch, byte for byte, then every stored thumbnail, then writes with
  it. Decided: `CATALOGUE_MOVE_ENABLED` stays off on every installation until
  the owner has tried the move on a real node, by the procedure in the spec.
- A fix between them (#64, 2026-09-29): the manager's admin-link browser test
  follows the per-stage owner wording phase 6 gave Test connection.
- Phase 9, the shared token stops (#65, 2026-09-29): the admin's uploader
  routes take a stage's own token alone, so `INTERNAL_API_TOKEN` is the
  registrar credential only and a stage still on another token is refused
  until it is rotated in the manager. `GET /api/internal/registrar` proves the
  manager's stored token, and its Manager settings Test connection uses it.
  `use_manager_admin_token` is gone, and these pages close checkpoint 3.
- Review of the pull request into `main` (#74, 2026-10-02): three reviews and
  a review table, answered in #76 to #81 on `fix/stages--review-fixes`.
  Decided: the admin's deploy script refuses the sample brand key and
  registrar token unless it is given `--allow-sample-secrets`; a new
  catalogue batch must be depth 18 or more, the batch already pinned and a
  move back to it excepted, and warnings for a shallow batch come later; a
  deploy on the manager's own Linux host binds every empty Bee API bind to the
  Docker bridge address, and the catalogue node card warns when Docker shows
  the node's API on every address; the manager sends the web2 admin plain
  http only on its own host, unless `ADMIN_LINK_ALLOW_PLAIN_HTTP=true`; a
  removed stage's retirement waits in the table migration 049 adds,
  `pending_stage_retirements`, and is sent again until the admin answers it.

Left open after the nine phases:

- **The catalogue move** is built and off until the owner's trial on a real
  node, whose date goes here.
- **The upgrade, scripted.** The rollout below is six manual steps in a fixed
  order; a script with a check after each step comes before the QA control
  host or the pilot is upgraded.
- **Pending retirements** show only in the manager's log; the Stages page
  could count them.
- **Top-ups from the admin.** The admin reads every rung's stamp and
  chequebook and the catalogue batch; buying, topping up and funding stay in
  the manager's console until this is decided.
- **Brand separation** inside one admin, and a second admin link per manager
  for a second brand, among the open decisions below.
- **Rollout**, decided 2026-09-29, for a host that runs the admin and
  manager from before stages: the catalogue node created; the manager that
  pushes stage records (phase 9), with the node designated at once; the
  intermediate admin, the phase 8 state of `feat/stages` (commit `d29616851`;
  tag it `web2-admin/stages-intermediate` before `feat/stages` is merged to
  `main`, because a squash or rebase merge leaves that commit unreachable);
  every scheduled stream unpublished, given a stage and published again, and
  every draft given a stage; every stage rotated and redeployed until the
  admin's Stages page reads "Its own token" for all; the admin that refuses
  the shared token (phase 9); then a `STREAM_KEY` of its own for each stage.
  Until the catalogue is moved, the batch from before stages holds every slot
  written before the intermediate admin: it stays topped up and alive, is
  never diluted, replaced or put in a pool string, and the move runs first
  after the real-node trial. That is the one remaining way the catalogue can
  go dark. "Upgrading" in `docs/self-hosting.md` has each step. A fresh
  installation needs none of this.

## Checkpoint 3: manager integration (built on `feat/stages`, 2026-09-29)

- Manager deploys swarm-hls-stream from `main-v3`.
- Derive ingest host and ports from a manager profile (`10001 + slot*10`
  etc.) instead of env; provision and stop through the Manager API. Done as
  [stages](architecture/stages.md): the manager pushes each stage's public
  ingest address, ports and passphrase, the admin's env carries no stage, and
  a stream's OBS panel comes from its stage. Nothing is provisioned from the
  admin: deployments are made and stopped in the manager's console.
- Stamp top-up and cheque balance read-through. The read-through is done:
  every stage record carries its rungs' stamps and chequebooks and the
  manager's readiness verdict, and the catalogue stamp record the catalogue
  batch's. Top-ups from the admin are not built and stay an open decision.
- Decide how the admin layer authenticates to the manager once they are on
  different hosts. Decided 2026-09-28: it does not, because the manager
  pushes, on the admin's registrar token, and every uploader presents a token
  of its own (done in phases 5 and 9).

## RTMP ingest, closed by default (2026-10-03)

First decided: RTMP ingest at the same level as SRT, as plain RTMP. Reviewed
the same day and decided again: **RTMP is off by default, and SRT is the
ingest broadcasters use.** The owner of the first decision should confirm the
second.

Why it was reversed:

- **Open RTMP lets anyone watch.** SRS lets anyone who reaches its RTMP port
  play any stream it holds, and the publish key guards publishing only. The
  stack's rule that allows play from loopback alone is new, and it runs only on
  SRS image `6.0-r2-swarm.3`, which is not built yet. Every stage that can run
  today would let anyone play every live broadcast with no key.
- **Open RTMP makes the SRT passphrase no gate.** SRT sends its stream id, key
  included, before encryption starts. While RTMP is open, a key read off an SRT
  connection publishes over RTMP with no passphrase, and with the takeover on,
  which it is wherever keys are checked, replaces a live broadcast.

What holds now:

- The manager's port policy opens no RTMP band, as its version 3. Version 2
  opened one, and the generator refuses an inventory export checked against
  version 1 or 2, so a host's table is replaced from a manager and a checkout
  of the same release.
- A stage record says `rtmpPublic: false` for every stage, so neither the
  admin's OBS panel nor the manager's Publish card offers RTMP.
- The stack keeps everything it gained for RTMP: SRS's RTMP listener, which the
  ABR ladder republishes to over loopback, the health check covering it, the
  RTMP takeover and loopback-only play. Nothing outside reaches it while the
  firewall keeps the port closed.
- The shared RTMP warning says that SRT's passphrase keeps the picture private
  but not the key while RTMP is open, for any stage where it ever is.
- Before RTMP is opened on any stage, that stage has to run a stack whose SRS
  allows play from loopback only, on an image that accepts the stack's config.
  A per-stage way to open RTMP is left for later.

## Checkpoint 4: brand console

- Login (placeholder until the auth decision), stream list, create stream,
  stamp and cheque views, branding editor.

## Checkpoint 5: branding to the player

- Branding writes the brand config the Viewer SPA bootstrap reads: theme,
  logo, stream list, gateway list, domain.

## Open decisions (blocking the second brand, not the first)

- Authentication and ownership: OIDC, wallet signature, or magic link.
- Manager API authentication and per-brand attribution.
- Brand separation inside one admin: which brand a stage and a stream belong
  to, and a second admin link per manager. Top-ups from the admin, which
  today reads stamps and chequebooks and leaves spending to the manager.
- Chat placement (SPA question; only lands here if a websocket wins).
