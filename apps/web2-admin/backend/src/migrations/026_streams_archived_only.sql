-- "List only archived qualities": a stream's catalogue entry names only the
-- qualities that play from an archive stamp.
-- docs/architecture/web2-admin.md, "Archiving a recording".
--
-- A user may archive some qualities of a recording and leave the others. The
-- catalogue entry lists every recorded quality, and once the stage's batches
-- expire the players would offer qualities that are gone. With the switch on,
-- the entry is built with the archived qualities alone: a quality without an
-- index is not offered, which the players already honour.
--
--   archived_only  false unless a user turned the switch on. It is offered
--                  once one quality of the stream is archived, and changing it
--                  rebuilds the stream's catalogue entry.

ALTER TABLE streams ADD COLUMN archived_only BOOLEAN NOT NULL DEFAULT false;
