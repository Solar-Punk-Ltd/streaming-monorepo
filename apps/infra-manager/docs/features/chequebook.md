# Chequebook funding and transfer recovery

A Bee node's wallet and chequebook are different balances. A deposit moves BZZ
from the node's wallet into its chequebook. A withdrawal moves it back. The
manager presents these transfers as recorded operations whose outcome must be
checked from transaction evidence. A balance change cannot confirm a transfer.

Status, 2026-09-16. Everything on this page is on `main`. It was
written at `6dc33d1` on `feat/ai-remediation`, the head of the remediation set,
which landed, and `main` has moved a long way past it since. It carries the
journal, receipt recovery, the durable browser workflow, history, the account
and instance guards, the owned transport factory and the automatic receipt
polling. New submission preparation captures the SQL target proof from the port and firewall work and uses one
qualified Docker and Bee connection. Local Unix and supervised SSH adapters are
implemented, and acquisition uses a transport only with a matching qualified
record, from the seed catalog or from the manager's own check of the image.
The live host was first deployed on 2026-09-11, and what that pass and the
later ones found is in
the remediation's handover record, which the repository's history keeps. A
postage batch was bought with real money on 2026-09-13. No chequebook transfer
has been made with real money. Corrected twice on 2026-09-17: the paragraph on
new uploader starts, first against the code at `0c0354c` for the ruling that a node that does not answer no longer refuses a start, then
in `50363c5` for the further ruling that the chequebook check never refuses a
start, which `667aee5` built.

Updated 2026-09-26 at `9e4e8c8f` (the chequebook funding change), for the ruling of
2026-09-25 that funding must work on any host a clone deploys to. A transfer no
longer needs `CHEQUEBOOK_RPC_ENDPOINTS` or `CHEQUEBOOK_DOCKER_TRANSPORTS`: it
reads the chain through the node's own endpoint, reaches Docker the way the
manager already does for that host, and checks a Bee image nothing has checked
before the first transfer through it. Every refusal now names its cause.

Updated 2026-10-15, for the owner's rule that the manager uses Bee's API. A
transfer reaches the node through its Bee API, as stamp operations do, and no
longer through a Docker connection, so a host written as `user@host` needs no
`Host` block, and `CHEQUEBOOK_DOCKER_TRANSPORTS` and `DOCKER_HOST` are no longer
read for it. The chain is read through the manager's own settings. The sections
"Where a transfer reaches the node and the chain" and "Evidence and remaining
acceptance" below describe that code, and the operator's view is "Funding a
chequebook on a new host" in `manager/README.md`.

## Balances and new uploader starts

The storage card shows wallet balances, the chequebook address, total and
available chequebook balances, and settlement totals when the node answers.
Unavailable readings remain unknown and must not appear as zero or a fresh
successful reading. The manager's configured floor is shown consistently in
the UI. On the paths that start an uploader a balance under it is a warning,
never a refusal, on the owner's ruling of 2026-09-17. The default floor is
0.5 BZZ. The protocol amount uses PLUR, with 10^16 PLUR per BZZ.

The deployment page scopes its node readings to the profile's instance UUID.
If a deployment is deleted and recreated under the same name, the old wallet
address and its copy action disappear as soon as the replacement profile
arrives. They stay absent while the replacement node is unreadable, then only
the replacement address is shown.

Since 2026-09-17, amending the rule of 2026-09-07, a node that
does not answer no longer refuses a new uploader start. The chequebook check
never refuses at all, on the owner's further ruling the same day: a node that
says nothing, a balance that cannot be read and a balance under the floor are
each a warning in the manager's log, and the start proceeds. The one refusal
left is the batch check, and only for a batch the node itself reports as
unknown, expired or not usable yet. Neither policy automatically stops an
existing stream. Engine-only recovery and node bootstrap remain separate from
starting an uploader.

A read-only balance or readiness check does not submit money. Filling the
chequebook requires an explicit confirmed transfer intent. The manager does
not offer arbitrary transfers from a node wallet to an outside address as
part of the transaction work.

