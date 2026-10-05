# Funding from the admin: brand wallet, stamps and chequebooks

Plan, 2026-10-05. Phase 1, the brand wallet, the Balance tab and sends to node wallets, is built
on `feat/funds`; phases 2 to 4 are not. It lets a brand keep its stages alive after handover, from
the web2 admin: fund the nodes, top up the batches, fill the chequebooks, and later dilute. Every
funding operation goes through the infra manager.

## The flow

1. The admin creates a **brand wallet** once, on its first start. Its private key is stored
   encrypted in the admin's database; its address is shown on the Funding page.
2. The brand sends xDAI and xBZZ to that address from any wallet, for example with Swarm's
   Multichain app. The page shows the address, a QR code and a link to the app.
3. **Balance tab**: the brand wallet's balances, then every node grouped by stage, each with its
   wallet's balances. Tick nodes, enter amounts, send from the brand wallet.
4. **Stamps tab**: the catalogue batch on top, then each stage's batches. Tick batches, pick
   "Top up", choose the days, confirm. Each node pays its own batches' top-up from its wallet, so
   the tab shows any node short of xBZZ, with a shortcut to fund it. Dilute comes later.
5. **Chequebooks tab**: the same, for each stage's nodes; the catalogue node is not listed. Tick,
   choose the amount, confirm. Each node deposits from its own wallet.
6. The admin asks the infra manager for all of it, through a new manager API with a bearer token.
   The manager talks to the nodes and to the chain; the admin talks to neither.

## Who does what

| Action                 | Who signs                      | Paid from             | Carried out by                                    |
| ---------------------- | ------------------------------ | --------------------- | ------------------------------------------------- |
| Fund node wallets      | the brand wallet, in the admin | the brand wallet      | the manager sends the admin's signed transfer out |
| Top up batches         | the node                       | the node's wallet     | the manager, through each node's Bee API          |
| Fill chequebooks       | the node                       | the node's wallet     | the manager, through each node's Bee API          |
| Dilute a batch (later) | the node                       | the node's xDAI (gas) | the manager, through each node's Bee API          |

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
  - deposits into chequebooks;
  - later, dilutes.
- Each operation is a list, run item by item with each item's result reported, under a request
  id, so a retry never runs twice. The manager journals each item before it starts, as it already
  does for chequebook deposits.
- It never answers Bee API addresses, RPC endpoints or keys. https, or plain http only on the same
  host, as the admin link already requires.
- Safety rules, not limits:
  - an operation names only the manager's own nodes and batches;
  - a dilution takes at most two steps, leaves at least 7 days, and is refused if the depth moved.

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

| #   | What                                                                                         | Size |
| --- | -------------------------------------------------------------------------------------------- | ---- |
| 1   | Brand wallet and Balance tab: the manager API's inventory and balances, send to node wallets | M    |
| 2   | Stamps tab: bulk top-up through the manager, the days slider, the "short of xBZZ" shortcut   | M    |
| 3   | Chequebooks tab: bulk deposit through the manager                                            | S    |
| 4   | Dilute through the manager                                                                   | M    |

The UI follows msrs-client's bulk stamp pages: ticked lists, a days slider, and per-item
progress. Before a brand relies on it, the owner tries each phase once on a scratch setup with
small amounts. The manager's own top-up and dilute have never run against a real node.

## Decided, 2026-10-05

- Every funding operation goes through the manager; the admin has no chain connection.
- No spending limits; the brand wallet stays small.
- No recovery address; the key's backup, handed to the brand, covers recovery.
- Every operator may fund, for now; the password again before every send from the brand wallet.
