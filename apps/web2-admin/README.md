# web2-admin

The Web2 admin layer of the multi-brand Swarm streaming platform, split like
streaming-infra-manager:

| Package     | Name                                      | What                                                                                                                                                                             |
| ----------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/`   | `@streaming-monorepo/web2-admin-common`   | The API contract: types shared by backend and frontend, plus the OBS ingest URL builders.                                                                                        |
| `backend/`  | `@streaming-monorepo/web2-admin-backend`  | Express 5 + pg API: session auth, stream drafts, publish to the stream list feed, OBS connection details, and the stages and catalogue batch the manager pushes. See its README. |
| `frontend/` | `@streaming-monorepo/web2-admin-frontend` | React + MUI + Vite console modelled on msrs-client. See its README.                                                                                                              |

Design brief: [docs/architecture/web2-admin.md](../../docs/architecture/web2-admin.md).
Stages, what the manager tells the admin about every stage it runs:
[docs/architecture/stages.md](../../docs/architecture/stages.md). The admin's env
file carries no stage: it needs its database, a brand key and the registrar
token the manager pushes with, and every stage's uploader presents a token of
its own.
Checkpoint 2 spec: [docs/architecture/web2-admin-checkpoint-2.md](../../docs/architecture/web2-admin-checkpoint-2.md).
Roadmap: [docs/ROADMAP.md](../../docs/ROADMAP.md).

## Run it locally

```bash
pnpm install                                                # the whole workspace, from the root lockfile
cp backend/.env.sample backend/.env                         # set FEED_PRIVATE_KEY. FEED_GATEWAY=fake needs no Bee
pnpm --filter @streaming-monorepo/web2-admin-backend database:start
pnpm dev                                                    # backend on :9877, frontend on :5081
```

There is no seeded account. Create the first user on the host, which makes it
an admin:

```bash
pnpm --filter @streaming-monorepo/web2-admin-backend user:add <username>
```

Then log in at http://localhost:5081. The Access page manages users and
passwords.
