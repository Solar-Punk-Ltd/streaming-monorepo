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
│       ├── manager/         the API, and the script that builds stack versions
│       ├── frontend/        the manager console
│       ├── common/          types shared by its API and console
│       ├── deploy/          its deploy script and what it sets up on a host
│       └── docs/            its feature pages, its issue and decision record, its test notes
├── infra/                   what hosts need, shared by every project
│   └── edge/                the front door of a host
├── packages/                code shared by two or more apps: contracts, db-migrate, web-auth
├── tools/                   scripts that serve the whole repository
│   ├── boundary-check/      the check that no app depends on another
│   ├── app-workspace/       the cut of an app's lockfile and workspace file out of the root's
│   └── release/             the name a deploy gives its build, and the tag script a release starts with
├── scripts/public-leaks/    the gate that refuses a real address, wallet or host name in the tree
├── docs/                    how the pieces fit
├── .github/                 CODEOWNERS and every workflow
├── package.json             the one workspace: the pnpm it runs, Nx, and the commands over every app
├── nx.json                  how Nx runs the apps' own scripts: order, cache, no cloud
├── pnpm-workspace.yaml      every app's projects, the security overrides, the workspace settings
├── pnpm-lock.yaml           the one lockfile of every app
└── AGENTS.md, CLAUDE.md     rules for the whole repository, and each app keeps its own pair
```

Two things the tree shows are worth knowing before a first change. Code that two apps share lives
once, in `packages/`: `contracts` holds the shapes the apps send each other, one schema each,
checked by the side that receives it, `web-auth` the sign-in and session code of the two backends,
and `db-migrate` the migration runner both backends use. Any app may depend on a package, and the
boundary check refuses a package that depends on an app. And the repository is one pnpm workspace:
the root `package.json` pins its pnpm, the root `pnpm-workspace.yaml` lists every app's projects
under the app's own folder and holds the security overrides, and one lockfile covers all three apps.
Each app keeps its own `package.json` and its own Node. The [README](../README.md#working-in-an-app)
says how to work in one.

`tools/release` holds what a release runs: the tag script an operator runs on the commit about to be
deployed, and the script each deploy runs to name its build after that tag.
[releasing.md](releasing.md) is the order of a release.

## The rules

### A project owns its folder

Everything a project owns lives under its folder: code, tests, Dockerfiles, compose files, deploy
script, docs and its `AGENTS.md`. The edge does one job.

### Projects never import each other's code

No app imports another app's package, and no file reaches across `apps/` with a relative path.
Projects meet in two places only:

- shared packages under `packages/`, each small, doing one thing and never importing an app,
- their published interfaces: HTTP APIs (the admin's internal API, which the uploader calls and
  the manager's Test connection reads, and the uploader's health page, which the manager reads),
  the Swarm catalog feed the uploader and the admin write and the viewer reads, and the arguments
  of the stack's `deploy.sh`, which the manager runs.

The `boundaries` check holds this on every pull request. Every project carries two tags in the
`nx` field of its `package.json`: a scope, `admin`, `manager`, `stack`, `shared` or `tools`, and a
type, `app` for something that runs or `lib` for code others import. The check reads the project
graph Nx builds from declared dependencies and from imports in the source, and fails when an app
depends on another app, a project depends on another scope, or a shared package depends on an
app. A project without its two tags fails too. `pnpm boundaries` at the root runs it. One
exception stands, named with its reason in `tools/boundary-check/exceptions.json`: the manager
console's mock server and test runner reuse code from the manager API, until that code moves into
the manager's `common`. How the check works: [its README](../tools/boundary-check/README.md).

A shape that crosses between two projects is a contract, and a contract is checked on both sides.

### In the repository files move. On the hosts nothing that holds state moves

A move in the repository changes paths in the tree and nothing else. Every deploy keeps its host
folder, its compose project name, its volumes and its env file names, whatever the files are
called in the repository. Those names are listed in [self-hosting.md](self-hosting.md), so that a rename here
cannot quietly rename a database or a certificate store there.

### A pull request that moves files only moves them

Renames come first, each in its own commit, then the smallest path edits the renames need, each in
its own commit. No logic change and no dependency upgrade rides along with a move. A diff that
moves and changes at once cannot be read, and a move that changed nothing can be proved while a
mixed one cannot.

### A bug gets its own pull request, with a test

A bug found before, during or after a move is fixed in a pull request of its own, with a test that
fails before the fix. Never inside the move.

### Real hosts stay out of the repository

A document names a host by its role, control host, stage host or Bee host, and an address by a
placeholder. Real names, addresses and domains belong to one deployment and live in that
deployment's env files, which are not committed.

## The imported projects

`apps/hls-stream` and `apps/infra-manager` were imported whole from their own
repositories. Since 2026-09-27 all work on them happens here, like the rest of the repository. The
repositories they came from are left as they are and get nothing new, and nothing more is pulled
from them.

The manager builds the stack it bundles from `apps/hls-stream` of the commit it is deployed from,
and every version added on its Versions page from this repository: `apps/hls-stream` for a commit
made since the import, and the whole tree for a commit of the stack's own history from before it.
A version built from swarm-hls-stream before the move keeps its record of coming from there.

Every workflow lives in the root `.github/workflows`, since GitHub runs workflows from there only:
one per app (`hls-stream.yml`, `infra-manager.yml` with `infra-manager-docker.yml`,
`web2-admin.yml`), one for the shared packages (`packages.yml`), one for `tools/` (`tools.yml`),
and the boundary check (`boundaries.yml`). The root `.github` also holds `CODEOWNERS`.

## How the history came along

The stack and the manager came in with `git subtree add`, which merges a
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
  source repositories, left as they
  were on 2026-09-27, answer the same question.
- **`git subtree split` rebuilds a folder's own history** as a separate line of commits, when a
  whole history rather than one file's is wanted.
- **The manager's last changes came in with one `git subtree pull`** before the switch. It is a
  merge like the first import, so the same reading applies to it.
