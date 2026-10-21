# CI and local checks

This is the reference for the manager's continuous integration: which workflow runs what, which
actions and images are pinned, and how to run the same checks on your own machine. The manager is
`apps/infra-manager`. Its workflows live at the repository root, because GitHub runs workflows from
the root `.github` folder only.

No job reaches a real host, a Bee node or a wallet. A green check says the code builds and its
suites pass. It says nothing about a deployment.

## `infra-manager.yml`: every pull request

It runs on a pull request into `main` and on a push to `main` when any of these change:
`apps/infra-manager`, `apps/hls-stream` (the manager's tests read the stack), `packages/` (the
manager imports the shared packages), `tools/app-workspace` (the images build through it), the root
`package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml`, the root `.oxlintrc.json` and
`.oxfmtrc.json`, or the workflow file. Its steps run in `apps/infra-manager`. All four jobs run on
`ubuntu-latest`.

| Job        | What it runs                                                                                                                                                                                                                   | Limit  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `checks`   | Install from the frozen lockfile, build `common`, type check every package with its tests, lint with oxlint, check formatting with oxfmt, the unit suites of `common`, the manager and the frontend, and the frontend build.   | 20 min |
| `database` | The SQL suites in `manager/test/database/`, each against its own disposable database in a Postgres service container, through `manager/test/database/run-all.mjs`.                                                             | 20 min |
| `browser`  | The suites under `frontend/test/`, most of them driving a real headless Chrome against a real Vite, through `frontend/test/run-all.mjs`.                                                                                       | 30 min |
| `images`   | Builds `frontend/Dockerfile` and `manager/Dockerfile` the way a deploy builds them on the host, from a copy of the manager's folder made by `tools/app-workspace/in-copy.mjs`, and throws both images away. Nothing is pushed. | 20 min |

The manager's unit tests compare the stack's guides, samples and contract fixtures against
`apps/hls-stream` of the same commit, so nothing else is fetched.

## `infra-manager-docker.yml`: by hand or by label

These jobs start real containers, so they do not run on every push. Start them in one of two ways:

- **Run workflow** on the Actions tab, on any branch.
- Add the label `docker-checks` to a pull request. A later push to that pull request runs them
  again while the label stays.

| Job             | What it runs                                                                                                                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `srs-parser`    | `manager/test/docker/srs-check-isolation.sh`: eight SRS config files checked at once by the manager's own config checker on the stack's SRS image. Every valid file is accepted and every refusal names the directive of its own file. |
| `ome-gate`      | `manager/test/docker/ome-admission-gate.sh`: SRT in, a signed admission webhook out and an HLS playlist served, from OvenMediaEngine in throwaway containers.                                                                          |
| `image-race`    | `manager/test/docker/shared-image-race.sh`: two Compose projects building one image name, reproduced and then closed with per-project image names.                                                                                     |
| `version-build` | `manager/test/docker/stack-version-build.sh`: `manager/scripts/stack-version-build.sh` on the commit under test, and checks of the staging tree it leaves.                                                                             |
| `integration`   | The manager built and started on the runner with Postgres beside it, a user created through the CLI, and the signed-in integration suite run against it. See [the integration testing page](../manager/test/integration/README.md).    |

The `integration` job needs the repository secret `ITEST_PASSWORD`, the password of the user the
suite signs in as. The job refuses to start without it and never prints it. Its manager builds the
bundled stack by fetching the commit under test from this repository on GitHub without a login.

## What the runners refuse

The SQL and browser suites skip themselves when their database or browser is missing, so a plain
`node --test` run can pass while testing nothing. The two runners close that:

- `manager/test/database/run-all.mjs` refuses to start when a port variable of `SUITE_DATABASES` is
  unset or is not a port, when a suite file is gated on a variable the run does not set, or when a
  database already holds the manager's own tables (`_migrations` or `profiles`), which means the
  port leads to a real deployment. It runs one file at a time.
- `frontend/test/run-all.mjs` runs one file at a time, each in a child process of its own, and
  kills a file that runs longer than `SUITE_TIMEOUT_MS`, 600 seconds, naming it.
- Both refuse a failed test, a skipped test, a suite that skipped itself whole, a run with no
  tests, a missing summary, a signal and a non-zero exit. The shared rules are in
  `manager/test/support/tapJudge.mjs`.
- The `browser` job sets `CHROME_BIN` to `/usr/bin/google-chrome` and fails its first step when
  nothing executable is there. It also sets `CHEQUEBOOK_TEST_PG_PORT`, because
  `transfer-connected-browser.test.mjs` signs into a real manager over a real database.

## Pins

Actions are pinned by commit, with the tag in a comment. Both workflows use the same three:

