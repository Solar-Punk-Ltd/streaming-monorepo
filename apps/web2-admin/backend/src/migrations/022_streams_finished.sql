-- A finished stream cannot be restarted by mistake.
--
-- The uploader accepts a stream that is already `vod`, so a broadcaster who
-- dropped for longer than the uploader's reconnect window can come back, and
-- so an old encoder profile pressed weeks later goes live again on the old
-- record. From now on a recorded stream can come back for a restart window
-- after it ends, STREAM_RESTART_WINDOW_MINUTES in the admin's env (30 by
-- default, 0 allowed), and then the admin changes its key itself, so the old
-- profile is refused at its next connect. Finish on the stream page changes
-- the key at once.
--
--   finished_at  when the key was changed for good: by Finish, or by a sweep
--                that found the window run out. Null while the stream can
--                still come back on its key, and on a stream that never went
--                live. A `live` report that starts a broadcast, from `vod` or
--                from any other status, clears it and starts a new window at
--                its next end; only the uploader's retried `live → live`
--                leaves it.
--
-- The sweep selects recorded streams with no finished_at whose ended_at is
-- older than the window, or null (a row from before migration 002 counts as
-- ended long ago), and rotates each with a conditional update on
-- finished_at IS NULL, so a second process or a retry rotates nothing twice.
-- The partial index serves that select. On its first run after this
-- migration the sweep finishes every older recording that way, which is what
-- protects the old records.
--
-- Going back to an older admin needs no step: it never reads the column, and
-- the keys it finds are the ones the sweep set.

ALTER TABLE streams ADD COLUMN finished_at TIMESTAMPTZ;

CREATE INDEX streams_restart_window ON streams (ended_at) WHERE status = 'vod' AND finished_at IS NULL;
