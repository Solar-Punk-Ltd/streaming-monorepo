-- A quality on more than one archive stamp, and the stream's image under the
-- archive stamp. docs/architecture/web2-admin.md, "Archiving a recording".
--
-- stream_archives holds one row per copy: a stream, a quality and the archive
-- stamp the copy is on. A quality has a row for each stamp it was archived
-- onto, and each stands by itself: partial or complete, what it holds, and
-- its stamp's end. A copy made again onto the same stamp, after the stream
-- recorded again or after a copy that stopped, replaces that stamp's row, and
-- the rows of the other stamps stay as they are. Every row written before
-- this migration is the one copy its quality has.
--
-- stream_archive_thumbnails holds the image of a stream as it was stamped
-- under one archive stamp: every archive job uploads the image the catalogue
-- entry names again, under its own stamp, and records it here once the upload
-- came out at the same reference.
--
--   batch_id        the archive stamp, 64 hex digits in lower case with no
--                   0x, as stream_archives names one.
--   thumbnail_ref   the image's reference, as streams.thumbnail_ref holds it.
--                   One row per stream and stamp: an image stamped later under
--                   the same stamp takes the row.
--   stamped_at, stamped_by_user_id, stamped_by
--                   when it was stamped, and who started the job that did it,
--                   as the audit log names an actor.
--
-- Deleting the stream deletes its rows. The image's chunks stay on Swarm for
-- as long as their stamp lasts.

ALTER TABLE stream_archives DROP CONSTRAINT stream_archives_pkey;
ALTER TABLE stream_archives ADD PRIMARY KEY (stream_id, rendition, batch_id);

CREATE TABLE stream_archive_thumbnails (
  stream_id           UUID NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  batch_id            TEXT NOT NULL CHECK (batch_id ~ '^[0-9a-f]{64}$'),
  thumbnail_ref       TEXT NOT NULL CHECK (thumbnail_ref <> ''),
  stamped_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stamped_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  stamped_by          TEXT NOT NULL,
  PRIMARY KEY (stream_id, batch_id)
);
