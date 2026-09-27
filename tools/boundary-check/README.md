# boundary-check

One check that fails when the repository's projects depend on each other across the
boundaries their tags draw. It reads the project graph Nx writes, so it judges every
dependency Nx can see: the ones a `package.json` declares and the imports in source files,
relative paths included.

The rules are the ones [docs/monorepo.md](../../docs/monorepo.md#projects-never-import-each-others-code)
states in words. This makes them a check that refuses.

## The tags

Every package carries one scope tag and one type tag in the `nx` field of its own
`package.json`:

```json
"nx": { "tags": ["scope:admin", "type:app"] }
```

| Tag                                           | Means                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| `scope:admin`, `scope:manager`, `scope:stack` | a package of that app, under `apps/`                                      |
| `scope:shared`                                | a package under `packages/`, shared by two or more apps                   |
| `scope:infra`                                 | a package under `infra/`                                                  |
| `scope:tools`                                 | a package under `tools/`                                                  |
| `type:app`                                    | something that runs: a service, a UI, a command-line tool, a test harness |
| `type:lib`                                    | code other projects import                                                |

Nx adds tags of its own, such as `npm:private`. The check reads only `scope:` and `type:`.

## The rules

- An app never depends on another app.
- A project never depends on a project of another scope, unless that scope is `shared`.
- A shared package never depends on an app.
- Every project carries exactly one known scope tag and one known type tag, so a new package
  cannot escape the rules by having none.

## Running it

From the repository root, after the install:

```sh
pnpm boundaries
```

That runs the three lines below, with the repository's exceptions file. The `boundaries` workflow runs
it on every pull request, then plants an import from the admin backend into the manager API and
requires the check to refuse it by name. By hand:

```sh
pnpm exec nx show projects > /dev/null
pnpm exec nx graph --file=.nx/boundary-graph.json
node tools/boundary-check/boundaries.mjs --graph .nx/boundary-graph.json
```

The first line is not optional. When the project graph has errors, `nx graph --file` still
writes the part it could build and exits 0. `nx show projects` exits 1 on the same errors.

Nx records imports from source files only when `nx.json` sets
`pluginsConfig["@nx/js"].analyzeSourceFiles` to `true` and `typescript` resolves from Nx's own
install. Without either, the graph holds only what `package.json` files declare, an import by
relative path from one app into another is not in it, and the check passes on less than it
should. Nx says nothing when this happens.

`--help` prints the full usage.

## What the exit code means

- **0**: every dependency keeps to the boundaries. It prints one line.
- **1**: a boundary is broken. It prints one line per problem, then a summary line.
- **2**: the check could not run. An argument was wrong, or a file could not be read or is not
  the shape Nx writes. The message says which. A 2 says nothing about the boundaries either
  way.

A problem line names the two projects, so a plain text search finds it:

```text
@streaming-monorepo/web2-admin-backend -> @streaming-infra-manager/api (static): an app depends on another app and a project depends on another scope's internals
boundaries: broken, 1 problem
```

The words in brackets are the kinds of dependency Nx recorded: `static` for a declared
dependency or an import, `dynamic` for an `import()`, `implicit` for one named in an `nx` field.

## Exceptions

`--exceptions <file>` names a JSON list of dependencies to let through, each with its reason:

```json
[
  {
    "source": "@streaming-infra-manager/frontend-prototype",
    "target": "@streaming-infra-manager/api",
    "reason": "Why this one app depends on the other, and what would end it."
  }
]
```

An exception can let one app depend on another app of its own scope, and nothing else. It never
covers a dependency between scopes. An entry that no longer matches a dependency the rules refuse
fails the check, so an exception cannot outlive its reason.

An exception covers the pair of projects, not one import. While it stands, a new import between
the same two projects passes too.

## What it proves, and what it does not

**It proves** that every dependency in the graph file between two of the repository's projects
keeps to the rules above, and that every project in it is tagged.

**It does not prove** anything about a dependency Nx cannot see: a script that runs another
project's file by its path, a Dockerfile that copies across apps, an HTTP call. Those are how the
projects are allowed to meet. Nor does it prove that the graph file is complete, which is what the
two settings and the first command above are for.

## The tests

```sh
cd tools/boundary-check
node --test
```

Plain Node, no dependencies. `tests/fixtures/nx-23.2.1-graph.json` is a file Nx 23.2.1's
`nx graph --file` wrote, byte for byte, over a three-project workspace with a declared
dependency, an undeclared import, an import by relative path across apps and a dynamic
`import()`. When Nx is upgraded, add a fixture written by the new version beside it, so the
reader is tested against every format it has to read.
