# Releasing

Since 2026-10-07 every deploy names the build it sends after the git tag on its commit and builds that name into its
images, and the consoles show it to signed-in users. So a release is tagged first and deployed after, in this order.
[tools/release/README.md](../tools/release/README.md) says what each script checks.

Run every step from your own checkout of this repository, on the commit you deploy. `<ssh-target>` stands for a host's
ssh alias and `<profile>` for the profile whose env file a host runs on, as in [self-hosting.md](self-hosting.md).

## 1. Tag the build

By hand, on the commit you are about to deploy. It must be pushed, and nothing a deploy ships may hold a change git
has not committed: `apps/`, `packages/`, `tools/`, `infra/` and the root's `package.json`, `pnpm-lock.yaml` and
`pnpm-workspace.yaml`. Ignored files, the env files among them, and changes elsewhere, such as `docs/`, do not count.

```sh
node tools/release/tag.mjs
```

It fetches the tags, shows the commit and the tags there are, asks for a name and a message, and asks before it
creates an annotated tag on the commit and pushes it. Any name works within letters, digits and `. _ + / -`, starting
with a letter or a digit, such as `QA-build-2026-10-07`, `v2.4.0` or `release/2026.10`. A name a tag already has on
another commit, here or on the remote, is refused. On a commit that already has an annotated tag, Enter keeps it.

It worked when it ends with "Pushed <tag> to origin." or, for a tag it kept, "origin already has <tag>."

## 2. Deploy each manager

```sh
./apps/infra-manager/deploy/deploy.sh --host <ssh-target> --profile <profile>
```

Once for each host that runs a manager, each with its own profile.
[apps/infra-manager/deploy/README.md](../apps/infra-manager/deploy/README.md) has the details.

## 3. Deploy each admin

```sh
./apps/web2-admin/deploy/deploy.sh --host=<ssh-target> --profile=<profile>
```

Add `--remote-path=<dir>` where that host keeps its checkout elsewhere than `/opt/streaming/streaming-monorepo`.
[apps/web2-admin/deploy/README.md](../apps/web2-admin/deploy/README.md) has the details.

## 4. Check

Sign in to each console. The manager's sidebar shows the build's name under its host, and the admin console's toolbar
shows it beside the account button on a screen wider than a phone's. In the manager, the **Versions** page shows the
release of each stack build, and each deployment's **At a glance** card shows the release its containers run: under
**Player** on a Watch a stream deployment, whose release is the viewer client its viewers load, and under **Release** on
any other. A deployment keeps the build it runs until it is deployed again, so one that has not been redeployed since
the release still shows the build it was made from.

## A deploy without a tag

A deploy of a commit with no tag of its own still names its build:

- the nearest tag before the commit and how many commits past it, `<tag>+<n>`, as `QA-build-2026-10-07+3`;
- the short commit, as `635b4e175`, when there is no tag behind it at all;
- either of them, or the tag, followed by `-dirty` when the app, `packages/` or the root's install files held a change
  git had not committed.

A deploy run in a terminal on a commit without a tag says so and offers to run the tag script first, then deploys
under the name the new tag gives it. A deploy that runs without a terminal never asks, and deploys under the name
above.

## Removing a mistaken tag

A tag on the wrong commit, or with a name you would rather not keep, goes from your checkout and then from the remote:

```sh
git tag -d <tag>
```

```sh
git push origin :refs/tags/<tag>
```

Name another remote in place of `origin` if you pushed the tag there. A teammate who fetched the tag keeps a copy until
they run `git tag -d <tag>` too, and a deployment built under it shows that name until it is deployed again. The
manager hosts follow the remote's tags at their next stack build: a deleted tag goes from their clones, and a name used
again on another commit moves there with it. Then tag the right commit, by step 1.
