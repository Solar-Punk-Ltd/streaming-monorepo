# The manager, `apps/infra-manager`

The manager is a web console and an API for running the Swarm HLS live-streaming stack,
`apps/hls-stream`, on your own hosts. An operator uses it to create a deployment, which is one
running copy of some of the stack's services, and the manager deploys, checks, stops and removes
it. It keeps the ports of deployments on one host apart, buys and tops up postage for the Bee nodes
it runs, fills their chequebooks, and tells the admin (`apps/web2-admin`) about every stage
that publishes.

## What you can deploy

The new-deployment wizard offers five kinds of deployment:

- **Stream to Swarm**: `srs`, `stream-uploader` and a Bee node, `bee-uploader`. It takes a live
  feed from OBS or FFmpeg and publishes it to Swarm.
- **Watch a stream**: the web player, `client`, and a Bee node it reads through, `bee-gateway`.
- **ABR node pool**: four Bee nodes, one per quality from 360p to 1080p, as the upload targets of an
  ABR uploader. ABR, adaptive bitrate, means one broadcast in several qualities, so a player can
  switch as its connection allows. The pool produces the `BEE_PUBLISHERS` string.
- **ABR uploader**: `srs` and `stream-uploader`, encoding a quality ladder and publishing it to a
  node pool. It has no Bee node and no postage of its own.
- **Custom**: any of the components above, and the OvenMediaEngine media server (`ome`), picked by
  hand.

An ABR node pool and its uploader together are an ABR stage. They can share one host or run on
hosts of their own, the pool on a Bee host and the uploader on a stage host, which is the layout
[docs/self-hosting.md](../../docs/self-hosting.md) sets up. When the pool runs on the manager's own
host and its uploader on another machine, the uploader needs a `BEE_LOCAL_HOST` it can reach and a
Bee API bind that admits it. [ABR ladder](docs/features/abr-ladder.md) has the details.

## Run it in one minute

To work on the console without Docker, a database or a Bee node, from the repository root:

```sh
corepack pnpm install
cd apps/infra-manager/frontend
pnpm dev:mock    # an offline mock manager on 127.0.0.1:9876
pnpm dev         # in a second terminal: the console, at the address Vite prints
```

Sign in as `dev` with the password `dev-password-1234`. Every value in the mock is made up at start.

To run the real manager on one machine, deploying to `localhost`, follow "Run it" in
[the API reference](manager/README.md#run-it). To put it on a server, follow
[the deploy guide](deploy/README.md).

## Layout

| Path        | What it is                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------- |
| `manager/`  | The API, `@streaming-infra-manager/api`: Express, PostgreSQL, the deploy orchestration and the CLI |
| `frontend/` | The console, `@streaming-infra-manager/frontend-prototype`: React, served by nginx                 |
| `common/`   | Shapes and rules the API, the console and the mock share, `@streaming-infra-manager/common`        |
| `deploy/`   | `deploy.sh`, which puts the manager on a server, and the host firewall generator                   |
| `docs/`     | The feature pages, the console page and the CI page                                                |

The manager reads the stack from `../hls-stream/`, the monorepo's `apps/hls-stream`. The stack in
the commit a manager is deployed from is the bundled stack version, the default until another is
chosen. A deploy does not carry the stack tree. It writes the stack's commit into
`manager/.stack-commit`, and the server fetches that commit and builds its `apps/hls-stream` itself,
the same way it builds any version added on the Versions page. An older stack release can be added
there by its tag, such as `stack/v3.4`, or by its commit.

On a server, the manager keeps three folders beside its own:

| Folder (default)                                   | Setting               | What it holds                                                                                                                                                     |
| -------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/opt/streaming/streaming-infra-manager-versions/` | `STACK_VERSIONS_ROOT` | Each stack version's clone (`<name>.repo/`), its published builds (`<name>.builds/<build id>/`, about a gigabyte each) and the settings files you own (`<name>/`) |
| `/opt/streaming/streaming-infra-manager-data/`     | `BEE_DATA_ROOT`       | Each local deployment's Bee node data and keys, and its engine config file under `engine/`. Removed with the deployment                                           |
| `/opt/streaming/manager-ssh/`                      | `MANAGER_SSH_DIR`     | The SSH identity the manager deploys to other hosts with. Needed only when a deployment's host is not `localhost`                                                 |

All three sit outside the folder a manager deploy replaces, so a deploy never wipes them.

## Documents

- [manager/README.md](manager/README.md): the API and settings reference, every route and every
  environment variable.
- [deploy/README.md](deploy/README.md): putting the manager on a server, deploying Bee nodes to
  other hosts, and opening the manager to the internet.
- [docs/console.md](docs/console.md): the console's pages, the readiness checklist and the
  new-deployment wizard.
- [docs/ci.md](docs/ci.md): what the CI jobs run, the pins, and how to run the same checks locally.
- [manager/test/integration/README.md](manager/test/integration/README.md): the signed-in
  integration suite against a running manager.
- [docs/features/](docs/features/): one page per feature.
  - [stack-versions.md](docs/features/stack-versions.md): stack versions, their builds and their
    settings files.
  - [deployment-settings.md](docs/features/deployment-settings.md): every key a deployment's version
    declares, set for one deployment or in the wizard, and Apply.
  - [engine-control.md](docs/features/engine-control.md): the media engine's settings, restart,
    logs and effective config.
  - [engine-config.md](docs/features/engine-config.md): a deployment's own SRS or OvenMediaEngine
    configuration file.
  - [srt-ingest-health.md](docs/features/srt-ingest-health.md): how the broadcast coming into SRS
    held up over the last minute.
  - [group-deployment.md](docs/features/group-deployment.md): several deployments created at once
    under one name.
  - [abr-ladder.md](docs/features/abr-ladder.md): a node pool with one Bee node per quality, and the
    pool string an uploader publishes to.
  - [bee-node-mode.md](docs/features/bee-node-mode.md): whether a Bee node runs light or
    ultra-light, and which chain endpoint it uses.
  - [postage-stamps.md](docs/features/postage-stamps.md): buying, using, topping up and diluting a
    postage batch.
  - [chequebook.md](docs/features/chequebook.md): filling a Bee node's chequebook and recovering a
    transfer.
  - [web2-admin-link.md](docs/features/web2-admin-link.md): linking uploaders to the admin, the
    uploader's own token, and Test connection.
  - [stages.md](docs/features/stages.md): the stage records the manager pushes into the admin,
    and the catalogue node.
  - [auth-and-public-access.md](docs/features/auth-and-public-access.md): the sign-in, the HTTPS
    edge, the API binds and the host firewall.

## Checks

The `infra-manager` workflow runs on every pull request into `main`: the build, type checks, lint,
format and unit suites, the SQL suites against disposable databases, the browser suites against a
real headless Chrome, and a build of the two images. The Docker-backed suites and the signed-in
integration suite run when started by hand or by the `docker-checks` label.
[docs/ci.md](docs/ci.md) has the details.
