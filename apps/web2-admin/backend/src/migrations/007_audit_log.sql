-- Who did what, one row per mutation.
--
-- A stream belongs to the installation: every signed-in operator can edit,
-- publish, unpublish and delete every stream, and `streams.user_id` only says
-- who drafted it. Nothing on the row says who touched it after that, so this
-- table does. Written by the service after each mutation it describes, by
-- operators through the console, by the uploader through the internal API,
-- and by the process itself (the boot repair, the `user:add` CLI).
--
--   actor_kind     operator, uploader or system.
--   actor_user_id  the operator's user id; null for the other two, and set
--                  to null when that user is removed, because the row has to
--                  outlive the account it names.
--   actor_name     the username at the time, which survives the removal, or
--                  the system reason ('boot', 'cli'). Null for the uploader.
--   action         dotted: stream.create, stream.publish, user.add, ...
--   stream_id      no foreign key, deliberately. Deleting a stream is one of
--                  the things recorded here, and its history must not be
--                  deleted along with it.
--   topic          the stream id viewers use, kept for the same reason: it is
--                  how a deleted stream is still recognised.
--   status_before / status_after
--                  the stream's status before and after the action. Every
--                  stream action fills both, with the same status on both
--                  sides when nothing moved (an edit, a thumbnail, a key
--                  rotation, a republish, a rendition report), except that
--                  stream.create has no before and stream.delete no after.
--                  feed.reconcile and the user.* rows leave both null.
--   details        what else the action has to say: changed fields, feed
--                  index, rung, error message, target username. Never a
--                  secret — no publish key, password hash or session token.
--
-- A failed write here never fails the operation it records: the mutation has
-- already happened by then. The service logs the failure instead.

CREATE TABLE audit_log (
  id             BIGSERIAL PRIMARY KEY,
  at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_kind     TEXT NOT NULL CHECK (actor_kind IN ('operator', 'uploader', 'system')),
  actor_user_id  UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  actor_name     TEXT NULL,
  action         TEXT NOT NULL,
  stream_id      UUID NULL,
  topic          TEXT NULL,
  status_before  TEXT NULL,
  status_after   TEXT NULL,
  details        JSONB NULL CHECK (details IS NULL OR jsonb_typeof(details) = 'object')
);

CREATE INDEX audit_log_stream_at_idx ON audit_log (stream_id, at DESC);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
-- Removing a user sets their rows' actor_user_id to null, and without this
-- index that is a scan of the whole table.
CREATE INDEX audit_log_actor_user_idx ON audit_log (actor_user_id);
