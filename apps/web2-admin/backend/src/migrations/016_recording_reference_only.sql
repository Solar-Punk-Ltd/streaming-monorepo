-- A recording is named by its reference alone.
--
-- Uploaders on feeds reported a recording as the feed index of its final
-- manifest, which migration 002 stored in streams.manifest_index and
-- migration 004 in stream_renditions.manifest_index. Since migration 015 a
-- recording could also be a reference, `recording_ref`, never both. The
-- admin now takes and writes the reference only: a report with an index is
-- refused, and nothing reads or writes `manifest_index` any more.
--
-- The columns and what they hold stay. Dropping a column that holds data is
-- a permanent delete, and that is the owner's call. A row that still holds an
-- index from before is simply a row with no recording as far as the admin is
-- concerned.
--
-- Three checks of migration 015 named `manifest_index`, and each would now
-- refuse a write the admin makes:
--
--   streams_one_recording and stream_renditions_one_recording refused a
--   reference beside an index. A stream or rung that kept an old index would
--   refuse its first reference, so both go.
--
--   stream_renditions_finished_together tied the duration to either kind of
--   recording. The admin stops clearing `manifest_index` when a rung goes
--   live again, so a rung with an old index and no duration would break it.
--   It is replaced by the same rule over the reference alone. NOT VALID,
--   because rungs finished with an index before this migration hold a
--   duration and no reference: they are left as they are, and every write
--   from now on is checked.

ALTER TABLE streams
  DROP CONSTRAINT streams_one_recording;

ALTER TABLE stream_renditions
  DROP CONSTRAINT stream_renditions_one_recording,
  DROP CONSTRAINT stream_renditions_finished_together,
  ADD CONSTRAINT stream_renditions_finished_together
    CHECK ((recording_ref IS NULL) = (duration_seconds IS NULL)) NOT VALID;
