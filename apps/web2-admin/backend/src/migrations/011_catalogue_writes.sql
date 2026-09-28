-- The catalogue is written through the catalogue stamp, and every write keeps
-- the exact bytes it uploaded.
--
-- Until this migration the admin wrote the catalogue with the node and batch
-- of its env file, `BEE_URL` and `POSTAGE_BATCH_ID`. It now writes through the
-- node and batch of the catalogue stamp record the manager pushes (migration
-- 010, docs/architecture/stages.md), read on every write. Two things follow.
--
-- The admin keeps the batch it actually writes with. A batch stamps the chunks
-- it wrote, the catalogue's history among them, so a designation that names
-- another batch cannot simply be followed once the feed has history: the new
-- batch would stamp the next slot while the old one still holds every earlier
-- slot, and when the old one expires the viewer, which walks the slots until
-- the first one missing, sees nothing. Moving the catalogue means stamping the
-- history again under the new batch, which is a job of its own. Until it runs,
-- the admin keeps writing with the batch it has and says a move is waiting.
--
-- On `catalogue_stamp`:
--
--   active_batch_id   the batch the catalogue is written with, or null until
--                     the first write under the stamp pins one. A write pins
--                     the designated batch when nothing is pinned, and when
--                     the pinned one differs but the feed has no recorded
--                     write yet (the feed key changed), since there is no
--                     history to move then.
--   active_record     the last catalogue stamp record the manager pushed for
--                     that batch: its node's Bee API address and its readings.
--                     Refreshed by every push for the same batch, and kept as
--                     it was when the manager designates another one, so the
--                     admin still knows where to write and how the batch
--                     stood when the manager last read it. Like `record`, the
--                     console is never shown the address.
--   active_pinned_at  when the admin pinned it, by the admin's clock.
--
-- A clear of the designation leaves all three as they are: the history is
-- still stamped by that batch, and the admin writes nothing until the manager
-- designates a batch again.
--
-- On `feed_writes`:
--
--   payload_text      the exact string uploaded as the feed payload, which
--                     `payload` holds parsed. bee-js puts a payload straight
--                     into the feed's chunk with no timestamp, so these bytes
--                     under the same key and index make the same chunk at the
--                     same address, which is what stamping the history again
--                     needs. Null on rows written before this migration.
--   batch_id          the batch that stamped the write, or null on rows
--                     written before this migration (the env file's batch,
--                     which the admin did not record), on a head adopted from
--                     the network at boot, and on a write the in-memory
--                     gateway took with no catalogue stamp stored.

ALTER TABLE catalogue_stamp
  ADD COLUMN active_batch_id  TEXT NULL,
  ADD COLUMN active_record    JSONB NULL,
  ADD COLUMN active_pinned_at TIMESTAMPTZ NULL,
  ADD CONSTRAINT catalogue_stamp_active_whole CHECK (
    (active_batch_id IS NULL) = (active_record IS NULL)
    AND (active_batch_id IS NULL) = (active_pinned_at IS NULL)
  ),
  ADD CONSTRAINT catalogue_stamp_active_record_batch CHECK (
    active_record IS NULL
    OR (jsonb_typeof(active_record) = 'object' AND active_record->>'batchId' = active_batch_id)
  );

ALTER TABLE feed_writes
  ADD COLUMN payload_text TEXT NULL,
  ADD COLUMN batch_id     TEXT NULL,
  ADD CONSTRAINT feed_writes_payload_text_matches CHECK (payload_text IS NULL OR payload_text::jsonb = payload);
