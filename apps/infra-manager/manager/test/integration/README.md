# Integration tests

This is the testing page for the manager's integration suite: end-to-end tests that drive a
running manager over HTTP the way the browser does, signed in, with the session cookie on every
request and the write header on every write. They create real deployments through the API, wait
for them to come up, exercise edit, stop and remove, and the group features.

They are not unit tests. They start real containers through the stack's deploy scripts, take
minutes, and remove what their run created. They run only against a manager you declare as a test
target. Never point them at a manager whose deployments hold funds.

## What the suite needs

1. A running manager, with Docker running beside it. The deploys start Bee, SRS and client
   containers.

   ```sh
   # from manager/
   pnpm database:start      # Postgres
   pnpm dev                 # the API on :9876
   ```

   A manager started with `pnpm stack:start` runs in Compose project `streaming-infra-manager`.
   Its API port is internal, and the web proxy publishes `http://127.0.0.1:8080`, or the configured
   `WEB_PORT`. Use that proxy URL for both target variables below.

2. A user to sign in as. The manager has no sign-up, so create one on the manager you are testing,
   for example `itest`:

   ```sh
   # from manager/, for the Compose stack
   <command that prints the password> | docker compose -p streaming-infra-manager -f ./docker-compose.yml exec -T api node dist/cli.js user:add itest --password-stdin
   ```

   Against a manager started with `pnpm dev`, run the same CLI from `manager/` as
   `pnpm exec tsx --conditions=development src/cli.ts user:add itest --password-stdin`. The
   Docker-backed workflow signs in with the password in the repository secret `ITEST_PASSWORD`.

3. These variables in the shell that runs the suite. Put the sign-in pair there from wherever you
   keep it, so it is never written to a file:

   | Variable                | What it is                                                                                                                                                                   |
   | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `MANAGER_URL`           | The API's URL, `http://localhost:9876` by default, or the Compose web proxy's URL, `http://127.0.0.1:8080` by default                                                        |
   | `MANAGER_TEST_TARGET`   | The same URL, written again. It declares this manager a test target the suite may create and remove deployments on. The suite refuses to start when it is missing or differs |
   | `MANAGER_TEST_USERNAME` | The user to sign in as                                                                                                                                                       |
   | `MANAGER_TEST_PASSWORD` | Its password                                                                                                                                                                 |
   | `MANAGER_TEST_RUN`      | Optional, one to eight lowercase letters or digits. Gives every suite file the same run id. Without it each file is a run of its own                                         |

   Copy `env.example` to `env.itest` in this directory, which git ignores. It holds the URLs and the
   run id, never the sign-in pair.

## Run

```sh
# from manager/, with MANAGER_TEST_USERNAME and MANAGER_TEST_PASSWORD in the environment
set -a; . test/integration/env.itest; set +a
pnpm test:integration
```

A suite that cannot start fails in its first hook, in words, and creates nothing. A missing
declaration, an unreachable manager and a refused sign-in are three different messages, and no
message contains the password.

## What it covers

| Test                                                                    | Asserts                                                                                                                                                                                                               |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| signed in (`auth.test.ts`)                                              | A read with the cookie is answered, a read without it is refused with 401, a write without the request header is refused with 403 before the body is read, and the cookie of a signed-out session is refused with 401 |
| viewer lifecycle (`profiles.test.ts`)                                   | Deploys exactly `client` and `bee-gateway`, an edit of `feed_owner` and `notes` redeploys, stop gives `STOPPED`, remove leaves nothing                                                                                |
| streamer lifecycle (`profiles.test.ts`)                                 | Deploys `srs` and `bee-uploader` with `stream-uploader` held back (`pendingStamp`), then edit, stop and remove                                                                                                        |
| custom lifecycle (`profiles.test.ts`)                                   | Deploys exactly the chosen `components`, then stop and remove                                                                                                                                                         |
| group config edit (`groups.test.ts`)                                    | A two-viewer group, `feed_owner` edited for the whole group in one call, every member picks up the new feed and stays up, and removing the members deletes the empty group                                            |
| group resize (`group-resize.test.ts`)                                   | Grow a group by one member and deploy it, remove members until the group deletes itself. And remove the middle member, add one back, and the freed index is filled                                                    |
| ABR pool and uploader (`abr-node-pool.test.ts`, `abr-uploader.test.ts`) | The pool's publisher string and the uploader's Bee target rules. Each file's header has the details                                                                                                                   |
| engine config startup failure (`engine-startup-failure.test.ts`)        | A stored SRS file the manager's own check accepts and SRS exits on ends the rollout `failed`, and the deployment comes back `RUNNING` on the previous file                                                            |

The Docker-backed workflow's `integration` job runs the whole suite on a GitHub runner. See
[CI and local checks](../../../docs/ci.md).

Viewer groups use two members and the ABR cases a fixed four-rung pool. Several files can run at
once, so that is not a cap on the whole suite.

## What it creates, and what it removes

- Every resource the suite asks for is named `itest-<run>-<what>-<random>`, and teardown refuses a
  name outside its run's prefix. The prefix alone does not allow a deletion.
- A successful create registers the deployment's instance id before any assertion runs. A refused
  or lost create grants no right to clean up, so the suite never searches by prefix and deletes
  what it finds. It reports what it could not confirm instead.
- Every removal sends the confirmed instance id, which the manager compares before it removes
  anything, so a deployment created again under the same name is kept. An empty group's deletion
  checks the recorded group and its empty membership together.
- An accepted create starts the deploy and does not mean the deployment has left `DEPLOYING`.
  Tests wait for that exact instance to reach the state they need before they finish or remove it.
- Cleanup carries on across independent resources and reports every failure together. Each cleanup
  request has a five second budget, and an accepted removal is watched for up to 60 seconds. A
  refused or timed out write is not retried. A failed cleanup never counts as a clean run.

A lost create answer can leave a deployment whose identity was never confirmed. The suite reports it
and leaves it for you to inspect.

## Timeouts

- Reads and authentication wait at most 30 seconds for an answer (`FAST_REQUEST_TIMEOUT_MS`).
- Deployment writes wait at most 300 seconds (`DEPLOYMENT_WRITE_TIMEOUT_MS`), the console's own
  proxy budget.
- After an accepted write, `waitForStatus` polls for up to 240 seconds, the `DEPLOY_TIMEOUT` every
  file passes it. Its own default is 180 seconds.

## The other suites

- The SQL suites in `manager/test/database/` use disposable PostgreSQL databases with synthetic
  rows, one per suite family, through `pnpm test:database`. Setting `DATABASE_URL` does not select
  their target, and the runner refuses a database that already holds the manager's tables.
- The browser suites in `frontend/test/` run against a mock manager or a forked manager on a
  disposable database, with an isolated browser profile. They touch no Bee node, chain or funds.
- The SRS, OvenMediaEngine, shared-image and version-build harnesses in `manager/test/docker/` start
  real containers of their own.

[CI and local checks](../../../docs/ci.md) has the commands for each.
