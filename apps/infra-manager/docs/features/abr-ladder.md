# ABR ladder

This is a feature page of the manager (`apps/infra-manager`), the web console and API that deploys
the streaming stack (`apps/hls-stream`) onto hosts. It describes adaptive bitrate (ABR) publishing
through a node pool: four Bee nodes, one per quality of the stream, that an ABR uploader publishes
to.

## What it does

### Terms

- A **rung** is one quality of the ABR ladder. The shipped ladder is `DEFAULT_QUALITY_LADDER` in
  `packages/contracts/src/qualityLadder.ts`: `360p` (640x360, 700 kbps), `480p` (854x480, 1200
  kbps), `720p` (1280x720, 2800 kbps) and `1080p` (1920x1080, 5000 kbps).
- An **ABR node pool** is a deployment group of kind `abr-node-pool` whose members are four
  ordinary deployments, each running only a `bee-uploader`, one per rung. Each member has its own
  port slot, data directory, wallet and postage batch (`stamp_id`).
- The **pool string** is the value of the stack key `BEE_PUBLISHERS` the pool produces: one
  `rung@url<batchid>` entry per rung, space separated, lowest rung first. For example
  `360p@http://192.0.2.10:10015<batchid> 480p@http://192.0.2.10:10025<batchid> ...`. The batch id
  sits in angle brackets because `#` starts a comment in a `.env` file.
- An **ABR uploader** is a deployment of kind `abr-uploader`. It runs `srs` and `stream-uploader`
  and no Bee node of its own. It publishes each rung to the pool's node for that rung.
- The **coordinator** is the lowest rung, `360p`. It carries the stream catalogue and each
  stream's master playlist, the only two addresses a viewer needs to open a stage, because its
  batch lasts longest.

### Why one node per rung

A postage batch fills in proportion to the bitrate written to it. The `1080p` rung writes about
seven times the bytes of `360p`, so batches of equal depth run out hours apart. With one node per
rung, a batch running out silences one rung and players step down to another, instead of the
whole stage stopping. Each node also has its own chequebook and fails on its own.

A rung is an ordinary deployment, so every per-node operation works on it unchanged: fund, buy a
batch, top up, dilute, stop, remove, health and metrics. The stack knows nothing about pools. It
reads `BEE_PUBLISHERS`.

### Rung names

Members are named `<pool>-<rung>`, for example `abr1-360p` to `abr1-1080p`. The rung lives in the
name, not in a column and not in the member's position. A position shifts when a member is
removed and added again, and a batch sized for `360p` would then pay for `1080p`. A name is
stable, unique and readable in the deployments table. `rungFromMemberName` strips the known pool
name, so `abr` with `abr-1080p` and `abr-1` with `abr-1-360p` are never confused.

Deployment names are at most 31 characters and a member appends `-1080p`, so a pool name is at
most 25 characters (`LADDER_GROUP_NAME_MAX` in `common/src/abrLadder.ts`). `POST /groups` refuses
a longer one before any member is created.

### What is stored

| What                                  | Where                                       |
| ------------------------------------- | ------------------------------------------- |
| that the group is a pool              | `deployment_groups.kind = 'abr-node-pool'`  |
| that the four deployments are one set | `deployment_groups` and `profiles.group_id` |
| which rung a member publishes         | the member's name                           |
| the batch a rung pays with            | `profiles.stamp_id` of the member           |
| a rung's Bee API port                 | derived from the member's `port_slot`       |

The kind is a column rather than read from the member names. A pool that has lost a rung is
still a pool, one that needs repair, and the console keeps showing it as one and says which rung
is missing. `isLadderKind(group.kind)` answers "is this a pool", and `beePublishersForGroup`
answers whether every rung is ready.

## How to use it in the console

1. **New deployment**, then the goal card **ABR node pool**. The manager creates four
   deployments, `<pool>-360p` to `<pool>-1080p`, each with the single `bee-uploader` component,
   and deploys them.
2. Open the pool's group page. It lists the four rungs and the **Pool string** card.
3. Fund each rung. On each rung's own deployment page, under **Storage and funding**, send its
   address xDAI and xBZZ, then buy its batch. **Buy stamp** on a rung's row of the group page
   opens that card. The buy form starts at the rung's suggested depth, 17, 18, 19 and 20 across
   the shipped ladder (`suggestedRungDepth`: one more depth for each doubling of bitrate over the
   lowest rung, from `MIN_STAMP_DEPTH` 17).
