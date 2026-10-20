# Chequebook funding

A Bee node pays the peers that forward its uploads with cheques drawn on its
**chequebook**, a contract on the chain that holds BZZ. The chequebook is a
different balance from the node's **wallet**, which holds xDAI for gas and BZZ
for buying postage and for filling the chequebook. This is a feature page of
the manager (`apps/infra-manager`, the web console and API that deploys the
streaming stack onto hosts). It covers how the manager shows a node's balances
and how it moves BZZ between the wallet and the chequebook: a **deposit** fills
the chequebook from the wallet, a **withdrawal** moves BZZ back to the wallet.

## What it does

- **Balances.** The manager reads the node's wallet, its chequebook address,
  the chequebook's total and available balance, and the settlement totals.
  A reading the node did not give stays unknown. It never shows as zero.
- **Units.** Amounts on the wire are **PLUR**, BZZ's integer unit. 1 BZZ is
  10^16 PLUR (`PLUR_PER_BZZ` in `common/src/chequebook.ts`).
- **The floor.** `CHEQUEBOOK_FLOOR_BZZ`, default `0.5`
  (`DEFAULT_CHEQUEBOOK_FLOOR_BZZ`), is the balance a node should hold before its
  uploader is worth starting. A chequebook under the floor is a warning. It
  never refuses an uploader start: a node that does not answer, a balance that
  cannot be read and a balance under the floor are each a line in the
  manager's log, and the start goes ahead.
- **Transfers are recorded operations.** Every deposit or withdrawal is saved
  in the manager's journal, the `chequebook_operations` table, before anything
  is sent. Its outcome is decided by evidence from the chain, a transaction
  receipt at finality, never by a balance change. An unrelated deposit,
  withdrawal or cheque settlement can move a balance too.
- **One transfer at a time per node.** The journal holds at most one
  unresolved operation per chain and node. A second transfer for that node is
  refused as busy until the first one is resolved.
- **The manager never resends a transfer by itself.** A lost answer, a
  restart or a failed save leaves the operation unresolved, and recovery is the
  operator's action.

The manager offers only these two moves. It does not send BZZ from a node's
wallet to any outside address.

## In the console

1. Open a deployment that runs its own Bee node. The **Storage and funding**
   card shows the wallet, the chequebook address with a copy button, the
   balances and the floor.
2. Press **Fill chequebook** or **Withdraw**. The dialog takes an amount in
   BZZ, shows **Review transfer**, then **Confirm transfer**.
3. On confirm the browser saves the request (see below), then sends it. The
   dialog stays open and shows the transfer's state and its evidence. It does
   not close by itself and does not read completion from a balance.
4. While the manager checks the chain for the receipt, the dialog and the
   transfer's detail page re-read the saved record every 10 seconds
   (`RECEIPT_READ_INTERVAL_MS`) and say so. A transfer that settles shows as
   settled without a click.
5. **Transfers** in the navigation (`#/transfers`) lists every transfer the
   manager recorded, newest first, and the requests saved in this browser.
   A transfer's detail page, **Saved transfer**, shows its saved identity, its
   hashes, every answer the node gave, and the last check. It carries the
   recovery actions described under "Recovery".

Reopening the dialog, also through the opposite button, restores the saved
request with its amount, direction and request id. **Refresh saved status**
reads the journal again. **New transfer** starts a different request after an
explicit second confirmation.

## The saved request in the browser

Each transfer has a **request id**, a UUID the browser creates. Before the
first POST the browser saves the confirmed request in IndexedDB, in one
transaction: the request id, the signed-in account id, the deployment's name
and its instance id (`profileInstanceId`, the UUID of one deployment
lifetime), the direction and the exact PLUR amount. It never saves a password,
a key, a session token or an endpoint. If the save fails, nothing is sent.

- **The same id never sends twice.** The manager answers a repeated request id
  with the operation it already recorded, and prepares nothing new. The same id
  with a different body is a conflict.
- **A lost answer keeps the id.** The browser asks
  `GET /chequebook/operations/by-request/:requestId` for the saved id. A 404 or
  a failed read does not prove the earlier POST never arrived, so the id is
  kept. **Retry this saved request** sends the same id and body again, after an
  explicit step. There is no automatic resend.
- **The saved request survives** navigation, reload and a final result. A
  second tab restores the same saved request and cannot replace it silently.
- **Scoped to one account and one deployment lifetime.** A deployment deleted
  and recreated under the same name gets a new instance id, so an old saved
  request never targets the new one.
