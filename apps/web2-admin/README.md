# web2-admin

The admin is the brand console of the streaming platform. A brand's operators sign in to it to
draft streams, publish them to the stream list that viewers read (the catalogue), get the OBS
connection details for each stream, watch the stages they broadcast on, and fund the nodes behind
them. This page is the admin's README: what it is made of, how to run it on your machine in a
minute, and where the rest of its documentation lives.

The admin works beside two other parts of the platform. The manager (`apps/infra-manager`) runs
the hosts and the Swarm nodes and tells the admin about every stage it deploys. The stack
(`apps/hls-stream`) takes a broadcast in, packages it and uploads it to Swarm, and its uploader
asks the admin which stream an encoder is publishing to. How the three fit is in
[docs/architecture/web2-admin.md](../../docs/architecture/web2-admin.md).

## Packages

| Package     | Name                                      | What it is                                                                                                                                      |
| ----------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/`   | `@streaming-monorepo/web2-admin-common`   | The API contract: the types the backend answers and the console reads, the stream limits, and the OBS ingest URL builders.                      |
| `backend/`  | `@streaming-monorepo/web2-admin-backend`  | The API: Express 5 on PostgreSQL. Sign-in, streams, publishing to the catalogue, the uploader's and the manager's internal routes, and funding. |
| `frontend/` | `@streaming-monorepo/web2-admin-frontend` | The console: React, MUI and Vite, served by nginx in production.                                                                                |
| `deploy/`   |                                           | `deploy.sh` and the production compose file that put the admin on a host.                                                                       |

## Run it locally

From the repository root, install once for the whole workspace:

```bash
pnpm install
```

Then, from `apps/web2-admin`:

```bash
cp backend/.env.sample backend/.env                         # set FEED_PRIVATE_KEY, and FEED_GATEWAY=fake to work without a Bee node
pnpm --filter @streaming-monorepo/web2-admin-backend database:start
pnpm --filter @streaming-monorepo/web2-admin-backend user:add alice
pnpm dev                                                    # API on :9877, console on :5081
```

Open http://localhost:5081 and sign in as the user you just made. There is no seeded account:
[The first user](backend/README.md#the-first-user) says why and how to make one on a server. The
Access page manages users and passwords after that.

To work on the console with no database at all, run the mock API instead of the backend, as
[the frontend's README](frontend/README.md#without-the-backend-the-mock-api) shows.

## Documentation

- [backend/README.md](backend/README.md): the API and settings reference, and how publishing,
  stages, the catalogue and funding work.
- [frontend/README.md](frontend/README.md): running and developing the console, its pages and its
  looks.
- [deploy/README.md](deploy/README.md): the deploy guide, from a fresh host to HTTPS.
- [backend/test/integration/README.md](backend/test/integration/README.md): the integration
  tests, what they cover and what they need.
- [docs/architecture/web2-admin.md](../../docs/architecture/web2-admin.md): what the admin is for
  and how it relates to the manager and the stack.
- [docs/architecture/web2-admin-auth.md](../../docs/architecture/web2-admin-auth.md): how sign-in
  works.
- [docs/architecture/stages.md](../../docs/architecture/stages.md): what the manager tells the
  admin about every stage it runs.
- [docs/architecture/funding.md](../../docs/architecture/funding.md): how the admin funds the
  nodes through the manager.

## Checks

From `apps/web2-admin`, each runs every package's own script:

```bash
pnpm test        # unit tests of every package, and the deploy scripts' tests
pnpm typecheck
pnpm lint
pnpm build
```

The integration tests need a Postgres and are run on their own, as
[their README](backend/test/integration/README.md) says.