4. When every rung is ready, the **Pool string** card shows the value with **Copy pool string**
   and **Create an ABR uploader using this pool**. Until then it names the rung in the way and
   why. See [Rung validity](#rung-validity).
5. **New deployment**, then the goal card **ABR uploader**. Pick the pool, or paste a pool
   string. The form shows the rungs the value resolves to.

An ABR uploader's own page has no funding panel and no batch to buy, because it runs no Bee node.
Its pool target card lists where each rung lands. It can be started at once.

## The ABR uploader

|                  | Single-node uploader                       | ABR uploader                        |
| ---------------- | ------------------------------------------ | ----------------------------------- |
| services         | `srs` + `stream-uploader` + `bee-uploader` | `srs` + `stream-uploader`           |
| where uploads go | its own Bee node, or `BEE_URL`             | the pool's four rungs               |
| postage          | its own `stamp_id`                         | the pool's, one batch per rung      |
| its page         | fund the node, buy batches                 | nothing to fund, shows pool targets |

`BEE_PUBLISHERS` is required for an ABR uploader. The form, the API and the deploy each check it
with `beePublishersProblem` against the uploader's own rules: every rung of the shipped ladder,
none twice, nothing else, and an http(s) address that is neither loopback nor carries ssh user
information. A pasted value is stored in one canonical form (`normalizeBeePublishers`): one space
between entries, batch ids lower case and without `0x`. `bee_publishers` needs the `srs` engine.
The ladder is not implemented for OME.

At deploy, `writeProfileEnv` writes `BEE_PUBLISHERS`, `ABR_ENABLED=true` and `ABR_LADDER` into
the deployment's env file. `srs` and the uploader both read all three, so the ladder the engine
encodes and the ladder the uploader publishes come from one definition.

The Bee API is unauthenticated, and the uploader must reach all four rung API ports. Keep them on a
private network.

### Each rung's size and bitrate

The four rung names are fixed, because the pool has one Bee node per rung named after it and the
uploader refuses to start unless the pool covers the ladder exactly. Each rung's width, height and
bitrate are engine settings of the ABR uploader, twelve in all: `ABR_RUNG_<RUNG>_WIDTH`,
`_HEIGHT` and `_KBPS`, for example `ABR_RUNG_1080P_WIDTH` (`common/src/abrRungSettings.ts`). They
are listed under Engine settings on the deployment's settings card, grouped by rung, each
defaulting to the shipped ladder. Save, then Stop and Start the deployment, or Apply while it
runs, and the stack encodes at the new values.

The stack reads only `ABR_LADDER`, so the rung settings are never written as lines of their own.
`composedAbrLadderEnvValue` builds `ABR_LADDER` from them, each stored value or else the shipped
one, highest rung first, as `name:width:height:kbps`. With nothing stored it is the shipped
ladder. A value of `ABR_LADDER` in the host's base `.env` never applies to an ABR uploader. The
settings card shows `ABR_LADDER` read-only, with the value the deployment gets.

A save, and again the deploy, refuses:

- a width or height that is odd, because the H.264 encoder refuses odd picture sizes, or a value
  that is not a whole number
- a width outside 128 to 3840, a height outside 72 to 2160, or a bitrate outside 100 to 20000
  kbps
- a rung no taller than the one below it, or with no higher bitrate (`abrLadderOrderProblem`),
  because a viewer stepping up would get no sharper picture and one stepping down would save no
  bandwidth

A change to any of them recreates the engine and the uploader. The pool's own pages describe each
rung at the shipped size and bitrate, and a rung's suggested depth follows the shipped bitrates,
because a pool does not know which uploader publishes through it.

### When the pool string changes

A rung that buys a new batch changes the pool string. Topping up and diluting keep the batch id,
so neither changes it. A batch bought on the rung's own page is set on the rung once its node
calls it usable. A batch chosen with **Use** on the rung's Storage and funding card is set at
once.

An ABR uploader whose pool string names a pool on this manager follows it. Its pool is the pool
whose rung addresses every one of its entries names, as the pool card gives them. Each deploy of
the uploader, after an edit, a Start after a Stop, or a redeploy, writes the pool's current
string rather than the stored copy, and stores it when it differs (`withCurrentBatches` in
`manager/src/domain/stages/StagePoolStrings.ts`). Setting a batch on a rung also updates the
stored copy of every such uploader, so its page and its stage record name the new batch.

Setting a batch redeploys nothing. A running uploader pays with the old batch until it restarts.
After a **Use**, the rung's Storage and funding card lists every uploader still running on the
old batch and offers **Apply now** for each, which asks first and says whether that stage's
broadcast is live. See [postage-stamps.md](postage-stamps.md).

The deploy refuses when a rung of the pool has no batch, with
`<rung>: no postage batch set on this rung yet`, and when the catalogue guard refuses the string,
with the guard's own sentence. To change a rung's batch, use **Use** on the rung, not an edit of
the uploader's pool string.

A pool string that names any other node, one pasted from another manager among them, deploys as
saved. Nothing links it to the pool, so it has to be pasted again after a rung buys a new batch.
It also goes stale when a rung is removed and created again: ports come from the port slot, and a
freed slot is reused by the next deployment on that host, so an entry can come to name an
unrelated Bee node. That rung's uploads are then refused while the other three carry on. Paste
the string again after rebuilding a rung.

A pool string pasted from another manager does not follow the pool. Paste it again after a rung buys
a new batch or is rebuilt.

### When a rung's node does not answer

A rung that does not answer does not stop the uploader starting. The manager asks no node before
an ABR uploader starts, because it has no node of its own. The stack's uploader runs its own start
gates on every rung, set by its `UPLOADER_START_GATES` key, whose shipped value `chequebook-warn`
works like this: a dry chequebook is a warning, a node that does not answer is a warning, and the
one thing that refuses the start is a batch the node itself reports as not usable, out of time,
or immutable and over its fill ceiling.

A node that never answers is waited for instead of ending the start. The uploader reports the
wait on its own `/health`. The deployment page reads that route every 10 seconds (`NODE_REFRESH_INTERVAL_MS`),
and the **Uploader running** step says which node it waits for, how many attempts it has made and
since when, and clears when the node answers. A start gate that warned shows there too, for
example "the chequebook gate warned on the 360p rung".

The overview and the Deployments page read every running uploader's health every 30 seconds
(`REFRESH_MS` in `frontend/src/deployments/useUploaderHealths.ts`). Both list an uploader under
**Needs attention** when it reports a problem, waits for its node, or does not answer its health
route. `postage_refused` means a rung's Bee node refused that rung's batch, usually because it is
full or has expired. The uploader reads each rung's batch once, when it starts, so that rung's
uploads fail until the uploader is deployed again with a batch that pays.

A stack build whose uploader reports none of these fields shows only that the container is
running.

The coordinator has no failover. When the `360p` node is down, new viewers cannot join while
existing ones keep playing.

## Rung validity

A rung can take uploads only when three things hold: its node is running, its address is usable,
and its batch is alive. `GET /groups/:id/bee-publishers` checks each, in the order an operator
fixes them, since a stopped node makes its batch moot and an unusable address makes both moot.
It asks all four nodes at once, each probe on a 3 second timeout (`PROBE_TIMEOUT_MS` in
`manager/src/domain/StampService.ts`). A node that cannot answer leaves its rung unverified, never
failed.

### The node

Only `RUNNING` (`PUBLISHABLE_RUNG_STATUS`) is publishable. Any other status blocks the rung and
is named. A rung's row on the group page shows a status chip only when the node is not running,
so the one row that needs attention stands out.

### The address

A rung's URL is a host plus the Bee API port, `10005 + port_slot * 10` (the `bee_api` role in
`common/src/portPolicy.js`). For a member on this manager's host, the host is the address a
container on this host reaches the node on, from `resolveLocalPublisherHost` in
`manager/src/domain/localHost.ts`:

