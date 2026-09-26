# The monorepo: layout and rules

This repository is one home for every project of the streaming platform. Each project keeps its
own folder, its own dependencies and its own way of building, testing and deploying, and the
projects meet only through the interfaces they publish. This page says where things are, which
rules keep the projects apart, and how the history of the imported projects came along.

## The layout

```
streaming-monorepo/
├── apps/                    one folder per project, each with only its own dependencies
│   ├── web2-admin/          the brand console
│   │   ├── backend/         the API and its Postgres schema, which also publishes the catalog feed
│   │   ├── frontend/        the console UI
│   │   ├── common/          the API contract: types shared by its backend and frontend
│   │   └── deploy/          its deploy script and production compose file
│   ├── hls-stream/          the streaming stack
│   │   ├── packages/        stream-uploader, client (the viewer), shared, cli, audit-gate, gate-facts
│   │   ├── engines/         SRS and OME configuration
│   │   ├── nodes/           Bee node initialisation
│   │   ├── deploy/          deploy scripts, compose files, Dockerfiles and their tests
│   │   ├── e2e/             fault-injection suites, the browser and bench harness
│   │   └── docs/            bench records, reviews, scale notes
│   └── infra-manager/       the manager
│       ├── manager/         the API, and the pinned copy of the stack it builds
│       ├── frontend/        the manager console
│       ├── common/          types shared by its API and console
│       ├── deploy/          its deploy script and what it sets up on a host
│       └── docs/            its feature pages, its issue and decision record, its test notes
├── infra/                   what hosts need, shared by every project
│   ├── edge/                the front door of a host
│   └── terraform/           the pilot's GCP and Vps hosts, and the monitoring stack
├── packages/                code shared by two or more apps, none yet
├── tools/                   scripts that serve the whole repository, starting with the move-check kit
├── docs/                    how the pieces fit
├── .github/                 CODEOWNERS
├── AGENTS.md, CLAUDE.md     rules for the whole repository, and each app keeps its own pair
└── .gitmodules              the manager's pinned copy of the stack
```

Two things the tree shows are worth knowing before a first change. There is no `packages/` folder
yet, because no code is shared yet: what crosses between projects today is copied on each side,
and shared packages come one contract at a time. And there is no `package.json` at the root: each
app is a pnpm workspace of its own, with its own lockfile and its own pinned pnpm and Node, until
one workspace covers them all. The [README](../README.md#working-in-an-app) says how to work in
one.

## The rules

### A project owns its folder

Everything a project owns lives under its folder: code, tests, Dockerfiles, compose files, deploy
script, docs and its `AGENTS.md`. Everything one cloud vendor needs lives in that vendor's
Terraform root. The edge and the monitoring stack each do one job.

### Projects never import each other's code

No app imports another app's package, and no file reaches across `apps/` with a relative path.
Projects meet in two places only:

- shared packages under `packages/`, each small, doing one thing and never importing an app,
- their published interfaces: HTTP APIs (the admin's internal API, which the uploader calls, and
  the manager's API, which the admin calls), the Swarm catalog feed the admin writes and the
  viewer reads, and the arguments of the stack's `deploy.sh`, which the manager runs.

A shape that crosses between two projects is a contract, and a contract is checked on both sides.

### In the repository files move. On the hosts nothing that holds state moves

A move in the repository changes paths in the tree and nothing else. Every deploy keeps its host
folder, its compose project name, its volumes and its env file names, whatever the files are
called in the repository. Those names are listed in [hosts.md](hosts.md), so that a rename here
cannot quietly rename a database or a certificate store there.

### A pull request that moves files only moves them

Renames come first, each in its own commit, then the smallest path edits the renames need, each in
its own commit. No logic change and no dependency upgrade rides along with a move. A diff that
moves and changes at once cannot be read, and a move that changed nothing can be proved while a
mixed one cannot. The move-check kit under `tools/move-check/` is that proof: it compares the tree
before and after, file for file.

### A bug gets its own pull request, with a test

A bug found before, during or after a move is fixed in a pull request of its own, with a test that
fails before the fix. Never inside the move.

### Real hosts stay out of the repository

A document names a host by its role, control host, stage host or Bee host, and an address by a
placeholder. Real names, addresses and domains belong to one deployment and live in that
deployment's env files, which are not committed.

## The imported projects, until the switch

`apps/hls-stream`, `apps/infra-manager` and `infra/terraform` were imported whole from their own
repositories and are still developed there. Their folders here stay identical to those
repositories, file for file, until the switch that moves all work here. Until then:

- a change to the stack, the manager or the Terraform is made in its own repository, and
  `git subtree pull` brings the new commits into its folder here,
- the admin, the edge and the root documents are developed here,
- the manager builds the stack from a pinned commit of the stack's own repository, recorded as the
  git submodule at `apps/infra-manager/manager/swarm-hls-stream`, which is what the root
  `.gitmodules` names. A plain clone leaves that folder empty, and only work on the manager needs
  it filled.

The workflows under `apps/hls-stream/.github` and `apps/infra-manager/.github` are those
repositories' own. GitHub runs workflows from the root `.github` only, so they do not run here.
The root `.github` holds `CODEOWNERS`.

## How the history came along

The stack, the manager and the Terraform came in with `git subtree add`, which merges a
repository's whole history in under a folder. Nothing was rewritten: every original commit is here
under its own id, so a commit id quoted in a note, a bench record or an issue resolves in this
repository. What that means when reading history:

- **`git blame` names the original commits once move detection is on.** A plain `git blame`
  credits every imported line to the import commit, because the file arrived at a new path.
  `git blame -M -C <file>` follows the path change and names the commit that wrote the line, with
  its original date.
- **A plain `git log` of an imported folder or file starts at the import.** `git log -- apps/hls-stream`
  shows the import commit and what came after it, and `--follow` does not cross the import either.
- **A file's older history is read through the source commit ids.** Each import commit names the
  repository and commit it came from, and that commit is its second parent:
  `git log --format='%h %P %s' -n 1 -- apps/infra-manager` prints the manager's. A log from that
  id, with the path as the source repository had it, walks the file's whole history, for example
  `git log <source commit> -- packages/stream-uploader/src/index.ts` for a file of the stack. The
  Terraform's source commit is a split of the `terraform/` folder alone, so its paths start at
  that folder's root, as they do under `infra/terraform/`. The source repositories answer the same
  question until the switch.
- **`git subtree split` rebuilds a folder's own history** as a separate line of commits, when a
  whole history rather than one file's is wanted.
- **New commits keep coming in with `git subtree pull`** until the switch. Each pull is a merge
  like the first import, so the same reading applies to them.
