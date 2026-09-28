-- Moving the catalogue to another batch: the job's progress, so a restart
-- continues where it stopped.
--
-- The viewer walks the catalogue feed's slots from 0 and stops at the first one
-- it cannot read, so every slot has to stay retrievable. A batch keeps the
-- chunks it stamped until it expires. Moving the catalogue to another batch
-- therefore means uploading every slot's chunk again, byte for byte, under the
-- new batch before the old one lapses, then writing with the new one
-- (docs/architecture/stages.md, "Moving the catalogue to another batch").
--
-- catalogue_moves holds one row per move, the latest one being the one the
-- console shows:
--
--   feed_owner, feed_topic
--                the feed moved, as feed_writes names it.
--   target_batch_id
--                the batch the history is stamped under: the one the manager
--                designated when the move started.
--   from_batch_id
--                the batch the catalogue was written with when it started, or
--                null when none was pinned yet (history written with the env
--                file's batch, before the catalogue stamp).
--   state        running, done or failed. At most one running per feed.
--   next_index   every slot below it is stamped under the target batch. The
--                job goes through the slots in order, so this one number is
--                where a restart continues.
--   head_index   the feed's last slot as the job last read it, for the
--                console's "N of M".
--   restamped_slots, skipped_slots
--                slots uploaded again, and slots left as they were because
--                they were already under the target batch.
--   thumbnails   thumbnails uploaded again for the latest entry, in the run
--                that finished.
--   error        why a failed move stopped, in the sentence the console shows.
--   started_by   who started the move, as the audit log describes an actor.
--   started_at, updated_at, finished_at
--                the admin's own clock.
--
-- On feed_writes, restamped_batch_id and restamped_at say which batch a write
-- was last uploaded again under, and when. Both or neither. A slot with no row
-- (written before migration 003) is covered by next_index alone.

CREATE TABLE catalogue_moves (
  id               BIGSERIAL PRIMARY KEY,
  feed_owner       TEXT NOT NULL,
  feed_topic       TEXT NOT NULL,
  target_batch_id  TEXT NOT NULL CHECK (target_batch_id ~ '^[0-9a-f]{64}$'),
  from_batch_id    TEXT NULL CHECK (from_batch_id IS NULL OR from_batch_id ~ '^[0-9a-f]{64}$'),
  state            TEXT NOT NULL CHECK (state IN ('running', 'done', 'failed')),
  next_index       BIGINT NOT NULL DEFAULT 0 CHECK (next_index >= 0),
  head_index       BIGINT NULL CHECK (head_index IS NULL OR head_index >= 0),
  restamped_slots  INT NOT NULL DEFAULT 0 CHECK (restamped_slots >= 0),
  skipped_slots    INT NOT NULL DEFAULT 0 CHECK (skipped_slots >= 0),
  thumbnails       INT NOT NULL DEFAULT 0 CHECK (thumbnails >= 0),
  error            TEXT NULL,
  started_by       TEXT NOT NULL,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at      TIMESTAMPTZ NULL,
  CHECK ((state = 'failed') = (error IS NOT NULL)),
  CHECK ((state = 'running') = (finished_at IS NULL))
);

CREATE UNIQUE INDEX catalogue_moves_one_running
  ON catalogue_moves (feed_owner, feed_topic)
  WHERE state = 'running';

CREATE INDEX catalogue_moves_latest ON catalogue_moves (feed_owner, feed_topic, id DESC);

ALTER TABLE feed_writes
  ADD COLUMN restamped_batch_id TEXT NULL,
  ADD COLUMN restamped_at       TIMESTAMPTZ NULL,
  ADD CONSTRAINT feed_writes_restamped_whole CHECK ((restamped_batch_id IS NULL) = (restamped_at IS NULL));