## Confirm once and retain the request

Before the first money POST, the browser must durably save the confirmed
intent and its request UUID in one IndexedDB transaction. The intent includes
the original signed-in account, deployment instance, direction and exact
amount. If persistence fails, submission is refused. Only the invocation whose
transaction commits the new intent may make its initial POST.

Keep the intent after navigation, reload and terminal results. Another tab
restores the saved intent. It cannot silently replace it. New transfer is an
explicit action followed by a confirmation that checks the current saved
pointer again. Browser notifications refresh views but do not provide the lock.

After a lost response, query the original request id. An error or 404 does not
prove that an earlier POST can never reach the manager. Preserve the UUID.
Any explicit resend uses the same UUID and immutable payload under the same
account and deployment instance. There is no automatic resend. Deleting and
recreating a deployment under the same name must not retarget an old intent.

Submission and recovery writes carry the account that the page expects. The
server compares it with the current signed-in account before doing the work.
An account change in another tab therefore cannot silently send a reviewed
request as a different user. The authenticated user remains the recorded actor.

The server stores the operation before dispatch. Its immutable identity includes
chain, node address, chequebook, token, amount, direction, actor, deployment
instance, start-block evidence and observed nonce lower bound. The nonce
observation is not a nonce reservation. Request ids remain unique even after
an operation finishes. One unresolved operation per chain and node protects
against concurrent aliases and managers.

Dispatch is a durable one-shot claim. A lost Bee response or a failure to save
the returned hash leaves an unresolved operation. The manager never sends it
again automatically after a restart.

## Reading the outcome

