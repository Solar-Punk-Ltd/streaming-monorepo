-- The archive job: the chosen qualities of one finished recording being
-- copied onto an archive stamp. docs/architecture/web2-admin.md, "Archiving a
-- recording".
--
-- One archive exists at a time, so archive_jobs holds at most one row: the
-- archive working, paused or waiting, or once it is done, its result until a
-- new one starts. Starting a new one deletes a done row first. Cancel deletes
-- the row, and what was copied stays on Swarm, its qualities partial in
-- stream_archives.
--
-- An archive and an export share one place for the whole admin. Each takes the
-- same advisory lock at its start and looks at the other's table: an export in
-- any state but done holds the place, and so does an archive unless it is
-- done, paused by a user, or waiting for a user to confirm a purchase.
--
--   stream_id       the stream archived. Deleting the stream deletes the row.
--   batch_id        the archive stamp copied onto, 64 hex digits in lower case
--                   with no 0x. Null while a stamp is still to be bought.
--   buy_new         the user chose to buy a new stamp for this archive.
--   purchase_id     the purchase made for it, once the user confirmed one.
--   state           measuring, awaiting_purchase, buying, waiting_usable,
--                   copying, verifying, paused, waiting or done.
--   pause_reason    user, unreadable, live, batch, node, funds or problem: set
--                   while paused, and only then.
--   pause_message   the sentence the console shows for the pause.
--   paused_at       when it paused: the console brings the panel to front once
--                   per pause, for the user who started it.
--   chunks_total    the chunks of every chosen quality together, an upper
--                   bound, null until all are measured.
--   chunks_per_second
--                   the rate of the copy, saved as it goes. The next job's
--                   estimate starts from the last one a job measured.
--   bzz_estimate_low_plur, bzz_estimate_high_plur
--                   what the copy is expected to cost the catalogue node's
--                   chequebook, once measured.
--   chequebook_before_plur, bzz_spent_plur
--                   what the chequebook could pay when the copy started, and
--                   what it went down by once done.
--   started_by_user_id, started_by
--                   who started it: the user, for the panel's "started by
--                   you", and the name as the audit log describes an actor.

CREATE TABLE archive_jobs (
  id                      UUID PRIMARY KEY,
  -- At most one row, as stream_exports.slot.
  slot                    BOOLEAN NOT NULL DEFAULT TRUE UNIQUE CHECK (slot),
  stream_id               UUID NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  batch_id                TEXT CHECK (batch_id IS NULL OR batch_id ~ '^[0-9a-f]{64}$'),
  buy_new                 BOOLEAN NOT NULL DEFAULT FALSE,
  purchase_id             UUID REFERENCES archive_stamp_purchases(id) ON DELETE SET NULL,
  state                   TEXT NOT NULL,
  pause_reason            TEXT,
  pause_message           TEXT,
  paused_at               TIMESTAMPTZ,
  chunks_total            BIGINT CHECK (chunks_total IS NULL OR chunks_total >= 0),
  chunks_per_second       DOUBLE PRECISION CHECK (chunks_per_second IS NULL OR chunks_per_second >= 0),
  bzz_estimate_low_plur   NUMERIC(78, 0) CHECK (bzz_estimate_low_plur IS NULL OR bzz_estimate_low_plur >= 0),
  bzz_estimate_high_plur  NUMERIC(78, 0) CHECK (bzz_estimate_high_plur IS NULL OR bzz_estimate_high_plur >= 0),
  chequebook_before_plur  NUMERIC(78, 0) CHECK (chequebook_before_plur IS NULL OR chequebook_before_plur >= 0),
  bzz_spent_plur          NUMERIC(78, 0) CHECK (bzz_spent_plur IS NULL OR bzz_spent_plur >= 0),
  started_by_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  started_by              TEXT NOT NULL,
  started_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at             TIMESTAMPTZ,
  CONSTRAINT archive_jobs_state CHECK (
    state IN (
      'measuring', 'awaiting_purchase', 'buying', 'waiting_usable', 'copying', 'verifying', 'paused', 'waiting',
      'done'
    )
  ),
  CONSTRAINT archive_jobs_pause_reason CHECK (
    pause_reason IS NULL
    OR pause_reason IN ('user', 'unreadable', 'live', 'batch', 'node', 'funds', 'problem')
  ),
  -- A reason while paused, and only then: "paused, and why" is one fact.
  CONSTRAINT archive_jobs_paused_with_reason CHECK ((state = 'paused') = (pause_reason IS NOT NULL)),
  -- A stamp to copy onto, or one to buy.
  CONSTRAINT archive_jobs_target CHECK (batch_id IS NOT NULL OR buy_new),
  -- Nothing is copied or verified without a stamp.
  CONSTRAINT archive_jobs_copy_needs_stamp
    CHECK (state NOT IN ('copying', 'verifying', 'done') OR batch_id IS NOT NULL),
  CONSTRAINT archive_jobs_done_with_moment CHECK ((state = 'done') = (finished_at IS NOT NULL))
);

