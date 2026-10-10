-- The transfers the web2 admin asked the manager to broadcast through the
-- funding API, from the brand wallet to a node's wallet. README.md, "Funding
-- API".
--
-- A row is written before the signed transaction is broadcast, keyed by the
-- admin's request id, so the same request is answered from here and never sent
-- twice. A manager that stops between the row and the broadcast leaves the row
-- in state 'unknown' with the transaction's hash, which the status route reads
-- the chain for; the transaction itself is not stored and never sent again.
--
-- kind is 'xdai' or 'xbzz'. to_address is the node's wallet and sender the
-- address the transaction is signed by, both 0x and 40 hex digits in lower
-- case. amount is wei for xDAI and PLUR for xBZZ. tx_hash is keccak256 of the
-- signed transaction. state follows the contract: 'submitted' once the chain
-- took it, 'confirmed' or 'failed' by its receipt, and 'unknown' before the
-- broadcast is confirmed or once the chain no longer knows it. error says why
-- in a sentence, and block_number is the receipt's block.
--
-- Going back to an older manager needs no step: it never reads the table.
CREATE TABLE funding_transfers (
  request_id    UUID PRIMARY KEY,
  node_id       TEXT NOT NULL CHECK (node_id ~ '^[A-Za-z0-9:._-]{1,200}$'),
  kind          TEXT NOT NULL CHECK (kind IN ('xdai', 'xbzz')),
  to_address    TEXT NOT NULL CHECK (to_address ~ '^0x[0-9a-f]{40}$'),
  amount        NUMERIC(78, 0) NOT NULL CHECK (amount > 0),
  sender        TEXT NOT NULL CHECK (sender ~ '^0x[0-9a-f]{40}$'),
  tx_hash       TEXT NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  state         TEXT NOT NULL CHECK (state IN ('submitted', 'confirmed', 'failed', 'unknown')),
  error         TEXT,
  block_number  BIGINT CHECK (block_number IS NULL OR block_number >= 0),
  created_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX funding_transfers_tx_hash ON funding_transfers (tx_hash);
