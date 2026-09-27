# AGENTS.md

Read by AI coding agents working anywhere in this repository. It holds the rules that apply
everywhere. Inside an app, that app's own `AGENTS.md` applies as well and wins where the two
differ:

- `apps/hls-stream/AGENTS.md`: the stack's rules, among them the rule on spending (never design a
  test around the balance) and the rule that an e2e suite checks correctness, never performance.
- `apps/infra-manager/AGENTS.md`: where the manager keeps its issues, its decisions and its
  reference documentation.
- `apps/web2-admin/AGENTS.md`: the admin's packages, its API contract and its boundaries.

Each `CLAUDE.md` is the one line `@AGENTS.md`, so every tool reads the same text.

## Layout

`docs/monorepo.md` is the map: one folder per project under `apps/`, what hosts need under
`infra/`, shared code under `packages/` when there is any, repository-wide scripts under `tools/`,
and how the pieces fit under `docs/`. Read it before moving anything.

- `docs/ROADMAP.md` is the plan and the checkpoint log. Update it when a checkpoint closes or a
  decision lands.
- `docs/architecture/` holds the design briefs.
- `docs/hosts.md` holds the host roles, the edge, and the names on the hosts that never change.
- `docs/infra-state.md` says what is deployed where.
- `docs/research/` holds condensed reports on the neighbouring systems. Read the relevant one
  before touching anything that talks to those systems.

## Rules that hold everywhere

- A project owns everything under its folder and never imports another project's code. Projects
  meet through shared packages under `packages/` and through their published interfaces: HTTP
  APIs, the Swarm catalog feed, the stack's deploy script arguments.
- In the repository files move. On the hosts nothing that holds state moves: host folders,
  compose project names, volumes and env file names stay what `docs/hosts.md` lists.
- A pull request that moves files only moves them. Renames first, each in its own commit, then
  the smallest path edits they need. No logic change and no upgrade rides along.
- A bug gets its own pull request, with a test that fails before the fix, never inside a move.
- `apps/hls-stream`, `apps/infra-manager` and `infra/terraform` are developed here like
  everything else, since 2026-09-27. The repositories they came from get nothing new, and
  nothing more is pulled from them.
- Nothing is deployed to a host without the owner's word. Every check that can be made without
  a host is made first.
- Real host names, addresses and domains stay out of the repository. Name a host by its role and
  an address by a placeholder.

## Conventions

- TypeScript and ESM throughout. The repository is one pnpm workspace: install once at the root,
  then work inside the app (`cd apps/<app>`), whose commands cover that app alone. pnpm is pinned in
  the root `package.json`, which each app repeats, and Node in the root `.nvmrc`, which the
  workflows read and every image's Node base image matches.
  Overrides and workspace settings live in the root `pnpm-workspace.yaml` alone.
- The root's `pnpm build`, `typecheck`, `test` and `lint` run every package's own script through
  Nx. Lint is oxlint and formatting is oxfmt (`pnpm format`), with one settings file each at the
  root, `.oxlintrc.json` and `.oxfmtrc.json`. `pnpm boundaries` fails when one app depends on another. A new package gets its scope and
  type tags in its `package.json`'s `nx` field, or that check fails.
- When you change behaviour, change the page that describes it in the same pull request.

## Working model

One orchestrating session owns docs, roadmap, memory and verification.
Implementation and other heavy work is delegated to high-effort agents with a
self-contained brief. Every delegated change is reviewed before it lands.
