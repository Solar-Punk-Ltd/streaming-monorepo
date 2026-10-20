# Postage stamps

A **postage stamp**, or **batch**, is prepaid storage on Swarm. A Bee node buys
it on Gnosis Chain with BZZ from its own wallet, and every chunk it uploads
carries a stamp from that batch as proof that the storage is paid for. This is
a feature page of the manager (`apps/infra-manager`, the web console and API
that deploys the streaming stack onto hosts). A deployment with a Bee node of
its own handles its batches on its page, on the **Storage and funding** card:
it buys one, records one on the deployment with **Use**, tops one up for more
life, and dilutes one for more room.

## What a batch is

A batch has a **depth**. It holds `2^depth` chunks of 4 KB, so a depth 23
batch holds 8,388,608 chunks, 32 GiB. Bee splits every batch into `2^16`
**buckets**, so each bucket holds `2^(depth - 16)` chunks: 2 at depth 17 and
128 at depth 23. A chunk's bucket is set by its own address. Chunks never
spread evenly, so one bucket fills first, long before the batch as a whole is
full.

The fullest bucket decides whether an upload is refused, and it is what Bee
reports: a batch's `utilization` is the chunk count of its fullest bucket. The
manager reads how full a batch is as that count over what one bucket holds,
`fullestBucketFillRatio` in `common/src/stampHealth.ts`, where 1 is full. The
stamps table shows it in its **Used** column as a percentage, rounded down,
with the two counts under it, for example "128 of 128".

The manager buys and dilutes from depth 17 (`MIN_STAMP_DEPTH`), the shallowest
batch Bee sells, to depth 40 (`MAX_STAMP_DEPTH`).

### When the fullest bucket fills

- An **immutable** batch refuses every upload that lands in a full bucket,
  with a 402. Bee still calls such a batch usable and still shows its time
  left. The manager calls it `full`, and a full batch blocks its deployment's
  readiness and its rung's place in a pool string, as an expired one does.
- A **mutable** batch never refuses. It takes the upload and overwrites the
  oldest chunk in that bucket, so earlier uploads lose data while new uploads
  keep working. It stays `active`.
- A batch whose kind the node did not report is read as immutable, the kind
  that refuses.

Past 90% full (`STAMP_FILL_WARNING_RATIO`) a batch warns as **Stamp nearly
full**. 90% is the uploader's default start ceiling, the stack's
`STAMP_MAX_UTILIZATION`: an uploader restarted on such an immutable batch
refuses to start while uploads still work. An immutable batch warns until it
is full, then fails as `full`. A mutable batch warns full or not, with its own
consequence: once full its node overwrites its oldest chunks. The manager can
still deploy a stack version before `v3.4`, whose uploader also refuses to
restart on a mutable batch past 90%, so the warning says that too
(`isStampNearlyFull`, `nearlyFullConsequence`).

## Life and price

A batch holds a balance for every chunk, in PLUR (1 BZZ is 10^16 PLUR). Every
Gnosis block, 5 seconds (`BLOCK_TIME_SECONDS`), the chain takes the current
price from that balance for every chunk. A batch's life, its **TTL**, is its
balance over the price, times 5 seconds. When the balance runs out the batch
has expired: its uploads fail, nothing revives it, and the node drops it some
time later.

The **amount** in the stamps table is what has been paid a chunk, Bee's
`amount`. It never falls as the batch spends, so the life left is the TTL
column, not the amount over the price.

- The price moves, so every life shown before paying is at **today's price**,
  from the node's `/chainstate`. A batch lives longer if the price falls and
  shorter if it rises.
- Bee refuses to buy a batch with less than a day of life at today's price
  (`MINIMUM_STAMP_VALIDITY_SECONDS`), so the buy form says what a day costs a
  chunk (`minimumStampAmountPlur`). At a price of 90,968 PLUR a chunk a block,
  a day costs 1,571,927,040 PLUR a chunk.
- Buying or topping up costs the amount for every chunk the batch holds,
  `amount × 2^depth` PLUR (`stampCostPlur`). At that price a day for a depth 23
  batch costs 1.318627974316032 BZZ.
- The postage contract refuses a top-up or a dilute that would leave a batch
  with less than a day of life.
- A batch warns as **Stamp ends soon** within two days of running out
  (`STAMP_EXPIRY_WARNING_SECONDS` in `packages/contracts`).

## What a deployment's page says about its batch

The readiness step **Postage stamp set** and the batch alerts on the Storage
card compare the batch recorded on the deployment with what its node says
(`stampHealthFrom`). The pool page and the overview read the same verdict.

