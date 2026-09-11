# Roadmap

Checkpoints are the unit of work. Each one ends with something verifiable and a
short note here on what was decided.

## Already running (before this repo)

- ABR Bee nodes on Vultr (publishers and gateways).
- ABR uploader on the GCP stage host.
- Test infrastructure: streaming-infra-manager (master) deployed with the
  swarm-hls-streaming main-v2 player. A test stream plays at
  http://65.108.40.56:10064/#/watch/video/0501b0ccf4e91006673e2ead7c521bb5997eb12b/1f79f309-a4fd-4941-b5f3-8c72eeb722ef?qoe=1

## Checkpoint 1: repo skeleton (done 2026-09-11)

- MIT license, copyright Solar Punk Ltd.
- pnpm workspace at the root, `web2-admin` as the first package.
- Design brief for the admin layer copied out of the interactive model.

## Checkpoint 2: stack decision and API scaffold

- Confirm the stack in docs/architecture/web2-admin.md.
- Postgres schema v1: brands, users, streams, batches, branding. Migrations.
- Admin API skeleton with health, brands and streams endpoints, no auth yet
  (single operator, single brand, both are us).
- Local dev: docker compose for Postgres, `pnpm dev` runs the API.

## Checkpoint 3: manager integration

- Admin API provisions and stops a stream through the Manager API.
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
