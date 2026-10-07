-- A recording named by reference.
--
-- An uploader on time windows writes no recording feed. It uploads each
-- recording playlist once as bytes at the end and reports the reference, as
-- `recording` on the state report and on each rung's rendition report, where
-- an uploader on feeds reports the final manifest's feed `index`. Both kinds
-- of report are taken until the last uploader on feeds is gone, so a
-- recording is now one of two things:
--
--   manifest_index    the feed index of the final manifest, as before, or
--   recording_ref     the Swarm reference of the recording playlist, 64
--                     lowercase hex digits as the contract checks it.
--
-- Never both. On the stream that is the only new rule, as the stream never
-- had one tying the index to the duration either. On a rung the old "index
-- and duration together" check becomes "a recording and its duration
-- together", either kind of recording.
--
-- Everything that asked whether a row holds a recording by `manifest_index
-- IS NOT NULL` now asks it of either column. A `live` report clears both, on
-- the row and on every rung, as it cleared the index.

ALTER TABLE streams
  ADD COLUMN recording_ref TEXT NULL,
  ADD CONSTRAINT streams_recording_ref_format
    CHECK (recording_ref IS NULL OR recording_ref ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT streams_one_recording
    CHECK (manifest_index IS NULL OR recording_ref IS NULL);

ALTER TABLE stream_renditions
  ADD COLUMN recording_ref TEXT NULL,
  ADD CONSTRAINT stream_renditions_recording_ref_format
    CHECK (recording_ref IS NULL OR recording_ref ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT stream_renditions_one_recording
    CHECK (manifest_index IS NULL OR recording_ref IS NULL),
  DROP CONSTRAINT stream_renditions_finished_together,
  ADD CONSTRAINT stream_renditions_finished_together
    CHECK ((manifest_index IS NULL AND recording_ref IS NULL) = (duration_seconds IS NULL));