- **The account is checked on every write.** Each submission and recovery
  write carries `expectedAccountId`, the account the page expects. The manager
  compares it with the signed-in user and refuses a mismatch with
  `409 account_changed`. The actor recorded is the signed-in user,
  `user:<id>`, derived by the manager.

## How a transfer reaches the node and the chain

No address is taken from a request, an operation record or a Bee answer. The
node's address comes from the deployment, the chain endpoint from the
manager's own settings. A transfer opens no Docker connection and no ssh
session, so a remote host needs nothing beyond what stamp operations already
need.

**The node.** `ConfiguredBeeTargetResolver` works out the node's Bee API from
the deployment's row: the address stamp operations use (`beeApiUrlFor`), over
plain `http`, on the port its `bee-uploader` container recorded
(`BEE_UPLOADER_API_PORT`). That port must be the one the deployment's port
reservation owns, read by `PostgresChequebookTargetOwnership.capture`, or the
transfer is refused before any connection opens. A port given since to another
deployment is never dialled.

`PinnedBeeSession` then opens one private HTTP connection to that address. It
reads `/addresses`, `/wallet` and `/chequebook/address`, which must agree on the
node, the chain and the chequebook, and sends the single
`POST /chequebook/deposit` or `POST /chequebook/withdraw`. The connection
follows no redirect and retries nothing.

| Limit                         | Value  | Source                                     |
| ----------------------------- | ------ | ------------------------------------------ |
| One HTTP read from the node   | 10 s   | `readTimeoutMs` in `PinnedBeeSession`      |
| The last check before sending | 30 s   | `preflightTimeoutMs` in `PinnedBeeSession` |
| The one POST                  | 180 s  | `postTimeoutMs` in `PinnedBeeSession`      |
| One answer from the node      | 64 KiB | `maxResponseBytes` in `PinnedBeeSession`   |
| Preparing a transfer          | 30 s   | `ChequebookTransferPreparation`            |

