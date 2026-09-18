# Roadmap

Checkpoints are the unit of work. Each one ends with something verifiable and a
short note here on what was decided.

## Already running (before this repo)

- ABR Bee nodes on Vps (publishers and gateways).
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

Real-Swarm test, same day: a team member pointed the backend at his Bee node, published
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