| Stored state | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submitting` | The operation was durably admitted. This state alone does not prove whether Bee received the POST.                                                                                                                                                                                                                                                                                                                                                                  |
| `submitted`  | A transaction hash was recorded. Mining and finality are not yet established. The manager checks the chain for its receipt about every 20 seconds while the operation's `receiptPollUntil` deadline is ahead. Three kinds of `submitted` row are never checked automatically: one with no deadline, which is every operation recorded before this behaviour existed, one whose deadline has passed, and one whose failure reason is `hash_conflict`.                |
| `unknown`    | Submission or later evidence could not establish an outcome. Keep the original request and inspect recovery evidence.                                                                                                                                                                                                                                                                                                                                               |
| `settled`    | A matching successful receipt and the required canonical, finalized history were verified.                                                                                                                                                                                                                                                                                                                                                                          |
| `reverted`   | A matching reverted receipt and the required canonical, finalized history were verified.                                                                                                                                                                                                                                                                                                                                                                            |
| `rejected`   | A positive preflight refusal prevented dispatch. `failureReason` says why: `preflight_no_gas` for a wallet with no xDAI, `preflight_insufficient_balance` for less BZZ than the amount in the wallet, or in the chequebook for a withdrawal, and `preflight_failed` for anything else the last check found, which is also every row written before 2026-09-26. The page shows one sentence for each. This state is never inferred from a timeout during submission. |
| `asserted`   | An operator recorded the explicit duplicate-risk assertion. It is not verified settlement or proof that submission never happened.                                                                                                                                                                                                                                                                                                                                  |

Conflicting attribution or direct-response evidence takes precedence over an
older terminal label. The detail view must show the saved identity, hashes,
response evidence and last check. A bounded candidate list is not necessarily
all recorded evidence. When its limit is reached, the response journal may
contain additional conflicting hashes.

Balances remain useful context, but neither total nor available balance closes
or settles a transfer. An unrelated deposit, withdrawal or cheque settlement
can move those values.

## Checking and resolving an unresolved operation

An operation that enters `submitted` gets one polling budget of 30 minutes,
written to `receiptPollUntil` at that moment. While the budget lasts the manager
asks the chain for the receipt about every 20 seconds, and the page showing the
operation re-reads the saved record every 10 seconds so the outcome appears
without a click. A settled or reverted receipt ends the polling by changing the
state.

The gap between checks grows when the chain endpoint stops answering. One pass
takes at most 20 operations and each one waits out the receipt inspector's own
timeout, so a pass during a complete outage can take about five minutes instead
of a few seconds. Nothing is lost by that, the budget is still the same 30
minutes and the page says the checks are about every 20 seconds and longer while
the endpoint does not answer.

The budget is never renewed. Nothing an operator does extends it, a restart
resumes only the operations whose budget has not passed, and every operation
recorded before this behaviour existed keeps an empty deadline and is never
polled. When the budget ends without a final receipt the operation stays
`submitted` with its last observation, the page says that automatic checks
ended, and Check remains the operator's own action, exactly as before. The page
holds itself to that same budget from its own side. It never re-reads a record
for longer than 30 minutes after that record last changed, whatever deadline the
record carries. An operation in `submitting` or `unknown` is never polled:
recovery stays explicit. An operation whose failure reason is `hash_conflict` is
never polled either, whatever deadline its row still carries, and the page shows
no automatic checking sentence for it.

Check uses the recorded identity and reads the chain through the endpoint that
"Where a transfer reaches the node and the chain" below describes, one of the
manager's own settings. It first examines the known hash when
available. Receipt verification checks identity, canonical block ancestry and
finality. Missing receipts remain pending. Unavailable RPC, incomplete history,
contradictory evidence and reorgs remain unresolved. Checks are bounded and
persist progress where supported.

If the hash was lost, recovery inspects matching pending transactions and then
performs a bounded block scan. An already-started scan must finish its recorded
range before a candidate can be treated as unique. An ambiguous or incomplete
search cannot authorize an assertion. Operations that might still broadcast
late remain relevant even after an operator assertion.

A supplied transaction hash is a request to verify that transaction against
the saved identity. It is not a force-settlement control. History remains
available after a deployment is deleted, and so do checks while the chain can
still be read for it, as the end of "Where a transfer reaches the node and the
chain" below says.

The manager permits a separate operator assertion only after a complete current
no-match result. The operator types the exact server-provided acknowledgement
that retrying the recorded amount may pay twice. The journal retains the actor,
time, amount and confirmation. A later result may still reveal a transaction
or conflicting evidence. The assertion does not submit a replacement transfer.

## API contract

All routes require the existing session and write-request protections. The
server derives the actor from the authenticated user, not request JSON. Amounts
are positive integer PLUR strings. New submissions require both `requestId`
and `profileInstanceId` UUIDs plus the positive integer `expectedAccountId`.
Existing exact-request replay is checked before looking up the current
deployment, so deletion does not break recovery. Recovery writes also require
`expectedAccountId`. An assertion additionally requires the reviewed journal
revision as a decimal string. A later journal change invalidates that assertion.

| Method | Path                                                | Purpose                                                                                                                                                                                 |
| ------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/profiles/:name/chequebook`                        | Read node balances and chequebook summary.                                                                                                                                              |
| POST   | `/profiles/:name/chequebook/deposit` or `/withdraw` | Submit `{ requestId, profileInstanceId, amount, expectedAccountId }`. An accepted or replayed result returns 202. Busy or conflicting identity returns 409 with the relevant operation. |
| GET    | `/chequebook/operations`                            | Bounded history with optional profile filter and cursor.                                                                                                                                |
| GET    | `/chequebook/operations/by-request/:requestId`      | Recover the exact original request.                                                                                                                                                     |
| GET    | `/chequebook/operations/:id`                        | Read the operation and its response evidence together.                                                                                                                                  |
| POST   | `/chequebook/operations/:id/check`                  | Request another evidence check with `{ expectedAccountId }`.                                                                                                                            |
| POST   | `/chequebook/operations/:id/resolve`                | Supply `{ transactionHash, expectedAccountId }` for verification.                                                                                                                       |
| POST   | `/chequebook/operations/:id/assert`                 | Submit `{ amountPlur, confirmation, expectedAccountId, expectedRevision }` using the recorded amount, exact duplicate-risk confirmation and reviewed revision.                          |

