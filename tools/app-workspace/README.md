# app-workspace

The repository is one pnpm workspace with one lockfile at its root. Each app still builds its images from its own
folder, on the hosts it deploys to as in CI, because that keeps every Dockerfile, compose file and host folder as it
was. This tool gives such a build what it needs: the app's own `pnpm-lock.yaml` and `pnpm-workspace.yaml`, cut out of
the root ones at build time. A cut is never committed and never written into a working checkout.

Plain Node scripts with no dependencies, because a cut runs before anything is installed. They need Node 22 or later,
and `in-copy.mjs` needs git.

## The two commands

`cut.mjs` writes one app's pair into a folder outside the workspace:

```bash
node tools/app-workspace/cut.mjs --app apps/infra-manager --out /tmp/manager-cut
```

`in-copy.mjs` runs a command in a copy of one app, made outside the checkout with the app's pair in it, and removes
the copy afterwards. It is how an image builds from a working checkout:

```bash
cd apps/infra-manager
node ../../tools/app-workspace/in-copy.mjs --app apps/infra-manager -- docker build --file manager/Dockerfile --tag manager-api .
```

The copy holds the files git sees on disk: every tracked file with its changes not yet committed, and every new file
git does not ignore. Ignored files, such as `node_modules`, `dist` and every `.env`, stay behind. `--also` copies one
more path git ignores, such as a build output an image copies in, and refuses a path that is or holds an env file,
`.env` or `.env.<anything>`. Where the root holds no lockfile, as on a commit from before it did, the apps keep their
own and the copy gets no cut.

Each script prints its usage with `--help`.

## What a cut holds

- **The lockfile:** the app's importers, named from its folder, the app's own as `.`, and exactly the snapshots and
  packages they reach, each as the root lockfile has it. Nothing is resolved again. Every other section stays as the
  root has it. A package the app reaches as another app's optional peer is kept, as the root resolved it.
- **The workspace file:** the root's, with the globs under the app's folder named from it, the app's injection
  setting, and build permissions for the app's own packages alone. Overrides and every other setting stay as the root
  has them, and so do the comments.

The injection setting comes from [apps.mjs](apps.mjs). It is on for the manager alone, because its image runs
`pnpm deploy` without `--legacy`, and pnpm refuses that unless injection is on for the whole workspace the deploy
runs in. The root keeps it off.

## What it refuses

A cut writes nothing and says why when:

- the output folder is inside the workspace, where a second `pnpm-workspace.yaml` would make that folder a workspace
  of its own, which pnpm before 11.28 ignores without a word. `--in-export` allows it inside a git archive export, a
  tree without `.git` that is thrown away after its build, and nowhere else
- the output folder already holds a lockfile or a workspace file
- the root or the app names no `packageManager`, or the two name different ones. A build from the app folder runs the
  app's pnpm, so it must be the root's
- `apps.mjs` has no entry for the app
- the root has no lockfile, or a lockfile in a format other than `'9.0'`
- a workspace link, a folder dependency or a glob reaches outside the app, which a copy of the app cannot carry

`cut.mjs` exits 0 when it wrote the pair, 1 when it refused, 2 on bad arguments. `in-copy.mjs` exits with the
command's own status, or 125 when it could not make the copy or start the command.

## Tests

```bash
cd tools/app-workspace && node --test
```

They build small workspaces and git repositories under the system's temporary folder and need nothing installed.
