-- The admin's journal of the transfers it signs from the brand wallet to the
-- wallets of the brand's nodes, and relays through the manager's funding API
-- (docs/architecture/funding.md, the backend README's "Funding transfers").
--
-- A send is one bulk of items, each one transfer of xDAI or xBZZ to one node.
-- Every item is signed, with the nonces of the bulk consecutive, and written
-- here with its signed transaction BEFORE it is relayed. So a relay whose
-- answer never came, or a process that stops between the signature and the
-- relay, leaves a row the Funding page refreshes from: the manager is asked
-- where the request id stands, and one it never received is relayed again,
-- the same bytes under the same request id. Nothing is ever signed twice.
-- While any item is queued or submitted, no new send starts, so two sends
-- never sign over the same nonces. An item failed by the chain's node at the
-- relay, with no block, and an item the manager answers unknown (the chain no
-- longer holds it) hold up no send, but stay watched: the refresh keeps asking
-- the manager about them, since a late receipt may still turn them confirmed.
-- That is safe for unknown: the chain does not hold it, so the next send
-- reuses its nonce, and at most one of the two can ever be mined.
--
--   request_id   the item's id, which the manager journals it under.
--   bulk_id      the send it belongs to, which the page reads it back by.
--   node_id, node_label
--                the manager's id of the node and its label as the manager
--                answered it when the item was signed.
--   to_address   the node's wallet, as an operator pinned it (migration 017).
--   kind         xdai or xbzz.
--   amount       wei for xdai, PLUR for xbzz: more than nothing, at most
--                2^256 - 1.
--   nonce        the brand wallet's nonce the item is signed with.
--   raw_transaction
--                the signed transaction, kept for a relay again byte for byte.
--                No route answers it and nothing logs or audits it.
--   tx_hash      keccak256 of raw_transaction, known once it is signed.
--   state        queued once journalled and until the manager answers for it,
--                then the manager's: submitted, confirmed, failed, unknown.
--   error        why it failed, or what the manager said of it, in a sentence.
--   block_number the block the manager says it was mined in.
--   watched      true while a settled item is still asked about: unknown, or
--                failed with no block by the chain's node. Only those.
--   requested_by_user_id, requested_by
--                the operator who sent it: the id, null once the user is
--                removed, and the username at the time, which stays.
--   created_at, updated_at
--                the admin's own clock.
--
-- Going back to an older admin needs no step: it never reads the table. The
-- items it holds are on the chain or with the manager whatever the admin runs.

CREATE TABLE funding_transfers (
  request_id            UUID PRIMARY KEY,
  bulk_id               UUID NOT NULL,
  node_id               TEXT NOT NULL CHECK (node_id ~ '^[A-Za-z0-9:._-]{1,200}$'),
  node_label            TEXT NOT NULL CHECK (node_label <> ''),
  to_address            TEXT NOT NULL CHECK (to_address ~ '^0x[0-9a-f]{40}$'),
  kind                  TEXT NOT NULL CHECK (kind IN ('xdai', 'xbzz')),
  amount                NUMERIC(78, 0) NOT NULL CHECK (
    amount > 0
    AND amount <= 115792089237316195423570985008687907853269984665640564039457584007913129639935
  ),
  nonce                 BIGINT NOT NULL CHECK (nonce >= 0),
  raw_transaction       TEXT NOT NULL CHECK (raw_transaction ~ '^0x([0-9a-f]{2})+$'),
  tx_hash               TEXT NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  state                 TEXT NOT NULL CHECK (state IN ('queued', 'submitted', 'confirmed', 'failed', 'unknown')),
  error                 TEXT NULL,
  block_number          BIGINT NULL CHECK (block_number IS NULL OR block_number >= 0),
  watched               BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    NOT watched OR state = 'unknown' OR (state = 'failed' AND block_number IS NULL)
  ),
  requested_by_user_id  UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  requested_by          TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One transfer of each kind to a node in one send, and one nonce per item.
  CONSTRAINT funding_transfers_one_per_node_kind UNIQUE (bulk_id, node_id, kind),
  CONSTRAINT funding_transfers_bulk_nonce UNIQUE (bulk_id, nonce)
);

-- A send is read back in nonce order through the unique index on (bulk_id,
-- nonce). The check that no item holds up a send reads only these rows, with
-- the same predicate, and the refresh reads these and the watched ones.
CREATE INDEX funding_transfers_unsettled_idx ON funding_transfers (created_at)
  WHERE state IN ('queued', 'submitted');

CREATE INDEX funding_transfers_watched_idx ON funding_transfers (created_at)
  WHERE watched;

-- Removing a user sets their rows' requested_by_user_id to null.
CREATE INDEX funding_transfers_requested_by_idx ON funding_transfers (requested_by_user_id);
