-- The stamp operations the web2 admin asked the manager for through the
-- funding API: a top-up or a dilution of the batch one of its nodes uploads
-- with, which that node carries out through its Bee API and pays for from its
-- own wallet. README.md, "Funding API".
--
-- A row is written before the node is asked, keyed by the admin's request id,
-- so the same request is answered from here and the node is never asked twice.
-- A manager that stops between the row and the node's answer leaves the row in
-- state 'unknown', which the status route settles from the postage contract.
--
-- kind is 'topup' or 'dilute'. node_id is the inventory's opaque id of the
-- node, and batch_id the batch, 0x and 64 hex digits in lower case.
-- expected_depth is the batch's depth when the operation was asked for, which
-- the node and the postage contract both reported. A top-up has
-- amount_per_chunk, the PLUR it adds to each chunk, and cost, that amount for
-- every chunk of the batch, amount_per_chunk * 2^expected_depth, paid in xBZZ
-- from the node's wallet; it has no new_depth. A dilution has new_depth, one
-- or two steps deeper, and neither amount: it costs the node gas alone.
--
-- normalised_balance_before is the batch's normalisedBalance in the postage
-- contract (PostageStamp's batches(id)), read before the node was asked. The
-- status route settles an 'unknown' row by reading it again: a top-up landed
-- when it has grown by amount_per_chunk, a dilution when the batch's depth is
-- new_depth or deeper.
--
-- state follows the contract: 'confirmed' once the node answered with its
-- transaction, which Bee does after the receipt, or once the postage contract
-- shows the change; 'failed' when the node refused, or could not be reached,
-- or the contract shows no change thirty minutes after the row was written;
-- 'unknown' before the node answers and when its answer was lost. The manager
-- never writes 'submitted' for a stamp operation, since Bee answers only once
-- the transaction is mined; the column takes it because the contract's states
-- are four. tx_hash is the transaction the node answered with, or null when it
-- answered none. error says why in a sentence.
--
-- Going back to an older manager needs no step: it never reads the table.
CREATE TABLE funding_stamp_operations (
  request_id                 UUID PRIMARY KEY,
  kind                       TEXT NOT NULL CHECK (kind IN ('topup', 'dilute')),
  node_id                    TEXT NOT NULL CHECK (node_id ~ '^[A-Za-z0-9:._-]{1,200}$'),
  batch_id                   TEXT NOT NULL CHECK (batch_id ~ '^0x[0-9a-f]{64}$'),
  expected_depth             SMALLINT NOT NULL CHECK (expected_depth BETWEEN 0 AND 255),
  new_depth                  SMALLINT CHECK (new_depth BETWEEN 0 AND 255),
  amount_per_chunk           NUMERIC(78, 0) CHECK (amount_per_chunk > 0),
  cost                       NUMERIC(78, 0) CHECK (cost > 0),
  normalised_balance_before  NUMERIC(78, 0) NOT NULL CHECK (normalised_balance_before >= 0),
  tx_hash                    TEXT CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  state                      TEXT NOT NULL CHECK (state IN ('submitted', 'confirmed', 'failed', 'unknown')),
  error                      TEXT,
  created_at                 TIMESTAMPTZ NOT NULL,
  updated_at                 TIMESTAMPTZ NOT NULL,
  CONSTRAINT funding_stamp_operations_kind_fields CHECK (
    (kind = 'topup' AND amount_per_chunk IS NOT NULL AND cost IS NOT NULL AND new_depth IS NULL)
    OR (
      kind = 'dilute'
      AND new_depth IS NOT NULL
      AND new_depth - expected_depth IN (1, 2)
      AND amount_per_chunk IS NULL
      AND cost IS NULL
    )
  )
);
