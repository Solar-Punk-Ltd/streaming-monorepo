-- Archiving a recording: one quality of a finished recording copied, chunk
-- by chunk, onto an archive stamp, an immutable batch on the catalogue node,
-- so it outlives the mutable batches of the stage that made it.
-- docs/architecture/web2-admin.md, "Archiving a recording".
--
-- One row per stream and quality: the copy of that quality. A copy made again,
-- after the stream recorded again or onto another stamp, replaces the row. The
-- archive stamps themselves are not kept here: the manager pushes them inside
-- the catalogue stamp record, which catalogue_stamp.record holds whole.
--
--   rendition        the rung's name, or 'source' for a recording with one
--                    quality, as stream_exports.rendition.
--   batch_id         the archive stamp the copy is on, 64 hex digits in lower
--                    case with no 0x, as the record names one.
--   feed_owner, feed_topic, manifest_index
--                    the playlist slot that was copied: the stream's owner, the
--                    rung's topic or the stream's own as a UUID, and the feed
--                    index of the recording playlist. A stream that recorded
--                    again holds another index, and the copy is then outdated.
--   state            partial or complete. A row is written as partial when a
--                    copy starts, and complete once no data or tree chunk
--                    failed and Bee reported every posted chunk synced. A
--                    complete row is what "archived" means.
--   parity_missing   parity chunks that could not be read and were left out.
--                    A complete row with any is archived with reduced
--                    protection.
--   segments, chunks, bytes, chunks_rebuilt
--                    what the copy holds, and how many of its chunks the
--                    network had lost and were brought back from parity.
--   bucket_sum_before, bucket_sum_after
--                    the stamps used on the batch before and after the copy,
--                    the sum of its bucket counts as the node reports them.
--                    Kept for the room it took. A chunk already on the batch
--                    adds nothing, so the difference can be under `chunks`.
--   bzz_spent_estimate_plur
--                    what the catalogue node's chequebook went down by during
--                    the copy. The catalogue's own writes share it.
--   completed_at, completed_by_user_id, completed_by
--                    when it became complete, and who started the job that
--                    made it so, as the audit log names an actor.
--
-- Deleting the stream deletes its rows. The chunks stay on Swarm for as long
-- as their stamp lasts: nothing is taken off an immutable batch.

CREATE TABLE stream_archives (
  stream_id                UUID NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  rendition                TEXT NOT NULL CHECK (rendition <> ''),
  batch_id                 TEXT NOT NULL CHECK (batch_id ~ '^[0-9a-f]{64}$'),
  feed_owner               TEXT NOT NULL,
  feed_topic               TEXT NOT NULL,
  manifest_index           BIGINT NOT NULL CHECK (manifest_index >= 0),
  state                    TEXT NOT NULL,
  parity_missing           INT NOT NULL DEFAULT 0,
  segments                 INT NOT NULL DEFAULT 0,
  chunks                   BIGINT NOT NULL DEFAULT 0,
  bytes                    BIGINT NOT NULL DEFAULT 0,
  chunks_rebuilt           INT NOT NULL DEFAULT 0,
  bucket_sum_before        BIGINT,
  bucket_sum_after         BIGINT,
  bzz_spent_estimate_plur  NUMERIC(78, 0) CHECK (bzz_spent_estimate_plur IS NULL OR bzz_spent_estimate_plur >= 0),
  completed_at             TIMESTAMPTZ,
  completed_by_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  completed_by             TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stream_id, rendition),
  CONSTRAINT stream_archives_state CHECK (state IN ('partial', 'complete')),
  -- Complete, and when and by whom, is one fact.
  CONSTRAINT stream_archives_complete_with_moment
    CHECK ((state = 'complete') = (completed_at IS NOT NULL) AND (state = 'complete') = (completed_by IS NOT NULL)),
  CONSTRAINT stream_archives_counts_non_negative
    CHECK (parity_missing >= 0 AND segments >= 0 AND chunks >= 0 AND bytes >= 0 AND chunks_rebuilt >= 0),
  CONSTRAINT stream_archives_bucket_sums
    CHECK (
      (bucket_sum_before IS NULL OR bucket_sum_before >= 0)
      AND (bucket_sum_after IS NULL OR bucket_sum_after >= 0)
    )
);

-- The Archive page lists by the stamp a copy is on, and a stamp's row counts
-- the qualities on it.
CREATE INDEX stream_archives_batch ON stream_archives (batch_id);
