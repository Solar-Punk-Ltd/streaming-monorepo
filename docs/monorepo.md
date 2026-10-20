# The monorepo: layout and rules

This is a reference page for contributors. It says where each part of the platform lives, which
rules keep the parts apart, and how to read the history of the apps that came from other
repositories. Each app keeps its own folder, its own dependencies and its own way of building,
testing and deploying, and the apps meet only through the interfaces they publish.

## The layout

```
streaming-monorepo/
├── apps/                    one folder per app, each with only its own dependencies
│   ├── web2-admin/          the admin, the brand console
│   │   ├── backend/         the API and its Postgres schema, which also writes the catalogue feed
│   │   ├── frontend/        the console UI
│   │   ├── common/          the API contract: types shared by its backend and frontend
│   │   └── deploy/          its deploy script and production compose file
│   ├── hls-stream/          the stack, the streaming software that runs on a stage host
│   │   ├── packages/        stream-uploader, client (the viewer), shared, cli, and two development
│   │   │                    tools that are not part of the product: audit-gate (the dependency
│   │   │                    advisory check) and gate-facts (the figures a pull request quotes)
│   │   ├── engines/         SRS and OvenMediaEngine configuration
│   │   ├── nodes/           Bee node initialisation
│   │   ├── deploy/          deploy scripts, compose files, Dockerfiles and their tests
│   │   ├── e2e/             fault-injection suites, the browser and bench harness
│   │   └── docs/            the stack's own documentation
│   └── infra-manager/       the manager
│       ├── manager/         the API, and the script that builds stack versions
│       ├── frontend/        the manager console
│       ├── common/          types shared by its API and console
│       ├── deploy/          its deploy script and what it sets up on a host
│       └── docs/            the manager's own documentation
├── infra/                   what hosts need, shared by every app
│   └── edge/                the front door of a host
├── packages/                code shared by two or more apps: contracts, db-migrate, web-auth
├── tools/                   scripts that serve the whole repository
│   ├── boundary-check/      the check that no app depends on another
│   ├── app-workspace/       the cut of an app's lockfile and workspace file out of the root's
│   └── release/             the name a deploy gives its build, the tag script, the image publish
├── scripts/public-leaks/    the gate that refuses a real address, wallet or host name in the tree
├── docs/                    how the pieces fit, the guides for running the platform
├── .github/                 CODEOWNERS and every workflow
├── package.json             the one workspace: the pnpm it runs, Nx, and the commands over every app
├── nx.json                  how Nx runs the apps' own scripts: order, cache, no cloud
├── pnpm-workspace.yaml      every app's projects, the security overrides, the workspace settings
├── pnpm-lock.yaml           the one lockfile of every app
└── AGENTS.md, CLAUDE.md     rules for the whole repository, and each app keeps its own pair
```

Code that two apps share lives once, in `packages/`:

- `contracts` holds the shapes the apps send each other, one zod schema each, checked by the side
  that receives it.
- `web-auth` holds the sign-in and session code of the admin's and the manager's backends.
- `db-migrate` is the migration runner both backends use.

Any app may depend on a package. The boundary check refuses a package that depends on an app.

