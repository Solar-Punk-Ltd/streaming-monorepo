# move-check

Six small checks that prove a change moved things and changed nothing else. Each one
compares a before and an after, and passes only when the two match apart from the
differences you name on the command line.

They were written for turning this repository into a monorepo: projects imported with
`git subtree add`, whose files land byte for byte under `apps/<name>/`, and `web2-admin/`
moved to `apps/web2-admin/` with `git mv` plus a few path edits. They work on any two
commits, though.

| Check | What it compares |
|---|---|
| `tree.mjs` | every file of two git trees |
| `lockfile.mjs` | two `pnpm-lock.yaml` files |
| `compose.mjs` | a compose file as docker compose renders it |
| `image.mjs` | two docker images, config and files |
| `images.mjs` | every image of a manifest, built from a base and a head commit |
| `counts.mjs` | the test counts in two test-run logs |

They are plain Node scripts with no dependencies and nothing to install. They need Node 22
or later and git, `compose.mjs` and `image.mjs` need the docker CLI, and `images.mjs` needs
a Docker daemon to build with, plus whatever its manifest's prepare commands run. For
[images.json](images.json) that is corepack, which Node 22 ships. Run them
from the repository root.

## What the exit code means

Every check exits the same way.

- **0**: the two sides match, apart from what you allowed. It prints one line.
- **1**: the two sides differ, or for `counts.mjs` a test failed. It prints every problem,
  then a summary line.
- **2**: the check could not run. An argument was wrong, a revision, file or image does not
  exist, or a command it runs failed. The message says which. A 2 says nothing about your
  change either way, so fix what the message names and run the check again.

`--help` prints the full usage of any check.

## tree.mjs: the files are the same

It lists both sides with `git ls-tree -r`, renames the before side with your `--map` rules,
and compares every entry by mode and object id. A submodule counts as the commit it points
at.

**It proves** that every file, symlink and submodule has the same content and the same mode
on both sides, once the paths you mapped are renamed. When you give no `--map`, it also
compares the two tree ids, and matching tree ids alone prove that a subtree import copied
the tree exactly.

**It does not prove** anything about what the files do, whether the code builds or passes
its tests. It reads commits, not your working tree, so commit first.

A `--map old=new` renames a path, or a directory and everything under it. The longest
matching rule wins. An `--allow` lets one difference through: an exact path, or a prefix
that ends in `/`. A missing file can be allowed by its old path or its new one.

For the web2-admin move, the tree must match once the directory is renamed. The files the
move had to edit are allowed by name, and each of them is covered by another check: the
lockfile by `lockfile.mjs`, the compose files by `compose.mjs`, the Dockerfiles by
`image.mjs`. The workspace file is one line to read by eye.

```bash
node tools/move-check/tree.mjs --from main-v3 --to feat/apps-layout \
  --map web2-admin/=apps/web2-admin/ \
  --allow pnpm-workspace.yaml --allow pnpm-lock.yaml \
  --allow deploy/docker-compose.yml --allow apps/web2-admin/backend/docker-compose.yml \
  --allow apps/web2-admin/backend/Dockerfile --allow apps/web2-admin/frontend/Dockerfile
```

A rehearsal of this move printed:

```text
tree: match, 238 identical entries, 6 allowed differences
```

Without the `--allow` entries it lists the six files under `changed`, each with its mode
and object id on both sides, and exits 1.

For a subtree import, name the directory on the after side. Both commits must be in this
repository, so fetch the project first if its history did not come with the import:

```bash
node tools/move-check/tree.mjs --from <project-commit> --to HEAD:apps/<project>
```

```text
tree: match, tree ids match (<tree id>), <n> identical entries
```

## lockfile.mjs: the lockfile only renamed its importers

It reads both files from git. In the from file it renames each importer an `--importer`
names, which are the keys two spaces deep under the top-level `importers:` map, and touches
nothing else. Then it needs the two texts to be identical byte for byte.

**It proves** that every dependency, version, integrity hash and link in the lockfile is
exactly what it was, and only the importer names changed.

**It does not prove** that pnpm would accept the result. And pnpm sorts importers by name,
so a rename that makes an importer sort elsewhere moves its whole block. The check renames
in place and reports that move as a difference, so read the first differing lines it prints
before deciding.

pnpm treats a moved package as a new importer. In a rehearsal of this move,
`pnpm install --lockfile-only --offline` stopped for want of registry metadata for the moved
backend's dependencies. So run this check on the lockfile pnpm writes after the move. It is
what shows whether resolving them again changed anything beyond the names.

```bash
node tools/move-check/lockfile.mjs \
  --from main-v3:pnpm-lock.yaml --to feat/apps-layout:pnpm-lock.yaml \
  --importer web2-admin/backend=apps/web2-admin/backend \
  --importer web2-admin/common=apps/web2-admin/common \
  --importer web2-admin/frontend=apps/web2-admin/frontend
```

