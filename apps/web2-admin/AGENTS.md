# AGENTS.md

Read by AI coding agents working in `apps/web2-admin`, the brand console. The root `AGENTS.md`
of the repository holds the rules that apply everywhere. This file adds the admin's own.

## Layout

- Three projects of the repository's one pnpm workspace, listed in the root
  `pnpm-workspace.yaml`: `common`, `backend` and `frontend`. Install once at the root. Package scope is `@streaming-monorepo/`. `common` is the API contract. Change
  it deliberately and update both sides.
- `deploy/` holds `deploy.sh` and the production compose file. `deploy/README.md` says how a
  host is set up and deployed to.
- The host's HTTPS edge is not the admin's. It lives in `../../infra/edge/` and serves the
  manager's console as well.
- The docs are at the repository root. `../../docs/architecture/web2-admin.md` is the text
  version of the interactive MVP model and the reference for what the admin layer is and is not.
  `../../docs/architecture/web2-admin-auth.md` is the login gate. `../../docs/ROADMAP.md` is the
  plan and the checkpoint log. `../../docs/self-hosting.md` says how a host is set up.
  `../../docs/research/` holds condensed reports on the sibling systems (the manager and the
  stack). Read the relevant one before touching anything that talks to those systems.

## Conventions

- TypeScript, ESM, exact-pinned dependencies (`saveExact: true` in the root `pnpm-workspace.yaml`).
- Mirror the manager (`../infra-manager`) where a choice is arbitrary, so the two read as one
  team's work.
- The admin never touches a host or a node's wallet directly. Wallet actions go through the
  manager's funding API, on its bearer token (`MANAGER_FUNDING_TOKEN`), and the admin signs with
  the brand wallet and nothing else. `../../docs/architecture/funding.md` is the plan.
- Ownership (which brand a call may act for) is enforced in the admin API and nowhere else.
