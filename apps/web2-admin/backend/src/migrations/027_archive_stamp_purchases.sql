-- The archive stamps this admin asked the manager to buy, from the Stamps
-- tab or from an archive job: a new immutable batch on the catalogue node,
-- which that node pays for from its own wallet.
-- docs/architecture/funding.md, "Stamps tab".
--
-- A row is written before the manager is asked, and its id is the request id
-- the manager's funding API knows the purchase by, so asking again never buys
-- twice. One purchase runs at a time, as the node buys one at a time.
--
--   depth, amount_per_chunk_plur, cost_plur
--                 what the user confirmed in the buy dialog: the depth, the
--                 PLUR each chunk is given, and that amount for every one of
--                 the batch's 2^depth stamps, which the node pays in xBZZ.
--   label         the name the user gave the stamp, 1 to 64 characters, or
--                 null.
--   state         buying while the node's transaction is not mined,
--                 waiting_usable once the batch is bought and cannot stamp yet,
--                 usable once it can, and failed when nothing was bought.
--   batch_id      the batch, 64 hex digits in lower case with no 0x, once the
--                 manager answered with it.
--   tx_hash       the purchase's transaction, once there is one.
--   error         the sentence that says why it failed.
--   relayed_at    when the request was sent to the manager, null before it.
--                 A row that was never sent is safe to send again.
--   started_by_user_id, started_by
--                 who confirmed it, as the audit log describes an actor.

CREATE TABLE archive_stamp_purchases (
  id                     UUID PRIMARY KEY,
  depth                  SMALLINT NOT NULL CHECK (depth BETWEEN 17 AND 41),
  amount_per_chunk_plur  NUMERIC(78, 0) NOT NULL CHECK (amount_per_chunk_plur > 0),
  cost_plur              NUMERIC(78, 0) NOT NULL CHECK (cost_plur > 0),
  label                  TEXT CHECK (label IS NULL OR (label <> '' AND char_length(label) <= 64)),
  state                  TEXT NOT NULL,
  batch_id               TEXT CHECK (batch_id IS NULL OR batch_id ~ '^[0-9a-f]{64}$'),
  tx_hash                TEXT CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
  error                  TEXT,
  relayed_at             TIMESTAMPTZ,
  started_by_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  started_by             TEXT NOT NULL,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT archive_stamp_purchases_state
    CHECK (state IN ('buying', 'waiting_usable', 'usable', 'failed')),
  CONSTRAINT archive_stamp_purchases_bought_with_batch
    CHECK (state NOT IN ('waiting_usable', 'usable') OR batch_id IS NOT NULL),
  CONSTRAINT archive_stamp_purchases_failed_with_error CHECK (state <> 'failed' OR error IS NOT NULL)
);

-- At most one purchase is under way: a second start, from a second request or
-- a second process, fails on this rather than asking the node twice.
CREATE UNIQUE INDEX archive_stamp_purchases_one_open
  ON archive_stamp_purchases ((TRUE))
  WHERE state IN ('buying', 'waiting_usable');