A busy response can name another operation. The browser must not attach that
operation to its own saved intent as though its submission succeeded. History
is available independently of the deployment page.

Since 2026-10-08 the web2 admin's funding API submits deposits and withdrawals
through this same path and journal, on its bearer token rather than these
routes: `POST /api/admin-funding/chequebook-operations`, under "Chequebook
operations" in `manager/README.md`. The actor it records is `web2-admin`, never
a `user:<id>`, and there is no browser intent behind it: the admin keeps its
own request and asks again under the same request id. The history and the
detail page show such an operation like any other, with `web2-admin` as the
requester, and the page never takes it for the signed-in operator's own, since
that match requires `user:<accountId>` (`isExactTransfer`). Check, resolve and
assert work on it as on any other.

A submission the manager could not prepare answers `503` with
`{ error: 'chequebook_preparation_unavailable', cause, check, message }`.
`cause` is one of the closed list in `common/src/chequebookRefusals.ts`, set
where the refusal is decided and kept through every rewrap, and `check` names
the failed bridge check when the cause is `bridge_not_qualified`, which only the
retired Docker route answered. `message` is the cause's own sentence. Nothing in the
answer is upstream text, an endpoint or a socket path. The page shows the same
sentence from the same list and ignores any cause it does not know. Nothing is
recorded or sent for such a submission, and the saved request can be sent again
from the dialog once the cause is fixed. A deployment removed or replaced while
the transfer was being prepared answers `409 chequebook_profile_changed`
instead, and nothing is sent either.

## Where a transfer reaches the node and the chain

No route is taken from a money request, an operation record or a Bee answer.
The node's address comes from the deployment, and the chain endpoint from the
manager's process settings.

**The node.** `ConfiguredBeeTargetResolver` works out the node's Bee API from
the deployment's own row: `beeApiUrlFor`, the address stamp operations and the
inventory use, over plain `http`, with the port its `bee-uploader` container
recorded, `BEE_UPLOADER_API_PORT`. It takes the transfer's target from the SQL
ownership capture, `PostgresChequebookTargetOwnership.capture`, which the journal
admits a transfer under and which never touches Docker. That target carries the
port the deployment's reservation owns, and the recorded port must be that port,
or the transfer is refused before any session opens. So a port another
deployment has since been given is never dialled. `PinnedBeeSession` then reads
the node's addresses, wallet and chequebook over that address, and sends the one
`POST /chequebook/deposit` or `/chequebook/withdraw`. The last check before
the POST works the target out again, and a deployment whose address, port or
shape changed since makes it refuse the recorded transfer, `rejected` with
`preflight_failed`. The refusals before anything is recorded are:

- no `bee-uploader` container recorded: `bee_container_not_found`;
- a deployment that is deploying, stopping or removing, two `bee-uploader`
  containers recorded, or a capture that refuses: `target_changed`;
- a recorded port that is missing, out of range or not the reserved one:
  `bee_container_unsupported`;
- no such deployment, one without a Bee node of its own, or a Bee API address
  that is not plain `http`: `unavailable`;
- a deployment the capture finds removed or replaced keeps its own error,
  answered as `409 chequebook_profile_changed`.

No ssh alias is involved, so a host written as `user@host` is reached like any
other.

**The chain.** `ChequebookChainRegistry` reads every chain through the manager's
settings alone: `CHEQUEBOOK_RPC_ENDPOINTS` for a chain it names, else the
default, `FUNDING_RPC_URL`, else `BEE_RPC_ENDPOINT`, the pair the funding API
uses. Each endpoint is held to the same shape rules, `http` or `https` with no
user information and no fragment, and is used only after it answered
`eth_chainId` with the node's chain. A default endpoint that breaks those rules
refuses every transfer with `chain_setting_invalid`, and a chain with no
endpoint at all refuses with `chain_endpoint_missing`. Preparation, receipt
polling, finality and recovery all read the chain there. The endpoint the node
was started with is no longer read.

