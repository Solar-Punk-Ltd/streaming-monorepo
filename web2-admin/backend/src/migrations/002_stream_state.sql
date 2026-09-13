-- web2-admin, checkpoint 3 step 1: what the uploader reports back.
--
-- Until now the feed was written one way: this backend announced a draft as
-- `state: 'scheduled'` and nothing ever contradicted it. The uploader now
-- calls POST /api/internal/streams/:id/state when the encoder's first segment
-- lands (`live`) and when the broadcast stops (`vod`), and each report is
-- rewritten onto the catalogue entry by the same single writer.
--
-- The four columns are that report, kept on the row so the console can show it
-- and so a catalogue entry can be rebuilt from the database alone:
--
--   live_since        when the uploader first said `live`. Set once per live
--                     run; a repeated `live` report (the uploader retries) does
--                     not move it.
--   ended_at          when it said `vod`. Cleared again by a `live` report, so
--                     a stream that goes live again is not shown as ended.
--   manifest_index    feed index of the final manifest under the stream's own
--                     topic — what a viewer needs to play the recording. BIGINT
--                     for the same reason published_feed_index is.
--   duration_seconds  length of the recording. DOUBLE PRECISION because the
--                     uploader measures it in fractional seconds.
--
-- All four are nullable and stay null for a draft: nothing here is known until
-- an encoder actually connects. Unpublishing clears them, because that returns
-- the row to `draft` and hands it a fresh life.

ALTER TABLE streams
  ADD COLUMN manifest_index    BIGINT,
  ADD COLUMN duration_seconds  DOUBLE PRECISION,
  ADD COLUMN live_since        TIMESTAMPTZ,
  ADD COLUMN ended_at          TIMESTAMPTZ;

ALTER TABLE streams
  ADD CONSTRAINT streams_manifest_index_non_negative
    CHECK (manifest_index IS NULL OR manifest_index >= 0),
  ADD CONSTRAINT streams_duration_non_negative
    CHECK (duration_seconds IS NULL OR duration_seconds >= 0);
