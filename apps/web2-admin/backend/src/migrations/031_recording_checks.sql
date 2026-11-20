-- The checks of the recordings a person starts on the Streams page, and what
-- each found. docs/architecture/web2-admin.md, "Lost recordings".
--
-- A check reads every recording it may judge through the catalogue node, and
-- reads the ones that failed again in a second and a third round, ten minutes
-- apart. One check runs at a time for the whole admin, and the latest row is
-- the one the page shows.
--
-- state follows RecordingCheckState in the admin's common package: 'running',
-- 'done' with a result, and 'stopped' when it ended early with none, with the
-- reason in stop_message. round is the round being read or last read, 1 to 3,
-- and next_round_at when the next one starts, null when none waits.
--
-- unjudged is how many streams the one rule left out: live ones, ones inside
-- their restart window, ones with an export or an archive under way, and test
-- streams.
CREATE TABLE recording_checks (
  id                  UUID PRIMARY KEY,
  state               TEXT NOT NULL CHECK (state IN ('running', 'done', 'stopped')),
  stop_message        TEXT,
  round               SMALLINT NOT NULL DEFAULT 1 CHECK (round BETWEEN 1 AND 3),
  next_round_at       TIMESTAMPTZ,
  unjudged            INTEGER NOT NULL DEFAULT 0 CHECK (unjudged >= 0),
  started_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  started_by          TEXT NOT NULL,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at         TIMESTAMPTZ,
  CONSTRAINT recording_checks_stopped_with_message CHECK ((state = 'stopped') = (stop_message IS NOT NULL)),
  CONSTRAINT recording_checks_running_unfinished CHECK ((state = 'running') = (finished_at IS NULL))
);

CREATE UNIQUE INDEX recording_checks_one_running ON recording_checks ((TRUE)) WHERE state = 'running';

CREATE INDEX recording_checks_latest ON recording_checks (started_at DESC);

-- One recording of a check. title and status are the stream's when the check
-- started, kept so the result reads the same after a stream is removed, which
-- is why stream_id has no reference to streams.
--
-- readings is what was read, round by round, as RecordingReadings names it: a
-- JSON object { master: [true|false, ...], qualities: [{ name, rounds }] }.
-- verdict is null until the check is done, and then 'readable',
-- 'partly_lost' or 'lost'. has_export_file is whether the server kept an
-- export file of the stream when the check ended.
--
-- removed_at is when a removal took a lost recording, and removal says what it
-- did: 'removed' for a deleted stream, 'unlisted' for one kept as a draft off
-- the catalogue, 'kept' for one left as it was, with the reason in kept_reason.
CREATE TABLE recording_check_streams (
  check_id         UUID NOT NULL REFERENCES recording_checks (id) ON DELETE CASCADE,
  stream_id        UUID NOT NULL,
  title            TEXT NOT NULL,
  status           TEXT NOT NULL,
  readings         JSONB NOT NULL DEFAULT '{"master": [], "qualities": []}'::jsonb,
  verdict          TEXT CHECK (verdict IS NULL OR verdict IN ('readable', 'partly_lost', 'lost')),
  has_export_file  BOOLEAN NOT NULL DEFAULT FALSE,
  removal          TEXT CHECK (removal IS NULL OR removal IN ('removed', 'unlisted', 'kept')),
  kept_reason      TEXT,
  removed_at       TIMESTAMPTZ,
  PRIMARY KEY (check_id, stream_id),
  CONSTRAINT recording_check_streams_removal_whole CHECK ((removal IS NULL) = (removed_at IS NULL)),
  CONSTRAINT recording_check_streams_kept_with_reason CHECK ((removal = 'kept') = (kept_reason IS NOT NULL)),
  CONSTRAINT recording_check_streams_removal_of_lost CHECK (removal IS NULL OR verdict IS NOT DISTINCT FROM 'lost')
);

-- What the latest finished check found of a stream's recording, shown on the
-- stream's row: 'lost' or 'partly_lost', and null for one that read, one never
-- checked, and one that went live again since. recording_checked_at is when.
ALTER TABLE streams
  ADD COLUMN recording_verdict     TEXT CHECK (recording_verdict IS NULL OR recording_verdict IN ('lost', 'partly_lost')),
  ADD COLUMN recording_checked_at  TIMESTAMPTZ,
  ADD CONSTRAINT streams_recording_verdict_checked
    CHECK (recording_verdict IS NULL OR recording_checked_at IS NOT NULL);