- `BEE_LOCAL_HOST` when it is set, taken as given. The bare name `host.docker.internal` is
  resolved as in the next case. The manager checks the value at startup and refuses to start on
  anything that is not a host name or an IPv4 address.
- Otherwise, when the manager runs in a container, the IPv4 address `host.docker.internal`
  resolves to there, which is the Docker bridge, handed on as a literal. The name itself would
  resolve nowhere inside an uploader container on Linux, because the uploader's compose service
  has no `extra_hosts`. A failed lookup answers the name, logs one warning, and is tried again on
  the next read.
- Otherwise, running natively, the name `host.docker.internal`, which Docker Desktop resolves
  inside a container.

The stack binds every local Bee API to the bridge address unless told otherwise (see the bind
step in [../../deploy/README.md](../../deploy/README.md)), which is why the bridge is the default.
A member on a declared remote host keeps that host's address, and its API has to be bound
somewhere this host can reach. An uploader running off this host needs `BEE_LOCAL_HOST` set to an
address it can reach, and a bind that admits it.

`profiles.host` is a deploy target: an ssh alias for a new deployment, and possibly `user@host` on one
stored before aliases were required.
`resolveNetworkHost` (`manager/src/utils/deployHost.ts`) turns it into an address: it drops the
ssh user, resolves a dotless name as an ssh alias with `ssh -G` against the config the manager's
container mounts, and takes a literal or dotted name as given. A name no Host block matches comes
back unchanged. Results are cached for 60 seconds (`DEFAULT_TTL_MS`), since the ssh config is a
bind mount an operator edits without restarting the manager. The same resolved value reaches the
browser as `network_host` on each profile, which the console builds component links and the SRT
publish address from.