-- The last rate a job measured, for the next job's estimate, outlives the
-- job's own row.
CREATE TABLE archive_rate (
  id                 BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  chunks_per_second  DOUBLE PRECISION NOT NULL CHECK (chunks_per_second > 0),
  measured_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One chosen quality of the job. They are copied one after another, in
-- `position` order.
--
--   feed_owner, feed_topic, manifest_index
--                    the playlist slot being copied, as stream_archives.
--   state            waiting, measuring, copying, verifying or done.
--   result           complete, or reduced when parity chunks were left out:
--                    set once done, and only then.
--   segments_total, segments_done, chunks_total, chunks_copied,
--   chunks_rebuilt, parity_missing, bytes_copied
--                    progress, saved as the job goes.
--   tag_uid          the Bee tag every post of this quality carries. With a
--                    tag Bee defers the push, and the tag counts it.
--   posts_under_tag  every post the job made under the tag, a chunk posted
--                    again after a resume counted again, as the tag's `split`
--                    counts it. After a restart the job takes the tag's
--                    `split` as this count, since Bee counted every post it
--                    answered.
--   chunks_synced, chunks_seen
--                    the tag's `synced` and `seen`, as last read. A chunk
--                    posted again while its first post still waits to be
--                    pushed goes to `seen`, and one posted again after it
--                    synced is pushed and counted in `synced` again. The
--                    quality is complete when no data or tree chunk failed, the
--                    tag's `split` equals posts_under_tag, and its `synced`
--                    and `seen` together equal its `split`.
--
-- A tag the node no longer knows cannot be read for that verdict. The quality
-- then takes a new tag, posts_under_tag and both counts start from 0, its rows
-- in archive_job_segments are deleted, and it is posted again, which costs
-- pushes and no room.
--   bucket_sum_before
--                    the stamps used on the batch when this quality's copy
--                    started.

CREATE TABLE archive_job_items (
  job_id             UUID NOT NULL REFERENCES archive_jobs(id) ON DELETE CASCADE,
  rendition          TEXT NOT NULL CHECK (rendition <> ''),
  position           INT NOT NULL CHECK (position >= 0),
  feed_owner         TEXT NOT NULL,
  feed_topic         TEXT NOT NULL,
  manifest_index     BIGINT NOT NULL CHECK (manifest_index >= 0),
  state              TEXT NOT NULL,
  result             TEXT,
  segments_total     INT,
  segments_done      INT NOT NULL DEFAULT 0,
  chunks_total       BIGINT,
  chunks_copied      BIGINT NOT NULL DEFAULT 0,
  chunks_rebuilt     INT NOT NULL DEFAULT 0,
  parity_missing     INT NOT NULL DEFAULT 0,
  bytes_copied       BIGINT NOT NULL DEFAULT 0,
  tag_uid            BIGINT CHECK (tag_uid IS NULL OR tag_uid >= 0),
  posts_under_tag    BIGINT NOT NULL DEFAULT 0,
  chunks_synced      BIGINT NOT NULL DEFAULT 0,
  chunks_seen        BIGINT NOT NULL DEFAULT 0,
  bucket_sum_before  BIGINT CHECK (bucket_sum_before IS NULL OR bucket_sum_before >= 0),
  PRIMARY KEY (job_id, rendition),
  UNIQUE (job_id, position),
  CONSTRAINT archive_job_items_state CHECK (state IN ('waiting', 'measuring', 'copying', 'verifying', 'done')),
  CONSTRAINT archive_job_items_result CHECK (result IS NULL OR result IN ('complete', 'reduced')),
  CONSTRAINT archive_job_items_done_with_result CHECK ((state = 'done') = (result IS NOT NULL)),
  CONSTRAINT archive_job_items_counts_non_negative CHECK (
    segments_done >= 0 AND chunks_copied >= 0 AND chunks_rebuilt >= 0 AND parity_missing >= 0
    AND bytes_copied >= 0 AND posts_under_tag >= 0 AND chunks_synced >= 0 AND chunks_seen >= 0
    AND (segments_total IS NULL OR segments_total >= 0)
    AND (chunks_total IS NULL OR chunks_total >= 0)
  )
);

-- The resume ledger: the segments of a quality whose every chunk was posted.
-- A job that stops picks up at the first segment not listed, and a segment it
-- was in the middle of is copied whole again, which costs pushes and no room,
-- since Bee keeps one stamp per batch and chunk.
--
--   reference       the segment's Swarm reference, 64 hex digits in lower case.
--   chunks, bytes   what the segment's copy took.
--   parity_missing  parity chunks of it that were left out.

CREATE TABLE archive_job_segments (
  job_id          UUID NOT NULL,
  rendition       TEXT NOT NULL,
  reference       TEXT NOT NULL CHECK (reference ~ '^[0-9a-f]{64}$'),
  chunks          INT NOT NULL CHECK (chunks >= 0),
  bytes           BIGINT NOT NULL CHECK (bytes >= 0),
  parity_missing  INT NOT NULL DEFAULT 0 CHECK (parity_missing >= 0),
  done_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (job_id, rendition, reference),
  FOREIGN KEY (job_id, rendition) REFERENCES archive_job_items(job_id, rendition) ON DELETE CASCADE
);

-- Who closed the widget of a finished archive, as stream_export_dismissals.
CREATE TABLE archive_job_dismissals (
  job_id        UUID NOT NULL REFERENCES archive_jobs(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dismissed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (job_id, user_id)
);