```text
lockfile: match, identical byte for byte after renaming 3 importers (3870 lines)
```

With `--packages` it compares only the keys under `packages:` and `snapshots:`, and lists
what one side has and the other lacks. That is for an upgrade of pnpm itself, where the text
changes but the resolved packages should not. It proves that the same package versions, with
the same peer combinations, are locked. It does not compare integrity hashes, dependency
lists or importers.

## compose.mjs: the compose file renders the same

It runs `docker compose config --format json` in two checkouts and compares the results.
Before comparing, every path that sits inside a checkout, such as a build context, a
Dockerfile or a bind-mount source, is rewritten relative to that checkout, and your `--map`
rules rename those paths on the before side. A relative Dockerfile is joined to its build
context first, so a map can reach it.

**It proves** that compose sees the same services, images, builds, ports, variables,
labels, volumes, networks and healthchecks on both sides.

**It does not prove** that the images build, since rendering builds nothing. Both renders
get the same environment, your shell's plus every `--env`, so the check shows that the two
files use those values the same way, not that the values are right. A `.env` file next to
the compose file is never read. With `--project` both sides run under that project name, which hides a
changed top-level `name:`. A service in a profile is rendered only when that profile is on,
so pass `--env COMPOSE_PROFILES=<name>` to compare it. It needs the docker CLI but no
running Docker daemon.

Make one checkout per commit, then compare. When the compose file itself moved, use
`--before-file` and `--after-file` in place of `--file`.

```bash
git worktree add ../before main-v3
git worktree add ../after feat/apps-layout
node tools/move-check/compose.mjs --before ../before --after ../after \
  --file deploy/docker-compose.yml \
  --env POSTGRES_PASSWORD=placeholder --env WEB2_ADMIN_ENV_FILE=/dev/null \
  --map web2-admin/=apps/web2-admin/
```

```text
compose: match, the same config for 3 services on both sides
```

## image.mjs: the images run the same way and hold the same files

It compares the config a container runs with: Entrypoint, Cmd, Env, User, ExposedPorts,
WorkingDir, Healthcheck, Labels and Volumes. Then it creates a container from each image
without starting it, streams `docker export` through a tar reader, and compares every
entry's path, type, permission bits, owner, size, link target and, for a regular file, the
sha256 of its content. It removes the containers afterwards, even when something fails.

**It proves** that the two images start the same process with the same settings over the
same files.

**It does not prove** that a build is reproducible. It compares the two images you built, so
build each from its own checkout first. Nothing is pulled. Modification times are ignored on
purpose, but a build can still write different bytes each time, such as Alpine's
`/var/log/apk.log`, which records when `apk add` ran. Allow such a file by its path, exactly
or by a prefix ending in `/`.

pnpm writes four files about an install rather than for any package, in the install's own
`node_modules` folder: `.modules.yaml`, `.pnpm/lock.yaml`, `.pnpm-workspace-state-v1.json`
from pnpm 10, and `.package-map.json` from pnpm 11. They are never allowed away and never
fail the check. One that differs is listed by name under `pnpm's own files`, with the pnpm
that wrote each side, the change of format where pnpm 9's YAML became JSON, and otherwise
the top-level keys that differ. `.modules.yaml` and the workspace state record when the
install ran, so every rebuild changes them, and when that is all that differs the images
match. When more differs, as after a pnpm version change, the verdict is
`match apart from pnpm's own files`, which still exits 0. So a pnpm version change is
reported as one rather than hidden in an allow list.

```bash
docker build -f ../base/apps/infra-manager/manager/Dockerfile -t infra-manager-api:base ../base/apps/infra-manager
docker build -f ../head/apps/infra-manager/manager/Dockerfile -t infra-manager-api:head ../head/apps/infra-manager
node tools/move-check/image.mjs \
  --before infra-manager-api:base --after infra-manager-api:head \
  --allow /var/log/apk.log
```

```text
pnpm's own files (2):
  /app/node_modules/.modules.yaml  its install time only: prunedAt
  /app/node_modules/.pnpm-workspace-state-v1.json  its install time only: lastValidatedTimestamp
image: match, 9 config fields equal, <n> identical filesystem entries, 1 allowed difference, 2 of pnpm's own files differ in their install time only
```

A difference is listed under `changed`, `missing` or `added`, a changed file with each field
that moved, for example `/backend/Dockerfile  size 1827 -> 1882, sha256 d4ee1d73be62 -> 3c9c2e62348e`.

A `--map old=new` renames a path of the before image, or a folder and everything under it,
before the two are compared. It is for a folder the after image keeps under another name, such
as pnpm's folder for a workspace package, whose name carries the package's path in the
workspace. What is under the folder is still compared entry by entry, under its new name, so a
file that changed inside it is still listed. The summary counts the renamed entries, and two
paths sent to one are refused.

