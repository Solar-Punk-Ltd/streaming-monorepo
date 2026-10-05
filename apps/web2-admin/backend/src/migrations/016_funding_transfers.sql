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
-- never sign over the same nonces. Nor while an item is unknown and the
-- manager answered its relay at most 30 minutes ago, the manager's
-- FUNDING_UNKNOWN_AFTER_MS, which the manager counts from its own journal row,
-- written when the relay reaches it: the manager answers unknown when the
-- answer of its broadcast was lost, and the transaction may then sit in the
-- chain's pool at its nonce. An unknown item older than that (the chain no longer holds it, so the next send reuses
-- its nonce and at most one of the two can ever be mined) and an item failed
-- by the chain's node at the relay, with no block, hold up no send, but stay
-- watched: the refresh keeps asking the manager about them, since a late
-- receipt may still turn them confirmed.
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
--   relayed_at   when the admin recorded the manager's first answer for it,
--                to a relay, or, for a relay whose answer was lost, to the
--                status read that found it, by the service's clock. Written
--                once that answer is back, so at or after the manager's own
--                journal moment: an unknown item's 30 minutes count from it,
--                and end no earlier than the manager's. Null while the item is
--                queued, and on an item failed before the manager ever
--                answered for it; every write that moves a queued item to one
--                of the manager's states sets it. created_at stands in only as
--                a backstop for a row written otherwise, so that no item holds
--                a send for good.
--   created_at, updated_at
--                the database's clock.
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
  relayed_at            TIMESTAMPTZ NULL,
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
-- nonce). The check that no item holds up a send asks for a queued or
-- submitted item, or an unknown one whose relay the manager answered since a
-- cutoff 30 minutes back: COALESCE(relayed_at, created_at) >= the cutoff. A
-- partial index cannot hold that cutoff, since its predicate cannot call
-- now(), so it covers every row of the three states, by that same moment: the
-- check's predicate implies the index's, and the rows of those states are few,
-- one open send and its watched items, whichever column the scan reads.
CREATE INDEX funding_transfers_unsettled_idx
  ON funding_transfers ((COALESCE(relayed_at, created_at)))
  WHERE state IN ('queued', 'submitted', 'unknown');

CREATE INDEX funding_transfers_watched_idx ON funding_transfers (created_at)
  WHERE watched;

-- Removing a user sets their rows' requested_by_user_id to null.
CREATE INDEX funding_transfers_requested_by_idx ON funding_transfers (requested_by_user_id);