| State   | What it means                                | Blocks | What is offered                                                           |
| ------- | -------------------------------------------- | ------ | ------------------------------------------------------------------------- |
| none    | No batch recorded on the deployment.         | yes    | Buy stamp                                                                 |
| pending | Bought, and Bee has not made it usable yet.  | yes    | nothing, it settles by itself                                             |
| active  | Usable, with room or mutable, and time left. | no     | Top up or buy within two days of running out, Dilute or buy past 90% full |
| full    | Immutable, its fullest bucket full.          | yes    | Dilute or buy                                                             |
| expired | No time left.                                | yes    | Buy stamp                                                                 |
| gone    | The node no longer holds the recorded batch. | yes    | Buy stamp                                                                 |
| unknown | The node was not asked or did not answer.    | no     | Retry node checks, where the page asked                                   |

Under **Needs attention** on the overview, a missing, expired, full, nearly
full or ending batch carries the same remedy as a button that opens the
deployment's storage: **Buy stamp**, **Dilute or buy**, or **Top up or buy**.

## The four operations on the Storage card

Each batch in the stamps table has its readings on one row and, under it, its
actions: **Use**, **Top up** and **Dilute**. All three are off for an expired
batch, for one not usable yet, and while another change is in flight.

### Buy

The form under the table takes an amount per chunk, a depth, an optional label
and whether the batch is immutable, and shows the life and the cost before you
buy. It costs `amount × 2^depth` PLUR from the node's wallet and the
transaction fee in xDAI. The new batch is unusable for a few minutes. The
manager checks it every 3 seconds (`USABLE_POLL_MS` in `StampService`) for up
to 15 minutes (`USABLE_WAIT_MS`) and records it on the deployment once it is
usable, unless another batch was recorded with **Use** meanwhile.

Recording a batch redeploys nothing. A running uploader keeps paying with the
batch it started with until it restarts, which the card offers at once (see
Use). A pool rung's new batch reaches an ABR uploader on this manager that
publishes to its pool at that uploader's next deploy, which writes the pool's
current string ([abr-ladder.md](abr-ladder.md)). An uploader handed the string
from another manager needs it pasted again.

### Use

Records a batch the node already holds as the deployment's batch. It costs
nothing and sends nothing to the chain. It is unavailable on a full immutable
batch, and the row says "full, dilute it first", because the node refuses
every upload in its full bucket.

A stream uploader reads its batch once, when it starts, so Use changes nothing
that runs until the uploader restarts. The card says so where you clicked:

- Right after Use, the page reads the deployments again, and the settings of
  every uploader that pays with this node's batches. A warning says the batch
  is saved but the running uploader still pays with the one it started with,
  naming that batch when the manager's container record has it.
- Beside it, **Apply now** runs the deployment's own settings Apply, the one
  the Stack settings card offers. That Apply carries every saved setting the
  running containers are behind on, not only the batch. The row names each key
  it applies, which of them were saved earlier, and what it recreates, usually
  the stream uploader alone.
