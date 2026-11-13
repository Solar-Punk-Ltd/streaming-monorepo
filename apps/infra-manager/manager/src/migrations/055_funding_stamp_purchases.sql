-- The archive stamps the web2 admin asked the manager to buy through the
-- funding API: a new immutable batch on the catalogue node, which that node
-- buys through its Bee API and pays for from its own wallet. README.md,
-- "Funding API".
--
-- A row is written before the node is asked, keyed by the admin's request id,
-- so the same request is answered from here and the node is never asked twice.
-- A manager that stops between the row and the node's answer leaves the row in
-- state 'unknown', which the status route settles from the node's own list of
-- batches.
--
-- node_id is the inventory's opaque id of the catalogue node. depth is the
-- batch's depth, 17 to 41, the depths the capacity table of packages/contracts
-- names. amount_per_chunk is the PLUR each chunk is given, and cost that amount
-- for every chunk of the batch, amount_per_chunk * 2^depth, paid in xBZZ from
-- the node's wallet.
--
-- label is the name the batch carries in the manager and the admin, or null.
-- node_label is the label the batch carries on its node, 'archive-' and the
-- request id, and unique. A new batch's id is known only once the node
-- answers, so the status route finds the batch of an 'unknown' row by this
-- label among the node's batches.
--
-- batch_id is the batch, 0x and 64 hex digits in lower case, as the funding
-- API prints one, and null until the node answered or the row was settled.
-- tx_hash is the transaction the node answered with, or null when it answered
-- none.
--
-- state follows the contract: 'confirmed' once the node answered with the
-- batch, which Bee does after the receipt, or once the node lists a batch under
-- node_label; 'failed' when the node refused, or could not be reached, or lists
-- no such batch thirty minutes after the row was written; 'unknown' before the
-- node answers and when its answer was lost. The manager never writes
-- 'submitted' for a purchase; the column takes it because the contract's
-- states are four. A confirmed row has its batch. error says why in a sentence.
--
-- Whether the batch is usable yet is read from the node on every status call
-- and is never kept here.
--
-- Going back to an older manager needs no step: it never reads the table.
CREATE TABLE funding_stamp_purchases (
  request_id        UUID PRIMARY KEY,
  node_id           TEXT NOT NULL CHECK (node_id ~ '^[A-Za-z0-9:._-]{1,200}$'),
  depth             SMALLINT NOT NULL CHECK (depth BETWEEN 17 AND 41),
  amount_per_chunk  NUMERIC(78, 0) NOT NULL CHECK (amount_per_chunk > 0),
  cost              NUMERIC(78, 0) NOT NULL CHECK (cost > 0),
  label             TEXT CHECK (label IS NULL OR (label <> '' AND char_length(label) <= 64)),
  node_label        TEXT NOT NULL UNIQUE CHECK (node_label ~ '^archive-[0-9a-f-]{36}$'),
  batch_id          TEXT CHECK (batch_id ~ '^0x[0-9a-f]{64}$'),
  tx_hash           TEXT CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  state             TEXT NOT NULL CHECK (state IN ('submitted', 'confirmed', 'failed', 'unknown')),
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL,
  CONSTRAINT funding_stamp_purchases_confirmed_with_batch CHECK (state <> 'confirmed' OR batch_id IS NOT NULL)
);

-- At most one purchase is being settled on a node at a time: a second one is
-- refused while the first is 'unknown' or 'submitted', since both would spend
-- the same wallet.
CREATE UNIQUE INDEX funding_stamp_purchases_one_open_per_node
  ON funding_stamp_purchases (node_id)
  WHERE state IN ('unknown', 'submitted');
