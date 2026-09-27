# streaming-monorepo

Solar Punk's multi-brand live streaming platform on [Swarm](https://www.ethswarm.org/). A brand
signs in to a console, creates a stream and gets its OBS settings. The streaming stack takes the
broadcast in, puts the video on Swarm as it happens and serves a viewer that plays it back without
a CDN. A manager deploys stack versions onto hosts and looks after the Bee nodes, postage stamps
and chequebooks they need. The interactive design of the whole is at
https://solar-punk-ltd.github.io/pilot-streaming-partnership/?model=mvp.

Every project of the platform lives here, each in its own folder with only its own dependencies.
How the folders relate and the rules that keep them apart are in
[docs/monorepo.md](docs/monorepo.md).

## What is here

| Folder | What it is |
|---|---|
| [`apps/web2-admin`](apps/web2-admin/README.md) | The brand console: an API on Postgres, a React front end, the API contract the two share, and its deploy script. |
| [`apps/hls-stream`](apps/hls-stream/README.md) | The streaming stack: SRS and OME ingest, the uploader that writes HLS segments to Swarm, the viewer, Bee node setup, the deploy scripts, and the e2e and bench harness. |
| [`apps/infra-manager`](apps/infra-manager/README.md) | The manager: an API and a console that deploy stack versions onto hosts and handle profiles, port slots, stamps and chequebooks. |
| [`infra/edge`](apps/web2-admin/deploy/README.md#public-https-the-hosts-edge) | The front door of a host: one Caddy that holds ports 80 and 443, gets the HTTPS certificates and sends each domain to the console behind it. |
| [`infra/terraform`](infra/terraform/README.md) | The pilot's cloud hosts: the GCP stage and monitoring hosts, the Vps Bee hosts, and the monitoring stack. |
| [`docs`](docs/) | How the pieces fit: the layout and its rules, the host roles, the roadmap, the design briefs, what is deployed where, and notes on the neighbouring systems. |

Scripts that serve the whole repository go under `tools/`: the boundary check, which keeps the apps
from depending on each other, and the cut of each app's own lockfile out of the root one.

## Working in an app

The repository is one pnpm workspace, so one install at the root, from its one lockfile, installs
all three apps. Then go into an app and use its own commands, which cover that app alone:

```sh
pnpm install            # at the root, once
cd apps/web2-admin      # or apps/hls-stream, or apps/infra-manager
pnpm test
```

Each app keeps its own `package.json`, with its scripts and its dependencies, and pnpm lets a
package import only what it declares, so the apps stay apart. The pnpm release is the
`packageManager` field of the root `package.json`, which each app's `package.json` repeats, and
with corepack enabled `pnpm` is that release. The security overrides, the builds allowed and the
other workspace settings are in the root `pnpm-workspace.yaml`. The Node release is the root
`.nvmrc`, one for every app: the workflows read it, and the Node base image of every Dockerfile
matches it.

At the root, `pnpm build`, `pnpm typecheck`, `pnpm test` and `pnpm lint` run that script in every
package of every app that has it, through Nx, which runs a package after the packages it depends
on. Nx replays a type check whose files and dependencies have not changed from its cache in
`.nx/`, and runs everything else each time. It never contacts Nx Cloud. `pnpm boundaries` checks
that no app depends on another ([the rules](docs/monorepo.md#projects-never-import-each-others-code)).

Each app's README says what its commands are and what a development setup needs:
[the admin's](apps/web2-admin/README.md), [the stack's](apps/hls-stream/README.md) and
[the manager's](apps/infra-manager/README.md).

## Where the work happens

All work on the platform happens here, since 2026-09-27. The stack and the manager came in whole
from their own repositories, swarm-hls-stream and streaming-infra-manager, and `infra/terraform`
from the `terraform/` folder of pilot-streaming-partnership. Those repositories are left as they
are: they get nothing new, and nothing more is pulled from them.

The manager builds the stack it bundles from `apps/hls-stream` of the same commit it is deployed
from, and builds every version added on its Versions page from this repository too, so a plain
clone has everything and nothing links back to the old repositories. A version built from
swarm-hls-stream before the move keeps its record of where it came from.

Every original commit of the imported repositories is in this one under its own id.
[docs/monorepo.md](docs/monorepo.md#how-the-history-came-along) says how to read that history.

## Documents

- [docs/monorepo.md](docs/monorepo.md): the layout, the rules between projects, and how the history came along.
- [docs/hosts.md](docs/hosts.md): the three kinds of host, the edge, and the names on the hosts that never change.
- [docs/ROADMAP.md](docs/ROADMAP.md): the roadmap and the checkpoint log.
- [docs/architecture/](docs/architecture/): the design briefs, starting with the [admin layer](docs/architecture/web2-admin.md).
- [docs/infra-state.md](docs/infra-state.md): what is deployed where.
- [docs/research/](docs/research/README.md): condensed notes on the systems the admin talks to.
- Deploying: [the admin](apps/web2-admin/deploy/README.md), [the stack](apps/hls-stream/deploy/README.md), [the manager](apps/infra-manager/deploy/README.md), and [the pilot's hosts](infra/terraform/README.md).

## Licence

The whole repository is under the MIT licence in the root [LICENSE](LICENSE): every app, package
and folder. The two packages that keep a licence file of their own, the stack's
[uploader](apps/hls-stream/packages/stream-uploader/LICENSE) and
[viewer](apps/hls-stream/packages/client/LICENSE), hold the same text.
