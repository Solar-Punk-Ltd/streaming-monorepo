-- The viewer a test stream is watched on, and a test stream's empty
-- description. docs/architecture/test-streams.md.
--
--   viewer_url  the address of a deployed viewer, as someone gave it on the
--               test stream's page: any http or https one. The console builds
--               the link to the stream's watch page from it. Null until given.
--
-- The check on it holds the column to a test stream, to an address that starts
-- with http:// or https://, and to the length the admin takes.
--
-- A test stream is created from a title, a media type and a stage, and its
-- description is empty. The description's check, from migration 001, asked
-- every row for one to 500 characters. It now asks that of a stream that is no
-- test stream, and lets a test stream's be empty.
--
-- Every row there is today holds a null viewer_url and a description the
-- check already held, so both checks hold for all of them. An older admin
-- reads no viewer_url.

ALTER TABLE streams ADD COLUMN viewer_url TEXT NULL;

ALTER TABLE streams ADD CONSTRAINT streams_viewer_url_of_test CHECK (
  viewer_url IS NULL
  OR (
    test
    AND viewer_url ~* '^https?://[^[:space:]]'
    AND length(viewer_url) <= 2000
  )
);

ALTER TABLE streams DROP CONSTRAINT streams_description_length;

ALTER TABLE streams ADD CONSTRAINT streams_description_length CHECK (
  length(description) <= 500
  AND (test OR length(description) >= 1)
);
