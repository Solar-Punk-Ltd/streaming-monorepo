# release

The scripts a release runs before its deploys. [docs/releasing.md](../../docs/releasing.md) is the procedure; this
page says what each script does.

Plain Node scripts with no dependencies. They need Node 24 or later and git.

## tag.mjs

Tags the commit checked out for a release, by hand, before its deploys. It shows the commit and the tags there are,
asks for a name and a message, then creates an annotated tag on the commit and pushes that tag alone:

```bash
node tools/release/tag.mjs
```

It takes any name a deploy can carry, and suggests and enforces no scheme: `QA-build-2026-10-07`, `v2.4.0` and
`release/2026.10` all work. In order, it:

1. Fetches the remote's tags, and its branches with them. When the fetch fails, as offline, it warns that a name a
   teammate pushed cannot be checked, and goes on.
2. Shows the commit: its branch, or `detached`, its short commit, its subject and its date. It refuses a commit that
   no branch of the remote holds: push it first.
3. Refuses when what a deploy ships holds a change git has not committed: a changed file, or a new one git does not
   ignore, under `apps/`, `packages/`, `tools/` or `infra/`, or in the root's `package.json`, `pnpm-lock.yaml` or
   `pnpm-workspace.yaml`. It names each path. Ignored files, the env files among them, and changes anywhere else,
   such as `docs/`, do not count. A tag names exactly what gets deployed.
4. Lists the tags, newest first: when each was made, in your time zone, or its commit's date for a lightweight tag,
   the commit it names, whether it is annotated or lightweight, and the first line of an annotated tag's message. `*`
   marks a tag on this commit. It lists the latest 20 and says how many more there are: `--all` lists every tag and
   `--limit <n>` the latest n.
5. Says when the commit already has an annotated tag, the one a deploy of it shows. Enter keeps it, and pushes it
   where the remote lacks it. A new name adds another tag. A lightweight tag on the commit is named but not offered,
   since a mistyped `git tag list` leaves one.
6. Asks for the name, with no default. It says why it refuses a name, and asks again:
   - a name `lib/tagName.mjs` refuses, which a deploy could not carry;
   - one `git check-ref-format` refuses, and `HEAD`, which `git tag` refuses;
   - the name of a tag, here or on the remote, that names another commit, and it says which commit;
   - a name that differs from a tag's only in case, which git on a Mac or on Windows mixes up;
   - `release` when there is a `release/2026`, or the other way round, which git cannot hold together.

   The name of a tag already on this commit keeps that tag. An empty answer cancels when there is nothing to keep.

7. Asks for the message. Enter uses the name.
8. Asks `Create <name> on <short> and push it to origin? [y/N]`.
9. Creates the annotated tag and pushes it alone. When the push fails, the tag stays here and the script prints the
   command that pushes it again.

It never moves or deletes a tag: the fetch prunes none whatever `fetch.pruneTags` says, and the push sends no other
tag whatever `push.followTags` says. Both go through your own ssh and git setup, so a passphrase prompt works as it
always does. Like the git `version.mjs` runs, its git ignores `GIT_DIR` and the other variables a hook exports, so it
tags the checkout its folder is in.

For scripts and tests:

- `--name <tag>` and `--message <text>` answer the two questions. Without a terminal on stdin, `--name` is required
  and a name it refuses ends the run.
- `--yes` creates the tag without asking. Without a terminal it is required to create one. Keeping one needs none.
- `--no-push` creates the tag on this machine only, and prints the command that pushes it.
- `--remote <name>` is the remote it fetches, checks names against and pushes to, `origin` unless given.
- `--root <checkout>` tags another checkout than the one the script is in.

It exits 0 when a tag was created or kept, 1 when it refused or a step failed, 2 for a usage error, among them a run
without a terminal that lacks `--name`, or lacks `--yes` to create a tag, and 3 when cancelled, saying "Nothing was
tagged."

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
