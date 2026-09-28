-- Removing a user no longer deletes the streams they drafted.
--
-- Migration 001 declared `streams.user_id` NOT NULL with ON DELETE CASCADE,
-- from when a stream was its drafter's and nobody else could see it. A stream
-- now belongs to the installation: every signed-in operator lists, edits,
-- publishes and deletes every stream, and `user_id` only records who drafted
-- the row. Under the cascade, removing a user on the Access page deleted every
-- stream they had drafted, published and live ones included, and left their
-- entries on the catalogue with no row left to unpublish them.
--
-- So `user_id` becomes nullable and the foreign key sets it to null instead.
-- A stream whose drafter is gone is still the installation's, and still
-- editable by everyone. For a stream created since migration 007, who drafted
-- it is not lost: its `stream.create` row in `audit_log` keeps the username it
-- was created under, and that row's own `actor_user_id` goes null the same
-- way. A stream created before 007 has no such row, because the table started
-- empty and nothing backfills it, so once its drafter is removed nothing in the
-- database says who drafted it.

ALTER TABLE streams ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE streams DROP CONSTRAINT streams_user_id_fkey;

ALTER TABLE streams
  ADD CONSTRAINT streams_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
