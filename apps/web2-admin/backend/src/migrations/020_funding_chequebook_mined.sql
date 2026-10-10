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
--   mined        true from the status read that first said the item's move
--                is mined and its block not final yet, for as long as the
--                item is submitted: a later read that says otherwise while
--                it is still submitted, as after a failed look at the
--                receipt, does not clear it, so the page never steps back
--                from Mined to Sent. False before the move is mined, once
--                the item leaves submitted (confirmed, failed or not known),
--                and on every row written before this migration. An answer
--                with none, as a manager older than it gives, says false. A
--                relay's answer does not say, and leaves it as it is: an
--                item a relay is sent for, queued or submitted with no hash,
--                is in no block yet. Nothing else reads it: a mined item
--                holds up a new bulk as any submitted one does.
--
-- Going back to an older admin needs no step: it never reads the column, and
-- the rows it writes take the default.

ALTER TABLE funding_chequebook_operations
  ADD COLUMN mined BOOLEAN NOT NULL DEFAULT FALSE;