`classifyPublishUrl` (`common/src/publishUrl.ts`) refuses three shapes without touching the
network:

- `loopback`: a loopback host works only on the manager's own machine. Only
  `BEE_LOCAL_HOST=127.0.0.1` produces one, and the message names `BEE_LOCAL_HOST`.
- `ssh-target`: a URL with user information is a deploy target, not a network address.
- `malformed`: no usable http(s) URL.

The manager then probes the published URL, the one the pool string carries, rather than the
address it reads the node on itself. The two can differ, and only the published one matters to
the uploader. A failed probe is `unreachable` and warns rather than blocks: the manager and the
uploader are separate containers with separate routes, and for a remote member NAT hairpinning
explains a failure as well as a wrong address does.

The address probe runs from the manager, not from the uploader, so an unreachable address only
warns.

### The batch

`profiles.stamp_id` records which batch a rung points at, not that the batch still works. A batch
runs out on its own, and bee drops a spent batch from `/stamps` after a while. So readiness asks
the rung's node, and `stampHealthFrom` (`common/src/stampHealth.ts`) classifies the answer:

| State     | Meaning                                                                                           | Blocks readiness |
| --------- | ------------------------------------------------------------------------------------------------- | ---------------- |
| `none`    | No batch recorded on the deployment.                                                              | yes              |
| `active`  | On the node, usable, time left, and either room left, mutable, or a fill the node did not report. | no               |
| `pending` | On the node, bought too recently to be usable.                                                    | yes              |
| `full`    | On the node, usable by bee's own flag, time left, immutable, and its fullest bucket is full.      | yes              |
| `expired` | On the node, `batchTTL` is 0.                                                                     | yes              |
| `gone`    | Recorded, but the node does not hold it: expired and dropped, or never bought there.              | yes              |
| `unknown` | The node was not asked, or could not answer.                                                      | no               |

`unknown` renders as unverified on the rung and on the pool string. An unreachable node is no
evidence that its batch is dead, and no evidence that it is alive.

bee returns a `batchTTL` of 0 for a spent batch and a negative value when it cannot work the TTL
out. Only 0 means expired. Within `STAMP_EXPIRY_WARNING_SECONDS` (48 hours) of running out, the
rung shows how long is left and the pool warns without withholding the value.

**Fill.** A batch also stops paying when it fills. bee's `utilization` is the chunk count of the
batch's fullest bucket, so the fill that decides refusals is `fullestBucketFillRatio`:
`utilization / 2^(depth - bucketDepth)`, where 1 is full. It is null when any of the three fields
is missing or not a whole non-negative number, or when `depth` is below `bucketDepth`, and null
never reads as empty. The pool passes the fill and bee's `immutableFlag` on to each rung as
`stampFillRatio` and `stampImmutable`, so the group page, the overview and the rung's own page
show the same numbers.