**The Docker route, retired on 2026-10-15.** Until then a transfer reached the
node over a Docker connection, the manager's own socket for `localhost` or an ssh
forward of the host's socket through its `Host` block, refused an alias with
`@`, and ran a bash bridge inside the node's container after checking the Bee
image for it (`bee_bridge_qualifications`). Its code, `ChequebookDockerTransports`,
the qualification catalog and the image check among it, stays in the tree,
unused, until a cleanup removes it. The running manager never takes it, and the
four refusal causes only it answered, `docker_unreachable`,
`docker_route_missing`, `docker_setting_invalid` and `bridge_not_qualified`,
stay in the shared list, unused.

History and exact replay do not require current transport configuration.
Pending Bee reads require the saved deployment instance and matching node
identity. Missing pending observations remain unavailable, while receipt and
manual chain recovery can still use the frozen operation after profile deletion,
through the manager's endpoint for its chain, while that endpoint answers.

## Evidence and remaining acceptance

**The composition is exercised whole, and only the Bee, the chain and the
database are synthetic.** `manager/test/database/chequebookConnected.test.ts`
signs in over HTTP, goes through the real router behind the real session and
same-site gates into a real PostgreSQL journal, out through the node's Bee API
to a synthetic Bee, and reads the outcome back.
`frontend/test/transfer-connected-browser.test.mjs` does the same with the
browser as the only client, against that manager run as a forked process. Both
need a disposable PostgreSQL on `CHEQUEBOOK_TEST_PG_PORT` and skip out loud without it,
and the browser runner treats a silent skip as a failure.

**The rest of the suites.** Four database files cover this feature:
`chequebookConnected`, `chequebookOperations`, which holds the polling
behaviour, `chequebookTargets`, and `beeBridgeQualifications`, which holds the
retired Docker route's stored checks and their race. Eight browser suites cover the durable
intent, the dialog, the history, the recovery actions, the two API surfaces and
the polling itself. A ninth file, `transfer-fixture.test.mjs`, starts no
browser: it checks what the browser fixtures leave on the machine. The unit
suites cover the poller, the receipt check, the receipt inspector, the routes,
the schemas, submission, recovery, the route through the Bee API and its port
check, the chain endpoint order, the retired Docker route's code, and the answer
for every refusal cause. All of them pass on a laptop, and all of them
are in the jobs the checks workflow declares for a pull request. A full run
taken at `e857994` is recorded in
the remediation's handover record, which the repository's history keeps.

**What the tests cannot establish.** They exercise protocol and ownership code
against a synthetic Bee and chain. They do not reach a real Bee node or a real
chain, and they move no money.

**The seed catalog has two entries, each from a real host.** They belong to the
retired Docker route and are kept with it.
`PRODUCTION_BEE_BRIDGE_QUALIFICATIONS` in
`manager/src/domain/chequebook/beeBridgeQualification.ts` carries
`bee-2.8.3-docker-29.1.3`, qualified on 2026-10-15 against a throwaway
container of the digest-pinned 2.8.3 image, and
`bee-2.8.2-docker-29.1.3`, qualified on 2026-09-14 by
`manager/scripts/qualify-bee-bridge.mjs` against the Bee image the deployment
host runs, with its image id, engine version, platform, harness revision and
evidence digest recorded. Its harness revision is the git object id the script
had then, kept as history. A unit test pins the list as non-empty and every
entry to the live bridge revision. Since 2026-09-26 an image the catalog does
not list is checked automatically instead of refused, and the script is a thin
wrapper over the same `beeBridgeCheck.ts` the manager runs. A synthetic pass
qualifies nothing and must never be used to populate the catalog.

**What completion still requires.** A real transfer to a remote node through
its Bee API: the connected suites use a synthetic Bee and chain.
Real-money testing is a separately authorised part of the live acceptance run, which waits for
its spending cap and duration to be set and keeps strict ownership of cleanup.

The historical 0.5 BZZ fill on the funded `review-20260907` deployment remains
unverified. Without transaction evidence, this document does not establish
whether it was submitted, whether it settled or whether a retry is safe.
