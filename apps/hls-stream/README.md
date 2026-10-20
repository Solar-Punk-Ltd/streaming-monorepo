# Swarm HLS Stream

Live and recorded video streaming over [Swarm](https://www.ethswarm.org/), the decentralised storage
network, with no CDN in between. This folder, `apps/hls-stream`, is the stack: the media engine that
takes a broadcast, the stream uploader that publishes it to Swarm, and the viewer that plays it. It is
one app of the streaming monorepo, beside the admin (`apps/web2-admin`) and the manager
(`apps/infra-manager`).

```
OBS or ffmpeg ──SRT/RTMP──> SRS or OME ──HLS segments──> stream uploader ──> Swarm
                                                                               │
                                                  viewer <── feed lookup + segment fetch
```

A broadcaster pushes SRT or RTMP to the media engine, SRS or OvenMediaEngine (OME). The engine cuts
the stream into HLS segments. The uploader uploads each segment to Swarm and publishes the playlists
as Swarm feeds, which a viewer can always find from the publisher's address and a topic. When the
broadcast ends, the uploader publishes the recording. With the ABR ladder on, SRS transcodes each
broadcast into several qualities and the viewer switches between them.

The uploader runs in one of two modes. Standalone, the default, needs nothing else: the uploader keeps
the stream list (the catalogue) on Swarm itself, and any HLS producer can also push segments through
its HTTP API. Admin mode, which `ADMIN_API_URL` turns on, is how the platform runs it: the admin owns
the catalogue and declares streams before they publish, and the uploader reports each stream's state
back to it.

## Run it in a minute

You need Node.js 24 or later, pnpm, Docker with Compose, [jq](https://jqlang.github.io/jq/download/),
and a Bee node on Gnosis Chain funded with xDAI and BZZ.

```bash
pnpm install                    # the whole workspace, from the root lockfile
./deploy/scripts/setup.sh       # creates deploy/config.json and .env, and builds the packages
# set STREAM_KEY in .env, start the Bee node and fund it, then:
pnpm stamp:setup                # buys a postage batch and writes STAMP to .env
./deploy/scripts/deploy.sh      # starts everything enabled in deploy/config.json
```

The [deploy guide](deploy/README.md) walks through each step.

## Where to read next

| Page                                                         | What it covers                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| [Deploy guide](deploy/README.md)                             | Topology, first deploy, profiles and port slots, the deploy scripts            |
| [Stream uploader](packages/stream-uploader/README.md)        | Settings, HTTP API, publish keys, admin mode, health states, metrics, limits   |
| [How the uploader publishes](packages/stream-uploader/concepts.md) | Feeds, the ABR ladder, the manifest contract, reconnects, time markers   |
| [Engines](engines/README.md)                                 | SRS and OME, the SRS fork, the ABR ladder, your own config file                |
| [Client](packages/client/README.md)                          | The viewer: settings, the node picker, playback behaviour, the QoE overlay     |
| [CLI](packages/cli/README.md)                                | Bee node and postage batch commands                                            |
| [Testing](e2e/README.md)                                     | Unit tests, the end-to-end suites, browser drivers, the latency benchmark      |

## Packages

| Package                                      | What it is                                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [stream-uploader](packages/stream-uploader/) | Receives HLS segments, uploads them to Swarm, publishes the feeds                                                |
| [client](packages/client/)                   | The React viewer for browsing and playing streams                                                                |
| [cli](packages/cli/)                         | Bee node and postage batch management                                                                            |
| [shared](packages/shared/)                   | The stream, playlist, log and publish-key contracts the uploader, the client and the harness share               |
| [audit-gate](packages/audit-gate/)           | Development tooling: `pnpm audit:check`, which fails on a dependency advisory that is not on its reviewed list   |
| [gate-facts](packages/gate-facts/)           | Development tooling: `pnpm gate:facts` prints the figures a pull request description may quote, each with the command that produced it |
| [deploy](deploy/)                            | Deploy scripts, the compose file and their tests                                                                 |
| [e2e](e2e/)                                  | End-to-end suites against a deployed stack, and the harness's own tests                                          |

```
packages/
  stream-uploader/     # the uploader service
  client/              # the React viewer
  cli/                 # Bee node and postage batch CLI
  shared/              # shared contracts
  audit-gate/          # dependency advisory check
  gate-facts/          # change, test and dependency evidence for pull requests
engines/
  srs/                 # SRS config template and entrypoint
  ome/                 # OME config template and entrypoint
deploy/
  scripts/             # setup, deploy, stop, health, clean and the test-run wrappers
  docker-compose.yml   # every service, with compose profiles
  config.sample.json   # the topology template
nodes/                 # Bee node initialisation
e2e/                   # end-to-end suites, browser drivers and the harness's unit tests
```

## Development

```bash
pnpm build                         # build every package
pnpm client:start                  # the viewer's dev server, on localhost:5173
pnpm uploader:start                # the uploader, from its build
pnpm srs:host                      # SRS on the host network
pnpm ome:host                      # or OME instead. The stack runs one engine
pnpm verify                        # lint, typecheck, build, test and format check
```

`pnpm verify` stops at the first failing stage, so a lint error hides later results. CI runs
typecheck, lint, build and test as steps of one job, and the format check as a job of its own. Three
more CI jobs need a registry or a Docker daemon, so they stay outside `pnpm verify`:
`pnpm audit:check` for dependency advisories, `pnpm shellcheck` for the shell scripts, and the image
build of the uploader, client, bench and browser Dockerfiles. Run the first two before you change what
they cover.

## Configuration

The stack's `.env` holds the core settings. See [.env.sample](.env.sample). Engine settings live next
to each engine, in `engines/<name>/.env` (copy [engines/srs/.env.sample](engines/srs/.env.sample) or
[engines/ome/.env.sample](engines/ome/.env.sample)). The uploader loads the file for the engine `ENGINE`
names. `deploy/scripts/setup.sh` creates these files for the engines enabled in `deploy/config.json`. A
value in the stack's `.env`, or in a container's environment, wins over the engine file. Nothing reads
a `.env` at the monorepo root.

## License

MIT
