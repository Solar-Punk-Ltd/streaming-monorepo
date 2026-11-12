-- An export the job joins by itself pauses when its stream goes live again;
-- one a user chose to save finishes regardless.
--
-- A stream that goes live again pauses its export, because its recording is
-- changing and a user decides: save what was read, wait until the stream
-- finishes, or cancel. Reading looked at the stream, but joining did not, so
-- a stream that went live after the last segment was read, or while ffmpeg
-- ran, still produced a file of the earlier part with nobody asked. Now the
-- join looks too, except after Save what was read, which is the user's
-- answer to exactly that question and must finish while the stream is live.
-- That choice has to outlive a restart in the middle of the join, so it is
-- kept on the row.
--
--   save_chosen  true from the moment a user chooses Save what was read until
--                the export reads again; the join then finishes whatever the
--                stream does. False on a join the job starts itself.

ALTER TABLE stream_exports ADD COLUMN save_chosen BOOLEAN NOT NULL DEFAULT false;
