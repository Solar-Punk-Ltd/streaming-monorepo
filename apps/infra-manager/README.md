# streaming-infra-manager

Deployment and orchestration tooling for testing the Swarm HLS live-streaming
stack. Targets two dedicated servers:

- **Streamer**: Bee light node, `stream-uploader` service, SRS.
- **Watcher**: N lightweight Docker containers running a Bee node, ultra-light
  unless it is created light, and the React streaming client, plus a small
  interface to start and stop them.

It also deploys the two halves of an ABR stage, which normally run on this one
host under this manager:

- **ABR Node Pool**: a deployment group with one Bee node per quality rung, as
  the publish targets. Produces the `BEE_PUBLISHERS` string.
- **ABR Uploader**: `srs` and `stream-uploader` publishing to that pool. It has
  no Bee node and no postage of its own. The wizard copies the pool's
  `BEE_PUBLISHERS` string into it.

An uploader on another machine is possible, and it needs two things: a
`BEE_LOCAL_HOST` naming an address that machine can reach, and a Bee API bind
that admits it. See [deploy/README.md](deploy/README.md) for the bind.

See [docs/features/abr-ladder.md](docs/features/abr-ladder.md).

## Layout

- `../hls-stream/`, the monorepo's `apps/hls-stream`: the streaming stack, with
  the packages under `packages/` and the engine trees under `engines/`. The
  monorepo commit a manager is deployed from holds both, and the stack in it is
  the **bundled** stack version, the default until another is chosen. A deploy
  does not carry this tree. It writes that commit into `manager/.stack-commit`,
  and the server fetches it and builds its `apps/hls-stream` itself, the same
  way it builds any version added on the Versions page.
- `/opt/streaming/streaming-infra-manager-versions/` on the deploy host
  (`STACK_VERSIONS_ROOT`). Each version keeps three siblings there:
  `<name>.repo/`, the clone it builds from, `<name>.builds/<build id>/`, one
  immutable directory per published build, and `<name>/`, the settings files
  the operator owns. A build is a checkout with its packages built, so it runs
  to about a gigabyte, and more than one build of a version can be kept at
  once. The root is a sibling of the data root and sits outside the tree
  `deploy/deploy.sh` rsyncs with `--delete`, so a manager deploy cannot wipe
  it. The Versions page adds, updates, configures and removes these. See
  [docs/features/stack-versions.md](docs/features/stack-versions.md) and
  [deploy/README.md](deploy/README.md).
- `/opt/streaming/streaming-infra-manager-data/<deployment>/` on the deploy
  host (`BEE_DATA_ROOT`): the deployment's Bee node data and keys, and under
  `engine/` the config file of its own when it runs on one. Survives a manager
  deploy, removed with the deployment. See
  [docs/features/engine-config.md](docs/features/engine-config.md).
- `/opt/streaming/manager-ssh/` on the deploy host (`MANAGER_SSH_DIR`): the ssh
  identity the manager deploys to *other* hosts with (the deploy key, an
  `ssh_config` with a `Host` block per target alias, and `known_hosts`),
  bind-mounted into the api container at `/root/.ssh`. Another sibling outside
  the tree `deploy/deploy.sh` rsyncs, and only needed when a deployment's host
  is not `localhost`. See [deploy/README.md](deploy/README.md).

## Checks

The `checks` workflow declares four jobs on every pull request and push to
`main` (and `main-v2` during the release transition): the build and the unit suites, the SQL suites against nine
disposable databases, the browser suites against a real headless Chrome, and a
build of the web and api images the way a deploy builds them on the host. A
second workflow, started by hand, runs the container-backed regressions and the
signed-in integration suite. Its five runs on push events of 2026-09-10 and
2026-09-11 all failed. Dispatched by hand, it first passed on 2026-09-19 (run
35447516491) and has passed on every stack pin move since, most recently run
36099132624 on 2026-09-25 for `v3.4`, read on GitHub that day. What each job proves, what it does not, and how to
run any of it on a laptop: [docs/ci.md](docs/ci.md).

## Documents

- [docs/features/](docs/features/): one page per feature, what the operator
  sees and how the code behaves. Start here to understand a capability.
  - [stack-versions.md](docs/features/stack-versions.md): versions, immutable
    builds, the copies a deploy runs from, and settings revisions.
  - [engine-control.md](docs/features/engine-control.md): engine settings,
    restart, logs and the effective config from the UI.
  - [engine-config.md](docs/features/engine-config.md): a deployment's own SRS
    or OvenMediaEngine configuration file.
  - [deployment-settings.md](docs/features/deployment-settings.md): every key a
    deployment's version declares and its engine settings, set for one
    deployment on its page or in the new-deployment wizard, and Apply for the
    containers behind on them.
  - [srt-ingest-health.md](docs/features/srt-ingest-health.md): how the SRT
    link from the broadcaster held up over the last minute, from SRS's own
    statistics, and what to change when it drops packets.
  - [group-deployment.md](docs/features/group-deployment.md): several
    deployments created at once under one name.
  - [abr-ladder.md](docs/features/abr-ladder.md): a node pool with one Bee node
    per quality rung, and the pool string an uploader publishes to.
  - [chequebook.md](docs/features/chequebook.md): funding a node's chequebook
    and recovering a transfer.
  - [postage-stamps.md](docs/features/postage-stamps.md): what a postage batch
    is, and buying, using, topping up and diluting one on a deployment's
    Storage card.
  - [auth-and-public-access.md](docs/features/auth-and-public-access.md): the
    login gate, the HTTPS edge, the API binds and the host firewall.
  - [next-features-2026-09.md](docs/features/next-features-2026-09.md): the
    September plan, kept as the record of what was asked for and why.
- [docs/ci.md](docs/ci.md): what each CI job proves, what it does not, and how
  to run any suite on a laptop.
- [docs/testing/](docs/testing/): what particular suites cover and, as
  importantly, what they do not model.
- [docs/handover/](docs/handover/): the narrative of the main-v2 remediation,
  one dated section per slice, including what the first real deploy found.
- [docs/consensus/](docs/consensus/): the record of the cross-provider review
  that produced that remediation. The PRD, its 25 rows, rows T23 to T27, the
  briefs and the acceptance trail. These are records of finished work and not
  instructions, apart from the parts of T23 and T27 that its README names as
  open. Its README is the index.
- [docs/ux/](docs/ux/): the UX rework brief and the clickable mockup it was
  decided from. Merged 2026-09-05.

## The stack this manager bundles

The stack sits beside the manager in the monorepo, in `apps/hls-stream`, so a
plain clone of the monorepo holds both and nothing more has to be fetched. A
manager deploy bundles the stack of the commit it deploys, so moving the bundled
stack on is a change to `apps/hls-stream` in the same repository, reviewed and
merged like any other.

Until the monorepo, this repository pinned the stack as a git submodule. The
last pin was the stack's release `v3.4`, commit `dc0c55e1`, as of 2026-09-25.
Its commits are in the monorepo's history under the same ids, so a version of
that release can still be added on the Versions page, from its commit.