**The last check before sending.** With the operation already recorded, the
manager works out the target again, reads the node again, and checks the
wallet holds some xDAI for gas and enough BZZ (in the wallet for a deposit, in
the chequebook's available balance for a withdrawal). A failure here records
the operation as `rejected` and sends nothing.

**The chain.** `ChequebookChainRegistry` reads each chain through
`CHEQUEBOOK_RPC_ENDPOINTS` for a chain it names, else the manager's default
endpoint, `FUNDING_RPC_URL`, else `BEE_RPC_ENDPOINT`. Each endpoint must be
`http` or `https` with no user information and no fragment, and must answer
`eth_chainId` with the node's chain before it is used. Preparation, receipt
checks, finality and recovery all read the chain there. The endpoint the node
itself was started with is not read. An endpoint is never logged, answered or
put in an error.

## States and confirmation

| State        | Meaning                                                                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submitting` | The operation is recorded and the send was claimed. This state alone does not prove whether the node received the POST.                                        |
| `submitted`  | A transaction hash is recorded. Mining and finality are not established yet.                                                                                   |
| `unknown`    | No outcome could be established. Keep the request id and use recovery.                                                                                         |
| `settled`    | A matching successful receipt, on the canonical chain at or below the finalized block, was verified.                                                           |
| `reverted`   | A matching reverted receipt, on the canonical chain at or below the finalized block, was verified.                                                             |
| `rejected`   | The last check before sending refused it, and nothing was sent. `failureReason` is `preflight_no_gas`, `preflight_insufficient_balance` or `preflight_failed`. |
| `asserted`   | An operator recorded the duplicate-risk assertion (see "Recovery"). It is not a verified settlement and not proof that nothing was sent.                       |

The page shows one sentence per `failureReason`
(`chequebookPreflightSentence` in `common/src/chequebookRefusals.ts`).

**Receipt polling.** When an operation enters `submitted` the manager writes
`receiptPollUntil`, a deadline 30 minutes ahead (`RECEIPT_POLL_BUDGET_MS`).
Until then `ChequebookReceiptPoller` asks the chain for the receipt about every
20 seconds (`RECEIPT_POLL_INTERVAL_MS`), at most 20 operations a pass. A pass
waits for each check's own timeout, so during a chain outage the gap between
checks grows. The deadline is set once and never renewed. A restart resumes
only the operations whose deadline has not passed. When the deadline passes
without a final receipt, the operation stays `submitted`, the page says the
automatic checks ended, and **Check** stays available.

Never polled automatically: an operation in `submitting` or `unknown`, one with
no deadline, and one whose `failureReason` is `hash_conflict`.

**Finality.** `ChequebookReceiptInspector` accepts a receipt only when the
transaction matches the saved identity, and the receipt's block is canonical
and at or below the chain's `finalized` block. It walks parent hashes from the
finalized block down to the receipt and to the block recorded when the
transfer was prepared. One inspection has a 15 second deadline and walks at
most 512 parents (`maxAncestryBlocks`). A longer walk saves its progress and
resumes on the next check. A mined receipt before finality stays pending. A
missing `finalized` tag, an incomplete walk, a reorg or contradictory answers
leave the operation unresolved.

**What identifies a transfer.** The saved identity holds the chain, the node
address, the chequebook, the token, the amount, the direction, the actor, the
deployment instance, the block recorded at preparation and a lower bound on
the node's nonce. The nonce bound is an observation, not a reservation.

## Recovery

The detail page offers three actions. Each sends `expectedAccountId`, and none
of them sends or resends a transfer.

- **Check** (`Check transaction receipt`, or `Search transaction history` when
  no hash is known). With a hash, it checks that transaction's receipt. Without
  one, it reads the node's pending transactions and then scans the chain from
  the recorded start block, 64 blocks a pass (`maxBlocks` in
  `ChequebookRecoveryInspector`), 15 seconds at most. A scan that has started
  must finish its range before a match counts as the only one.
- **Resolve by hash** (`Check this transaction hash`). The operator supplies a
  transaction hash. The manager verifies it against the saved identity on the
  chain. It is a request to check, never a way to force a state.
- **Assert.** Allowed only after a complete current search found no match. The
  operator types the exact confirmation text the manager gives, which says that
  sending the amount again may pay twice. The request carries the recorded
  amount and the journal revision the operator reviewed (`expectedRevision`).
  If the operation changed since, the answer is `409 operation_changed`. The
  journal keeps the actor, time, amount and confirmation. A later check can
  still find a transaction.

History and recovery keep working after the deployment is deleted, through the
manager's endpoint for the transfer's chain. Reading the node's pending
transactions needs the original deployment instance and the same node.

When answers conflict, the conflict wins over any earlier final label. The
detail page shows every hash and answer it holds. The candidate list in an
answer is bounded. When `additionalEvidenceInResponseJournal` is true, the
journal holds more hashes than the list shows.

## API contract

All routes sit behind the session gate, and writes behind the same-site
header check. Bodies are strict: an unknown field is a 400. The actor always
comes from the session. A body cannot choose an actor, a chain, a contract, an
RPC endpoint or a Bee address. `amount` and `amountPlur` are positive integer
PLUR strings of at most 30 digits. The full reference is in
[manager/README.md](../../manager/README.md#chequebook).

| Method | Path                                           | Body                                                                | Answer                                                                                                                       |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/profiles/:name/chequebook`                   |                                                                     | Address, balances, settlement totals and the health verdict against the floor.                                               |
| POST   | `/profiles/:name/chequebook/deposit`           | `{ requestId, profileInstanceId, amount, expectedAccountId }`       | 202 with `{ kind, operation }`, `kind` `admitted` or `replayed`. 409 with the operation in the way when busy or conflicting. |
| POST   | `/profiles/:name/chequebook/withdraw`          | `{ requestId, profileInstanceId, amount, expectedAccountId }`       | As deposit.                                                                                                                  |
| GET    | `/chequebook/operations`                       | Query: `limit` (default 50, at most 100), `cursor`, `profileName`   | A page of history, newest first, with the next cursor.                                                                       |
| GET    | `/chequebook/operations/by-request/:requestId` |                                                                     | The operation saved under that request id, with its evidence. 404 when none.                                                 |
| GET    | `/chequebook/operations/:id`                   |                                                                     | The operation, its answers from the node and the assertion text.                                                             |
| POST   | `/chequebook/operations/:id/check`             | `{ expectedAccountId }`                                             | 200 with the updated operation detail.                                                                                       |
| POST   | `/chequebook/operations/:id/resolve`           | `{ transactionHash, expectedAccountId }`                            | 200 with the updated operation detail.                                                                                       |
| POST   | `/chequebook/operations/:id/assert`            | `{ amountPlur, confirmation, expectedAccountId, expectedRevision }` | 200 with the updated detail. 409 `chequebook_recovery_required` without a complete no-match search.                          |

A 202 never means settled. It can carry a `rejected` or `unknown` operation.
Other answers:

- `409 account_changed`: `expectedAccountId` is not the signed-in user.
- `409 chequebook_profile_changed`: the deployment was removed or replaced, or
  `profileInstanceId` is not its current instance. Nothing was sent.
- `409 operation_changed`: the operation changed after the operator reviewed
  it.
- `503 chequebook_preparation_unavailable` with
  `{ error, cause, check, message }`: the manager could not prepare the
  transfer. Nothing was recorded or sent. `cause` is one of
  `CHEQUEBOOK_REFUSAL_CAUSES` in `common/src/chequebookRefusals.ts`, and
  `message` is that cause's sentence. The answer carries no upstream text and
  no endpoint. The saved request can be sent again once the cause is fixed.
- `503 chequebook_journal_unavailable`: the journal could not be read or
  written.

The causes a running manager answers:

| Cause                       | When                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `bee_container_not_found`   | No `bee-uploader` container is recorded for the deployment.                                             |
| `bee_container_unsupported` | The recorded Bee API port is missing, out of range or not the reserved one.                             |
| `target_changed`            | The deployment is deploying, stopping or removing, has two `bee-uploader` containers, or changed.       |
| `bee_unreadable`            | The node did not answer, or its answers disagree.                                                       |
| `chain_endpoint_missing`    | No endpoint is set for the node's chain.                                                                |
| `chain_setting_invalid`     | `CHEQUEBOOK_RPC_ENDPOINTS` is malformed, or the default endpoint is not a usable `http` or `https` URL. |
| `chain_unreachable`         | The chain endpoint did not answer.                                                                      |
| `wrong_chain`               | The endpoint answered for a different chain than the node's.                                            |
| `unsupported_chain`         | The node runs on a chain whose BZZ token the manager does not know.                                     |
| `unavailable`               | No such deployment, no Bee node of its own, or a Bee API address that is not plain `http`.              |

The list also holds `docker_unreachable`, `docker_route_missing`,
`docker_setting_invalid` and `bridge_not_qualified`. The running manager never
answers them, and `check` is always `null` from it.

The admin moves chequebooks through the same preparation, the same last
check and the same journal, on its own bearer-token route,
`POST /api/admin-funding/chequebook-operations`
([manager/README.md](../../manager/README.md#chequebook-operations)). Its
operations are recorded as requested by `web2-admin` and appear in the history
like any other. The page never treats them as the signed-in operator's own, and
Check, Resolve and Assert work on them as on any other operation.

## Settings

| Setting                        | What it does                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `CHEQUEBOOK_FLOOR_BZZ`         | The floor in BZZ, default `0.5`, above zero with at most 16 decimal places. A malformed value stops the manager at startup.    |
| `CHEQUEBOOK_RPC_ENDPOINTS`     | Optional JSON object from chain id to endpoint, for example `{"100":"https://rpc.example.com"}`. Wins for each chain it names. |
| `FUNDING_RPC_URL`              | The default chain endpoint for any chain the setting above does not name.                                                      |
| `BEE_RPC_ENDPOINT`             | The default when `FUNDING_RPC_URL` is unset.                                                                                   |

The chain settings are read at startup. A change takes effect after a restart.

## Supported chains and contracts

`transactionIdentity.ts` in `manager/src/domain/chequebook` pins one BZZ
token per chain. A transfer on any other chain is refused as
`unsupported_chain`.

| Chain id   | Chain        | BZZ token                                    |
| ---------- | ------------ | -------------------------------------------- |
| `1`        | Ethereum     | `0x19062190b1925b5b6689d7073fdfc8c2976ef8cb` |
| `100`      | Gnosis Chain | `0xdbf3ea6f5bee45c02255b2c26a16f300502f68da` |
| `11155111` | Sepolia      | `0x543ddb01ba47acb11de34891cd86b675f04840db` |

A transaction matches a saved transfer only when it comes from the node's
address, carries zero native value, has a nonce at or above the recorded
bound, lies at or after the recorded start block, and has the exact call data:

- a deposit calls the token's `transfer(address,uint256)`, selector
  `a9059cbb`, with the chequebook as recipient and the saved amount,
- a withdrawal calls the chequebook's `withdraw(uint256)`, selector
  `2e1a7d4d`, with the saved amount.

## Limits

- A transfer needs the node's Bee API to answer the manager on its reserved
  port, as stamp operations do.
- A transfer needs a chain endpoint in the manager's settings for the node's
  chain. The manager does not use the node's own endpoint.
- The connection boundary is the node's Bee API address. It cannot pin the
  signer behind a proxy that routes requests to different nodes.
- Some xDAI in the wallet is checked before sending. It does not guarantee the
  gas is enough, and Bee or the chain can still refuse the transaction.
- A node with any operation whose `failureReason` is `hash_conflict` accepts
  no new transfer.
- Receipt polling stops after 30 minutes. A transaction mined later is found
  by **Check**.
- The chain endpoint must support the `finalized` block tag. Without it no
  transfer settles.
- An assertion accepts the risk of paying twice. It proves neither that
  nothing was sent nor that anything settled.
