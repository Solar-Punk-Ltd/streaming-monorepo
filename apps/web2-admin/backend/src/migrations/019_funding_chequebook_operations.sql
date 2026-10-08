-- The admin's journal of the chequebook operations it asks the manager's
-- funding API for (docs/architecture/funding.md, the backend README's
-- "Chequebook operations"): the deposits into and withdrawals from the
-- chequebooks of the brand's nodes that bring each to a target, each carried
-- out by the node, from its own wallet or into it, the gas paid by the node.
-- The admin signs nothing for them and moves none of the brand wallet's
-- funds.
--
-- A request is one bulk of items, all brought to one target, each one move on
-- one node's chequebook. Every item is written here, queued, with the fields
-- of the manager's request BEFORE any is relayed; then they are relayed in
-- turn. So a relay whose answer never came, or a process that stops before or
-- during the relays, leaves a row a refresh picks up: the manager is asked
-- where the request id stands, and an item it never received is relayed
-- again, the same fields under the same request id, which the manager runs at
-- most once. An item the manager answered for is never relayed again. While
-- any item is queued, no new bulk starts, since a move still under way changes
-- the balances the next one is checked against. Nor while an item is submitted
-- or unknown and the manager answered its relay at most 30 minutes ago, the
-- manager's receipt budget (RECEIPT_POLL_BUDGET_MS): past it, the manager may
-- hold the move so until an operator settles it in the manager's console, and
-- it refuses a second move on a node while one is in flight there. A
-- submitted or unknown item older than that holds up no bulk, but is still
-- asked about.
--
--   request_id   the item's id, which the manager journals it under.
--   bulk_id      the request it belongs to, which the page reads it back by.
--   position     its place in the request, the order it is relayed in.
--   node_id, node_label
--                the manager's id of the node whose chequebook moves, which
--                pays the gas, and its label as the manager answered it when
--                the item was journalled.
--   direction    deposit, from the node's wallet into its chequebook, or
--                withdraw, from its chequebook into its wallet.
--   amount_plur  what moves, in PLUR: more than nothing, and at most 30
--                digits, as the manager's own chequebook journal holds one.
--   target_plur  the available balance the request brings the chequebook to,
--                in PLUR: 1 xBZZ or more, the owner's floor.
--   available_plur
--                the chequebook's available balance the move was worked out
--                from, again when the request came in: of the one the page
--                showed and the one the manager read then, the larger for a
--                deposit and the smaller for a withdrawal, so that the move
--                never moves more than the confirm dialog showed
--                (chequebookMoveNow, web2-admin-common). A deposit is the
--                target less it, a withdrawal it less the target.
--                node_id, direction and amount_plur are the manager's request
--                as it went out: a relay again sends them as they are, under
--                the same id.
--   state        queued once journalled and until the manager answers for it,
--                then the manager's: submitted, confirmed, failed, unknown.
--   tx_hash      the transaction's hash, once the manager answered one.
--   error        why it failed, or what the manager said of it, in a sentence.
--   relayed_at   when the admin recorded the manager's first answer for it, to
--                a relay, or, for a relay whose answer was lost, to the status
--                read that found it, by the service's clock. A submitted or
--                unknown item's 30 minutes count from it. Null while the item
--                is queued, and on an item failed before the manager ever
--                answered for it; created_at stands in only as a backstop for
--                a row written otherwise, so that no item holds a bulk for
--                good.
--   requested_by_user_id, requested_by
--                the operator who asked for it: the id, null once the user is
--                removed, and the username at the time, which stays.
--   created_at, updated_at
--                the database's clock.
--
-- Going back to an older admin needs no step: it never reads the table. The
-- operations it holds are on the chain or with the manager whatever the admin
-- runs.

CREATE TABLE funding_chequebook_operations (
  request_id             UUID PRIMARY KEY,
  bulk_id                UUID NOT NULL,
  position               INTEGER NOT NULL CHECK (position >= 0),
  node_id                TEXT NOT NULL CHECK (node_id ~ '^[A-Za-z0-9:._-]{1,200}$'),
  node_label             TEXT NOT NULL CHECK (node_label <> ''),
  direction              TEXT NOT NULL CHECK (direction IN ('deposit', 'withdraw')),
  amount_plur            NUMERIC(30, 0) NOT NULL CHECK (amount_plur > 0),
  target_plur            NUMERIC(30, 0) NOT NULL CHECK (target_plur >= 10000000000000000),
  available_plur         NUMERIC(30, 0) NOT NULL CHECK (available_plur >= 0),
  state                  TEXT NOT NULL CHECK (state IN ('queued', 'submitted', 'confirmed', 'failed', 'unknown')),
  tx_hash                TEXT NULL CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
  error                  TEXT NULL,
  relayed_at             TIMESTAMPTZ NULL,
  requested_by_user_id   UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  requested_by           TEXT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The move is the one that brings the balance it was worked out from to the
  -- target, and its direction the way it goes.
  CONSTRAINT funding_chequebook_operations_move CHECK (
    (direction = 'deposit' AND amount_plur = target_plur - available_plur)
    OR (direction = 'withdraw' AND amount_plur = available_plur - target_plur)
  ),
  -- A node at most once in a request, and one item at each place of it.
  CONSTRAINT funding_chequebook_operations_one_per_node UNIQUE (bulk_id, node_id),
  CONSTRAINT funding_chequebook_operations_bulk_position UNIQUE (bulk_id, position)
);

-- A request is read back in order through the unique index on (bulk_id,
-- position). The check that no item holds up a bulk asks for a queued item,
-- or a submitted or unknown one whose relay the manager answered since a
-- cutoff 30 minutes back: COALESCE(relayed_at, created_at) >= the cutoff. A
-- partial index cannot hold that cutoff, since its predicate cannot call
-- now(), so it covers every row of the three states, by that same moment. Its
-- predicate is also exactly the items a refresh still asks about, so it serves
-- both, and the rows of those states are few.
CREATE INDEX funding_chequebook_operations_unsettled_idx
  ON funding_chequebook_operations ((COALESCE(relayed_at, created_at)))
  WHERE state IN ('queued', 'submitted', 'unknown');

-- Removing a user sets their rows' requested_by_user_id to null.
CREATE INDEX funding_chequebook_operations_requested_by_idx
  ON funding_chequebook_operations (requested_by_user_id);
