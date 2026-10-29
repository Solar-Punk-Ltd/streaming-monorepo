# Funding from the admin

This is a concepts page. It explains how a brand keeps its stages funded from the admin: the brand
wallet, the three tabs of the Funding page, who signs and pays for each operation, and the rules
that keep the money safe. Every funding operation goes through the manager, and the admin talks
to no Bee node and no chain itself.

Three kinds of balance keep a stage alive. Each Bee node has a wallet on Gnosis Chain, holding xDAI
for gas and xBZZ, the Swarm token. Each node that uploads holds postage batches (stamps), bought in
xBZZ, which pay for the storage of what it writes and expire when their balance runs out. And each
node has a chequebook, a contract it pays its peers from for bandwidth.

## The brand wallet

The admin creates a brand wallet on its first start with `BRAND_WALLET_SECRET` set. Its private
key is stored in the admin's database, encrypted with AES-256-GCM under that secret, and its
address is shown on the Funding page with a QR code. The brand sends xDAI and xBZZ to that address
from any wallet it likes.

- The key is decrypted only to sign, and is never logged or answered.
- A wallet created under one secret opens under no other, so the secret stays with the env file.
- `wallet:export`, a command run on the host, prints the key once, as the backup a brand receives
  at handover. With it the brand can move the funds from any wallet app.
- The wallet has no spending limits. The brand keeps in it only what the coming months need.

One admin holds one brand wallet.

## The Funding page

The page has three tabs. They keep what you tick, type and choose while you stay on the Funding
page, so a trip to the Balance tab to fund the nodes loses nothing. A reload starts afresh.

### Balance tab

The brand wallet's balances, then every node grouped by stage, each with its wallet's balances.
You type an amount beside a node, which ticks its row, and send from the brand wallet. Clear all
empties every amount at once. The password is asked again before every send.

### Stamps tab

The catalogue batch first, then each stage's batches. You choose Top up or Dilute and tick batches,
one at a time, a stage at a time or all at once. One days slider, any whole number of days from 1,
or 1 or 2 dilution steps, applies to every ticked batch, and each row shows what its batch has left
after the operation and what it costs. A confirm dialog, without the password, comes before the
operation runs, because each node pays from its own wallet and nothing leaves the brand wallet.

- Every batch the manager reads whole, usable and not expired can be topped up.
- A dilution takes at most 2 steps and must leave the batch 7 days or more.
- The catalogue batch can be topped up and diluted like any other. A move of the catalogue to
  another batch is not handled here: the tab lists only the designated catalogue batch.

### Chequebooks tab

Each stage's nodes with their chequebooks: the available balance, the total and the uncashed
cheques, to the last digit. The available balance is the one that matters, because the total
includes cheques already written that a peer has not cashed yet. The catalogue node is not listed.

You type one target in xBZZ, 1 xBZZ or more, and tick chequebooks. One under the target takes a
deposit of the difference from its node's wallet, one over it a withdrawal of the difference into
its node's wallet, and one at the target is left as it is. Apply, behind a confirm dialog without
the password, starts the moves.

- The admin works each move out again from the balance it reads when the request arrives, and
  never moves more than the dialog showed. A chequebook that grew since takes a smaller deposit,
  and one that paid out since a smaller withdrawal, so a withdrawal never leaves it under the
  target. A chequebook already at the target or past it refuses the request.
- A busy node keeps paying its peers, so a deposit lands near the target rather than on it.
- A gateway's chequebook is shown, not moved. The manager moves only a deployment's own Bee node's
  chequebook.
- The manager carries each move out through its own chequebook path and journal, so a move from the
  admin shows in the manager's chequebook history too.

### Fund all and Select all

Each node pays for its own stamp and chequebook operations, so the Stamps and Chequebooks tabs show
any node short of xBZZ or out of xDAI. One Fund all button, beside the tab's action button, fills in
on the Balance tab what every short node lacks: its xBZZ rounded up to three decimals, and 0.01 xDAI
for a node with none, leaving every other amount as it was.

The Stamps and Chequebooks tabs take Select all and Clear, and a checkbox before each group's name
ticks or clears that group. The Balance tab takes Clear all only.

### Progress

