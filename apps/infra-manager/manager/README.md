# Manager API and settings reference

This is the reference for the manager's API, `apps/infra-manager/manager`: its routes, the shapes
it answers, the settings it reads, and its limits. The manager is a TypeScript backend that runs
the streaming stack's deploy scripts (`apps/hls-stream`) on demand, and keeps each deployment's
port slot in PostgreSQL so two deployments on one host never collide on a port. The console in
`frontend/` is its only browser client. What each feature does for an operator is in
[docs/features/](../docs/features/), and putting the manager on a server is in
[the deploy guide](../deploy/README.md).

A deployment is called a profile in the API and in the database. Both words name the same thing.

## Stack

- Express 5, ESM, TypeScript.
- PostgreSQL 16, the single source of truth for port slot allocations, from 1 to 100 and no
  higher than the stack version allows (99 for the stack in this repository).
- Yup validates request bodies and parameters at the API edge.
- dotenv reads `manager/.env`.
- Docker-out-of-Docker: the api container runs `bash deploy.sh ...`, which calls `docker compose`
  against the host's daemon through the mounted `/var/run/docker.sock`.

## Run it

On one machine, deploying to `localhost`, from `apps/infra-manager`:

```bash
cp manager/.env.sample manager/.env
cd manager
node ../../../tools/app-workspace/in-copy.mjs --app apps/infra-manager -- docker build --file manager/Dockerfile --tag manager-api .
node ../../../tools/app-workspace/in-copy.mjs --app apps/infra-manager -- docker build --file frontend/Dockerfile --tag manager-web .
docker compose up -d
curl localhost:8080/health                      # {"status":"ok"}
docker compose exec -it api node dist/cli.js user:add <username>
```

The two images build from a copy of `apps/infra-manager` made outside the checkout by
`tools/app-workspace/in-copy.mjs`, which carries the manager's own lockfile cut out of the
repository's root one, and leaves every `.env` and `node_modules` behind. The tags are the names
Compose gives the `api` and `web` services, so `up` runs them without building again.

`8080` is the web container's port, `WEB_PORT`. The api container publishes no port, and the web
container's nginx forwards `/health` and the rest of the API to it. Under `pnpm dev` the API
answers on `localhost:9876` directly, which the examples below assume. Read `8080` for `9876` when
the manager runs under Compose.

For development without Docker deployments, `pnpm database:start` in `manager/` starts Postgres
alone and `pnpm dev` runs the API with a watch. `pnpm --filter @streaming-infra-manager/frontend-prototype dev:mock`
runs the console against an offline mock manager that needs no database, no Docker and no Bee
node.

## Authentication

Every route needs a session except four:

- `GET /health`, which answers `{"status":"ok"}` once the database answers a query.
- `POST /auth/login`.
- `GET /auth/session`, which answers 401 so the page can tell signed out from refused.
- `POST /auth/logout`, which answers 204 whatever cookie it is sent.

