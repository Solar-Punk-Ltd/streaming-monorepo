-- When the stamp a copy is on runs out, as the manager last read it, so a copy
-- whose stamp the catalogue stamp record no longer lists still reads as expired
-- once that moment has passed.
-- docs/architecture/web2-admin.md, "What a stream shows".
--
-- The record lists each archive stamp with its time to live as of its
-- observedAt, and leaves a stamp out once a manager user removes it or the
-- record is at its maximum, the expired ones first. Without this column the
-- admin forgot a spent stamp's end with the stamp, and the copy read as
-- unlisted, which counts as archived.
--
--   stamp_expires_at  observedAt plus ttlSeconds of the latest record that
--                     listed the copy's stamp, or observedAt when that record
--                     read it expired or gone. Written as each record arrives,
--                     for every copy on each archive stamp it lists, and kept
--                     when the record says nothing of the stamp's time to live.
--                     Null until a record lists the stamp, and again when the
--                     copy is made once more onto another stamp.

ALTER TABLE stream_archives ADD COLUMN stamp_expires_at TIMESTAMPTZ;
