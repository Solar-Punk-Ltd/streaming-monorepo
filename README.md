# streaming-monorepo

A live streaming platform on [Swarm](https://www.ethswarm.org/), the decentralised storage network
run by Bee nodes. A broadcaster streams from OBS or ffmpeg, the platform writes every video segment
to Swarm as it happens, and viewers play the stream straight from Swarm, with no CDN and no server
of the broadcaster's in the path. One installation serves a brand: an organisation with its own
console users, its own signing key and its own list of streams.

This README is the front door. It says what the platform is made of, how to get it running, and
where the rest of the documentation is.

## What is here

| Part                                                    | What it is                                                                                                                                                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [The admin](apps/web2-admin/README.md)                  | The brand console, `apps/web2-admin`. Brand users sign in, create streams, get the encoder settings for each, and publish the stream list (the catalogue) to Swarm. It also funds the nodes.  |
| [The stack](apps/hls-stream/README.md)                  | The streaming software, `apps/hls-stream`: the ingest engine (SRS or OvenMediaEngine), the uploader that writes HLS segments to Swarm, Bee node setup, the deploy scripts and the e2e suites. |
| [The viewer](apps/hls-stream/packages/client/README.md) | A web player inside the stack, `apps/hls-stream/packages/client`. It reads the catalogue and plays each stream from a Bee gateway or from a light Swarm node in the browser tab.              |
| [The manager](apps/infra-manager/README.md)             | The operator's console, `apps/infra-manager`. It deploys the stack onto hosts over ssh, runs the Bee nodes, buys postage and tells the admin about every stage it runs.                       |

A stage is one stack deployment that takes broadcasts in, with the Bee nodes behind it.
[docs/architecture/overview.md](docs/architecture/overview.md) explains how the parts fit.

Beside the apps: `packages/` holds code two apps share, `infra/edge` the HTTPS front door of a
host, `tools/` the scripts that serve the whole repository, and `scripts/public-leaks` the check
that keeps real addresses and secrets out of the tree.

## Quick start

To run the platform yourself, follow [docs/self-hosting.md](docs/self-hosting.md). It takes you from
empty Linux machines to a first live stream: the hosts to rent, the deploy scripts to run, how to
fund the Bee nodes and which ports to keep closed. One machine can carry every role for a first try.

To work on the code, you need Node 24 and corepack:

```sh
corepack enable
pnpm install
pnpm test
```

## Working in the repository

The repository is one pnpm workspace. One install at the root, from its one lockfile, installs all
three apps. Then go into an app and use its own commands, which cover that app alone:

```sh
cd apps/web2-admin      # or apps/hls-stream, or apps/infra-manager
pnpm test
```

Each app keeps its own `package.json`, and pnpm lets a package import only what it declares, so the
apps stay apart. The pnpm release is the `packageManager` field of the root `package.json`, which
each app repeats. The Node release is the root `.nvmrc`, which the workflows read and every
Dockerfile's Node base image matches. Overrides and workspace settings live in the root
`pnpm-workspace.yaml`.

Commands at the root run over every app:

| Command                                     | What it does                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pnpm build`, `pnpm typecheck`, `pnpm test` | runs that script in every package that has it, through Nx, after the packages it depends on                  |
| `pnpm lint`                                 | oxlint over every package, with the settings in `.oxlintrc.json`                                             |
| `pnpm format`, `pnpm format:check`          | oxfmt over the repository except `infra/`, with the settings in `.oxfmtrc.json`                              |
| `pnpm boundaries`                           | fails when one app depends on another ([the rules](docs/monorepo.md#projects-never-import-each-others-code)) |

Nx replays a type check or a lint whose inputs have not changed from its cache in `.nx/`, and never
contacts Nx Cloud. Each app's README lists its own commands and what a development setup needs.

## Documentation

Running the platform:

- [docs/self-hosting.md](docs/self-hosting.md): a guide from empty hosts to a first live stream, the firewall, funding the Bee nodes, and the host names that never change.
- [docs/releasing.md](docs/releasing.md): a guide to tagging a release and deploying it.

How it works:

- [docs/architecture/overview.md](docs/architecture/overview.md): the parts, how a stream travels, the ports, and what must never be public.
- [docs/architecture/stages.md](docs/architecture/stages.md): how the admin learns every stage from the manager, the tokens and keys, and the catalogue batch.
- [docs/architecture/funding.md](docs/architecture/funding.md): how a brand funds its nodes, stamps and chequebooks from the admin.
- [docs/architecture/](docs/architecture/): the admin's own design pages.

Working on the code:

- [docs/monorepo.md](docs/monorepo.md): the layout, the rules between apps, the workflows, and how to read the history.
- Each app's README, and its deploy guide: [the admin](apps/web2-admin/deploy/README.md), [the stack](apps/hls-stream/deploy/README.md), [the manager](apps/infra-manager/deploy/README.md).

## Related repositories

- [stream-event-client](https://github.com/Solar-Punk-Ltd/stream-event-client): a web app for watching an event's live streams and recordings over Swarm, with a chat beside each stream. It reads what this platform publishes ([how they are coupled](docs/architecture/overview.md#who-reads-what-we-publish)).

## Licence

The whole repository is under the MIT licence in the root [LICENSE](LICENSE). The two packages that
keep a licence file of their own, the stack's
[uploader](apps/hls-stream/packages/stream-uploader/LICENSE) and
[viewer](apps/hls-stream/packages/client/LICENSE), hold the same text.