Only an immutable batch is `full`. bee never refuses a mutable batch: once a bucket fills, it
takes the upload and overwrites that bucket's oldest chunks, so older recordings lose data while
uploads keep working. A batch whose kind the node did not report is treated as immutable, the
kind that refuses. `full` is not a dead state: diluting the batch, from the rung's Storage and
funding card, buys room and keeps the batch id. See [postage-stamps.md](postage-stamps.md).

A batch past 90% of its fullest bucket (`STAMP_FILL_WARNING_RATIO`) that still takes uploads
stays `active` and warns. That is the uploader's default start ceiling, the stack's
`STAMP_MAX_UTILIZATION`: an uploader restarted on an immutable batch past it refuses to start. A
mutable batch warns there too, for the reasons in
[When the fullest bucket fills](postage-stamps.md#when-the-fullest-bucket-fills). The wording is
`nearlyFullConsequence` in `common/src/stampHealth.ts`.

### Blocking versus warning

|         | Blocks the value                             | Warns, value still served                                                   |
| ------- | -------------------------------------------- | --------------------------------------------------------------------------- |
| Node    | not `RUNNING`                                | none                                                                        |
| Address | `loopback`, `ssh-target`, `malformed`        | `unreachable`                                                               |
| Batch   | `none`, `pending`, `full`, `expired`, `gone` | `unknown`, expiring within 48 hours, past 90% full and still taking uploads |

Every warning is something the manager could not confirm rather than something it found wrong.
A rung already blocked gets no warning, so each rung carries one complaint, the one to act on.

## Group guards

Three group operations refuse a pool with 409 `ladder_group_invalid_operation`:

- `POST /groups` with `abr_ladder` and a `stamp_id`, and `PATCH /groups/:id/config` with a
  `stamp_id`. One batch across the pool is the failure a node per rung exists to prevent. Other
  shared fields stay editable for the whole group.
- `POST /groups/:id/members`. New members of a plain group are named `<group>-profile-N`, which
  is not a rung name.

All of them read `deployment_groups.kind`, so a pool that has lost a rung still refuses them.

Nothing keeps a pool whole after creation. Any rung can be stopped or removed on its own. The group
page names the missing rung.

## A single-node uploader on an external Bee node

A single-node deployment can publish to a Bee API it does not run. That is `profiles.bee_url`,
the external Bee API choice in the new deployment form.

It applies only to a deployment that runs no `bee-uploader`. With a local Bee node, the stack's
`resolve_bee_url` in `deploy/scripts/deploy.sh` writes its own `BEE_URL` into an override file
that outranks the deployment's env file, so a stored value would never take effect. The API
refuses `bee_url` beside a `bee-uploader`, and beside `bee_publishers`, so a deployment never says
two different things about where uploads go.

## Settings and routes

Manager environment, full list in [../../manager/README.md](../../manager/README.md):

| Key              | Default                                                                                  | What it does                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `BEE_LOCAL_HOST` | for a pool string, the bridge address in a container and `host.docker.internal` natively | The host every local pool string carries, among other local reads. See [The address](#the-address). |

Stack keys an ABR uploader's env file carries:

| Key                                         | Written from                                         |
| ------------------------------------------- | ---------------------------------------------------- |
| `BEE_PUBLISHERS`                            | the stored pool string, or the pool's current string |
| `ABR_ENABLED`                               | `true` whenever `BEE_PUBLISHERS` is set              |
| `ABR_LADDER`                                | the twelve rung settings, composed                   |
| `ABR_RUNG_<RUNG>_WIDTH`, `_HEIGHT`, `_KBPS` | never written, composed into `ABR_LADDER`            |

Routes:

| Method | Path                         | Body                                          | Answer                                                                                                            |
| ------ | ---------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| POST   | `/groups`                    | `{ group_name, size, abr_ladder: true, ... }` | the pool and its four members                                                                                     |
| GET    | `/groups/:id/bee-publishers` | none                                          | `{ ready, value, rungs, missing, warnings }`. 409 `ladder_group_invalid_operation` for a group that is not a pool |

The full answers are in [../../manager/README.md](../../manager/README.md), under Groups.

Ports are sparse. A rung takes a full port slot of 10 ports, so a pool reserves 40 ports. At the
manager's cap of 100 slots (`MANAGER_SLOT_CAP`) that is 25 pools on one host.
