-- The stages the manager runs for the brand, as it last pushed them.
--
-- A stage is a manager deployment that runs a stream uploader, with the node
-- pool behind it (docs/architecture/stages.md). The manager pushes one record
-- per stage, `stageRecordSchema` in packages/contracts, into
-- `PUT /api/internal/stages/:stageId` every 30 seconds while the deployment
-- runs and whenever it changes, and `DELETE`s it when the deployment goes.
-- The admin keeps the latest record of each and never calls the manager back.
--
--   stage_id            the deployment's instance id, in lower case.
--   manager_id          the id of the manager that pushed it, so two managers
--                       linked to one admin cannot be taken for each other.
--   name, kind, engine, owner
--                       copied out of the record so a query can read them
--                       without the JSON. `owner` is the address the stage's
--                       feeds are signed as, never the key.
--   record              the record as it arrived, without the two values
--                       below: no `ingest.srtPassphrase` and no `adminToken`.
--                       The CHECKs keep it that way, so a query that selects
--                       the record cannot carry either by accident.
--   srt_passphrase      the SRT passphrase encoders need, or null when the
--                       stage's SRT is unencrypted. In a column of its own
--                       that no list query selects; the console is told only
--                       whether there is one.
--   admin_token_sha256, admin_token_kind
--                       the sha256 of the token the stage's uploader presents
--                       to the admin, and whether it is the deployment's
--                       `own` or the admin link's `shared` one. Both or
--                       neither. Nothing reads them yet.
--   observed_at         when the manager read what the record says. A record
--                       observed before the stored one never replaces it.
--   received_at         when the admin last stored a record for the stage.
--   retired_at          when the manager deleted the stage, or null. The row
--                       is never deleted: streams and old catalogue entries
--                       name its owner. A later record un-retires it only
--                       when it was observed after the retirement arrived, so
--                       a push that was already on its way when the
--                       deployment was deleted does not bring it back.

CREATE TABLE stages (
  stage_id            UUID PRIMARY KEY,
  manager_id          UUID NOT NULL,
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('abr-uploader', 'streamer')),
  engine              TEXT NOT NULL CHECK (engine IN ('srs', 'ome')),
  owner               TEXT NOT NULL,
  record              JSONB NOT NULL CHECK (
                        jsonb_typeof(record) = 'object'
                        AND NOT (record ? 'adminToken')
                        AND NOT (record -> 'ingest' ? 'srtPassphrase')
                      ),
  srt_passphrase      TEXT NULL,
  admin_token_sha256  TEXT NULL,
  admin_token_kind    TEXT NULL CHECK (admin_token_kind IN ('own', 'shared')),
  observed_at         TIMESTAMPTZ NOT NULL,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at          TIMESTAMPTZ NULL,
  CHECK ((admin_token_sha256 IS NULL) = (admin_token_kind IS NULL))
);

-- The manager is a caller of its own in the audit log: it registers, changes
-- and retires stages, and sets the catalogue stamp. Written with no name,
-- like the uploader, since the registrar token names nobody.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_kind_check;
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_actor_kind_check
  CHECK (actor_kind IN ('operator', 'uploader', 'system', 'manager'));