The repository is one pnpm workspace. The root `package.json` pins its pnpm, the root
`pnpm-workspace.yaml` lists every app's projects and holds the security overrides, and one lockfile
covers all three apps. Each app keeps its own `package.json`, and every app runs on the one Node
release the root `.nvmrc` names. The [README](../README.md#working-in-the-repository) says how to
work in one app.

`tools/release` holds what a release runs: the tag script an operator runs on the commit about to be
deployed, the script each deploy runs to name its build after that tag, and the script that
publishes the images of a tag. [releasing.md](releasing.md) is the order of a release.

## The rules

### An app owns its folder

Everything an app owns lives under its folder: code, tests, Dockerfiles, compose files, deploy
script, docs and its `AGENTS.md`. The edge in `infra/edge` serves every app and belongs to none.

### Projects never import each other's code

No app imports another app's package, and no file reaches across `apps/` with a relative path.
Apps meet in two places only:

- shared packages under `packages/`, each small, doing one thing and never importing an app,
- their published interfaces: HTTP APIs (the admin's internal API, which the uploader calls and
  the manager's Test connection reads, the manager's funding API, which the admin calls, and the
  uploader's health page, which the manager reads), the Swarm catalogue feed the admin writes and
  the viewer reads, and the arguments of the stack's `deploy.sh`, which the manager runs.

The `boundaries` workflow holds this on every pull request. Every project carries two tags in the
`nx` field of its `package.json`: a scope, `admin`, `manager`, `stack`, `shared` or `tools`, and a
type, `app` for something that runs or `lib` for code others import. The check reads the project
graph Nx builds from declared dependencies and from imports in the source, and fails when an app
depends on another app, a project depends on another scope, or a shared package depends on an
app. A project without its two tags fails too. `pnpm boundaries` at the root runs it.

One exception stands, named with its reason in `tools/boundary-check/exceptions.json`: the manager
console's mock server and test runner reuse code from the manager API, until that code moves into
the manager's `common`. [The check's README](../tools/boundary-check/README.md) says how it works.

A shape that crosses between two apps is a contract, and a contract is checked on both sides.

### In the repository files move. On the hosts nothing that holds state moves

A move in the repository changes paths in the tree and nothing else. Every deploy keeps its host
folder, its compose project name, its volumes and its env file names, whatever the files are
called in the repository. [self-hosting.md](self-hosting.md#the-names-that-never-change) lists those
names, so that a rename here cannot rename a database or a certificate store on a host.

### A pull request that moves files only moves them

Renames come first, each in its own commit, then the smallest path edits the renames need, each in
its own commit. No logic change and no dependency upgrade rides along with a move. A diff that
moves and changes at once cannot be reviewed, and a move that changed nothing can be proved while a
mixed one cannot.

### A bug gets its own pull request, with a test

A bug found before, during or after a move is fixed in a pull request of its own, with a test that
fails before the fix. Never inside the move.

### Real hosts stay out of the repository

A document names a host by its role, control host, stage host or Bee host, and an address by a
placeholder. Real names, addresses and domains belong to one deployment and live in that
deployment's env files, which are not committed. The [public leak gate](../scripts/public-leaks/README.md)
refuses a real address, wallet or host name in any tracked file.

## Workflows

Every workflow lives in the root `.github/workflows`, because GitHub runs workflows from there only:

| Workflow                                        | What it checks                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `web2-admin.yml`                                | the admin                                                               |
| `hls-stream.yml`                                | the stack                                                               |
| `infra-manager.yml`, `infra-manager-docker.yml` | the manager, and its Docker builds                                      |
| `packages.yml`                                  | the shared packages                                                     |
| `tools.yml`                                     | the scripts under `tools/`                                              |
| `boundaries.yml`                                | the boundary check and the public leak gate                             |
| `publish-images.yml`                            | publishes the images of every pushed tag ([releasing.md](releasing.md)) |

The root `.github` also holds `CODEOWNERS`.

## How the manager builds the stack

The manager builds the stack it bundles from `apps/hls-stream` of the commit it is deployed from.
Every version added on its Versions page comes from this repository as well: `apps/hls-stream` for a
commit made in this repository, and the whole tree for a commit of the stack's own history from
before its import.

## Reading the history of the stack and the manager

The stack and the manager came into this repository with `git subtree add`, which merges a
repository's whole history in under a folder. Nothing was rewritten, so every original commit is
here under its own id, and a commit id quoted in a note, a bench record or an issue resolves in
this repository.

- **`git blame -M -C <file>` names the original commits.** A plain `git blame` credits every
  imported line to the import commit, because the file arrived at a new path. Move detection
  follows the path change and names the commit that wrote the line, with its original date.
- **A plain `git log` of an imported folder starts at the import.** `git log -- apps/hls-stream`
  shows the import commit and what came after it, and `--follow` does not cross the import either.
- **A file's older history is read through the source commit.** Each import commit names the
  repository and commit it came from, and that commit is its second parent.
  `git log --format='%h %P %s' -n 1 -- apps/infra-manager` prints the manager's. A log from that
  id, with the path as the source repository had it, walks the file's whole history, for example
  `git log <source commit> -- packages/stream-uploader/src/index.ts` for a file of the stack.
- **`git subtree split` rebuilds a folder's own history** as a separate line of commits, when a
  whole history rather than one file's is wanted.
- **The manager's last changes came in with one `git subtree pull`.** It is a merge like the first
  import, so the same reading applies to it.