## images.mjs: a pull request builds the same images as its base

It reads a manifest of images, each with its build context and Dockerfile, from two commits: a
base, such as a pull request's base, and a head, such as the pull request merged into it. Each
side is built as its own commit's copy of the manifest says, so a pull request that changes how
an image builds changes its entry with it, and its base still builds as it did. A base without
the manifest is built as the head's copy says, and an image only one copy names is reported and
not built. It checks all of it first: every commit, context and Dockerfile must be in this
repository, and no path may leave it. Then it exports each commit once with `git archive`,
builds both sides from their own export with `--no-cache`, and compares each pair with
`image.mjs`, handing it the `map` and `allow` lists of the head's copy. What may differ is the
head's to say.

**It proves** that the head builds, from clean builds, into images that run the same way over
the same files as its base's, apart from what the head's manifest allows and pnpm's own files,
which `image.mjs` names whenever they differ.

**It does not prove** that a build is reproducible beyond the two builds it made. A base image
or a package mirror that changes between the two builds shows up as a difference, so run it
again before believing one. It builds with each Dockerfile's default build arguments, not the
ones a deploy passes, so it cannot see a defect in those.

An image may carry `prepare`, commands to run in its context before it is built, each written
as a list of its words and run without a shell. It is for an image whose Dockerfile copies
something a deploy script builds first. The uploader's image copies
`packages/stream-uploader/dist/`, which is built and never committed, so both of its sides
install from their lockfile and build the uploader first. A side that prepares builds from an
export of its own, so what it writes reaches no other image. Both sides are prepared before
either is built, and a failed prepare is reported with its output, like a failed build.

`--plan` prints the builds and runs none. `--only` picks images by name. `--keep` leaves the
exports on disk, and `--remove-images` removes each pair and the build cache once the pair is
compared, which is what a CI runner needs. What each build and prepare command prints goes to
stderr as it comes, so a build that stalls shows where it stopped rather than nothing at all.
A failed build is reported with its output, and the other images are still checked. It exits
0 when every image matches, counting one that matches apart from pnpm's own files, 1 when one
differs and 2 when one could not be checked.

[images.json](images.json) names the eight images of the admin, the stack and the manager.
What it allows is build noise that differs between any two builds, each with its reason. The
`compare-images` workflow at the root runs it when a pull request gets the label
`compare-images`, with the pull request's base and the pull request merged into it, and puts
the report on the run's page. Removing the label and adding it again runs it again.

Phase 1 of the monorepo used this check to compare each project's last commit before the move
with the merge that brought it in, and all eight images matched in the run on #38. That
manifest, `phase-1-images.json`, and the mode that read it are in the history of this folder.

```bash
node tools/move-check/images.mjs --manifest tools/move-check/images.json \
  --base origin/main-v3 --head HEAD --plan
```

```text
images: plan, 8 images, 16 builds, every commit, context and Dockerfile found
```

## counts.mjs: the same number of tests ran and passed

It reads two test-run logs and finds every summary it knows: node:test's TAP and spec
summaries, and vitest's `Test Files`, `Tests` and `Errors` lines. Colour codes and CI
timestamps are stripped. Each summary belongs to the package printed before it: the
directory that `pnpm -r` puts in front of every line, or the name in a
`> name@version script` banner. A move changes the directory pnpm prints, so `--map`
renames the before log's packages.

**It proves** that every package reported the same numbers of tests, suites, passes, skips
and todos in both runs, and that nothing failed, was cancelled or raised an error.

**It does not prove** that the same tests ran, only the same number of them. A runner whose
summary it does not know gives it nothing to compare. So a package that pnpm ran a `test` or
`test:<name>` script for, but that printed no summary the check reads, is listed as a
problem rather than skipped, and two logs with no summary it knows exit 2, not 0.

```bash
(cd ../before && pnpm install --frozen-lockfile && pnpm -r test > ../before.log 2>&1)
(cd ../after && pnpm install --frozen-lockfile && pnpm -r test > ../after.log 2>&1)
node tools/move-check/counts.mjs --before ../before.log --after ../after.log \
  --map web2-admin/=apps/web2-admin/
```

```text
counts: match, 3 packages, 3 summaries, <n> tests, none failed
```

Without the map, each package shows up twice, once as `only in the before log` under its old
directory and once as `only in the after log` under its new one.

## Running the kit's own tests

```bash
cd tools/move-check
node --test
```

Nothing to install. The tests build throwaway git repositories in the system temp folder,
with hooks and commit signing switched off, and they stand in for docker with a small script
that answers from a scenario. So they need git but no Docker daemon, and they never pull,
build or run an image. One compose test also renders a real compose file when the docker CLI
is installed, and reports itself as skipped when it is not.

This folder is not a workspace package, so `pnpm install` and `pnpm -r test` at the root
leave it alone.
