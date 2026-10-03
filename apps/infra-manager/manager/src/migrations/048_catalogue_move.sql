-- Moving the brand's catalogue to another batch: the batch the catalogue is
-- moving from, kept beside the one it is pinned to until the operator releases
-- it. docs/features/stages.md, "Moving the catalogue".
--
-- A move designates another batch, on the same Bee-only deployment or another,
-- in profile_name, batch_id and batch_depth, and records the batch it moved off
-- here. The web2 admin stamps every slot of the catalogue again under the new
-- batch before it writes with it, and until it reports the move done the old
-- batch holds the history the viewers read. So the manager keeps guarding both:
-- neither node is removed and no pool string may name either, until a release
-- takes the old one out of this row.
--
-- moving_from_profile_name, moving_from_batch_id and moving_from_batch_depth are
-- the deployment, the batch (64 hex digits in lower case with no 0x, as
-- batch_id) and the depth recorded for it, the pinned columns as they stood
-- before the move. They are set together or not at all, and a move is pending
-- while they are set. A move back to that batch swaps the two, so whichever
-- batch still holds history stays guarded.
--
-- move_started_at and move_started_by are the manager's moment and the user of
-- the last move, set with the moving_from columns and cleared with them.
-- released_at and released_by are the moment and the user of the last release,
-- kept after it for the page and the log to name; the next release replaces
-- them.
--
-- A clear leaves a pending move as it is: it takes the designation out, not the
-- history the old batch holds.
--
-- Going back to an older manager needs no step: it never reads these columns,
-- and its designation reads and writes the ones migration 047 made.
ALTER TABLE catalogue_designation
  ADD COLUMN moving_from_profile_name TEXT CHECK (moving_from_profile_name IS NULL OR moving_from_profile_name <> ''),
  ADD COLUMN moving_from_batch_id TEXT CHECK (moving_from_batch_id IS NULL OR moving_from_batch_id ~ '^[0-9a-f]{64}$'),
  ADD COLUMN moving_from_batch_depth INTEGER
    CHECK (moving_from_batch_depth IS NULL OR moving_from_batch_depth BETWEEN 17 AND 64),
  ADD COLUMN move_started_at TIMESTAMPTZ,
  ADD COLUMN move_started_by TEXT,
  ADD COLUMN released_at TIMESTAMPTZ,
  ADD COLUMN released_by TEXT,
  ADD CHECK ((moving_from_profile_name IS NULL) = (moving_from_batch_id IS NULL)),
  ADD CHECK ((moving_from_batch_id IS NULL) = (moving_from_batch_depth IS NULL)),
  ADD CHECK ((moving_from_batch_id IS NULL) = (move_started_at IS NULL)),
  ADD CHECK (move_started_by IS NULL OR move_started_at IS NOT NULL),
  ADD CHECK (moving_from_batch_id IS NULL OR (batch_id IS NOT NULL AND moving_from_batch_id <> batch_id)),
  ADD CHECK (released_by IS NULL OR released_at IS NOT NULL);
