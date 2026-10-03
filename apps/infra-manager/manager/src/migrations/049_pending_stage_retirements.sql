-- A removed deployment's stage whose retirement the web2 admin has not
-- answered yet. docs/features/stages.md, "When a deployment goes".
--
-- The removal that deletes a stage's profile row writes its row here in the
-- same transaction, so a manager that stops between the two cannot lose it.
-- The stage publisher sends the retirement, and sends it again every 30
-- seconds and when the manager starts, until the admin answers that it retired
-- the stage or held none, and then deletes the row.
--
-- stage_id is the deployment's instance id, the stage's id in every record.
-- profile_name is the deployment's name, for the log alone: a deployment of the
-- same name made later is another stage.
--
-- deleted_at and origin are the publisher's decision, NULL until it takes it.
-- deleted_at is the moment the manager saw the row gone, which the retirement
-- carries as its observedAt, so a record read before it cannot bring the stage
-- back. origin is the origin of the admin link the stage's records went to, or
-- NULL to send it to the link's current origin, as for a stage never pushed
-- since the manager started. A row the removal wrote and the publisher never
-- decided, because the manager stopped between them, is decided when it is
-- found, as of that moment. A row whose origin is no longer the link's is
-- dropped and logged.
--
-- Going back to an older manager needs no step: it never reads the table, and
-- what is pending here stays unsent.
CREATE TABLE pending_stage_retirements (
  stage_id      UUID PRIMARY KEY,
  profile_name  TEXT NOT NULL CHECK (profile_name <> ''),
  deleted_at    TIMESTAMPTZ,
  origin        TEXT CHECK (origin IS NULL OR origin <> ''),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (origin IS NULL OR deleted_at IS NOT NULL)
);
