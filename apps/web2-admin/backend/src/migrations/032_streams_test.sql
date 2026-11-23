-- A test stream: a stream of its own for checking the devices, the encoder and
-- the path to a stage before an event, never on the catalogue.
-- docs/architecture/test-streams.md.
--
--   test          true on a row created as a test stream. The insert sets it
--                 and no other statement of the admin writes it.
--   report_order  a test stream's order number: how many of the uploader's
--                 reports the admin has stored for it. The uploader orders the
--                 answers to its quality reports by a number, which for a
--                 listed stream is the catalogue slot the report wrote. A test
--                 stream's report writes no slot, so it takes the next number
--                 here, in the statement that stores the report. It names no
--                 catalogue slot. Zero on every other row.
--
-- The check is the database's own guard that a test stream is never on the
-- catalogue: such a row is a draft, live or recorded, and holds no catalogue
-- index, no publish time and no image. The admin refuses the same before a
-- statement gets here, in the rule that lists the rows on the feed and in the
-- catalogue's writer.
--
-- Every row there is today is no test stream, so the check holds for all of
-- them. Before going back to an older admin, delete the test streams: it reads
-- neither column, and lists a live or recorded test stream on the catalogue.

ALTER TABLE streams ADD COLUMN test BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE streams ADD COLUMN report_order INTEGER NOT NULL DEFAULT 0;

ALTER TABLE streams ADD CONSTRAINT streams_test_off_catalogue CHECK (
  NOT test
  OR (
    status IN ('draft', 'live', 'vod')
    AND published_feed_index IS NULL
    AND published_at IS NULL
    AND thumbnail IS NULL
    AND thumbnail_ref IS NULL
  )
);
