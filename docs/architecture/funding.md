# Funding from the admin: brand wallet, stamps and chequebooks

Plan, 2026-10-05. Phase 1, the brand wallet, the Balance tab and sends to node wallets, phase 2,
the Stamps tab's top-ups and dilutions, and phase 3, the Chequebooks tab's deposits and
withdrawals, are built on `feat/funds`. It lets a brand keep its stages alive after handover, from
the web2 admin: fund the nodes, top up and dilute the batches, and keep the chequebooks at a
target. Every funding operation goes through the infra manager.

## The flow

1. The admin creates a **brand wallet** once, on its first start. Its private key is stored
   encrypted in the admin's database; its address is shown on the Funding page.
2. The brand sends xDAI and xBZZ to that address from any wallet, for example with Swarm's
   Multichain app. The page shows the address, a QR code and a link to the app.
3. **Balance tab**: the brand wallet's balances, then every node grouped by stage, each with its
   wallet's balances. Enter amounts beside the nodes' balances, send from the brand wallet. Clear
   all empties every amount at once.
4. **Stamps tab**: the catalogue batch on top, then each stage's batches. Choose Top up or Dilute
   and tick batches, one by one, a stage at a time or all at once: one days slider, or 1 or 2
   steps, applies to every ticked batch, and each row shows what its batch has left after and what
   it costs. Confirm. Each node pays from its own wallet, so the tab shows any node short of xBZZ
   or out of xDAI, and one Fund all fills in on the Balance tab what each of them lacks.
5. **Chequebooks tab**: each stage's nodes with their chequebooks, the available balance, the
   total and the uncashed cheques to the last digit; the catalogue node is not listed. Type a
   target and tick chequebooks, as on the Stamps tab: one under the target takes a deposit of the
   difference from its node's wallet, one over it a withdrawal of the difference into its node's
   wallet. Apply, then confirm. A move reads Mined once its block is in and Confirmed once that
   block is final, about 3 minutes later. Fund all works as on the Stamps tab. A gateway's
   chequebook is shown, not moved.
6. The tabs keep what you tick, type and choose while you stay on the Funding page, so a round
   trip to the Balance tab to fund the nodes loses nothing.
7. The admin asks the infra manager for all of it, through a new manager API with a bearer token.
   The manager talks to the nodes and to the chain; the admin talks to neither.

## Who does what

| Action            | Who signs                      | Paid from             | Carried out by                                    |
| ----------------- | ------------------------------ | --------------------- | ------------------------------------------------- |
| Fund node wallets | the brand wallet, in the admin | the brand wallet      | the manager sends the admin's signed transfer out |
| Top up batches    | the node                       | the node's wallet     | the manager, through each node's Bee API          |
| Move chequebooks  | the node                       | the node's wallet     | the manager, through each node's Bee API          |
| Dilute a batch    | the node                       | the node's xDAI (gas) | the manager, through each node's Bee API          |

The brand wallet's key never leaves the admin. For a transfer, the admin builds and signs the
transaction itself. The manager supplies the nonce and fee, sends it, and reports the receipt. The
admin needs no chain connection of its own.

## The manager API

- A new API on the manager for the admin alone, behind a bearer token. The manager generates the
  token and shows it once, and keeps only its hash; the admin keeps the manager's address and the
  token. Neither the token nor a session cookie works on the other's routes.
- It answers:
  - every stage's nodes, with their wallet balances, batches (depth, time left, fill) and
    chequebook balance;
  - the catalogue node and batch;
  - the brand wallet's balances;
  - the price a top-up costs.
- It does:
  - sends a signed transfer and reports its receipt;
  - tops up batches;
  - dilutes batches;
  - deposits into and withdraws from chequebooks.
- Each operation is a list, run item by item with each item's result reported, under a request
  id, so a retry never runs twice. The manager journals each item before it starts, as it already
  does for chequebook deposits.
- It never answers Bee API addresses, RPC endpoints or keys. https, or plain http only on the same
  host, as the admin link already requires.
- Safety rules, not limits:
  - an operation names only the manager's own nodes and batches;
  - a dilution takes at most two steps, leaves at least 7 days, and is refused if the depth moved;
  - a chequebook is brought to no target under 1 xBZZ, and a withdrawal goes to its node's own
    wallet, the one place Bee sends one.

## The admin's side

- **Wallet key**:
  - encrypted with a secret of its own, generated at deploy, which the deploy script refuses while
    it is the sample value;
  - decrypted only to sign, never logged or answered;
  - backed up at handover with a command on the host, and the backup handed to the brand: with it,
    the brand can move the funds from any wallet app.
- **Transfers go only to node wallets the manager lists.** Each address is remembered at
  handover, and a changed one needs the operator's confirmation. The chain id is fixed in the admin,
  and a fee the manager supplies is checked against a sane bound before signing.
