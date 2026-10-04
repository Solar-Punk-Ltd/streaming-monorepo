# Working rules for this repository

## ⛔⛔⛔ Never engineer around money

**This rule overrides any instinct to be careful with the balance, and any earlier judgement written
into a doc, a roadmap or a comment that shrank a test to save funds.** Funds for proper tests and
measurements can always be added. A test plan is never shaped by what the balance happens to be.

### What this means in practice

**Size the work from the question, never from the balance.** How many arms, how many replicates, how
long a broadcast, how many rungs. Decide all of it from what would actually settle the question, then
report what it costs in the same message as the plan, then run it.

**A cheaper experiment that cannot settle the question is not thrift, it is waste.** An n=1 arm
shipped with a caveat costs the same broadcast and answers less. Repeating always beats a warning.

**If the pot is short, that is a sentence, not a redesign.** Say the amount needed, hand over the
exact command, and carry on planning the run that answers the question. Whoever operates the
deployment adds funds when asked, and does not need to be asked twice.

**Never write any of these as a reason to stop:** "deferred because it costs BZZ", "needs funds",
"no longer free", "we should wait until there is more headroom", "a smaller version to fit the
budget". Price it and say so instead.

**Never quietly run a smaller sitting and report it as the answer.** That is the failure this rule
exists to prevent. Scaling work down is the operator's call, never the agent's.

### What this rule does NOT change

⛔ **The agent never moves money.** No deposit, no top up, no dilute, no buy, no send. Write the exact
command, hand it over, stop. The operator runs it from their own shell. This is a mechanic and it is
never a reason to shrink anything.

⛔ **The spend ceiling is an operator setting.** `.spend-ledger.env` holds the ceiling the operator
authorised, and the gates in `deploy/scripts/` read it before a publisher starts. **Never rewrite the
ledger to make your own plan pass.** A night that does not fit the authorised ceiling stays a night
that does not fit, and the answer is to ask the operator for a higher one, not to edit the file.

⛔ **Cost is still worth measuring and reporting as a product fact.** What a broadcaster pays per hour
is a real number this project exists partly to establish. That is completely different from letting
the balance shape a test plan.

### Before ever saying funds are short

Read **both** balances on every bee node that publishes. The wallet usually holds BZZ outside the
chequebook, so more headroom is often a move rather than a send.

A deployment publishes through four bee nodes, each with its own chequebook and wallet: the
coordinator, which the catalog goes through, and one node for each of the 480p, 720p and 1080p
rungs. The gateway node serves viewers. On a deployment started with
`--portSlot <slot>` (1 to 99), `deploy/scripts/_lib.sh` gives each node's API port as its base plus
`<slot> * 10`:

| Node | Variable | Port |
|---|---|---|
| coordinator (uploader) | `BEE_UPLOADER_API_PORT` | 10005 + `<slot>` * 10 |
| 480p rung | `BEE_RUNG_480P_API_PORT` | 11001 + `<slot>` * 10 |
| 720p rung | `BEE_RUNG_720P_API_PORT` | 11003 + `<slot>` * 10 |
| 1080p rung | `BEE_RUNG_1080P_API_PORT` | 11005 + `<slot>` * 10 |
| gateway | `BEE_GATEWAY_API_PORT` | 10007 + `<slot>` * 10 |

Read them all before any funds statement, with `<slot>` replaced by the deployment's slot:

```bash
ssh <host> 'slot=<slot>; for p in $((10005 + slot * 10)) $((11001 + slot * 10)) $((11003 + slot * 10)) $((11005 + slot * 10)) $((10007 + slot * 10)); do echo "== $p"; curl -s http://127.0.0.1:$p/chequebook/balance; echo; curl -s http://127.0.0.1:$p/wallet; echo; done'
```

A deployment without `--portSlot` takes these variables from its env file, and where one is unset
the stock port: 1633 for the coordinator, 1733 for the gateway, and 11001, 11003 and 11005 for the
rungs. Read the ports from the env file in that case.

The chequebook preflight and `pnpm e2e:smoke` print the same readings per node.

⚠️ Watch `availableBalance`, never `totalBalance`. They differ because `available = total - outstanding
cheques`, so a peer cashing a cheque the node already wrote moves total without anything being spent.

## ⛔ An e2e suite checks correctness, never performance

A suite under `e2e/suites/` asserts that a feature works and stays stable.
It never gates on a timing.

Durations, latencies, freeze lengths and recovery times are **measured on every run, printed under a
heading that says `observations, none of them asserted`, and filed in the artifact**. None of them
refuses a run. A threshold carried across a configuration change is a number about a different
deployment, and this project has already spent runs failing correct code against ceilings measured on
a stack that no longer exists.
