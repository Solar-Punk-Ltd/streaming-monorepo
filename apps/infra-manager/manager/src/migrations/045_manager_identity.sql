-- The manager's own id, generated once, which every stage record it pushes into
-- the web2 admin carries as `managerId`, so two managers linked to one admin
-- cannot take each other's stages for their own. docs/features/stages.md.
--
-- One row, always there, written by this migration and read once at boot. It
-- is not a secret: it names this manager and proves nothing.
--
-- Going back to an older manager needs no step: it never reads the table.
CREATE TABLE manager_identity (
  singleton   BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  manager_id  UUID NOT NULL DEFAULT gen_random_uuid(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO manager_identity DEFAULT VALUES;