A stamp operation or a transfer counts as done once it is mined. A chequebook move reads Mined once
its block is in and Confirmed once that block is final, about 3 minutes later on Gnosis Chain.

## Who does what

| Action            | Who signs                      | Paid from             | Carried out by                                    |
| ----------------- | ------------------------------ | --------------------- | ------------------------------------------------- |
| Fund node wallets | the brand wallet, in the admin | the brand wallet      | the manager sends the admin's signed transfer out |
| Top up batches    | the node                       | the node's wallet     | the manager, through each node's Bee API          |
| Dilute a batch    | the node                       | the node's xDAI (gas) | the manager, through each node's Bee API          |
| Move chequebooks  | the node                       | the node's wallet     | the manager, through each node's Bee API          |

The brand wallet's key never leaves the admin. For a transfer the admin builds and signs the
transaction itself, and the manager supplies the nonce and the fee, sends it and reports the
receipt. The admin checks a fee the manager supplies against a sane bound before it signs, and the
chain id is fixed in the admin.

## The manager's funding API

The manager serves the admin a funding API under `/api/admin-funding`, behind a bearer token, the
manager's `FUNDING_API_TOKEN`. The admin holds the manager's address in `MANAGER_FUNDING_URL` and
the same token in `MANAGER_FUNDING_TOKEN`. Neither the token nor a session cookie works on the
other's routes. With `FUNDING_API_TOKEN` unset the API is off and every path under it answers 404.

It answers:

- every stage's nodes, with their wallet balances, batches (depth, time left, fill) and
  chequebook balances,
- the catalogue node and its batch,
- the brand wallet's balances,
- the price of a top-up.

It does:

- send a signed transfer and report its receipt,
- top up and dilute batches,
- deposit into and withdraw from chequebooks.

Each operation is a list, run item by item with each item's result reported, under a request id, so
a retry never runs an item twice. The manager journals each item before it starts it. The API never
answers a Bee API address, an RPC endpoint or a key. It takes https, or plain http only on the same
host.

## Safety rules

- An operation names only the manager's own nodes and batches.
- Transfers go only to node wallets the manager lists. The admin remembers each node's address, and
  a changed one needs an operator's confirmation before the admin sends to it.
- A dilution takes at most two steps, leaves at least 7 days, and is refused if the batch's depth
  moved since it was read.
- A chequebook is brought to no target under 1 xBZZ, and a withdrawal goes to its node's own
  wallet, the one place Bee sends one.
- Every operator may fund. The password is asked again before every send from the brand wallet.
- Every operation and every send gets an audit entry with its transaction hash.

## Settling a send

The admin runs one send at a time, enforced on the server. A lost browser tab leaves no send stuck:
the next send and the Funding page refresh the open one, and the page resumes it.

- Items the chain's node refused at the relay, and items whose outcome is `unknown`, are watched.
- Nothing is sent again except an item the manager never received (`unknown_request`), which is
  relayed byte for byte under the same request id.
- An `unknown` item holds the next send back for 30 minutes from when the manager answered the
  relay. The manager also answers `unknown` when the answer of its broadcast was lost, and the
  transaction may then sit in the pool at its nonce. Only after those 30 minutes, when the chain no
  longer holds it, does the next send reuse its nonce, so a send cannot pay twice.
- Each item the admin answers says whether it still holds the next send back (`settled`) and
  whether it is still watched (`watched`).

## Settings

| Setting                 | Where                        | What it is                                                                                       |
| ----------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `BRAND_WALLET_SECRET`   | the admin's env file         | 64 hex characters. The secret the brand wallet's key is encrypted under. Unset, no wallet exists |
| `MANAGER_FUNDING_URL`   | the admin's env file         | the manager's address. Empty, funding is not set up and the Funding page says so                 |
| `MANAGER_FUNDING_TOKEN` | the admin's env file         | the manager's `FUNDING_API_TOKEN`, the same value                                                |
| `FUNDING_API_TOKEN`     | the manager's `manager/.env` | 32 characters or more with no space. Unset, the funding API is off                               |
| `FUNDING_RPC_URL`       | the manager's `manager/.env` | the chain endpoint the funding API reads and broadcasts through. Unset, it is `BEE_RPC_ENDPOINT` |

The sample env files describe each setting in full, and the admin's deploy script refuses the
sample values of the secret and the token.
