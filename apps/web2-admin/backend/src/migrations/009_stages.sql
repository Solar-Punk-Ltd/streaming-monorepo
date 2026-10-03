-- The stages the manager runs for the brand, as it last pushed them.
--
-- A stage is a manager deployment that runs a stream uploader, with the node
-- pool behind it (docs/architecture/stages.md). The manager pushes one record
-- per stage, `stageRecordSchema` in packages/contracts, into
-- `PUT /api/internal/stages/:stageId` every 30 seconds while the deployment
-- runs and whenever it changes, and `DELETE`s it when the deployment goes.
-- The admin keeps the latest record of each and never calls the manager back.
--
-- Every moment the admin orders these by is the manager's: a record's
-- `observedAt`, stamped when the manager read the deployment row, and a
-- retirement's `observedAt`, the moment the manager saw the deployment gone.
-- The admin's own clock only says when something arrived.
--
--   stage_id            the deployment's instance id, in lower case.
--   manager_id          the id of the manager that last pushed it. The last
--                       manager to push wins, so a manager reinstalled with a
--                       new id takes its stages back; the change is audited.
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
--                       `own`, which the manager generated, or `shared`, any
--                       other. Both or neither. An uploader's call is
--                       attributed by them (migration 012).
--   observed_at         when the manager read what the record says. A record
--                       observed before the stored one never replaces it.
--   received_at         when the admin last stored a record for the stage.
--   retired_observed_at when the manager saw the deployment gone, or null
--                       while the stage is active. The row is never deleted:
--                       streams and old catalogue entries name its owner. A
--                       later record brings the stage back only when it was
--                       observed after this moment, so a push that was
--                       already on its way when the deployment was deleted
--                       does not undo the delete. A retirement that names a
--                       moment before the stored record's is not taken: the
--                       manager has seen the deployment since.
--   retired_at          when the retirement arrived. Both or neither.

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
  retired_observed_at TIMESTAMPTZ NULL,
  retired_at          TIMESTAMPTZ NULL,
  CHECK ((admin_token_sha256 IS NULL) = (admin_token_kind IS NULL)),
  CHECK ((retired_observed_at IS NULL) = (retired_at IS NULL))
);

-- A retirement of a stage the admin never stored: the manager deleted a
-- deployment whose first push had not arrived yet, or was refused. Without
-- it, that first push arriving late would register a stage that is gone. A
-- record for the id is stored only when it was observed after `observed_at`,
-- and storing it removes the row. A second retirement keeps the later moment.
--
--   stage_id     the deployment's instance id, in lower case.
--   observed_at  when the manager saw the deployment gone.
--   received_at  when the retirement last arrived.

CREATE TABLE stage_retirements (
  stage_id     UUID PRIMARY KEY,
  observed_at  TIMESTAMPTZ NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The manager is a caller of its own in the audit log: it registers, changes
-- and retires stages, and sets the catalogue stamp. Written with no name,
-- like the uploader, since the registrar token names nobody.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_kind_check;
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_actor_kind_check
  CHECK (actor_kind IN ('operator', 'uploader', 'system', 'manager'));
