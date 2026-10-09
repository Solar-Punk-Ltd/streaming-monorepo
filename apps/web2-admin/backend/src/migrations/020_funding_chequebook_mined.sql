-- Whether a chequebook item's move is mined and waits for its block to be
-- final (docs/architecture/funding.md, the backend README's "Chequebook
-- operations").
--
-- The manager confirms a chequebook move only once its block is final on the
-- chain, about 3 minutes after it is mined on Gnosis Chain, and answers the
-- move submitted until then. Its status read says, in `mined`, whether the
-- move's transaction is in a block that is not final yet, so the page shows
-- the step between Sent and Confirmed: Mined.
--
--   mined        true while the item is submitted and the manager's last
--                status read said its move is mined and its block not final
--                yet. False otherwise: before the move is mined, once it has
--                an outcome, and on every row written before this migration.
--                A refresh records it from each status read, an answer with
--                none, as a manager older than it gives, read as false. A
--                relay's answer does not say, and leaves it as it is: an
--                item a relay is sent for, queued or submitted with no hash,
--                is in no block yet. Nothing else reads it: a mined item
--                holds up a new bulk as any submitted one does.
--
-- Going back to an older admin needs no step: it never reads the column, and
-- the rows it writes take the default.

ALTER TABLE funding_chequebook_operations
  ADD COLUMN mined BOOLEAN NOT NULL DEFAULT FALSE;
