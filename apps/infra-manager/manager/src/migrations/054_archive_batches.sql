-- The brand's archive batches: immutable batches on the catalogue node that
-- the web2 admin copies finished recordings onto, so a recording outlives the
-- mutable batches of the stage that made it. docs/features/stages.md,
-- "Archive batches".
--
-- A row is one archive batch. The admin buys one through the funding API
-- (funding_stamp_purchases, migration 055), and the manager writes the row
-- once the node answers with the batch. A batch bought another way is adopted
-- on the Manager settings page, which writes the row with source 'adopted'.
-- Every row is pushed to the admin inside the catalogue stamp record.
--
-- batch_id is the batch, 64 hex digits in lower case with no 0x, as
-- catalogue_designation.batch_id. profile_name is the deployment whose Bee
-- node holds it, which is the catalogue node at the time: a batch stays with
-- the node that bought it, so a batch whose deployment is the catalogue node no
-- longer is still listed and topped up, and nothing is copied onto it.
--
-- batch_depth is the batch's depth as its node last reported it: the depth a
-- purchase bought, or the one the node reported at an adopt, and then each
-- reading's, so a dilution reaches it. The catalogue stamp record carries it
-- when the node does not answer, so every archive batch is in the record
-- whether its node answers or not.
--
-- label is the name its buyer or adopter gave it, 1 to 64 characters, or null.
-- source is 'purchase' or 'adopted'. purchase_request_id is the funding API
-- request that bought it, set for a purchase and only then, and unique, so one
-- purchase makes one row however often it is settled.
--
-- designated_at is the manager's moment. designated_by is the user who adopted
-- it, and null for a purchase, which the admin's own audit log names.
--
-- A removal deletes the row, and only an expired batch is removed: the admin
-- shows the recordings of a batch that left the list as expired. An adopt
-- brings a removed batch back.
--
-- The rows stay while no catalogue node is designated, when the record that
-- carries them is cleared, and are pushed again with the next designation.
-- They stay too when the deployment of a batch is deleted: the batch is then
-- listed with its state unknown, and nothing is copied onto it.
--
-- archive_batches_revision is the one row an adopt and a removal check and
-- raise, as catalogue_designation.revision is for the designation, so two
-- operators at once cannot both act on a list one of them has not seen.
--
-- Going back to an older manager needs no step: it never reads these tables,
-- and its catalogue stamp record carries no archive batches.
CREATE TABLE archive_batches (
  batch_id             TEXT PRIMARY KEY CHECK (batch_id ~ '^[0-9a-f]{64}$'),
  profile_name         TEXT NOT NULL CHECK (profile_name <> ''),
  batch_depth          INTEGER NOT NULL CHECK (batch_depth BETWEEN 17 AND 64),
  label                TEXT CHECK (label IS NULL OR (label <> '' AND char_length(label) <= 64)),
  source               TEXT NOT NULL CHECK (source IN ('purchase', 'adopted')),
  purchase_request_id  UUID UNIQUE,
  designated_at        TIMESTAMPTZ NOT NULL,
  designated_by        TEXT,
  CHECK ((source = 'purchase') = (purchase_request_id IS NOT NULL))
);

CREATE INDEX archive_batches_designated_at ON archive_batches (designated_at, batch_id);

CREATE TABLE archive_batches_revision (
  singleton   BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  revision    INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO archive_batches_revision DEFAULT VALUES;