- **A small wallet**: no spending limits. The brand keeps only what the next months need in it.
- **Who may fund**: every operator, for now. The password is asked again before every send from
  the brand wallet; stamp and chequebook operations take a confirm dialog.
- Every operation and every send gets an audit entry with its transaction hash.
- **Settling**: one send at a time, enforced on the server. A lost tab leaves no send stuck: the
  next send and the Funding page refresh the open one, which the page resumes. Items the chain's
  node refused at the relay, and `unknown` ones, are watched. Nothing is resent but an item the
  manager never received (`unknown_request`), relayed byte for byte under the same request id. An
  `unknown` item holds the next send back for the manager's 30 minutes, counted from when the
  manager answered the relay: the manager also answers `unknown` when the answer of its broadcast
  was lost, and the transaction may then sit in the pool at its nonce. Only after those 30 minutes,
  when the chain no longer holds it, does the next send reuse its nonce, so it cannot pay twice.
  Each item the admin answers says whether it still holds the next send back (`settled`) and
  whether it is still watched (`watched`).

## Phases

| #   | What                                                                                                  | Size |
| --- | ----------------------------------------------------------------------------------------------------- | ---- |
| 1   | Brand wallet and Balance tab: the manager API's inventory and balances, send to node wallets          | M    |
| 2   | Stamps tab: bulk top-up and dilute through the manager, the days slider, the "short of xBZZ" shortcut | M    |
| 3   | Chequebooks tab: to a target, a deposit or withdrawal per ticked chequebook, through the manager      | S    |
| 4   | Dilute through the manager: built with phase 2, decided 2026-10-08                                    | —    |

The Stamps tab follows msrs-client's bulk stamp pages, ticked lists, a days slider and per-item
progress, with the Balance tab's line per row. Before a brand relies on it, the owner tries each
phase once on a scratch setup with small amounts. The manager's top-up and dilute had never run
against a real node before phase 2, so its first trial is theirs too.

## Decided, 2026-10-05

- Every funding operation goes through the manager; the admin has no chain connection.
- No spending limits; the brand wallet stays small.
- No recovery address; the key's backup, handed to the brand, covers recovery.
- Every operator may fund, for now; the password again before every send from the brand wallet.

## Decided, 2026-10-08

- Dilute comes with phase 2, beside the top-up.
- One days slider, any whole number of days from 1 with no cap, applies to every ticked batch; a
  dilution takes 1 or 2 steps.
- Every batch read whole, usable and not expired can be topped up. A dilution must leave the batch 7
  days or more after it.
- A stamp operation takes a confirm dialog, without the password: a node pays for its own, and
  nothing leaves the brand wallet.
- A catalogue move is not handled: the tab lists only the designated catalogue batch.
- The catalogue batch may be diluted like any other. This supersedes the rollout note in the
  [roadmap](../ROADMAP.md) that the batch from before stages is never diluted until the catalogue is
  moved.

## Decided, 2026-10-08, the Chequebooks tab

- One target, typed in xBZZ, applies to every ticked chequebook: one under it takes a deposit of
  the difference from its node's wallet, one over it a withdrawal of the difference into its
  node's wallet, and one at it is left as it is. One button, Apply, behind a confirm dialog
  without the password, as for stamps.
- The target is 1 xBZZ or more.
- The tab shows each chequebook's available balance, total and uncashed cheques, every digit.
- The catalogue node's chequebook is not listed.
- A gateway's chequebook is shown, not moved: the manager moves only a deployment's own Bee node's
  chequebook, from its console and from the admin alike.
- The admin works each move out again from the balance it reads when the request comes in, and
  never moves more than the confirm dialog showed: a chequebook that grew since takes a smaller
  deposit, and one that paid out since a smaller withdrawal, so a withdrawal never leaves it under
  the target. One already at the target or past it refuses the request. A busy node keeps paying
  its peers from its chequebook, so a deposit lands near the target rather than on it.
- The manager carries each move out through its own chequebook path and journal, the ones its
  console's Fill chequebook and Withdraw use, so a move from the admin shows in its chequebook
  history too.

## Decided, 2026-10-09

- The Stamps and Chequebooks tabs take Select all and Clear, and a checkbox in front of each
  group's name that ticks or clears that group's rows. The Balance tab takes Clear all only:
  typing an amount already ticks a row.
- One Fund all, beside the tab's action button, replaces a Fund link in each row. It fills in on
  the Balance tab what every short node lacks: its xBZZ rounded up to three decimals, and 0.01
  xDAI for one with none, leaving everything else typed there as it was.
- The tabs keep their state while you stay on the Funding page; a reload starts afresh.
- A chequebook move counts as confirmed only once its block is final, as the manager's chequebook
  path has it, about 3 minutes after it is mined on Gnosis Chain; stamp operations and transfers
  count once mined. The progress shows the step between as Mined.
