# AGENTS.md

Read by AI coding agents working in this repository.

## Layout

- pnpm workspace. Packages are listed in `apps/web2-admin/pnpm-workspace.yaml`:
  `apps/web2-admin/common`, `apps/web2-admin/backend` and
  `apps/web2-admin/frontend`.
  Package scope is `@streaming-monorepo/`. `common` is the API contract;
  change it deliberately and update both sides.
- `docs/ROADMAP.md` is the plan and the checkpoint log. Update it when a
  checkpoint closes or a decision lands.
- `docs/architecture/` holds the design briefs. `web2-admin.md` is the text
  version of the interactive MVP model and is the reference for what the
  admin layer is and is not.
- `docs/infra-state.md` says what is deployed where.
- `docs/research/` holds condensed reports on the sibling repos (msrs-client,
  streaming-infra-manager, swarm-hls-stream). Read the relevant one before
  touching anything that talks to those systems.

## Conventions

- TypeScript, ESM, exact-pinned dependencies (`save-exact=true` in
  `apps/web2-admin/.npmrc`).
- Mirror streaming-infra-manager where a choice is arbitrary, so the two repos
  read as one team's work.
- The admin layer never touches a wallet or a host directly. Anything that
  does goes through the Manager API.
- Ownership (which brand a call may act for) is enforced in the Admin API and
  nowhere else.

## Working model

One orchestrating session owns docs, roadmap, memory and verification.
Implementation and other heavy work is delegated to high-effort agents with a
self-contained brief. Every delegated change is reviewed before it lands.
