-- The node wallets an operator confirmed (docs/architecture/funding.md: "Each
-- address is remembered at handover, and a changed one needs the operator's
-- confirmation").
--
-- The manager answers each node's wallet as it read it from the node. The
-- admin sends from the brand wallet only to a node whose current wallet is the
-- one pinned here, so a manager or a node that starts answering another
-- address gets nothing until an operator, with their password, pins the new
-- one. The Funding page shows each node as pinned, new (no row) or changed
-- (a row with another address).
--
--   node_id         the manager's id of the node.
--   wallet_address  the address pinned, 0x and 40 hex digits in lower case.
--   pinned_at       when, by the admin's clock.
--   pinned_by       the operator's username at the time.
--
-- Going back to an older admin needs no step: it never reads the table.

CREATE TABLE funding_node_pins (
  node_id         TEXT PRIMARY KEY CHECK (node_id ~ '^[A-Za-z0-9:._-]{1,200}$'),
  wallet_address  TEXT NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  pinned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pinned_by       TEXT NOT NULL CHECK (pinned_by <> '')
);
