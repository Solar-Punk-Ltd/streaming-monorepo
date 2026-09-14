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

## Checkpoint 2: first working slice (in progress)

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
indexes 3 to 5 and Bee's lookup stopped at 2, hiding the live entry at 6.
Follow-up for the backend: keep its own last-written index and probe for gaps
instead of trusting the lookup alone, and warn in the console when the batch
is near expiry.

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
