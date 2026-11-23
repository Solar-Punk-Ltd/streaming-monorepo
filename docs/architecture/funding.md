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

The catalogue batch first, then the archive stamps, then each stage's batches. You choose Top up or Dilute and tick batches,
one at a time, a stage at a time or all at once. One days slider, any whole number of days from 1,
or 1 or 2 dilution steps, applies to every ticked batch, and each row shows what its batch has left
after the operation and what it costs. A confirm dialog, without the password, comes before the
operation runs, because each node pays from its own wallet and nothing leaves the brand wallet.

- Every batch the manager reads whole, usable and not expired can be topped up.
- A dilution takes at most 2 steps and must leave the batch 7 days or more.
- The catalogue batch can be topped up and diluted like any other. A move of the catalogue to
  another batch is not handled here: the tab lists only the designated catalogue batch.
- **Buy new** is on the row of a rung's batch, of a single-node stage's batch and of the catalogue
  batch once that batch has expired, once its node holds it no more, and where none is set. A batch
  that is ending or full keeps Top up and Dilute. [Buying a new batch](#buying-a-new-batch) says
  what the button does.
- **Archive stamps** are the immutable batches on the catalogue node that recordings are archived
  onto ([web2-admin.md](web2-admin.md#archiving-a-recording)). They have a group of their own,
  "Archive stamps", under the catalogue batch and above the stages. The group lists each with its
  label, the node that holds it, depth, time left, room and the qualities on it, and tops them up
  and dilutes them like any other, through the node that holds it, whose wallet pays. A stamp
  that is not written any more takes top-ups only.
  **Buy archive stamp** opens the buy dialog: a depth with what it holds, the days it lasts and
  what it costs, then a confirm without the password, since the catalogue node pays. A stamp being
  bought shows in the group until it is usable. With a manager that offers no purchases the dialog
  says so. A stamp left on a node that is the catalogue node no
  longer is not topped up or diluted here unless that node is a stage's node, since its wallet is
  funded outside the admin.

### Chequebooks tab

Each stage's nodes with their chequebooks: the available balance, the total and the uncashed
cheques, to the last digit. The available balance is the one that matters, because the total
includes cheques already written that a peer has not cashed yet. The catalogue node is listed
first: it pays its peers for every recording it copies onto an archive stamp.

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

## Buying a new batch

A batch that has run out cannot be topped up, and the node drops it some time later. **Buy new** on
its row buys the batch that takes its place, and the manager and the admin put it to use by
themselves.

**The dialog** opens with the manager's recommendation: the depth and the kind of the batch being
replaced, and 30 days (`BATCH_BUY_DEFAULT_DAYS`). The depth, the kind for a rung, and the days can
be changed, a whole number of days from 2. The calculator shows the cost in xBZZ, the life in days
at today's price, what the batch holds before its fullest bucket fills (Swarm's effective volume of
an unencrypted batch without erasure coding, not its `2^depth` chunks), the paying node's wallet,
and what the wallet is short of.
A short wallet is filled on the Balance tab. A confirm comes before the purchase and no password,
since the node pays from its own wallet. A price that moved between the dialog and the confirm
refuses the purchase with the new cost.

**A rung's batch**, and a single-node stage's own:

1. The manager buys the batch on the rung's node and reads the node until it calls the batch
   usable, which takes some minutes. After an hour without it the purchase stops as failed, and
   **Check again** takes it up from there. Nothing is bought a second time.
2. The manager sets the batch on the rung, as its own buy form does, which writes the pool string
   of every uploader that follows the rung.
3. The manager restarts those uploaders one stage at a time with the stage's settings Apply, the one
   its own console runs. It applies a stage when the batch is the only setting the running uploader
   is behind on and no broadcast is live. Live is read twice, 15 seconds apart.

The row shows a line for each stage:

| Line                           | What it means                                                                              | What to do                                |
| ------------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------- |
| Restarting, then restarted     | The Apply runs, and then the uploader pays with the new batch                              | nothing                                   |
| A broadcast is live            | The manager looks again every 30 seconds and restarts the uploader when the broadcast ends | wait, or **Restart now**                  |
| Cannot tell whether one is     | The manager could not read the engine, and waits as if a broadcast were live               | wait, or **Restart now**                  |
| Other saved settings wait      | An Apply would carry more than the batch, so the manager applies nothing                   | apply the stage in the manager            |
| The restart did not go through | The Apply failed, with the reason                                                          | **Check again**                           |
| Stopped                        | The stage does not run. It takes the batch at its next start                               | nothing                                   |
| Pool string set by hand        | The stage's pool string is another than the pool's own, so the manager leaves it           | set the batch on the stage in the manager |

**Restart now** asks first and then restarts the uploader although a broadcast is live. The
broadcast pauses while the uploader is recreated, seconds for a short one and up to about five
minutes for a long one, and the recording is kept. After the restart a stream's feed goes on from
where the uploader finds its head, and from the start where the network holds none of it.

**The catalogue batch**:

1. The manager buys an immutable batch of depth 18 or more on the catalogue node and waits until it
   is usable, as for a rung.
2. The manager designates it as a move from the batch designated before.
3. The admin moves the catalogue onto it by itself: every slot of the feed is stamped again from the
   bytes the admin recorded, then the thumbnails, then the switch
   ([stages.md](stages.md#a-batch-bought-on-the-stamps-tab)). The feed keeps its owner and its
   topic, so the viewer and the gateway read on as before. The row shows the slots done.
4. The admin asks the manager to release the previous batch, and the purchase is done.

With the catalogue move switched off (`CATALOGUE_MOVE_ENABLED=false`) the catalogue row offers no
purchase and says so.

One purchase runs on a node at a time. Every purchase, restart and release gets an audit entry.

A purchase that failed after its batch was bought holds its row, whatever its age: the batch was
paid for and never put to use, so the row offers **Check again** in place of **Buy new**, until a
later purchase of that node is done. The hold lasts only while the bought batch is still on its node
with time left:

- The manager itself refuses a second purchase for that node and that purpose, with a sentence that
  names the check, while its node still holds the bought batch with time left. A node it cannot read
  keeps the refusal.
- The purchase carries the bought batch's state as the manager last read it (`batchState`). Once it
  reads expired or gone, no check can put the batch to use, and the row offers **Buy new** again.
  While the state is absent, the purchase holds its row.

A release the manager refuses ends the catalogue purchase as done, with the manager's sentence on
its row: the catalogue is written with the new batch, and the previous one is released on the
manager's own page.

## Who does what

| Action                | Who signs                      | Paid from                   | Carried out by                                                               |
| --------------------- | ------------------------------ | --------------------------- | ---------------------------------------------------------------------------- |
| Fund node wallets     | the brand wallet, in the admin | the brand wallet            | the manager sends the admin's signed transfer out                            |
| Top up batches        | the node                       | the node's wallet           | the manager, through each node's Bee API                                     |
| Dilute a batch        | the node                       | the node's xDAI (gas)       | the manager, through each node's Bee API                                     |
| Buy an archive stamp  | the catalogue node             | the catalogue node's wallet | the manager, through the catalogue node's Bee API                            |
| Buy a rung's batch    | the rung's node                | the rung's node's wallet    | the manager, which then sets it and restarts the uploaders that follow       |
| Buy a catalogue batch | the catalogue node             | the catalogue node's wallet | the manager, which then designates it; the admin moves the catalogue onto it |
| Move chequebooks      | the node                       | the node's wallet           | the manager, through each node's Bee API                                     |

An archive stamp stays with the node that bought it: one left on a former catalogue node is topped
up by that node, from its own wallet, and never diluted, since nothing is written to it any more.
The admin sends that node no transfer, since transfers go only to the stages' nodes and the
designated catalogue node, so its wallet is funded outside the admin, and the admin refuses to top
up or dilute its stamps, unless that node is also a stage's node. Before the catalogue moves to another node, top up the archive stamps it leaves
behind for as long as their recordings are needed.

The brand wallet's key never leaves the admin. For a transfer the admin builds and signs the
transaction itself, and the manager supplies the nonce and the fee, sends it and reports the
receipt. The admin checks a fee the manager supplies against a sane bound before it signs, and the
chain id is fixed in the admin.

## The manager's funding API

The manager serves the admin a funding API under `/api/admin-funding`, behind a bearer token, the
manager's API token, `MANAGER_API_TOKEN`. The admin holds the manager's address in
`MANAGER_API_URL` and the same token under the same name, `MANAGER_API_TOKEN`. Neither the token
nor a session cookie works on the other's routes. With the token unset in the manager the API is
off and every path under it answers 404.

It answers:

- every stage's nodes, with their wallet balances, batches (depth, time left, fill) and
  chequebook balances,
- the catalogue node and its batch,
- the archive batches, each with the node that holds it,
- the brand wallet's balances,
- the price of a top-up.

It does:

- send a signed transfer and report its receipt,
- top up and dilute batches,
- buy a batch on one route for three purposes: for a rung, for the catalogue, and as an archive
  stamp on the catalogue node. Only the parameters differ: the purpose, the node, the depth, the
  amount, the kind, a label, and the batch it replaces,
- follow a rung's and a catalogue's purchase up in the background: wait for a usable batch, set it
  or designate it, and restart the uploaders that follow a rung. Each step is in the manager's
  journal, so a manager that restarts goes on from it,
- restart a waiting stage now, take a stopped follow-up up again, and release the catalogue's
  previous batch, each as a call under the purchase,
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
- An archive stamp is named with the node that holds it, which pays for it. One not written any
  more is topped up only.
- A purchase names a node of the manager's own inventory: a rung's node or a single-node stage's
  for a rung's batch, of depth 17 to 40, and the catalogue node for a catalogue batch, immutable and
  of depth 18 to 40, and for an archive stamp, immutable and of depth 17 to 41. It buys the postage
  contract's floor of life or more. Its cost is within the node's wallet, which only a transfer from
  the brand wallet fills. One purchase runs on a node at a time.
- A purchase for a rung or for the catalogue replaces a batch that no longer pays: an expired one,
  one its node holds no more, or none. It names the batch it replaces, and a batch that changed
  since is refused.
- The manager restarts an uploader for the admin only as the follow-up of a purchase, only for the
  stages that follow the rung bought for, and only when the batch is the one setting the Apply
  carries. It releases a catalogue batch only as the one a purchase moved the catalogue from.
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

| Setting               | Where                        | What it is                                                                                                                 |
| --------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `BRAND_WALLET_SECRET` | the admin's env file         | 64 hex characters. The secret the brand wallet's key is encrypted under. Unset, no wallet exists                           |
| `MANAGER_API_URL`     | the admin's env file         | the manager's address. Read as `MANAGER_FUNDING_URL` when unset. Empty, funding is not set up and the Funding page says so |
| `MANAGER_API_TOKEN`   | the admin's env file         | the manager's `MANAGER_API_TOKEN`, the same value. Read as `MANAGER_FUNDING_TOKEN` when unset                              |
| `MANAGER_API_TOKEN`   | the manager's `manager/.env` | 32 characters or more with no space. Read as `FUNDING_API_TOKEN` when unset. Unset, the API is off                         |
| `FUNDING_RPC_URL`     | the manager's `manager/.env` | the chain endpoint the funding API reads and broadcasts through. Unset, it is `BEE_RPC_ENDPOINT`                           |

The sample env files describe each setting in full, and the admin's deploy script refuses the
sample values of the secret and the token.
