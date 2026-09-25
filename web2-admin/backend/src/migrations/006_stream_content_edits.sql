-- The console's "Edited since it was published" notice, measured against the
-- catalogue entry instead of against `updated_at`.
--
-- The console used to compare `updated_at` with `published_at`, and neither
-- is the right clock. `updated_at` moves on nearly every write: the uploader's
-- live and vod reports, a key rotation, thumbnail bookkeeping, a publish
-- error. `published_at` is not moved by a republish of a live or recorded
-- stream. So on the deployed admin (2026-09-24) a stream nobody edited showed
-- the notice once it had been broadcast, and a real edit kept showing it after
-- the republish that put the edit on the feed.
--
--   content_edited_at        when the console last changed something the
--                            catalogue entry carries: title, description,
--                            tags, media type, scheduled start or thumbnail.
--                            A save that changes nothing leaves it alone.
--                            Stamped to the millisecond, because the service
--                            reads it into a JavaScript Date and writes it
--                            back into the column below.
--   entry_content_edited_at  the content_edited_at of the row this stream's
--                            entry was last rebuilt from. Written by every
--                            write that rebuilds the entry from the row: a
--                            publish, a republish, a state or rendition report,
--                            and a reconcile that rewrote or added the entry.
--                            A write for another stream copies this stream's
--                            entry as it was, and writes nothing here.
--
-- The notice shows while the two differ on a stream that is on the catalogue.
-- The second column records which edit the entry carries rather than when the
-- write finished, because a live or recorded stream stays editable while its
-- entry is being written, and an edit saved during that write is not on it.
--
-- Both start null on every existing row, and the service reads two nulls as
-- the same edit, so no stream starts showing the notice because of this
-- migration.

ALTER TABLE streams
  ADD COLUMN content_edited_at        TIMESTAMPTZ,
  ADD COLUMN entry_content_edited_at  TIMESTAMPTZ;
