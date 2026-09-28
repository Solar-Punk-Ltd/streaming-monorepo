-- The stage a stream is broadcast on (docs/architecture/stages.md).
--
-- Picked in the stream form from the stages the manager pushed (migration 009)
-- that are not retired and run an engine the admin takes streams on, SRS in
-- this round. The OBS panel is built from that stage's ingest details, and a
-- draft with no stage is refused at publish.
--
--   stage_id  null for a stream no stage was picked for yet, and for every
--             stream created before this migration. It changes only while
--             the stream is a draft: publishing fixes it, because the
--             catalogue entry and every viewer link carry the stage's owner.
--             A row that holds a recording (`manifest_index` set) keeps the
--             stage it has, since the recording lives under that stage's
--             owner; one that holds a recording and no stage may be given its
--             first. The service holds these rules, and the conditional
--             UPDATE in StreamRepository holds them again.
--
-- Stage rows are never deleted, since streams and old catalogue entries name
-- their owner, so the foreign key only ever sees a stage retired, and a
-- retired stage keeps the streams it has. ON DELETE SET NULL covers a stage
-- row removed by hand.

ALTER TABLE streams
  ADD COLUMN stage_id UUID NULL REFERENCES stages(stage_id) ON DELETE SET NULL;

-- A stage row removed by hand looks its streams up by it, and so will the
-- uploader's routes once each uploader is answered only about its own
-- stage's streams.
CREATE INDEX streams_stage_id_idx ON streams (stage_id);
