# Roadmap

Checkpoints are the unit of work. Each one ends with something verifiable and a
short note here on what was decided.

## Already running (before this repo)

- ABR Bee nodes on Vultr (publishers and gateways).
- ABR uploader on the GCP stage host.
- Test infrastructure: streaming-infra-manager (master) deployed with the
  swarm-hls-stream player. A test stream plays on that host's client port
  (port slot 6). Host addresses stay out of this repo: any brand's viewer can
  live anywhere.

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
- OBS connection details per stream: SRT URL and RTMP server plus stream key
  carrying a per-stream `key=`, the server-wide SRT passphrase shown alongside.
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
`BEE_URL` and `POSTAGE_BATCH_ID` point at a real node. Docker image builds are
unverified on this machine (no registry access).

Real-Swarm test, same day: Nandor pointed the backend at his Bee node, published
two streams with thumbnails, and deployed a viewer built for the feed owner.
Two defects came out of it. Publish reused a thumbnail reference minted by the
fake gateway, so the real feed pointed at an image the node never had; publish
now verifies a stored reference on the gateway before reusing it and re-uploads
a missing one. The viewer ignored the catalogue's `thumbnail` field and probed
each stream's manifest feed, which does not exist before the first segment;
fixed on swarm-hls-stream branch `feat/catalogue-thumbnails` off `main-v3`
(cards render the catalogue thumbnail, scheduled streams show "Upcoming", the
watch page says the stream has not started). The viewer must be rebuilt from
that branch. The player link in the console now opens the viewer catalogue,
not the per-stream route, for the same reason.

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
file (`deploy/docker-compose.yml`) and [deploy/README.md](../deploy/README.md).
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
Deployed to a team server on 2026-09-24 at the first try. On the dev host the
tunnel connected but nothing answered: that host's persisted firewall accepts
Docker's original 172.x bridges and not the 10.200.x pool its daemon.json has
handed out since June, and the manager works there only because its network
predates the pool. A host matter, written up in the README; nothing in this
repo changes for it. The 2026-09-23 run found two defects that had never
been hit because the images had never been built: the backend image's
`pnpm deploy` fails under pnpm 10 (now `--legacy`), and nginx forwarded `Host`
without the port, so the API's cross-site check refused every write, sign-in
included, on any port but 80 (now `$http_host`, as in the manager).

## Shared HTTPS edge (2026-09-24)

`deploy/edge.sh` and `deploy/edge/`: one Caddy per host, its own compose
project (`edge`) on the host's network, serving each console the host
publishes on its loopback under its own name, web2-admin's on 9090 and
streaming-infra-manager's on 8080. See "Public HTTPS: the host's edge" in
[deploy/README.md](../deploy/README.md).

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

First real run, 2026-09-25, on the GCP QA control host (the monitoring VM): both
consoles deployed to loopback (manager 8080, web2-admin profile `qa` on 9091,
because Prometheus has 9090 there), then `edge.sh --host=monitoring` twice, first
with the manager's name alone while the admin name still pointed elsewhere, then
with both. Each run validated the Caddyfile, recreated Caddy, proved both
upstreams from the host, and saw valid certificates from outside within the
probe window; the certificate obtained in the first run survived the second in
the volume, as designed. What it took in Terraform: one firewall rule (tcp 80
and 443 from the internet to the host's tag), the manager's address and deploy
key in both roots' tfvars in place of the Hetzner host's, and a re-run of the
Bee host's provisioning so the new key landed there.

## Ingest panel and unpublish (2026-09-26)

Decided by Levi after a tester could not go live on the test host on
2026-09-25. Nothing there was broken: every SRT attempt carried no passphrase,
because the panel sent OBS users to an "OBS Passphrase field" that OBS does
not have.

- The OBS panel says, for SRT and for RTMP separately, what goes in OBS's
  Server box and its Stream Key box. For SRT the passphrase rides on the Server
  line as `&passphrase=`, which OBS reads after its Use authentication Password
  and so wins, and the Stream Key stays empty, because OBS hands that box to
  SRT as the stream id and the URL's own `streamid=` replaces it. OBS ends a
  value on that line at `&`, turns `+` into a space and never percent-decodes,
  so a passphrase outside RFC 3986's unreserved characters goes in the Use
  authentication Password instead, which OBS 29.1 and later hands to SRT. All
  of it read from OBS 31's source.

## Checkpoint 3: manager integration

- Manager deploys swarm-hls-stream from `main-v3`.
- Derive ingest host and ports from a manager profile (`10001 + slot*10`
  etc.) instead of env; provision and stop through the Manager API.
- Stamp top-up and cheque balance read-through.
- Decide how the admin layer authenticates to the manager once they are on
  different hosts.

## Checkpoint 4: brand console

- Login (placeholder until the auth decision), stream list, create stream,
  stamp and cheque views, branding editor.

## Checkpoint 5: branding to the player

- Branding writes the brand config the Viewer SPA bootstrap reads: theme,
  logo, stream list, gateway list, domain.

## Open decisions (blocking the second brand, not the first)

- Authentication and ownership: OIDC, wallet signature, or magic link.
- Manager API authentication and per-brand attribution.
- Chat placement (SPA question; only lands here if a websocket wins).