- **Apply now** always asks first. It says a broadcast is live when SRS
  reported a publisher over SRT, or over RTMP on the ingest vhost. SRS reports
  a publisher only about every ten seconds, so a reading with no publisher can
  miss one that connected moments ago, and the question says so. It says it
  cannot tell for an engine other than SRS, for a log it could not read, for an
  RTMP report without its vhost, and for an ingest read that failed or took
  more than 10 seconds (`INGEST_READ_DEADLINE_MS`). With the uploader alone
  recreated, a live broadcast pauses until the old uploader has written its
  recording and restarted: seconds for a short broadcast, up to about five
  minutes for a long one, because the uploader's compose service waits up to
  330 s (`stop_grace_period` in the stack's `deploy/docker-compose.yml`). The
  recording is kept. When the engine or every service is recreated, the encoder
  is disconnected and the broadcast stops until it reconnects.
- The manager answers Apply once the recreate has started. The card then reads
  the uploaders' settings again after 2, 4 and 8 seconds, then every 15
  seconds (`APPLY_FOLLOW_DELAYS_MS`), for up to seven minutes
  (`APPLY_FOLLOW_BUDGET_MS`), until the uploader runs on the saved settings.
  It then says the uploader runs the saved batch, or that it still ran its old
  batch, was not running again, or could not be read, and points at the
  deployment's page. The card's buttons stay usable meanwhile.
- The chip on each batch follows the running uploader, read from the
  `runningValue` the settings list carries for `STAMP`
  ([deployment-settings.md](deployment-settings.md)): **in use** on the saved
  batch it pays with, **saved, not in use until Apply** on a saved batch it does
  not run yet, and **in use until Apply** on the batch it still runs that is no
  longer saved, which keeps its Use button to go back to it. Where nothing
  records what an uploader runs, such as a stopped deployment, the saved batch
  reads **in use**, because the next start pays with it, unless an uploader is
  known to be behind on it.

A deployment that runs its own Bee node and also has a pool string in
`BEE_PUBLISHERS` publishes through the pool, and its uploader reads `STAMP`
only while that string is empty. While the saved string is set, Use changes
nothing the next deploy pays with, so the card offers no Apply now and marks no
saved batch in use. An uploader started with a pool string pays with none of
this node's batches. A local batch it still runs while it waits to switch to
the pool reads **in use until Apply**.

On a pool rung's page the uploaders are the ABR stages that publish through
the rung: those whose stored pool string names, for this rung, a batch the
node holds. Each stage's settings are read under a 15 second deadline
(`STAGE_READ_DEADLINE_MS`), so a stage that does not answer is left out and
the others still show. The warning names each stage that is behind, with a link
to its page and an Apply now of its own. The saved batch reads **in use** only
once no stage is behind on it. See [abr-ladder.md](abr-ladder.md).

### Top up

Adds an amount per chunk to a batch's balance. It buys the batch life and
changes nothing else: not its depth, not its fill, not its id. It costs
`amount × 2^depth` PLUR from the node's wallet and the transaction fee in xDAI.

The dialog names the batch by its short id, depth, life left and how full it
is, and takes one amount, PLUR per chunk, with a hint of what a day more costs
a chunk at today's price. Before you confirm it shows the life the amount adds,
the life after and the cost to the last digit, and the confirm button names
that cost, for example "Top up for 1.318627974316032 BZZ". Where the node's
wallet was read and holds less than the cost, the confirm is off and the dialog
says how much the wallet holds.

### Dilute

Raises a batch's depth. Every step doubles the chunks the batch holds and the
chunks each bucket holds, and keeps the fullest bucket's count, so it halves
how full the batch is. It also halves the life left, because the same balance
now pays for twice the chunks. It costs no BZZ, only the transaction fee in
xDAI, and it keeps the batch id. It is the remedy for a full immutable batch: a
depth 23 batch with 128 of 128 chunks in its fullest bucket is half full at
depth 24, 128 of 256, with half its life.

The dialog names the batch the same way and takes one input, the new depth,
from one step deeper up to 40. Before you confirm it shows what the batch holds
after, in chunks and per bucket, how full it is after, its life after, and that
it costs no BZZ. A depth that would leave less than a day of life is refused:
the dialog says the postage contract refuses it and to top the batch up first,
and the confirm stays off. Otherwise the confirm names the depth, for example
"Dilute to depth 24".

A batch diluted with little time left warns as ending soon, and a top-up buys
that life back.

## The catalogue node's pinned batch

The brand's **catalogue node** is a Bee-only deployment designated on the
Manager settings page, with one immutable batch its node holds pinned for the
catalogue ([stages.md](stages.md#the-catalogue-node)). On that node's page the
pinned batch carries a **catalogue** chip in the stamps table, and the Storage
and funding card says so. Buying a batch there, or using another one, changes
the batch the deployment records, `stamp_id`, and leaves the catalogue on the
pinned one, because the designation pins the batch by id in a table of its own.
Moving the catalogue to another batch is its own action
([stages.md](stages.md#moving-the-catalogue)).

**Top up** keeps the pinned batch alive. The manager checks the catalogue's
batch every 10 seconds (`CATALOGUE_CHECK_MS`) and pushes its new life to the
admin once the node reports it. **Dilute** keeps the batch too, with half the
life per step.

The designation refuses a mutable batch: once a bucket fills, a mutable batch
overwrites its oldest chunks, and the catalogue's oldest entries are the ones
a viewer reads first. It refuses a batch whose kind the node does not report as
well. **Buy** on the catalogue node should buy an immutable batch.

## After Bee answers

Bee sends a top-up or a dilute from the node's own wallet and answers once the
transaction is mined, with the batch id and the transaction hash. A top-up is
two transactions, an approval of the BZZ transfer and the top-up itself. The
manager answers the page 202 with Bee's answer.

The node then reads the change back from the chain a few blocks behind the
tip. Until it has, the node's list still shows the old life and depth. So the
dialog closes, the page reads the node's batches again at once, and a notice
says which transaction carries the change, that it is mined, and that the new
life, or the new depth and life, shows once the node has read it back,
usually within a minute. The card reads the node again every 10 seconds
(`NODE_REFRESH_INTERVAL_MS`), and **Refresh** reads it at once.

Neither change touches the deployment's record or its pool string, because the
batch keeps its id. A diluted batch takes uploads again once its node has the
new depth. An uploader that has already reported `postage_refused` keeps
reporting it until it is deployed again, because the stack's uploader keeps
that reason for the life of its process (the stack's
`packages/stream-uploader/README.md`).

## What the manager refuses before Bee is asked

- A body that breaks the rules: a batch id that is not 32 bytes of hex, with
  or without `0x`, an amount that is not a positive whole number of PLUR, or a
  depth outside 17 to 40. Answered 400.
- A batch the deployment's node does not hold. A top-up or a dilute asks the
  node for that one batch first, `GET /stamps/{id}`, and one the node does not
  hold is refused with `404 stamp_not_found`. Bee's batch store holds every
  batch on the chain, so without that read a batch of someone else's could be
  paid for.
- A dilute to a depth that is not deeper than the batch's own. Answered 400
  with the batch's depth in the sentence.
- A dilute that would leave the batch under a day of life. Answered 400 with
  the life it would leave and the advice to top it up first. The life is the
  one the node reports, halved for every step, the figure the dialog shows.
  Where the node does not say how long the batch has left, the dilute is sent
  and the contract decides.

A refusal from Bee itself, "out of funds" for example, reaches the page in
Bee's own words, as a refused buy does.

## Routes

| Method | Path                           | Body                   | Answer                         |
| ------ | ------------------------------ | ---------------------- | ------------------------------ |
| POST   | `/profiles/:name/stamp/topup`  | `{ batch_id, amount }` | 202 with `{ batchID, txHash }` |
| POST   | `/profiles/:name/stamp/dilute` | `{ batch_id, depth }`  | 202 with `{ batchID, txHash }` |

Both sit behind the same session as every stamp route. The other stamp routes,
buy, set and the node readings, are in
[manager/README.md](../../manager/README.md#postage-stamps).

The admin tops up and dilutes the same batches through the funding API's
stamp operations, on its bearer token
([manager/README.md](../../manager/README.md#stamp-operations)). Each asks the
node with the same two `PATCH` requests and pays from the node's own wallet.
Its checks are stricter than the Storage card's. It reads the node's wallet and
refuses a top-up the xBZZ does not cover, and either operation with no xDAI for
gas. A dilution takes at most two steps (`FUNDING_DILUTE_MAX_STEPS`) and must
leave seven days of life (`FUNDING_DILUTE_MIN_SECONDS`). Each operation is
journalled before the node is asked, so the same request is never sent twice.

## Code

| File                                                                                                                        | What it does                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `common/src/stampChanges.ts`                                                                                                | `dilutionPreview` and `topUpPreview`, what a change leaves a batch with, and the request and answer shapes. |
| `common/src/stampHealth.ts`, `stampCost.ts`                                                                                 | How full a batch is and what state it is in, and what life and cost an amount buys.                         |
| `manager/src/domain/BeeClient.ts`                                                                                           | `topUpStamp` and `diluteStamp`, the two `PATCH` requests to Bee.                                            |
| `manager/src/domain/StampService.ts`                                                                                        | Buy, set, top-up and dilute for a deployment's own node: read the batch first, refuse, send, log one line.  |
| `manager/src/domain/errors/StampNotFoundError.ts`, `DiluteDepthError.ts`, `DiluteLifeError.ts`                              | The three refusals, answered 404, 400 and 400.                                                              |
| `manager/src/api/routes/stamp.ts`, `manager/src/schemas/stamp.ts`                                                           | The routes and their bodies.                                                                                |
| `frontend/src/uploaders/StampTable.tsx`, `stampRowActions.ts`, `bucketFill.ts`                                              | The table's Used column and each batch's actions.                                                           |
| `frontend/src/uploaders/TopUpStampDialog.tsx`, `topUpView.ts`, `DiluteStampDialog.tsx`, `diluteView.ts`, `BatchSummary.tsx` | The two dialogs and what they show before you confirm.                                                      |
| `frontend/src/deployments/StorageCard.tsx`                                                                                  | Opens the dialogs, sends the change, reads the node again and says what was sent.                           |
| `frontend/dev/mock-stamps.mjs`                                                                                              | The offline mock's stamp routes, with the manager's schemas and refusals. It seeds a full immutable batch.  |

## Limits

- The dialog and the manager judge a dilution's remaining life at today's
  price. If the price falls before the next block, the contract could have
  accepted a dilution right at the one-day boundary that they refused. Topping
  the batch up first gets past it either way.
- Nothing warns about a top-up that leaves a batch under a day, which the
  contract refuses as well. This only happens on a batch with less than a day
  left, where the dialog's hint already says what a day costs.
- The manager does not check the wallet before a top-up. The page does, where
  it read the wallet, and Bee refuses one it cannot pay as "out of funds".
- A refusal from Bee reaches the page as `502 bee_node_unreachable` with Bee's
  words in its message, the code every failed call to a node gets, which reads
  as though the node did not answer.
- A top-up or dilute of a batch the node holds but has not made usable yet is
  answered by Bee with 400 "batch not usable", which the manager passes on as
  `502 bee_node_unreachable`. The page never offers either on such a batch.