| Action               | Pin                                                 |
| -------------------- | --------------------------------------------------- |
| `actions/checkout`   | `3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1) |
| `pnpm/action-setup`  | `ea17c68df8912ef543352723c149a84f56e3d413` (v6.1.0) |
| `actions/setup-node` | `820762786026740c76f36085b0efc47a31fe5020` (v7.0.0) |

pnpm comes from the `packageManager` field of the root `package.json`, and Node from the root
`.nvmrc`. Before a pin moves, check the new release's age, its signature and attestation, and the
known-malware advisories, as for any dependency.

Container images are pinned by digest. The resolved column is the day the tag was resolved to that
digest, because a tag moves and a digest does not. The SRS row is the image the stack's own compose
files pin, and its date is the day they first pinned that digest. `manager/test/unit/srsImagePin.test.ts`
fails when that row, the harness and the stack's compose files disagree.

| Image                                             | Digest                                                                    | Resolved   | Used by                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------- | ---------- | ----------------------------------------------- |
| `postgres:16.15-alpine`                           | `sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea` | 2026-09-27 | database, browser, integration                  |
| `ghcr.io/solar-punk-ltd/swarm-srs:6.0-r2-swarm.4` | `sha256:090f7b4e9017629b6837866e314e5576f7a1becf4cf3bfd85f393ada0e5f5d5a` | 2026-10-05 | srs-parser, and the engine startup observations |
| `airensoft/ovenmediaengine`                       | `sha256:172da9129d32093f3c92c426d385a318db38c7e70de0a3a685693e69614672a6` | 2026-09-08 | ome-gate                                        |

`SRS_CHECK_IMAGE` overrides the SRS harness image and is refused unless it carries `@sha256:`.

## Running the same checks locally

Run these from `apps/infra-manager` after `corepack pnpm install` at the repository root.

The build, type checks, lint, format and unit suites:

```sh
pnpm --filter @streaming-infra-manager/common build
pnpm typecheck
pnpm lint
pnpm format:check
pnpm -r test
```

`manager/test/unit/run.mjs` gives the manager's unit run a throwaway stack folder as `SHLS_ROOT`,
pins `BEE_LOCAL_HOST` and supplies a placeholder `DATABASE_URL`, because the config module
requires one at load and no unit test opens a database. To run one file by hand, give it the same
three:

```sh
cd manager
SHLS_ROOT="$(mktemp -d)" BEE_LOCAL_HOST=127.0.0.1 DATABASE_URL=postgres://unused@localhost/unused \
  pnpm exec tsx --conditions=development --test test/unit/<file>
```

The SQL suites, on a disposable Postgres of their own:

```sh
docker run --rm -d --name manager-test-pg -e POSTGRES_HOST_AUTH_METHOD=trust \
  -p 127.0.0.1:55432:5432 \
  postgres:16.15-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea
for name in engine_config_test build_references_test stack_versions_test port_reservations_test version_approval_test chequebook_test profile_removal_test deployment_settings_test deploy_phases_test; do
  docker exec manager-test-pg createdb -U postgres "$name"
done
export ENGINE_CONFIG_TEST_PG_PORT=55432 BUILD_REFERENCES_TEST_PG_PORT=55432 STACK_VERSIONS_TEST_PG_PORT=55432 \
  PORT_RESERVATIONS_TEST_PG_PORT=55432 VERSION_APPROVAL_TEST_PG_PORT=55432 CHEQUEBOOK_TEST_PG_PORT=55432 \
  PROFILE_REMOVAL_TEST_PG_PORT=55432 DEPLOYMENT_SETTINGS_TEST_PG_PORT=55432 DEPLOY_PHASES_TEST_PG_PORT=55432
pnpm --filter @streaming-infra-manager/api test:database
docker rm -f manager-test-pg
```

The browser suites, with the same database up so the connected transfer suite runs. Point
`CHROME_BIN` at your Chrome or Chromium. Without `CHEQUEBOOK_TEST_PG_PORT` the runner refuses the
run:

```sh
export CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
export CHEQUEBOOK_TEST_PG_PORT=55432
pnpm --filter @streaming-infra-manager/frontend-prototype test:browser
```

`BROWSER_CPU_THROTTLE=4` slows every page the harness opens by that factor, so a race that shows
only on a two-core runner shows on a fast laptop too. To run the suites on two pinned cores with
the runner's Chrome major, in a container, pass a suite file or nothing for all of them:

```sh
sh frontend/test/docker/browser-on-two-cores.sh pool-draft-browser.test.mjs
```

The connected transfer suite has no database in that container, so the runner refuses that one
file there.

The two images, as the `images` job and a deploy build them:

```sh
node ../../tools/app-workspace/in-copy.mjs --app apps/infra-manager -- docker build --file frontend/Dockerfile --tag manager-web:checks .
node ../../tools/app-workspace/in-copy.mjs --app apps/infra-manager -- docker build --file manager/Dockerfile --tag manager-api:checks .
```

The Docker harnesses. Each exits 0 on a pass, 1 on a wrong answer and 2 on a problem with the
harness itself:

```sh
bash manager/test/docker/srs-check-isolation.sh
bash manager/test/docker/ome-admission-gate.sh
bash manager/test/docker/shared-image-race.sh [rounds]
bash manager/test/docker/stack-version-build.sh <commit> <repo-url>
```

`stack-version-build.sh` builds the whole stack from a pushed commit, so it belongs on a runner
rather than a laptop.

The integration suite needs a running manager, a user and the sign-in pair in its environment.
[manager/test/integration/README.md](../manager/test/integration/README.md) has the steps.

## What CI does not cover

- No job deploys to a host, runs a Bee node against a real chain or moves money.
- The SQL suites use synthetic rows in fresh schemas on `127.0.0.1`. They say nothing about a
  deployment's database.
- The `images` job builds the images and does not run them.
- The Docker-backed jobs run only when started by hand or by the `docker-checks` label.
- There is no workflow lint and no secret scanner. The root `.github/CODEOWNERS` asks an owner to
  review any change under `.github/`.
