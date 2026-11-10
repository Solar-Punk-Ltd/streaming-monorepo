-- Exporting a recording: one quality of a finished recording read from Swarm
-- and joined into an MP4 on this server, kept so any user can save it again
-- without another Swarm read.
--
-- One export exists at a time for the whole admin, so this table holds at
-- most one row: the export running, paused or waiting, or once it is done,
-- the kept file. Starting a new export deletes a done row first, and is
-- refused while the row is in any other state. Cancel deletes the row. Its
-- files live in EXPORT_DIR/<id>/, and a folder without a row is deleted.
--
--   stream_id        the stream exported. Deleting the stream deletes the
--                    row, and the job and the folder sweep stop and clean up.
--   rendition        the rung's name, or 'source' for a recording with one
--                    quality.
--   quality          what the file name ends in: the rung's name, or the
--                    height of a single-quality recording once ffprobe has
--                    read it ('source' until then).
--   feed_owner, feed_topic
--                    the feed the playlist is read from: the stream's owner,
--                    and the rung's topic or the stream's own, as the UUID the
--                    rows above hold (the feed topic is its keccak, as bee-js
--                    makes it).
--   manifest_index   the feed index of the recording playlist being read. A
--                    stream that went live again and finished takes a new one,
--                    which an export that waited for it reads next.
--   state            reading, joining, paused, waiting or done.
--   pause_reason     user, unreadable, live, disk or problem: set while
--                    paused, and only then.
--   pause_message    the sentence the console shows for the pause.
--   paused_at        when it paused: the console brings the panel to front
--                    once per pause, for the user who started it.
--   segments_total, segments_read, segments_missing, bytes_read
--                    progress, saved as the job goes. segments_total is null
--                    until the playlist was read.
--   estimated_bytes, duration_seconds
--                    what the panel estimated when it started, and the
--                    recording's length.
--   file_name, size_bytes
--                    the MP4, once done.
--   partial          the MP4 was saved from part of the recording.
--   started_by_user_id, started_by
--                    who started it: the user, for the panel's "started by
--                    you", and the name as the audit log describes an actor.
--   started_at, updated_at, finished_at
--                    the admin's own clock.

CREATE TABLE stream_exports (
  id                  UUID PRIMARY KEY,
  -- At most one row: `slot` can only be true and is unique, as brand_wallet's
  -- id can only be true (migration 015). A second start, from a second request
  -- or a second process, fails on it rather than running two exports through
  -- one node.
  slot                BOOLEAN NOT NULL DEFAULT TRUE UNIQUE CHECK (slot),
  stream_id           UUID NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  rendition           TEXT NOT NULL,
  quality             TEXT NOT NULL,
  feed_owner          TEXT NOT NULL,
  feed_topic          TEXT NOT NULL,
  manifest_index      BIGINT NOT NULL,
  state               TEXT NOT NULL,
  pause_reason        TEXT,
  pause_message       TEXT,
  paused_at           TIMESTAMPTZ,
  segments_total      INT,
  segments_read       INT NOT NULL DEFAULT 0,
  segments_missing    INT NOT NULL DEFAULT 0,
  bytes_read          BIGINT NOT NULL DEFAULT 0,
  estimated_bytes     BIGINT,
  duration_seconds    DOUBLE PRECISION,
  file_name           TEXT,
  size_bytes          BIGINT,
  partial             BOOLEAN NOT NULL DEFAULT FALSE,
  started_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  started_by          TEXT NOT NULL,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at         TIMESTAMPTZ,
  CONSTRAINT stream_exports_state CHECK (state IN ('reading', 'joining', 'paused', 'waiting', 'done')),
  CONSTRAINT stream_exports_pause_reason
    CHECK (pause_reason IS NULL OR pause_reason IN ('user', 'unreadable', 'live', 'disk', 'problem')),
  -- A reason while paused, and only then: "paused, and why" is one fact.
  CONSTRAINT stream_exports_paused_with_reason CHECK ((state = 'paused') = (pause_reason IS NOT NULL)),
  CONSTRAINT stream_exports_done_with_file
    CHECK (state <> 'done' OR (file_name IS NOT NULL AND size_bytes IS NOT NULL AND finished_at IS NOT NULL)),
  CONSTRAINT stream_exports_counts_non_negative
    CHECK (segments_read >= 0 AND segments_missing >= 0 AND bytes_read >= 0)
);

-- Who closed the widget of a finished export. Each user closes it for
-- themselves; a new export, or the row's deletion, takes these with it.
CREATE TABLE stream_export_dismissals (
  export_id     UUID NOT NULL REFERENCES stream_exports(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dismissed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (export_id, user_id)
);
