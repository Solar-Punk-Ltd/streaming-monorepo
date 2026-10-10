-- The admin's journal of the stamp operations it asks the manager's funding
-- API for (docs/architecture/funding.md, the backend README's "Stamp
-- operations"): the top-ups and dilutions of the batches the brand's nodes
-- upload with, each paid for by the node that holds the batch, from its own
-- wallet. The admin signs nothing for them and moves none of the brand
-- wallet's funds.
--
-- A request is one bulk of items, all of one kind, each one operation on one
-- batch. Every item is written here, queued, with the fields of the manager's
-- request BEFORE any is relayed; then they are relayed in turn. So a relay
-- whose answer never came, or a process that stops before or during the
-- relays, leaves a row a refresh picks up: the manager is asked where the
-- request id stands, and an item it never received is relayed again, the same
-- fields under the same request id, which the manager runs at most once. An
-- item the manager answered for is never relayed again. While any item is
-- queued or submitted, no new bulk starts, since an operation still under way
-- moves the balances and depths the next one is checked against. Nor while an
-- item is unknown and the manager answered its relay at most 30 minutes ago:
-- the manager reads an unknown operation from the chain for 30 minutes, the
-- transfers' FUNDING_UNKNOWN_AFTER_MS, before it calls it failed. An unknown
-- item older than that holds up no bulk, but is still asked about.
--
--   request_id   the item's id, which the manager journals it under.
--   bulk_id      the request it belongs to, which the page reads it back by.
--   position     its place in the request, the order it is relayed in.
--   node_id, node_label
--                the manager's id of the node that holds the batch and pays
--                for the operation, and its label as the manager answered it
--                when the item was journalled.
--   batch_id     the batch, 0x and 64 hex digits in lower case.
--   kind         topup or dilute.
--   days         the days a top-up buys, 1 or more; null for a dilution.
--   steps        the steps a dilution takes, 1 or 2; null for a top-up.
--   expected_depth
--                the batch's depth as the page showed it and the admin checked
--                it. The manager refuses the operation once the batch has moved
--                off it.
--   new_depth    a dilution's depth after it, expected_depth + steps; null for
--                a top-up.
--   amount_per_chunk_plur
--                what a top-up adds to each of the batch's chunks, in PLUR: the
--                days in blocks, rounded up, at the price the manager read when
--                the item was journalled. Null for a dilution.
--   cost_plur    what the top-up takes from the node's wallet, in PLUR: the
--                amount per chunk for each of the batch's 2^depth chunks. Null
--                for a dilution, which costs only its gas, in xDAI.
--                node_id, batch_id, kind, expected_depth, new_depth and
--                amount_per_chunk_plur are the manager's request as it went
--                out: a relay again sends them as they are, under the same id.
--   state        queued once journalled and until the manager answers for it,
--                then the manager's: submitted, confirmed, failed, unknown.
--   tx_hash      the transaction's hash, once the manager answered one.
--   error        why it failed, or what the manager said of it, in a sentence.
--   relayed_at   when the admin recorded the manager's first answer for it, to
--                a relay, or, for a relay whose answer was lost, to the status
--                read that found it, by the service's clock. An unknown item's
--                30 minutes count from it. Null while the item is queued, and
--                on an item failed before the manager ever answered for it;
--                created_at stands in only as a backstop for a row written
--                otherwise, so that no item holds a bulk for good.
--   requested_by_user_id, requested_by
--                the operator who asked for it: the id, null once the user is
--                removed, and the username at the time, which stays.
--   created_at, updated_at
--                the database's clock.
--
-- Going back to an older admin needs no step: it never reads the table. The
-- operations it holds are on the chain or with the manager whatever the admin
-- runs.

CREATE TABLE funding_stamp_operations (
  request_id             UUID PRIMARY KEY,
  bulk_id                UUID NOT NULL,
  position               INTEGER NOT NULL CHECK (position >= 0),
  node_id                TEXT NOT NULL CHECK (node_id ~ '^[A-Za-z0-9:._-]{1,200}$'),
  node_label             TEXT NOT NULL CHECK (node_label <> ''),
  batch_id               TEXT NOT NULL CHECK (batch_id ~ '^0x[0-9a-f]{64}$'),
  kind                   TEXT NOT NULL CHECK (kind IN ('topup', 'dilute')),
  days                   INTEGER NULL CHECK (days IS NULL OR days >= 1),
  steps                  SMALLINT NULL CHECK (steps IS NULL OR steps IN (1, 2)),
  expected_depth         SMALLINT NOT NULL CHECK (expected_depth BETWEEN 0 AND 255),
  new_depth              SMALLINT NULL CHECK (new_depth IS NULL OR new_depth BETWEEN 1 AND 255),
  amount_per_chunk_plur  NUMERIC(78, 0) NULL CHECK (
    amount_per_chunk_plur IS NULL OR (
      amount_per_chunk_plur > 0
      AND amount_per_chunk_plur <= 115792089237316195423570985008687907853269984665640564039457584007913129639935
    )
  ),
  cost_plur              NUMERIC(78, 0) NULL CHECK (
    cost_plur IS NULL OR (
      cost_plur > 0
      AND cost_plur <= 115792089237316195423570985008687907853269984665640564039457584007913129639935
    )
  ),
  state                  TEXT NOT NULL CHECK (state IN ('queued', 'submitted', 'confirmed', 'failed', 'unknown')),
  tx_hash                TEXT NULL CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
  error                  TEXT NULL,
  relayed_at             TIMESTAMPTZ NULL,
  requested_by_user_id   UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  requested_by           TEXT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- What each kind carries, and nothing of the other's.
  CONSTRAINT funding_stamp_operations_kind_fields CHECK (
    (
      kind = 'topup'
      AND days IS NOT NULL AND amount_per_chunk_plur IS NOT NULL AND cost_plur IS NOT NULL
      AND steps IS NULL AND new_depth IS NULL
    )
    OR (
      kind = 'dilute'
      AND steps IS NOT NULL AND new_depth = expected_depth + steps
      AND days IS NULL AND amount_per_chunk_plur IS NULL AND cost_plur IS NULL
    )
  ),
  -- A batch at most once in a request, and one item at each place of it.
  CONSTRAINT funding_stamp_operations_one_per_batch UNIQUE (bulk_id, batch_id),
  CONSTRAINT funding_stamp_operations_bulk_position UNIQUE (bulk_id, position)
);

-- A request is read back in order through the unique index on (bulk_id,
-- position). The check that no item holds up a bulk asks for a queued or
-- submitted item, or an unknown one whose relay the manager answered since a
-- cutoff 30 minutes back: COALESCE(relayed_at, created_at) >= the cutoff. A
-- partial index cannot hold that cutoff, since its predicate cannot call
-- now(), so it covers every row of the three states, by that same moment. Its
-- predicate is also exactly the items a refresh still asks about, so it serves
-- both, and the rows of those states are few.
CREATE INDEX funding_stamp_operations_unsettled_idx
  ON funding_stamp_operations ((COALESCE(relayed_at, created_at)))
  WHERE state IN ('queued', 'submitted', 'unknown');

-- Removing a user sets their rows' requested_by_user_id to null.
CREATE INDEX funding_stamp_operations_requested_by_idx ON funding_stamp_operations (requested_by_user_id);