The funding API under `/api/admin-funding` is apart from all of them: it takes a bearer token of
its own and refuses a session, and every other route refuses a bearer (see [Funding API](#funding-api)).

Docker's healthcheck reads `/health` too: the `api` service asks it every 30 seconds, after a 60
second start period. `manager:upgrade` and the integration suite wait on it.

There is no sign-up. The first user is created on the host, once:

```bash
docker compose exec -it api node dist/cli.js user:add operator
```

It asks for the password twice with nothing echoed and stores only the hash. Without a terminal it
refuses unless `--password-stdin` is given, which reads the password from a pipe. No environment
variable or seed file carries a password. A password is 12 to 128 characters and must not contain
the username. It is stored as `scrypt$N$r$p$<salt>$<key>`, so the cost parameters can be raised
without invalidating stored passwords.

Signing in sets `sim_session=<token>; HttpOnly; SameSite=Lax; Path=/`, plus `Secure` when the
request arrived over HTTPS: `X-Forwarded-Proto: https` from the TLS edge, or a TLS connection to
the manager itself. The token is 32 random bytes and the database stores only its SHA-256. A
session ends after twelve hours without activity and fourteen days after sign-in at most. A stream
is not activity.

Signing out, revoking a user's sessions, removing a user or changing a password closes that
session's open event and command streams at once. Closing an output stream does not cancel an
accepted deploy, stop or version build. A health check stops when its stream closes.

Five wrong passwords for a username from one address, or from one address whatever the username,
start a one minute lockout that doubles per further attempt up to an hour, answered 429 with
`Retry-After`. A username's hundredth wrong password from all addresses together locks its sign-in
for everyone, on the same doubling, while sessions already signed in keep working.
[Lockout](../docs/features/auth-and-public-access.md#lockout) on the auth page has the details.

Every request that is not a GET must carry `X-Requested-With: streaming-infra-manager`, and one
whose `Origin` or `Sec-Fetch-Site` says it came from another site is refused with 403. The manager
sets no CORS headers, so a cross-origin page cannot add that header.

| Method | Path                              | Body                             | Answer                                                                                                                 |
| ------ | --------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| POST   | `/auth/login`                     | `{ username, password }`         | 204 and the cookie, 401 wrong pair, 429 locked, 409 when no user exists                                                |
| POST   | `/auth/logout`                    |                                  | 204, cookie cleared, session row deleted. Also 204 without a valid session                                             |
| GET    | `/auth/session`                   |                                  | `{ id, username, isAdmin, expiresAt }`, or 401 with `not_signed_in` or `no_users`                                      |
| POST   | `/auth/password`                  | `{ current, next }`              | 204, every other session of yours revoked                                                                              |
| GET    | `/auth/users`                     |                                  | `[{ id, username, isAdmin, createdAt, lastLoginAt, sessions }]`                                                        |
| POST   | `/auth/users`                     | `{ username, password, admin? }` | 201 and the new user's row, 403 `admin_required` unless you are an admin, 409 taken                                    |
| DELETE | `/auth/users/:id`                 |                                  | 204, 403 `admin_required` unless you are an admin, 404 no such user, 409 for yourself, the last user or the last admin |
| POST   | `/auth/users/:id/revoke-sessions` |                                  | 204 for your own id, and for anyone's if you are an admin, otherwise 403 `admin_required`. 404 no such user            |

Adding a user, removing one and signing someone else out need an admin. "Who can manage users"
under [Endpoints](../docs/features/auth-and-public-access.md#endpoints) on the auth page says who
is an admin.

**No HTTPS of its own.** The sign-in gate is only as good as the transport in front of it. The
host's edge, `infra/edge` at the repository root, terminates TLS. The deploy guide has the steps.

## Conventions

- Command routes (deploy, stop, health, version builds) stream their output as Server-Sent Events:
  `start`, `stdout`, `stderr`, `error`, `done`. Follow one with `curl -N`.
- `GET /events` is a Server-Sent Events stream of `profile.changed`, `profile.deleted`,
  `profile.notice`, `engine.restarted`, `version.changed` and `attempt.changed`.
- An error answer is JSON with an `error` code, and a `message` where a sentence helps.
- A route marked `no-store` answers with `Cache-Control: no-store`.
- A write that names `expectedInstanceId` or `expectedRevision` is refused with 409 when the
  deployment was replaced or the record moved since the caller read it.

## Profiles

| Method | Path                              | Body                        | Answer                                                                                                                                                     |
| ------ | --------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/profiles`                       | see below                   | 202 and the profile. Allocates the lowest free port slot that puts no port on a fetch bad port, and starts the deploy.                                     |
| GET    | `/profiles`                       |                             | `{ profiles }`, ordered by port slot                                                                                                                       |
| GET    | `/profiles/:name`                 |                             | One profile                                                                                                                                                |
| PUT    | `/profiles/:name`                 | the editable fields         | 202 and the profile. A full edit, which redeploys                                                                                                          |
| DELETE | `/profiles/:name`                 | `{ expectedInstanceId? }`   | 202 and the profile. Stops the containers, removes the data directory and execution copies, and frees the slot                                             |
| PATCH  | `/profiles/:name/notes`           | `{ notes, notes_revision }` | The notes alone, without a redeploy                                                                                                                        |
| PATCH  | `/profiles/:name/ingest-host`     | `{ ingest_host }`           | 200 and the profile. The public ingest address alone, without a redeploy. Null or empty for the resolved host (see [Stages](#stages))                      |
| GET    | `/profiles/:name/srt-passphrase`  |                             | `{ srt_passphrase }`, `no-store`. The deployment's own SRT passphrase, which no other answer carries. Every read is logged with the user's name            |
| GET    | `/profiles/:name/uploader-health` |                             | `{ state, reasons, waitingSince?, node?, startGateWarnings?, staleManifestStreamIds?, segmentFailingStreamIds? }`. See [Uploader health](#uploader-health) |
| GET    | `/profiles/:name/ingest-health`   |                             | `{ state, windowSeconds, srt?, rtmp? }`. See [Ingest health](#ingest-health)                                                                               |

`POST /profiles` takes `name` and `kind`, one of `streamer`, `viewer`, `custom` or
`abr-uploader` (`custom` when left out). Everything else is optional: `components`, `host`,
`notes`, `stack_version_id`, `feed_owner`, `feed_topic`, `private_key`, `public_key`, `stamp_id`,
`srt_passphrase`, `bee_url`, `bee_publishers`, `rpc_endpoint`, `rpc_endpoint_source`, `node_mode`,
`engine_settings` and `stack_settings`. A key the schema does not name is dropped. `abr_ladder`
belongs to `POST /groups`, and a create body carrying it is refused. `manager/src/schemas/profile.ts`
is the whole contract.

- `feed_topic` is the topic of the deployment's feed. The stack's deploy script writes it as
  `STREAM_LIST_TOPIC`, which an uploader publishes its stream list under, and as
  `VITE_APP_RAW_TOPIC`, which a player builds into its bundle beside `feed_owner`. It must match
  `^[A-Za-z0-9._-]{1,64}$` (`FEED_TOPIC_RE` in `common/src/feedTopic.ts`), or the route answers
  `400 validation_error`. Absent or null leaves the deployment on its stack version's topic,
  `swarm-stream` unless the version sets another. A `PUT` clears it when the body leaves it out.
- `engine_settings` is create-only, held to the rules of an engine settings save. A deployment
  that runs no media server, an ABR node pool among them, is refused rather than storing keys
  nothing reads.
- `stack_settings` is create-only too: a list of `{ key, value }` that the new deployment starts
  with instead of its version's values. It is checked against the list
  `GET /versions/:id/settings-catalog` answers for the kind, services and host the body describes.
  A key the version does not declare, a key one of the deployment's own controls decides, a key
  named twice, or a value the stack would read differently or outside its bounds refuses the whole
  create, each key named and no secret repeated.
- `rpc_endpoint` is the chain endpoint this deployment's own Bee nodes use. `rpc_endpoint_source`
  says where it comes from: `manager` is this manager's `BEE_RPC_ENDPOINT`, `stack` is the
  version's default and writes no line into the deployment's env file, and `custom` is the address
  in `rpc_endpoint`. `custom` and a stored address go together and only together. A create that
  names no source takes the manager's endpoint when there is one, and an address with no source is
  read as `custom`. An update that names no source keeps the stored choice.
- No answer carries a stored custom endpoint, because it can hold a provider's key. A profile
  answers `has_rpc_endpoint`, whether one is stored, and `rpc_endpoint_host`, its host with any
  user information removed. An edit that
  leaves the endpoint out keeps the stored one.
- `node_mode` is how much of a chain this deployment's Bee node runs with. `light` has a
  chequebook, gas and postage and can publish. `ultra-light` has no chain and can only retrieve.
  Empty is the mode the stack ships the node in: light for a `bee-uploader`, ultra-light for a
  `bee-gateway`. It is chosen at create, and an update with a different mode is refused. A
  `bee-uploader` asked to run ultra-light is refused, and a `bee-gateway` on `light` must name an
  endpoint. [Bee node mode](../docs/features/bee-node-mode.md) has the details.
- Every profile in an answer carries derived fields beside its stored columns. One is
  `network_host`: the deploy target in `host` with the SSH alias resolved away, so a client has an
  address to build links from. It equals `host` when there is nothing to resolve. Another is
  `pendingStamp`, see [The uploader held back for a stamp](#the-uploader-held-back-for-a-stamp).

### Port slots

**At most 100 deployments per host.** A port slot is a whole number from 1 to 100, and a stack
version may declare a lower ceiling, which the manager honours. The stack in this repository
declares 99, so a host running it holds at most 99 deployments. A stopped deployment still holds its
slot.

**Some slots are skipped.** The WHATWG fetch standard lists ports that Node's fetch and every
browser refuse ([port blocking](https://fetch.spec.whatwg.org/#port-blocking)), and a slot's ports
all follow from its number. So a new deployment skips any slot that would put a port on that list
(`FETCH_BLOCKED_PORTS` in `src/domain/ports/fetchBlockedPorts.ts`). With the bundled port table that
is slot 8, whose API port is 10080.

### Uploader health

`GET /profiles/:name/uploader-health` reads what the deployment's own `stream-uploader` says about
itself on its `/health`, at the uploader's API port for the deployment's slot, within three
seconds. The deployment page reads it every ten seconds, and the overview and the Deployments page
every thirty seconds for each running deployment with an uploader container. It never fails for a
reading.

`state` is one of:

| `state`            | Meaning                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `ok`               | The uploader reports itself healthy.                                                       |
| `waiting_for_node` | The uploader started and waits for its Bee node to answer. `waitingSince` says since when. |
| `warned`           | A start gate warned instead of refusing. `startGateWarnings` names each.                   |
| `unhealthy`        | The uploader reports a problem. `reasons` names each.                                      |
| `unreachable`      | Nothing answered on the uploader's API port.                                               |
| `not_deployed`     | The deployment has no uploader container.                                                  |

An `unhealthy` reading also carries `staleManifestStreamIds` and `segmentFailingStreamIds` when the
uploader names the streams whose playlist is not moving or whose segment uploads fail. A ladder rung
is a stream of its own, such as `live/stream_1080p`, so the id names the rung. An uploader that
names no stream ids reports none.

The deployment page's readiness checklist and the overview's "Needs attention" list show
`waiting_for_node`, `warned`, `unreachable` and `unhealthy` as warnings. The reason
`postage_refused` means a Bee node refused the batch it was paid with, usually because it is full
or expired, and that node's uploads fail until the uploader is deployed again with a batch that
pays.

### Ingest health

`GET /profiles/:name/ingest-health` says how the broadcast coming into SRS held up over the last
minute. SRS prints the packet counts of each SRT publisher, and each RTMP publisher's bitrate and
vhost, into its log about every ten seconds, and exposes them nowhere else. So the route reads the
last minute of the `srs` container's log, at most its last 20,000 lines, through the Docker socket
for a local deployment and over the deploy target's SSH for a remote one, and keeps those report
lines alone. The answer is numbers and states, never log text, because the log also carries the
uploader's webhook token and RTMP stream keys.

`state` is `read`, with the SRT part under `srt` and the RTMP part under `rtmp`, or why nothing was
read: `not_running`, `unreadable` or `not_srs`. `srt` is `{ state, reports?, connections?, counts?,
percent?, verdict? }`, its `state` `measured` or `no_reports`, and `verdict` is `healthy` (nothing
dropped), `degraded` (something dropped) or `bad` (dropped packets reached one percent of those
received). `rtmp` is `{ state, reports?, connections?, incomingKbps? }`, its `state` `measured`,
`no_reports` or `unattributed`, for the RTMP publishers on the ingest vhost. RTMP publishers on any
other vhost, the ABR ladder's rungs among them, are left out. Nothing gates on this reading.
[SRT ingest health](../docs/features/srt-ingest-health.md) describes the card that shows it.

## Groups

| Method | Path                         | Body                                                               | Answer                                                                                                                                                                                    |
| ------ | ---------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/groups`                    | `{ group_name, size, kind?, abr_ladder?, ... }`                    | 202 and `{ group, profiles }`. The rest is the create body of `POST /profiles` (`createGroupSchema` in `manager/src/schemas/profile.ts`). 409 `group_exists` for a name in use            |
| GET    | `/groups`                    |                                                                    | `{ groups }`, each `{ id, name, size, kind, created_at }`, oldest first                                                                                                                   |
| PATCH  | `/groups/:id/config`         | `{ notes?, feed_owner?, feed_topic?, stamp_id?, srt_passphrase? }` | 202 and `{ group, profiles }`. Applied to every member. An ABR node pool refuses `stamp_id` with 409 `ladder_group_invalid_operation`                                                     |
| POST   | `/groups/:id/members`        | `{ count }`                                                        | 202 and `{ group, profiles }`. An ABR node pool refuses it with 409 `ladder_group_invalid_operation`                                                                                      |
| DELETE | `/groups/:id`                | `{ expectedName }`                                                 | 204 once the group has no members, or was already gone. 409 `group_changed` when its name is no longer `expectedName`, 409 `group_not_empty` while it has members                         |
| GET    | `/groups/:id/bee-publishers` |                                                                    | `{ ready, value, rungs, missing, warnings }` (`BeePublishersResult` in `common/src/abrLadder.ts`). `value` is the paste-ready `BEE_PUBLISHERS`, null while a rung is missing or unstamped |

An unknown group id answers 404 `group_not_found` on every route but `DELETE`. `POST /groups`
takes `engine_settings`, `stack_settings`, `node_mode`, `rpc_endpoint_source` and `rpc_endpoint` on
the same terms as a create and writes them to every member. A node pool's members are one Bee node
each whatever `components` say, so a pool asked for `ultra-light` is refused. A member added to a
group later takes what its siblings run. [Group deployment](../docs/features/group-deployment.md)
and [the ABR ladder](../docs/features/abr-ladder.md) describe both kinds of group.

## Actions

| Method | Path                              | Body                      | What it runs                                                     |
| ------ | --------------------------------- | ------------------------- | ---------------------------------------------------------------- |
| POST   | `/profiles/:name/deploy`          | `{ services?: string[] }` | `deploy.sh --profile=<name> --portSlot=<n> [services]`, streamed |
| POST   | `/profiles/:name/stop`            | `{ services?: string[] }` | `stop.sh --profile=<name> --portSlot=<n> [services]`, streamed   |
| GET    | `/profiles/:name/health`          |                           | `health.sh --profile=<name> --portSlot=<n>`, streamed            |
| POST   | `/profiles/:name/deploy-uploader` |                           | Deploys `stream-uploader` alone, once a batch is set, streamed   |

When `services` is left out:

- `streamer` runs `srs stream-uploader bee-uploader`.
- `viewer` runs `client bee-gateway`.
- `abr-uploader` runs `srs stream-uploader` and no Bee node. It publishes to an ABR node pool's
  rungs, which hold the postage.
- `custom` passes no list, and the script runs everything enabled in the version's `config.json`.

The media engines `srs` (the default) and `ome` exclude each other, so `components` holds at most
one. With `ome` the manager writes `ENGINE=ome` and the slot-shifted `OME_SRT_PORT` and
`OME_HLS_PORT` into the deployment's `.env.<name>`, so the uploader runs its OvenMediaEngine plugin.

A deployment may carry its own `srt_passphrase`, written to `.env.<name>` as `SRT_PASSPHRASE` so
SRS encrypts that deployment's SRT listener with it. Left unset, the version's base `.env` decides.
It applies to SRS alone, because OvenMediaEngine's SRT listener takes no passphrase. A passphrase
is 10 to 79 characters of `A-Z a-z 0-9 . _ ~ -`: the bounds are libsrt's, and the character set
survives the engine's entrypoint, the env file, the SRS config and the `srt://...&passphrase=`
publish URL unchanged (`common/src/srtPassphrase.ts`).

A deploy takes minutes, so a manager restarted in the middle of one is ordinary. At boot, every
deployment still marked `DEPLOYING`, `STOPPING` or `REMOVING` is judged by what its services are
doing on the target, a service counting as up when at least one of its containers runs. A deploy
or removal that left every service up becomes `RUNNING`, otherwise `ERROR` naming each service that
is not up and Docker's state for it. A stop becomes `STOPPED` when nothing is up and `ERROR` naming
what still runs otherwise. A daemon that cannot be reached leaves the row `ERROR` saying so.

A stop that fails before its script starts marks the deployment `ERROR` with the reason at once. A
stop of a deployment that was replaced since the request read it is refused as an instance change.

**Commands stream over a held connection.** Closing it does not stop a deploy, a deploy-uploader or
a stop: each finishes on its own, the new state arrives as `profile.changed` on `/events`, and a
manager restarted mid-run reconciles the row at boot. Only a health check stops when its client goes
away.

**A deployment's status changes only on a deploy, a stop or another action.** An uploader that
failed its deploy, for example on a postage batch with less than `STAMP_MIN_TTL_HOURS` (12) left,
and then started by itself once the batch was topped up, still shows **Last deploy failed** while it
runs healthy. Deploy it again to clear the status.

### The uploader held back for a stamp

A postage stamp, or batch, is prepaid Swarm storage, bought on a running, funded Bee node. Only
`stream-uploader` needs one. The stack's `deploy.sh` refuses to start a `stream-uploader` whose env
file has neither a `STAMP` nor a `BEE_PUBLISHERS` value, and under the manager there is no terminal
to ask. So the manager never sends a deploy into that refusal. It splits the service list instead
(`splitDeployableServices` in `manager/src/domain/stampLogic.ts`):

- No `stream-uploader` in the set: deploy everything.
- `stream-uploader` with a `stamp_id` or a `bee_publishers` value: deploy everything, with `STAMP`
  written into `.env.<name>`.
- `stream-uploader` with neither: deploy the set without `stream-uploader`.

In the last case the rest of the deployment comes up and a batch can be bought on its Bee node. The
deployment reads `RUNNING`, and the derived `pendingStamp` field says the uploader is held back.
Once a batch exists, `POST /profiles/:name/deploy-uploader` deploys that one service.

The test is the component set, never the kind: a `custom` deployment with `stream-uploader`
behaves like a `streamer`. A pool-backed `abr-uploader` pays with the pool's batches, one per rung,
so `BEE_PUBLISHERS` satisfies the stack and nothing is held back. Its `.env.<name>` starts as a copy of
the base `.env`, so the manager writes `STAMP` empty there unless the deployment sets a stamp of its
own: a `STAMP` from the base file belongs to another deployment, and the uploader does not read it
while `BEE_PUBLISHERS` is set.

## Postage stamps

These routes act on the deployment's own Bee node. What a batch is, and what each change to one
costs, is in [Postage stamps](../docs/features/postage-stamps.md).

| Method | Path                               | Body                                    | Answer                                                                                                  |
| ------ | ---------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| GET    | `/profiles/:name/stamp/readiness`  |                                         | What the node's `/health` and `/readiness` say, with its chain progress from `/chainstate`              |
| GET    | `/profiles/:name/stamp/address`    |                                         | The node's addresses, from Bee's `/addresses`                                                           |
| GET    | `/profiles/:name/stamp/wallet`     |                                         | The node's wallet, BZZ and xDAI, from Bee's `/wallet`                                                   |
| GET    | `/profiles/:name/stamp/chainstate` |                                         | Bee's `/chainstate`, whose `currentPrice` is the price of a chunk per block                             |
| GET    | `/profiles/:name/stamp/stamps`     |                                         | `{ stamps }`, the node's batches from Bee's `/stamps`                                                   |
| POST   | `/profiles/:name/stamp/buy`        | `{ amount, depth, label?, immutable? }` | 202 `{ batchID }`. The batch is set on the deployment once its node calls it usable                     |
| POST   | `/profiles/:name/stamp/set`        | `{ stamp_id }`                          | 200 and the profile. Records a batch and redeploys nothing                                              |
| POST   | `/profiles/:name/stamp/topup`      | `{ batch_id, amount }`                  | 202 `{ batchID, txHash }`. Adds `amount` PLUR per chunk to a batch the node holds, paid from its wallet |
| POST   | `/profiles/:name/stamp/dilute`     | `{ batch_id, depth }`                   | 202 `{ batchID, txHash }`. Raises a batch the node holds to a deeper `depth`                            |

`batch_id` and `stamp_id` are 32 bytes of hex, with or without `0x`. `amount` is PLUR per chunk, a
positive whole number as a string, and `depth` a whole number from 17 to 40. A body that breaks
those is refused with 400.

A bought batch is set on the deployment once its node calls it usable, which the manager polls for
every three seconds for up to fifteen minutes. That replaces whatever batch the deployment
recorded, unless a batch was set with `stamp/set` while the bought one settled. Setting a batch
redeploys nothing, so a running uploader keeps paying with the batch it started with. The
deployment's settings list then shows `STAMP`, or `BEE_PUBLISHERS` on an ABR uploader, as behind,
and `POST /profiles/:name/settings/apply` restarts the uploader on the new batch.

A top-up or a dilute first asks the node for that batch, and one it does not hold is refused with
`404 stamp_not_found`. A dilute that is not deeper than the batch, or that would leave it less than
a day of life, which the postage contract refuses, is refused with 400. A top-up and a dilute
answer once Bee has the transaction mined. A node still starting answers `503 bee_node_not_ready`,
and any other failed call `502 bee_node_unreachable` with Bee's own words.

The readiness reads ask the node's `/health`, `/readiness` and `/chainstate` at once, each within
ten seconds (`DEFAULT_TIMEOUT_MS` in `BeeClient.ts`) and with a 64 KiB body limit. A network
failure, an unknown status and a malformed body stay unknown rather than unhealthy, and the node
counts as ready only when both `/health` and `/readiness` answered validly.

## Chequebook

A Bee node pays the peers that forward its uploads with cheques drawn on its chequebook, a contract
on Gnosis Chain holding BZZ. The chequebook is a different pot from the node's wallet, which holds
xDAI for gas and BZZ for buying stamps and filling the chequebook. When the chequebook runs dry the
node stays healthy and every push stalls. [Chequebook](../docs/features/chequebook.md) describes the
console's side.

| Method | Path                                           | Body                                                                | Answer                                                                                                                                                     |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/profiles/:name/chequebook`                   |                                                                     | Address, balances, settlement totals and the health verdict. A field is `null` when that call to the node failed                                           |
| POST   | `/profiles/:name/chequebook/deposit`           | `{ requestId, profileInstanceId, amount, expectedAccountId }`       | 202 `{ kind, operation }`, `kind` `admitted` or `replayed`, or 409 with the operation in the way. Wallet to chequebook                                     |
| POST   | `/profiles/:name/chequebook/withdraw`          | `{ requestId, profileInstanceId, amount, expectedAccountId }`       | The same, chequebook to wallet                                                                                                                             |
| GET    | `/chequebook/operations`                       | query `limit?`, `cursor?`, `profileName?`                           | `ChequebookHistoryPage`, newest first, 50 rows by default and 100 at most                                                                                  |
| GET    | `/chequebook/operations/by-request/:requestId` |                                                                     | `ChequebookOperationDetail` of the operation saved under that request id. 404 `chequebook_operation_not_found`                                             |
| GET    | `/chequebook/operations/:id`                   |                                                                     | `ChequebookOperationDetail`: `{ operation, responseEvidence, assertionConfirmation }`                                                                      |
| POST   | `/chequebook/operations/:id/check`             | `{ expectedAccountId }`                                             | `ChequebookOperationDetail`, after checking the chain for the operation's outcome                                                                          |
| POST   | `/chequebook/operations/:id/resolve`           | `{ transactionHash, expectedAccountId }`                            | `ChequebookOperationDetail`, after verifying the named transaction on the chain                                                                            |
| POST   | `/chequebook/operations/:id/assert`            | `{ amountPlur, confirmation, expectedAccountId, expectedRevision }` | `ChequebookOperationDetail`, recording that the operation was never made. 409 `chequebook_recovery_required` without a complete search that found no match |

`amount` is PLUR, Bee's integer unit, matching `^[1-9][0-9]*$` and at most 30 digits. 1 BZZ is
10^16 PLUR, so a decimal is refused rather than read. `common/src/chequebook.ts` converts.

The bodies are strict: a missing or unknown field is refused with 400 before any balance is read.
`requestId` is a UUID the browser saves before it sends, and sending it again answers the saved
operation and never prepares another transfer. `expectedAccountId` must be the signed-in user, or
the route answers `409 account_changed`. `profileInstanceId` must be the deployment's current
instance, or it answers `409 chequebook_profile_changed`. The server records the actor itself as
`user:<id>`. The body cannot choose a chain, contract or endpoint.

The last check before sending reads the node's balances. A refusal there is a recorded operation
rather than an error: 202 with the operation `rejected` and its `failureReason`
`preflight_no_gas` (send xDAI to the node's wallet), `preflight_insufficient_balance` (lower the
amount, or add BZZ) or `preflight_failed` (anything else the check found changed).

A write answers once Bee has submitted the transaction. The manager then checks for its receipt
every 20 seconds for up to 30 minutes, and settles it once its block is final
(`RECEIPT_POLL_INTERVAL_MS` and `RECEIPT_POLL_BUDGET_MS` in
`common/src/chequebookOperations.ts`).

The chequebook never refuses an uploader start. The start gate reads the node and logs what it
found, and the start goes ahead in every case. The one check that refuses is the batch, and only on
an answer the node gave: unknown, expired or not usable yet. A node that could not be asked never
refuses a start.

`CHEQUEBOOK_FLOOR_BZZ` is the floor below which the manager warns, `0.5` by default. `GET /config`
answers it as `chequebookFloorBzz`.

### Funding a chequebook on a new host

A transfer needs nothing set up on the host the deployment runs on. It reaches the node through its
Bee API, as stamp operations do, and reads the chain through the manager's own chain endpoint. It
uses no Docker connection and no SSH.

- **The node** is the deployment's own `bee-uploader`, reached at the address stamp operations use
  (the deployment's host, or `BEE_LOCAL_HOST` for a local one) over plain `http`, on the Bee API
  port its container recorded. That port must be the one the deployment's reservation owns, or
  nothing is sent.
- **The chain** is read through `CHEQUEBOOK_RPC_ENDPOINTS` for a chain it names, else
  `FUNDING_RPC_URL`, else `BEE_RPC_ENDPOINT`. Each endpoint must answer `eth_chainId` with the
  node's chain before it is used. With none of the three set, a transfer is refused with
  `chain_endpoint_missing`.

`CHEQUEBOOK_RPC_ENDPOINTS` is a JSON object keyed by chain id, one of `1`, `100` and `11155111`,
whose values are `http` or `https` URLs with no user information and no fragment, for example
`{"100":"https://rpc.example.invalid"}`. All three are manager settings, never read from a request,
a deployment or a Bee answer, and changing one takes a restart. A URL can carry a key, so route the
value into the process rather than writing it in a committed file.

A transfer the manager could not prepare is answered `503` with
`{"error":"chequebook_preparation_unavailable","cause":...,"message":...}`, where `message` is the
sentence the console shows. Nothing is sent or recorded. The causes are a closed list in
`common/src/chequebookRefusals.ts`, and none carries upstream text or an endpoint.

| `cause`                     | What is wrong                                                                                                                                  | The fix                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `bee_container_not_found`   | The manager has no `bee-uploader` container recorded for the deployment.                                                                       | Deploy it from the manager.                                                                                                  |
| `bee_container_unsupported` | The Bee API port the container recorded, `BEE_UPLOADER_API_PORT`, is missing, out of range, or not the port the deployment's reservation owns. | Deploy it again from the manager.                                                                                            |
| `chain_endpoint_missing`    | `CHEQUEBOOK_RPC_ENDPOINTS` names nothing for the node's chain, and neither `FUNDING_RPC_URL` nor `BEE_RPC_ENDPOINT` is set.                    | Set `FUNDING_RPC_URL` or `BEE_RPC_ENDPOINT`, or name the chain in `CHEQUEBOOK_RPC_ENDPOINTS`, then restart the manager.      |
| `chain_setting_invalid`     | `CHEQUEBOOK_RPC_ENDPOINTS` is malformed, or the default endpoint is not a usable `http` or `https` URL.                                        | Correct the setting, then restart the manager.                                                                               |
| `chain_unreachable`         | The chain endpoint did not answer the manager.                                                                                                 | Make the endpoint the manager uses for that chain reachable from the manager, or name another in `CHEQUEBOOK_RPC_ENDPOINTS`. |
| `wrong_chain`               | The endpoint answered for another chain than the node's.                                                                                       | Name an endpoint of the node's own chain in `CHEQUEBOOK_RPC_ENDPOINTS`, or point `FUNDING_RPC_URL` at one.                   |
| `unsupported_chain`         | The node runs on a chain with no pinned BZZ token.                                                                                             | Transfers work on Gnosis Chain, Ethereum and Sepolia only.                                                                   |
| `target_changed`            | The deployment is being deployed, stopped or removed, it has two `bee-uploader` containers recorded, or its ownership could not be captured.   | Wait until it is running and settled, or deploy it again.                                                                    |
| `bee_unreadable`            | The Bee node did not answer, or answered inconsistently.                                                                                       | Check that the node runs and is synced.                                                                                      |
| `unavailable`               | No such deployment, one without a Bee node of its own, a Bee API address that is not plain `http`, or anything else, a timeout among them.     | Try again, and read the manager's log if it keeps failing.                                                                   |

## A deployment's own settings

Every key a deployment's stack version declares, with the value its next deploy writes, where that
value comes from, and whether the running containers have it. The same list exists for a deployment
not created yet, which the new-deployment wizard edits. A deployment's list also holds every engine
setting it reads. [Deployment settings](../docs/features/deployment-settings.md) describes the
console's side.

| Method | Path                                                     | Body                                                                  | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | -------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/profiles/:name/settings`                               |                                                                       | `{ instanceId, revision, buildId, entries, drift, running, engine, abr, engineSettingsProblem }`, `no-store`. No secret value, only whether one is stored. `engineSettingsProblem` is the sentence the next deploy would refuse the stored engine settings with, or null. 409 `settings_not_ready` for a version with no build                                                                                                                                                                                                       |
| PUT    | `/profiles/:name/settings`                               | `{ expectedInstanceId, expectedRevision, entries: [{ key, value }] }` | `{ revision }`. Stores and runs nothing, and one refused key refuses the whole save. `value` null goes back to the version, or for an engine setting to its default. 400 `validation_error` for a key the version does not declare, a key named twice, a key a control of the deployment decides, a value the stack would read differently or outside its bounds, engine values the engine refuses together, or an admin address left with no token. 409 `deployment_settings_changed`, `profile_instance_changed` or `profile_busy` |
| POST   | `/profiles/:name/settings/apply`                         | `{ expectedInstanceId }`                                              | 202 `{ recreated: [service] }` or `{ recreated: 'all' }`, 200 `{ recreated: [] }` when nothing is behind. 400 `validation_error` while `engineSettingsProblem` stands, 409 `profile_stopped`, `profile_busy` or `profile_instance_changed`                                                                                                                                                                                                                                                                                           |
| GET    | `/versions/:id/settings-catalog?kind=&components=&host=` |                                                                       | `{ versionId, buildId, entries }`, `no-store`. What a deployment not created yet starts with. `kind` defaults to `custom`, `components` is a comma list, and an absent `host` is the manager's own. 404 `stack_version_not_found`, 409 `settings_not_ready`                                                                                                                                                                                                                                                                          |
| POST   | `/profiles/:name/settings/admin-link/test`               |                                                                       | `{ outcome }`, `no-store`. Test connection for what the next deploy would give the uploader (see [Linking uploaders to the admin](#linking-uploaders-to-the-admin))                                                                                                                                                                                                                                                                                                                                                                  |

Plain values are stored in `profiles.stack_settings` and secret ones in
`profiles.stack_settings_secret`, which no page and no event carries. A deploy writes them into
`.env.<name>` over the version's base `.env`, and then writes the lines the manager computes, so a
stored value never takes their place: the services, the stamp, the node pool, the chain endpoint
and the node mode, the Bee URL, the SRT passphrase and stream key, the feed, the engine config file,
the engine settings, every slotted port and, on the manager's own host, the data directories. A
stored value for one of those is left out of the file and named in the log. A generated secret is
the exception: a stored value replaces it.

Every successful deploy records, per container, what that container got: the keys its Compose block
reads and the keys only the deploy scripts read, a plain value where the page may show one, and a
salted digest of every key, so the page can tell which settings a running container is behind on.
A secret, and a chain endpoint, are kept as the digest alone.

## Linking uploaders to the admin

The admin, `apps/web2-admin`, is the service where streams are declared and listed. A
deployment's stream uploader reports to it when the stack gives it two settings:

- `ADMIN_API_URL` is where the uploader reaches the admin. Set, it turns the uploader's admin mode
  on: a stream has to be declared in the admin before anything may publish to it. Empty keeps the
  uploader standalone. The manager takes an `http` or `https` address with a host, and no user
  name, password or `#` part.
- `ADMIN_API_TOKEN` is the bearer token the uploader presents on the admin's internal routes, at
  least 32 characters. It is a secret: no answer carries it, only whether one is stored.

An uploader linked to the manager's own admin link gets a token of its own: its first deploy
generates 64 hex characters, keeps them with the deployment's other generated secrets, and the
stage record carries their SHA-256 so the admin knows the token. That admin takes no other token
from an uploader. An uploader linked to another admin is given a token typed for it. A save or a
create that leaves an address with no token anywhere is refused, because the uploader refuses to
start without one. A stored token goes only to the origin (scheme, host and port) it was stored
for. [The admin link](../docs/features/web2-admin-link.md) describes the rules, the wizard's
group, rotation and the owner check in full.

| Method | Path                                       | Body                                                                                                                                           | Answer                                                                                                                                                                                                                        |
| ------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/manager-settings/admin-link`             |                                                                                                                                                | `{ url, tokenStored, revision }`, `no-store`. `url` null is no link                                                                                                                                                           |
| PUT    | `/manager-settings/admin-link`             | `{ expectedRevision, url, token? }`. `url` empty for no link, `token` left out to keep the stored one, null to clear it                        | The link as it stands after. 400 `validation_error` for an address or a token the uploader would refuse, a token with no address, or an address on another origin that keeps the stored token. 409 `manager_settings_changed` |
| POST   | `/manager-settings/admin-link/test`        | `{ url, token: { source: 'stored' } or { source: 'typed', value }, tokenFor?, feedOwner? }`. `tokenFor` is `registrar` (default) or `uploader` | `{ outcome }`, `no-store`                                                                                                                                                                                                     |
| POST   | `/profiles/:name/settings/admin-link/test` |                                                                                                                                                | `{ outcome }` for what the deployment's next deploy would give its uploader                                                                                                                                                   |
| POST   | `/profiles/:name/admin-token/rotate`       |                                                                                                                                                | `{ message }`, `no-store`. The token is taken out and the next deploy generates a new one. 400 `validation_error` where it would generate none, 409 `profile_busy`, 404 for no such deployment                                |

The test asks the admin, from where the manager runs, what the holder of the token would ask it. It
takes `http` and `https` alone, follows no redirect, gives up after five seconds a request and reads
at most 64 KiB of an answer. The answer is an outcome code and nothing the admin said, and the log
names who tested and the outcome, never the address or a token.

| Outcome                  | What it means                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `linked`                 | The admin took the token, and knows the deployment's stream address as its stage's owner, or, for a token of no stage, as its catalogue's.                                     |
| `token-accepted`         | The admin took the token: the registrar check answered, or there was no stream address to compare.                                                                             |
| `owner-unconfirmed`      | The admin took the token but did not say which owner it knows for it. The uploader starts and checks each declaration instead.                                                 |
| `owner-mismatch`         | The admin took the token but knows another owner for it. The uploader will refuse to start.                                                                                    |
| `token-refused`          | The admin answered its own 401: the token is wrong.                                                                                                                            |
| `token-not-own`          | At the link's address, the deployment's token is not one the manager generated. An admin that takes only a stage's own token refuses it. Rotate it and redeploy.               |
| `token-not-registered`   | The admin answered its own 401 to the deployment's own token while no push of the stage has reached it yet. A deploy registers it.                                             |
| `not-admin`              | Something answered, but not the way an admin does.                                                                                                                             |
| `redirected`             | The address answered with a redirect, which the test does not follow. Give the address the admin itself answers on.                                                            |
| `unreachable`            | Nothing answered from where the manager runs, within five seconds a request.                                                                                                   |
| `invalid-address`        | The address is not an `http` or `https` one the uploader can use.                                                                                                              |
| `plain-http-refused`     | The address is plain `http` to another host than the manager's own, so nothing was sent. Give the `https` address, or set `ADMIN_LINK_ALLOW_PLAIN_HTTP=true` for a test setup. |
| `not-linked`             | The deployment has no address, so its uploader runs standalone.                                                                                                                |
| `no-token`               | There is an address and no token to test with.                                                                                                                                 |
| `stored-token-elsewhere` | A stored token was saved for another origin, so nothing was asked. Type the token again for this address.                                                                      |

## Stages

Every deployment of kind `abr-uploader` or `streamer` is a stage of the admin. The manager
builds its stage record, `stageRecordSchema` in `packages/contracts`, and pushes it with the link's
stored token to `PUT <link>/api/internal/stages/<instance_id>`, for each one whose effective
`ADMIN_API_URL` is on the link's origin: when the deployment changes, every 30 seconds while it
runs, and before a deploy starts its uploader. A removed deployment is retired with `DELETE` at the
same path, sent again every 30 seconds and at start until the admin answers. The record carries the
ingest address encoders dial, the owner the stage signs as, its rungs' stamps and chequebooks, the
uploader's reading, the readiness the console shows and the SHA-256 of the uploader's admin token,
and never a key, a token, an RPC endpoint or a node address. Each push comes to one outcome code,
kept in memory and logged when it changes.

The public ingest address is the deployment's own `ingest_host`, else the host the manager resolved
for it, else `PUBLIC_HOST` for a deployment on this host. A loopback address is never given, so a
stage on this host with no address of its own while `PUBLIC_HOST` is unset is not pushed.

| Method | Path                          | Body              | Answer                                                                                                |
| ------ | ----------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------- |
| PATCH  | `/profiles/:name/ingest-host` | `{ ingest_host }` | 200 and the profile. A host name, an IPv4 address or a bracketed IPv6 one                             |
| GET    | `/stages`                     |                   | `{ stages: [{ name, record, problem, lastPush }] }`, `no-store`. Built afresh, without the passphrase |
| GET    | `/stages/:name/registration`  |                   | `{ registration: { outcome, at } or null }`, `no-store`. The deployment page's line                   |

[Stages](../docs/features/stages.md) describes what is pushed, when, to whom, every outcome and the
limits.

### The catalogue node

The brand's catalogue node is a deployment of this manager that is nothing but a Bee node, with one
immutable batch it holds pinned by id. The manager pushes its catalogue stamp record,
`catalogueStampRecordSchema` in `packages/contracts`, to `PUT <link>/api/internal/catalogue-stamp`
with the link's stored token: when the designation changes, when the pinned batch's readings
change (read every ten seconds), and every 30 seconds. A designation taken out is cleared there
with `DELETE` and `{ observedAt }`. The deployment and the batch stay recorded after a clear. That
batch can be designated again, and another one only as a move (`move: true`), which records the
pinned batch as the one moved from until a release takes it out. A third batch is refused while a
move is pending. The pinned deployment, and the one moved from while a move is pending, cannot be
removed (409 `catalogue_node_designated`), and a create or update whose `bee_publishers` names
either batch or node is refused.

| Method | Path                                       | Body                                                | Answer                                                                                                                                                                                                                                                                                                                                                                                      |
| ------ | ------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/manager-settings/catalogue-node`         |                                                     | `{ designation, pinned, movingFrom, lastRelease, revision, reading, lastPush }`, `no-store`. `designation` null is none, `pinned` the node and batch recorded, `movingFrom` the batch a pending move left (`profileName`, `batchId`, `startedAt`, `startedBy`, `reading`) or null, `lastRelease` `{ at, by }` or null                                                                       |
| PUT    | `/manager-settings/catalogue-node`         | `{ expectedRevision, profileName, batchId, move? }` | The answer as it stands after. 400 `validation_error` for a deployment that is more than a Bee node or is a pool rung, a batch the node does not hold, a mutable or expired batch, a batch an ABR uploader stamps with, another batch without `move: true`, a third batch while a move is pending, and a new batch shallower than `MIN_CATALOGUE_DEPTH`, 18. 409 `manager_settings_changed` |
| DELETE | `/manager-settings/catalogue-node`         | `{ expectedRevision }`                              | The answer as it stands after. A pending move stays. 400 `validation_error` when nothing is designated                                                                                                                                                                                                                                                                                      |
| POST   | `/manager-settings/catalogue-node/release` | `{ expectedRevision }`                              | The answer as it stands after, with `movingFrom` null and `lastRelease` set. 400 `validation_error` when no move is pending                                                                                                                                                                                                                                                                 |

## Funding API

The admin funds a brand's stages from its brand wallet through these routes, and has no chain
connection of its own (`docs/architecture/funding.md` at the repository root). They are mounted at
`/api/admin-funding`, ahead of the cross-site and session gates, and the console's nginx sends that
path to the api. The shapes are in `packages/contracts/src/funding.ts`.

- `FUNDING_API_TOKEN` unset: the API is off, and every path under it answers 404
  `{ error: "funding_off" }`.
- Set: a request needs `Authorization: Bearer <FUNDING_API_TOKEN>` and no session cookie, or it is
  401 `unauthorized`. Both tokens are hashed with SHA-256 and compared in constant time, and neither
  is logged or answered.
- Every other route refuses a request carrying a bearer with 401, so the token opens nothing but
  this API and a session opens nothing of it.
- A refusal is `{ error, message }` with the status the contract gives its code: `funding_off` 404,
  `unauthorized` 401, `unknown_node` 404, `bad_transaction` 422, `chain_unreachable` 502,
  `conflict` 409, `unknown_request` 404, `stamp_refused` 422, `node_unreachable` 502 and
  `chequebook_refused` 422.

| Method | Path                                      | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/admin-funding/inventory`            | `{ observedAt, chain: { chainId, bzzToken, postage }, stages: [{ stageId, name, nodes }], catalogue }`, `no-store`. A stage's nodes are its own Bee node, its gateway when that runs light, and its pool's rungs run by this manager, lowest first. Each node is `{ nodeId, label, role, walletAddress, xdaiWei, xbzzPlur, readError, batch, chequebook }`: an opaque `<instance_id>:<service>` id, its wallet read now (five seconds at most each), amounts in wei and PLUR as decimal strings, or nulls and a sentence saying why, and the [batch](#batches-and-the-price-of-postage) and [chequebook](#chequebooks) below. Never a Bee API address, an RPC endpoint or a key |
| GET    | `/api/admin-funding/accounts/:address`    | `{ address, chainId, xdaiWei, xbzzPlur, nonce, maxFeePerGasWei, maxPriorityFeePerGasWei, gasNative, gasBzzTransfer }`, `no-store`: the address's xDAI and xBZZ, its pending nonce, a fee cap of twice the latest base fee plus the suggested tip, that tip, and the suggested gas limits, 21000 for xDAI and 65000 for an xBZZ `transfer`. 502 `chain_unreachable` when the chain does not answer or no endpoint is set                                                                                                                                                                                                                                                         |
| POST   | `/api/admin-funding/transfers`            | 202 `{ requestId, state, txHash }`. Takes `{ requestId, nodeId, kind, to, amount, rawTransaction }`. See [Transfers](#transfers)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GET    | `/api/admin-funding/transfers/:requestId` | `{ requestId, state, txHash, blockNumber, error }`, `no-store`. See [Transfers](#transfers)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### Transfers

A transfer is a signed transaction from the brand wallet to a node's wallet, which the manager
checks and broadcasts. The transaction is decoded and held to the request, and each failure is 422
`bad_transaction` with a sentence: EIP-1559 on chain 100 with no access list. For `xdai`, sent to
`to` with exactly `amount` and no data. For `xbzz`, sent to the BZZ token with no value and data
exactly `transfer(to, amount)`. A gas limit from 21000 to three times the suggestion, a fee cap
within three times the suggested one, and a tip no higher than the fee cap. An amount of at most
2^256 - 1. `to` must be the wallet of `nodeId` in the inventory read now, or 404 `unknown_node`.

The row is written to `funding_transfers` as `unknown` before the broadcast. A broadcast the chain
takes is `submitted`, one it refuses `failed` with the kind of refusal in a sentence, and one whose
answer is lost stays `unknown`. The same `requestId` again answers the recorded state and sends
nothing. Another body under it is 409 `conflict`.

The `GET` refreshes a `submitted` or `unknown` transfer from the chain: a receipt makes it
`confirmed` (status 1, with its block) or `failed` (status 0). Without one, a transaction the chain
still holds is `submitted`, and one it no longer knows thirty minutes after it was recorded is
`unknown`. A transfer refused at the broadcast is still read for a receipt, because a node can
answer with an error and keep the transaction. The chain is read at most once every five seconds
per request id. In between, and when the chain does not answer, the recorded state is answered.
404 `unknown_request` means the id was never recorded, so it is safe to send again.

### Batches and the price of postage

A node's `batch` in the inventory is the batch the manager uploads with through that node, read
now from the node's `GET /stamps/{id}` within five seconds: the stage's `stamp_id` for the stage's
own node, the rung's batch for a rung, and the designated batch for the catalogue node. It is null
for a gateway and for a node with no batch set.

- A batch is `{ batchId, depth, immutable, usable, ttlSeconds, fillRatio, readError }`: `0x` and
  64 hex digits, Bee's depth, `immutableFlag` and `usable`, the seconds left (0 once it has
  expired, null when Bee cannot work them out), and how full its fullest bucket is, from 0 to 1,
  null when the node's counts do not make one.
- A batch that could not be read has every reading null and `readError` saying why in a sentence.
- `chain.postage` is `{ pricePerChunkPerBlockPlur, blockSeconds, minimumValidityBlocks }`: the
  price from the `/chainstate` of the first listed node whose wallet reads on Gnosis Chain, 5
  seconds a block, and the postage contract's floor, 17280 blocks, a day. It is null when no such
  node names a price.

### Chequebooks

A node's `chequebook` in the inventory is the one it pays its peers from, read now from the node's
`GET /chequebook/address` and `GET /chequebook/balance`, five seconds at most each, for every node
listed.

- A chequebook is `{ address, availablePlur, totalPlur, readError }`: its address in lower case,
  what the node can still pay out of it, and its total, which also holds cheques its peers have not
  cashed yet. Both balances are PLUR as decimal strings.
- It is null when the node says it has none: Bee answers `403` "Chequebook is disabled" while its
  chequebook is off, and, while SWAP is off as on any ultra-light node, the zero address and `405`
  "chain disabled" for the balance.
- A chequebook that could not be read has every reading null and `readError` saying why.

### Stamp operations

The admin tops up and dilutes the batches the inventory names, one operation per request. The
node that uploads with a batch carries out its operation through its own Bee API and pays for it
from its own wallet: xBZZ for a top-up, xDAI for the gas of either.

| Method | Path                                             | Answer                                                                                                                                                                                                                                                                                                                                      |
| ------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/admin-funding/stamp-operations`            | 202 `{ requestId, kind, state, txHash }`, once the node has answered. Takes `{ requestId, kind: "topup", nodeId, batchId, expectedDepth, amountPerChunkPlur }` or `{ requestId, kind: "dilute", nodeId, batchId, expectedDepth, newDepth }`. The same `requestId` again answers the recorded state. Another body under it is 409 `conflict` |
| GET    | `/api/admin-funding/stamp-operations/:requestId` | `{ requestId, kind, state, txHash, error }`, `no-store`. 404 `unknown_request` for an id never recorded                                                                                                                                                                                                                                     |

- **The checks**, each 422 `stamp_refused` with a sentence before anything is recorded. Against the
  inventory read now: `batchId` is the batch `nodeId` uploads with (404 `unknown_node` for a node
  this manager does not run), the batch was read, has time left, is usable and is at
  `expectedDepth`. A top-up's cost, `amountPerChunkPlur × 2^depth`, is within the node's xBZZ. A
  dilution goes to depth 40 at most and leaves seven days or more, the time left halving for every
  step. The node's wallet holds some xDAI. Then against the postage contract, `batches(id)` on
  Swarm's PostageStamp on Gnosis Chain, read through `FUNDING_RPC_URL` or `BEE_RPC_ENDPOINT` (502
  `chain_unreachable` when it cannot be): it holds the batch at `expectedDepth`, and for a dilution
  the node's wallet bought it, since only that wallet may dilute it.
- **The record**: the operation is written to `funding_stamp_operations` as `unknown`, with the
  batch's normalised balance, before the node's `PATCH /stamps/topup/{id}/{amount}` or
  `PATCH /stamps/dilute/{id}/{depth}` is sent, within Bee's on-chain budget of 180 seconds. Bee
  answers once the transaction is mined, so an answer with a hash is `confirmed`. A refusal (a 4xx,
  501 or 503) is `failed` with Bee's words. A node the manager could not connect to is `failed` and
  answered 502 `node_unreachable`. A 500, and an answer that never came, stay `unknown`.
- **Settling an `unknown` operation**, on the `GET`: a top-up is `confirmed` once the batch's
  normalised balance has grown by `amountPerChunkPlur`, and a dilution once the batch is at
  `newDepth` or deeper. With no sign of either thirty minutes after it was recorded, it is
  `failed`. The contract is read at most once every five seconds per request id.

### Chequebook operations

The admin brings the nodes' chequebooks to a target, one deposit or withdrawal per request.
These routes are a thin adapter over the manager's own chequebook path (see [Chequebook](#chequebook)):
the same preparation, the same last check before sending and the same record,
`chequebook_operations`, where the move is recorded as requested by `web2-admin`. The node pays: a
deposit's xBZZ from its wallet, and the gas of either in xDAI. A withdrawal goes into the node's
own wallet.

| Method | Path                                                  | Answer                                                                                                                                                                                                                                                                             |
| ------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/admin-funding/chequebook-operations`            | 202 `{ requestId, direction, state, txHash }`, once the chequebook path has answered. Takes `{ requestId, nodeId, direction, amountPlur }`: `direction` is `deposit` or `withdraw`, and `amountPlur` 30 digits at most. Anything else is 422 `chequebook_refused` naming the field |
| GET    | `/api/admin-funding/chequebook-operations/:requestId` | `{ requestId, direction, state, txHash, error, mined }`, `no-store`. 404 `unknown_request` for an id never recorded                                                                                                                                                                |

- **A request id already recorded** answers that operation's state when it is the same move (the
  funding API's, on the same node, in the same direction, of the same amount), and 409 `conflict`
  otherwise. This comes before the inventory is read, so a replay answers even once the node is
  gone.
- **A request still under way** answers `submitted` with no hash on the `GET` until its call has
  answered, because the chequebook path records a move only once it has prepared it.
- **The checks**, each refused before anything is recorded: `nodeId` is a stage's own Bee node or a
  rung (404 `unknown_node` otherwise, 422 `chequebook_refused` for a gateway or a catalogue node no
  stage lists). The node's wallet and chequebook were read, a deposit is at most the wallet's xBZZ,
  a withdrawal at most what the chequebook has available, and the wallet holds some xDAI.
- **Preparation** refusals are 422 `chequebook_refused` with the manager's sentence for the cause
  (see [Funding a chequebook on a new host](#funding-a-chequebook-on-a-new-host)), and another move
  still open on the node is 409 `conflict`. A record the manager could not read or write is 503
  `chequebook_journal_unavailable`, which says nothing of whether the move was made.
- **The states** map onto the transfers' four. `submitting` and `submitted` are `submitted`.
  `settled` is `confirmed`. `reverted`, `rejected` and `asserted` are `failed`, with a sentence.
  `unknown` stays `unknown`, as does an operation whose transaction another operation's evidence
  names too, until an operator reviews it.
- **`mined`** is true while a `submitted` operation's transaction is in a block that is not final
  yet, which the admin shows as Mined.
- **The `GET`** has the chequebook path check an open operation first, at most once every 30
  seconds per request id. When that check fails, or takes longer than five seconds, the record is
  answered as it stands.
- **Timing**: the `POST` holds until the chequebook path is done, at most about 225 seconds: 15 to
  reach the node, 30 for the checks before sending, and 180 for Bee's answer.

## Engine control

The media server of one deployment: what it is configured with, a restart, its logs, and a config
file of its own. [Engine control](../docs/features/engine-control.md) and
[Engine config](../docs/features/engine-config.md) describe the console's side.

| Method | Path                                                | Body                                                                                                                                                                                                                                      | Answer                                                                                                                                                                                                                                                                            |
| ------ | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/profiles/:name/engine`                            |                                                                                                                                                                                                                                           | `{ identity, engine, abr, settings, defaults, defaultSources, observations, effective, fields, live, liveUnavailableReason, notInConfig }`                                                                                                                                        |
| PUT    | `/profiles/:name/engine-settings`                   | The whole set: `{ HLS_FRAGMENT?, HLS_SEGMENT_MAX?, HLS_WINDOW?, SRT_LATENCY?, ABR_*? }` for SRS, `{ HLS_SEGMENT_DURATION?, HLS_SEGMENT_COUNT?, OME_HLS_POLL_INTERVAL_MS? }` for OME, and `expectedInstanceId?`. `{}` resets every setting | 202 and the profile. Saves and recreates in one call, the engine and, when a key it also reads changed, the uploader. 400 `validation_error` naming a key neither engine reads, with nothing stored. 409 `engine_settings_changed` when a settings save landed after it read them |
| POST   | `/profiles/:name/containers/:service/restart`       |                                                                                                                                                                                                                                           | 202. `srs`, `ome`, `stream-uploader` and `bee-uploader` only                                                                                                                                                                                                                      |
| GET    | `/profiles/:name/containers/:service/logs?tail=200` |                                                                                                                                                                                                                                           | `text/plain`, at most 2000 lines                                                                                                                                                                                                                                                  |
| GET    | `/profiles/:name/engine/config`                     |                                                                                                                                                                                                                                           | `text/plain`, `no-store`. The config the running container generated                                                                                                                                                                                                              |
| GET    | `/profiles/:name/engine-config`                     |                                                                                                                                                                                                                                           | `{ engine, supported, unsupportedReason, config, template, placeholders, state, error, references }`, `no-store`                                                                                                                                                                  |
| PUT    | `/profiles/:name/engine-config`                     | `{ config }`                                                                                                                                                                                                                              | 202 and the profile, or 400 with the engine's own reason. Recreates the engine and watches it                                                                                                                                                                                     |
| DELETE | `/profiles/:name/engine-config`                     |                                                                                                                                                                                                                                           | 202 and the profile. Back to the version's template                                                                                                                                                                                                                               |
| POST   | `/profiles/:name/engine-config/verify`              |                                                                                                                                                                                                                                           | Watches an interrupted rollout again                                                                                                                                                                                                                                              |
| POST   | `/profiles/:name/engine-config/restore-previous`    |                                                                                                                                                                                                                                           | Puts the previous file back after an interrupted rollout                                                                                                                                                                                                                          |

`profiles.engine_settings` is a JSONB column holding only the keys a deployment overrides, by
their env name. An absent key is not written into `.env.<name>`, so the version's base `.env`
decides it. The fields, their bounds and choices, and the rule that frame rate times segment length
must be a whole number of frames live in `common/src/engineSettings.ts`, which the manager, the
console and the offline mock all read. One JSONB column rather than one per setting, because the
set differs per engine and per stack version.

One key differs. `SRT_LATENCY`, how long SRS waits for a lost SRT packet to be resent, in whole
milliseconds from 20 to 10000, defaults to the manager's own 2000. An absent `SRT_LATENCY` is
written into `.env.<name>` as 2000 unless the base `.env` sets it, and the Engine card calls it
"Manager default". SRS applies it to ingest only on a stack version whose SRS template fills
`recvlatency` as well as `latency`, as the bundled stack's does.

The console edits engine settings in the deployment's Stack settings card, where a save stores and
runs nothing and Apply recreates the containers behind on a saved value.
`PUT /profiles/:name/engine-settings` is the way a script saves and recreates in one call. It
redeploys the engine service alone, and the uploader with it for a key it also reads, so the
deployment goes `DEPLOYING` and back while the Bee node stays up. It moves the same settings
revision a page save moves. A restart changes no status and publishes an `engine.restarted` event.

The engine's live status, what is publishing right now, is not read. `GET /profiles/:name/engine`
answers `live: null` with the reason in `liveUnavailableReason`.

### A config file of the deployment's own

Both engines are configured by file alone: SRS by `srs.conf`, OvenMediaEngine by `Server.xml`. The
Engine card's **Config file** button opens the whole file, and the manager stores it in
`profiles.engine_config` with the stack's `*_PLACEHOLDER` tokens kept in it. The stack fills those
at container start, so the passphrase, the ports, the webhook token and the engine settings never
sit in the stored text. A token the file drops is a setting the Engine card marks as not read
(`notInConfig`).

It works on a stack version whose contract has the hook, `engineConfig` in `GET /versions`, which
the reader sets when the checkout ships `deploy/docker-compose.srs-conf.yml` or the OvenMediaEngine
counterpart. At deploy the manager writes the file to `<data root>/<name>/engine/srs.conf` (or
`Server.xml`) and names it as `SRS_CONF_FILE` or `OME_CONF_FILE` in `.env.<name>`, which the stack
turns into a read-only mount. The file goes with the deployment when it is removed.

Nothing is applied unchecked. A `PUT` first refuses a placeholder the version's entrypoint does not
fill, then asks the engine. For SRS that is `srs -t` in a throwaway container of the version's own
image, on a copy with every placeholder filled by a dummy value, and the line SRS names comes back
as the 400. A version whose compose file names no SRS image is checked on the image the stack's own
compose files pin, because stock SRS refuses directives the stack's template uses. OvenMediaEngine has no test mode, so it gets a well-formedness check and the watch.
Then the file is stored, the engine recreated, and the container inspected every two seconds for
twenty. An engine that is not running without restarts by then gets the previous file back, and
`engine_config_error` on the profile says why, with the engine's last log lines. A manager
restarted during a rollout settles it at boot, and marks one it cannot judge as interrupted, with
`verify` and `restore-previous` as the two ways out.

SRS documents every directive in its annotated
[full.conf](https://github.com/ossrs/srs/blob/develop/trunk/conf/full.conf), and OvenMediaEngine in
its [configuration guide](https://airensoft.gitbook.io/ovenmediaengine/configuration). The stack's
own notes are in `apps/hls-stream/engines/README.md` under "Your own config file".

## Stack versions

A version is a branch, tag or commit of the stack's repository, pinned to a commit, its
`apps/hls-stream` exported and built once. Its deploy contract is read out of that tree rather than
assumed: the port table from `deploy/scripts/_lib.sh`, the port slot ceiling from `deploy.sh`, the
secrets the containers refuse to start without from the `.env.sample` files, the engine defaults
from the entrypoints, which setting each container reads from the `${KEY}` references of its Compose
block, and whether its deploy script takes the build's release. A moving branch changes nothing
until `update` is called. [Stack versions](../docs/features/stack-versions.md) describes the
console's side.

The bundled version is the stack commit the manager pins in `manager/.stack-commit`, which
`deploy/deploy.sh` writes. The API reads it at boot and builds that commit when it has no complete
build of it. It is the default until another is chosen, and it cannot be removed. A manager that
pins no commit, which is a developer machine, keeps the bundled row on the checkout's own tree and
refuses to rebuild it.

Every build is made as a release, which its manifest keeps and the pages show: the bundled
version's as the label the manager was deployed with (`MANAGER_VERSION`), and an added version's as
the tag on the commit it built. `GET /versions` answers the current build's as `buildLabel`, and
each container in `GET /profiles` answers the one its build was made as. A deploy hands the stack's
deploy script `--release-label` and `--release-commit` on a version whose contract has
`playerRelease`, and the player shows them in its QoE overlay.

Every deployment runs one version, chosen in the wizard and preselected to the default. `POST
/profiles` and `POST /groups` take `stack_version_id`, absent meaning the default, and refuse a
version still building or failed. A group's members all run the version the group was made on. A
deployment stays on its version. Only a version marked **tested** can be made the default, which a
person sets after a real deployment has run on it.

The secrets a version's containers refuse to start without (`API_AUTH_TOKEN`, `SRS_WEBHOOK_TOKEN`
and `OME_ADMISSION_SECRET` on the bundled stack) are generated at the deployment's first deploy, 64
hex characters each, kept in `profiles.stack_secrets`, written into `.env.<name>` at every deploy
and never answered. A secret the version's own base or engine env already sets is neither generated
nor written, so the version's line is what the containers read. A value already in
`profiles.stack_secrets` wins over both.

| Method | Path                             | Body                               | Answer                                                                                                                                                                                          |
| ------ | -------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/versions`                      |                                    | `[{ id, name, gitRef, commitSha, status, isDefault, tested, testedInvalidatedAt, builtAt, lastError, contract, deployments, layout, buildId, previousBuildId, buildLabel }]`                    |
| POST   | `/versions`                      | `{ name, ref }`                    | The build log as Server-Sent Events, then `version.changed` on `/events`                                                                                                                        |
| POST   | `/versions/:id/update`           |                                    | The build log. On `bundled` it builds the commit the manager pins, and refuses when it pins none                                                                                                |
| POST   | `/versions/:id/default`          |                                    | 204. Refused for a version still building or not marked tested                                                                                                                                  |
| PATCH  | `/versions/:id`                  | `{ tested, commitSha?, buildId? }` | 200 and the row. Marking tested requires the commit the page showed, and the build id too                                                                                                       |
| DELETE | `/versions/:id`                  |                                    | 204, or 409 naming the deployments that use it, or for the bundled version, the default, one that is building, one with an unresolved build reference or execution, or one that moved meanwhile |
| GET    | `/versions/:id/settings`         |                                    | `{ generation, buildGeneration, buildId, files, leftAlone }`, `no-store`, or 409 `settings_not_ready`                                                                                           |
| PUT    | `/versions/:id/settings`         | `{ expectedGeneration, files }`    | `{ generation }`, or 409 `settings_changed`, 409 `settings_locked`, 400 on a value, 413 `payload_too_large`                                                                                     |
| POST   | `/versions/:id/settings/apply`   |                                    | `{ buildId, reused }`, or 409 `stack_build_busy`, `settings_not_ready` or `settings_locked`                                                                                                     |
| GET    | `/versions/attempts`             |                                    | `{ attempts }`, the deploy attempts that still hold a project or the daemon, each `{ id, project, jobId, kind, services, state, reason, startedAt, resolvedAt, releasedBy }`                    |
| POST   | `/versions/attempts/:id/release` | `{ jobId }`                        | `{ attempt }`. The operator types the attempt's job id back. 400 `validation_error` when it does not match, 404 `attempt_not_found` when it was resolved or released meanwhile                  |

### The settings files

Every version keeps three kinds of file the operator owns, beside its builds: the base `.env`,
`deploy/config.json` and one `.env` per engine. Its first build seeds them from the version's own
samples, and no build writes over them. **Settings** on a version card opens
`#/versions/<id>/settings`.

Each key of an env file shows the comment block directly above it in the version's `.env.sample`.
A value equal to the sample's is marked `default`. A secret-like key is masked until **Reveal** is
pressed: the routes are behind the session gate, nothing logs a value and nothing caches the
answer. A key the manager fills per deployment says so. A key the sample does not declare carries
**Remove**.

A value must be one the stack's env loader and the manager read the same way
(`settingValueProblem` in `common`): padding at either end, an unquoted space before a `#`, a quote
that does not close at the end and a control character are refused. `SRS_CONF_FILE` and
`OME_CONF_FILE` take only an absolute path or nothing.

**Save** writes the files as one revision, and refuses with 409 `settings_changed` when anything
moved since the page loaded. An env file is rewritten from its own bytes: the named lines get the
new value, and every comment, blank line and spacing survives. One save carries at most sixteen
files and 512 keys per file. While the SSH editing script holds the lock, every one of these routes
answers 409 `settings_locked` with what holds it.

**Save and apply** saves and then publishes another build of the same commit carrying the new
revision, rather than building the stack again. Its unchanged files are hard linked to the build it
was made from where the filesystem allows, and copied otherwise. It refuses with 409
`stack_build_busy` while a build runs. New deployments run the new build. Running deployments keep
their settings until they are deployed again. A build of the same commit already carrying the
revision is answered with `reused` true, so applying twice makes one build.

### Building a version

Adding and updating run `manager/scripts/stack-version-build.sh <repo-root> <staging-dir> <ref>
<repo-url> <attempt-id>`, which clones or fetches, exports the commit into a staging tree under the
version's builds directory, and builds the packages there in a throwaway `node:24-alpine` container
shown that tree and nothing else. When the commit keeps one lockfile at the repository root, the
container first cuts the stack's own pair out of it with that commit's `tools/app-workspace`. The
container runs the pnpm the stack's `package.json` names. The manager then publishes the tree as a
numbered build, seeds the version's settings files where it has none, and removes the staging tree.
One build runs at a time, because the stack tags its images by service name.

`STACK_SOURCES` lists the repositories a version may be built from. Adding a version runs that
branch's deploy scripts with the manager's Docker access, so only add branches you trust. The build
container never sees the versions root, which holds every deployment's `.env.<name>` with its
stream key, SRT passphrase and batch.

## Deploy targets

| Method | Path                       | Body        | Answer                                                                                                                                                                                              |
| ------ | -------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/targets`                 |             | `{ targets, inventorySeededAt }`, every deploy target with its own `inventorySeededAt`                                                                                                              |
| POST   | `/targets/verify`          | `{ alias }` | `{ target }`, after reading the target's Docker daemon identity and seeding its port inventory. 400 `validation_error` without an alias, 409 `target_not_verified` when the identity cannot be read |
| POST   | `/targets/inventory`       |             | `{ inventorySeededAt }`, after reading the daemon's ports again. 503 `inventory_unavailable` when the manager has no inventory                                                                      |
| GET    | `/targets/firewall?alias=` |             | The firewall inventory of that verified target as a download, `firewall-inventory.json`. 400 `validation_error` without an alias, 503 `inventory_unavailable`                                       |

Step 3 of [Opening the manager to the internet](../deploy/README.md#3-generate-and-review-the-host-firewall)
is what the firewall export is for.

**A target is verified before it is used.** `localhost` is the ordinary case. Another alias is
refused until the manager has read a Docker daemon identity on it over SSH.

## Configuration and version

| Method | Path        | Answer                                                                      |
| ------ | ----------- | --------------------------------------------------------------------------- |
| GET    | `/health`   | `{ "status": "ok" }` once the database answers                              |
| GET    | `/services` | The valid service names                                                     |
| GET    | `/config`   | `{ host, srtPassphrase, chequebookFloorBzz, beeRpcEndpoint, instanceName }` |
| GET    | `/version`  | `{ label, commit }`, `no-store`                                             |

`GET /config` answers what a page needs before it renders: `host`, the host deployments publish on,
which every deployment URL is built from, `srtPassphrase`, the host-wide SRT passphrase or null,
`chequebookFloorBzz`, `beeRpcEndpoint`, whether the manager has a chain endpoint and its host alone,
and `instanceName` from `MANAGER_INSTANCE_NAME`, or null.

`GET /version` answers the build `deploy/deploy.sh` built into the api image: `label`, the name
`tools/release/version.mjs` gave the deployed commit, and `commit`, the full commit. Each is null
when the image carries none or one of another shape, and the console shows a null label as a
development build. The console shows it in its sidebar as `<instance name> · <label> (<first 9 of
the commit>)`, or the label alone when it already starts with those nine characters. "The build it
names" in [the deploy guide](../deploy/README.md#the-build-it-names) says how a deploy names it.

## Resource metrics

CPU, memory, network and disk usage at four layers: the host (the whole machine), the infra (the
sum of the manager's deployments' containers), outside (the host minus the infra), and per
container, grouped by Compose project, which is the deployment. `common/src/metrics.ts` is the
shape.

| Method | Path                     | Answer                                                                                                                         |
| ------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/metrics`               | The latest snapshot as JSON. 503 until the first sample is ready                                                               |
| GET    | `/metrics/stream`        | Server-Sent Events, one `snapshot` event about every two seconds. 503 `too many metrics clients` once 50 are connected         |
| GET    | `/metrics/disk/:project` | `{ project, sizeBytes }`, the size of that deployment's data folder. `sizeBytes` is null when it has none or the lookup failed |

The collector polls Docker only while a client is connected to `/metrics/stream`, or right after a
`/metrics` request.

```jsonc
{
  "timestamp": "2026-06-07T14:30:00.000Z",
  "host": {
    "cpuPercent": 37.2,
    "ncpu": 8,
    "memUsedBytes": 9663676416,
    "memTotalBytes": 33554432000,
    "diskUsedBytes": 81604378624,
    "diskTotalBytes": 512110190592,
    "netRxBytes": 8388608,
    "netTxBytes": 16777216,
    "netRxRate": 20480,
    "netTxRate": 40960,
    "diskReadBytes": 0,
    "diskWriteBytes": 8192,
    "diskReadRate": 0,
    "diskWriteRate": 4096,
  },
  "infra": {
    "cpuPercent": 142.5,
    "memUsageBytes": 5368709120,
    "netRxBytes": 4194304,
    "netTxBytes": 8388608,
    "netRxRate": 10485,
    "netTxRate": 20971,
    "blkReadBytes": 0,
    "blkWriteBytes": 4096,
    "blkReadRate": 0,
    "blkWriteRate": 2048,
    "containerCount": 6,
  },
  "outside": { "cpuPercent": 155.1, "memUsageBytes": 4294967296 },
  "containers": [
    {
      "id": "abc123...",
      "name": "streamer1-srs-1",
      "project": "streamer1",
      "service": "srs",
      "state": "running",
      "restartCount": 0,
      "cpuPercent": 72.4,
      "memUsageBytes": 268435456,
      "memLimitBytes": 2147483648,
      "memPercent": 12.5,
      "netRxBytes": 1048576,
      "netTxBytes": 2097152,
      "netRxRate": 5120,
      "netTxRate": 10240,
      "blkReadBytes": 0,
      "blkWriteBytes": 4096,
      "blkReadRate": 0,
      "blkWriteRate": 2048,
      "pids": 14,
    },
  ],
}
```

- `cpuPercent` is the share of one core times 100, so an 8-core machine tops out at 800. The host
  field is normalised to 0 to 100. The `*Rate` fields are bytes per second from deltas, so they
  read 0 on the first sample after connecting.
- `restartCount` is how many times the daemon has restarted the container, read less often than
  the rest. It is the field that shows a crash loop, because a container that dies and comes back
  reads `running` in between.
- `outside` subtracts exactly for CPU and memory only. Network and disk are measured at different
  points for the host and for containers, so they are shown side by side.
- The host fields need read-only host mounts (`/proc` at `/host/proc` and `/` at `/host/rootfs`),
  which `docker-compose.yml` sets up. Without them the host fields fall back to capacity or null.
  Host network traffic is read from `/host/proc/1/net/dev`, the host init process's view.

**A remote Bee node's data is outside the manager's reach.** The disk figure and the cleanup on
removal cover the manager's own host only.

## Example session

Sign in first. The cookie file carries the session through the rest, and every request that is not
a GET also needs the `X-Requested-With` header:

```bash
# Sign in, keeping the session cookie in a file
curl -sS -c cookies.txt -X POST localhost:9876/auth/login \
  -H 'content-type: application/json' \
  -H 'X-Requested-With: streaming-infra-manager' \
  -d '{"username":"operator","password":"<the password>"}'

# Create streamer1 (port slot 1) and viewer1 (port slot 2)
curl -sS -b cookies.txt -X POST localhost:9876/profiles \
  -H 'content-type: application/json' \
  -H 'X-Requested-With: streaming-infra-manager' \
  -d '{"name":"streamer1","kind":"streamer"}'
curl -sS -b cookies.txt -X POST localhost:9876/profiles \
  -H 'content-type: application/json' \
  -H 'X-Requested-With: streaming-infra-manager' \
  -d '{"name":"viewer1","kind":"viewer"}'

# Deploy and follow the output
curl -N -b cookies.txt -X POST localhost:9876/profiles/streamer1/deploy \
  -H 'content-type: application/json' \
  -H 'X-Requested-With: streaming-infra-manager' -d '{}'

# Resource metrics, once and live
curl -sS -b cookies.txt localhost:9876/metrics | jq
curl -N -b cookies.txt localhost:9876/metrics/stream

# Remove: stops the containers, removes the data directory and execution copies, frees the slot
curl -b cookies.txt -X DELETE localhost:9876/profiles/streamer1 \
  -H 'X-Requested-With: streaming-infra-manager'
```

On a server, `ssh -L 8080:localhost:8080 <server>` reaches the web port, and the same paths answer
on `localhost:8080`.

## Environment

Everything comes from `manager/.env`, except the build's name. `manager/.env.sample` documents the
keys an operator sets by hand. `docker-compose.yml` sets `SHLS_ROOT` and `BEE_DATA_ROOT` for the
`api` container, and the deploy builds `MANAGER_VERSION` and `MANAGER_COMMIT` into the image.

| Variable                      | Default                                           | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                | required                                          | The Postgres connection string. Under Compose the `api` service's is set by `docker-compose.yml`, so the file's value is used by `pnpm dev` alone                                                                                                                                                                                                                                                                                                   |
| `POSTGRES_PASSWORD`           | none                                              | The password of the `postgres` container, embedded into the Compose `DATABASE_URL`                                                                                                                                                                                                                                                                                                                                                                  |
| `MANAGER_PORT`                | `9876`                                            | The port the API listens on                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `MANAGER_HOST`                | `0.0.0.0`                                         | The address the API binds. Every interface by default, which the `web` container needs to reach the `api` container. `127.0.0.1` when the manager runs on the host and should answer the loopback alone                                                                                                                                                                                                                                             |
| `WEB_PORT`                    | `8080`                                            | The host port the console is published on (Compose only)                                                                                                                                                                                                                                                                                                                                                                                            |
| `MANAGER_WEB_BIND`            | `127.0.0.1`                                       | The host address the console's port is published on (Compose only). Docker publishes past a host firewall, so name another address only where something else stands in front of it                                                                                                                                                                                                                                                                  |
| `MANAGER_ROOT`                | `/opt/streaming/streaming-infra-manager`          | The manager's own folder on the host, where `deploy/deploy.sh` sends this checkout and where `docker-compose.yml` mounts it at the same path. Read by the deploy script and the Compose file, not by the manager's code                                                                                                                                                                                                                             |
| `BEE_DATA_ROOT`               | `/opt/streaming/streaming-infra-manager-data`     | Each local deployment's Bee node data and keys, and its engine config file under `<name>/engine/`. Set by `docker-compose.yml`. Survives a manager deploy and goes with the deployment                                                                                                                                                                                                                                                              |
| `STACK_VERSIONS_ROOT`         | `/opt/streaming/streaming-infra-manager-versions` | Where every version lives, the bundled one included: its clone, its builds and its settings files                                                                                                                                                                                                                                                                                                                                                   |
| `SHLS_ROOT`                   | `apps/hls-stream` beside the manager              | A stack folder the manager reads settings from when a version root has none of its own yet. `docker-compose.yml` points it at `<MANAGER_ROOT>/manager/swarm-hls-stream`, which no deploy sends                                                                                                                                                                                                                                                      |
| `STACK_SOURCES`               | this repository's `apps/hls-stream`               | The repositories versions may be built from, an allow-list. Comma separated, each an `https` GitHub clone address with `#<folder>` where the stack sits in it. The first is where a new version and the bundled one are fetched from                                                                                                                                                                                                                |
| `MANAGER_SSH_DIR`             | `/opt/streaming/manager-ssh`                      | The SSH identity the manager deploys to other hosts with: the deploy key, `known_hosts`, and an `ssh_config` with a `Host` block per target alias. Mounted at `/root/.ssh` in the api container, whose image links `/etc/ssh/ssh_config` to the `ssh_config` in it. See [the deploy guide](../deploy/README.md#deploying-bee-nodes-to-other-hosts)                                                                                                  |
| `PUBLIC_HOST`                 | set by `deploy.sh`                                | The address clients reach this host's deployments on, and the public ingest address a stage record carries for a deployment on this host that sets none. Unset, component URLs work only on this machine                                                                                                                                                                                                                                            |
| `BEE_LOCAL_HOST`              | `host.docker.internal`, or `127.0.0.1` natively   | The host the manager reaches a local deployment's published ports on: the uploader's health, the Bee node's API and OvenMediaEngine's HLS port. Also the host every local ABR pool string carries. Set it to the stack's `*_API_BIND` address when that is not the bridge. A host name or an IPv4 address, no scheme, path, port or IPv6 address. Any other shape stops the manager at startup                                                      |
| `DOCKER_HOST`                 | `/var/run/docker.sock`                            | The Docker the manager talks to on its own host, read by its Docker client. `docker-compose.yml` leaves it unset and mounts the host's socket                                                                                                                                                                                                                                                                                                       |
| `HOST_PROC`                   | `/host/proc`, then `/proc`                        | Where the resource monitor reads the host's CPU, memory, disk I/O and network. A manager run outside Docker reports its own machine                                                                                                                                                                                                                                                                                                                 |
| `HOST_ROOTFS`                 | `/host/rootfs`, then `/`                          | Where the resource monitor reads the host's disk                                                                                                                                                                                                                                                                                                                                                                                                    |
| `LOG_LEVEL`                   | `info`                                            | `trace`, `debug`, `info`, `warn` or `error`. `error` is failures alone, `warn` adds what an operator should look at, `info` adds what the manager did, and `debug` adds each failed read that was answered for anyway, which repeat on every poll. `trace` writes what `debug` does. Any other value stops the manager at startup. `node dist/cli.js` writes at `info`                                                                              |
| `MANAGER_INSTANCE_NAME`       | none                                              | The name this manager goes by, such as `swarm-dev`, shown in the sidebar and answered by `GET /config`. At most 40 letters, digits, dots, dashes or underscores                                                                                                                                                                                                                                                                                     |
| `MANAGER_VERSION`             | none                                              | The build's name, built into the api image by the deploy. Never set it in `.env`: the deploy refuses a file with this line                                                                                                                                                                                                                                                                                                                          |
| `MANAGER_COMMIT`              | none                                              | The build's commit, 40 lowercase hex digits, built into the image the same way                                                                                                                                                                                                                                                                                                                                                                      |
| `BEE_RPC_ENDPOINT`            | none                                              | The chain endpoint every Bee node created here is offered first (`rpc_endpoint_source: manager`). Such a URL can carry an API key: `GET /config` answers only its host, and the logs this manager serves and the deploy output it stores have it removed. The Bee node prints its endpoint into its own container log, so the safe shape is an address carrying no key, such as a proxy on the host. A malformed value stops the manager at startup |
| `FUNDING_RPC_URL`             | `BEE_RPC_ENDPOINT`                                | The chain endpoint the funding API reads through and broadcasts to, and the default for chequebook transfers. A secret like `BEE_RPC_ENDPOINT`: never logged or answered. A malformed value stops the manager at startup                                                                                                                                                                                                                            |
| `CHEQUEBOOK_RPC_ENDPOINTS`    | none                                              | A chain endpoint per chain id for chequebook transfers, ahead of the defaults. See [Funding a chequebook on a new host](#funding-a-chequebook-on-a-new-host)                                                                                                                                                                                                                                                                                        |
| `CHEQUEBOOK_FLOOR_BZZ`        | `0.5`                                             | The chequebook balance below which the manager warns, a decimal BZZ amount above zero with at most 16 decimal places. A malformed value stops the manager at startup                                                                                                                                                                                                                                                                                |
| `FUNDING_API_TOKEN`           | none, the API is off                              | The bearer token of the funding API under `/api/admin-funding`, the same value as the admin's `MANAGER_FUNDING_TOKEN`. 32 characters or more with no space, or the manager stops at startup naming the variable. Never logged                                                                                                                                                                                                                       |
| `ADMIN_LINK_ALLOW_PLAIN_HTTP` | `false`                                           | Whether the admin link may be plain `http` to another host than the manager's own. Off, the manager takes plain `http` only to a loopback address, `host.docker.internal` or the bridge address it resolves to, or a name in a Docker network of the api container. Set it only for a test setup: every push carries the registrar token and each stage's SRT passphrase                                                                            |
| `KNOWN_HOST_NETWORK_PORTS`    | none                                              | Host-network containers that count as known, by Compose project, with the ports each holds, as in `edge=80/tcp,443/tcp,443/udp`, projects separated by `;`. Docker reports no port map for such a container, so an unnamed one blocks every removal, port handover and firewall export on its host. A port left out counts as free. No deployment may carry a named project's name. A malformed value stops the manager at startup                  |

`MANAGER_ROOT` and `STACK_VERSIONS_ROOT` are mounted into the api container at the same absolute
path they have on the host, because the Docker daemon runs on the host and reads every path in a
Compose file as a host path.
