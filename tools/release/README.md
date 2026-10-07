# release

The scripts a release runs before its deploys. [docs/releasing.md](../../docs/releasing.md) is the procedure; this
page says what each script does.

Plain Node scripts with no dependencies. They need Node 24 or later and git.

## version.mjs

Names the build a deploy is about to send, from the commit checked out. Both deploy scripts run it and build the
answer into the images they make:

```bash
node tools/release/version.mjs --app apps/web2-admin
```

```text
VERSION_COMMIT=635b4e1753cd35d06191fdd54a1f426f7478d438
VERSION_SHORT=635b4e175
VERSION_TAG=QA-build-2026-10-07
VERSION_LABEL=QA-build-2026-10-07
VERSION_DIRTY=false
```

- `VERSION_TAG` is the tag on the commit, and empty when it has none. When several tags name the commit, an
  annotated tag wins over a lightweight one, and the newest wins among equals.
- `VERSION_LABEL` is that tag. On a commit without one it is the nearest tag before it and how many commits the
  build is past it, `QA-build-2026-10-07+3`, and the short commit when there is no tag behind it at all.
- `-dirty` ends the label when the app's folder, `packages/`, or the root's `package.json`, `pnpm-lock.yaml` or
  `pnpm-workspace.yaml` holds a change or a new file git has not committed. Ignored files, the env files among them,
  never count. Without `--app` the whole checkout counts.
- Every value holds only letters, digits and `. _ + / -`, so a deploy script can carry it into a shell on a host and
  into a page without quoting it. A tag whose name holds anything else is passed over: the label names the nearest tag
  within that set, or the short commit when there is none.

`--format json` prints the same as one JSON object, with `dirty` a boolean. The script exits 1 with a message on
stderr outside a git checkout and for an `--app` that is outside the checkout or does not exist, and 2 for an option
it does not know.

The git it runs ignores `GIT_DIR`, `GIT_WORK_TREE` and the other variables a hook or `git rebase --exec` exports, so
it always reads the checkout its folder is in.
