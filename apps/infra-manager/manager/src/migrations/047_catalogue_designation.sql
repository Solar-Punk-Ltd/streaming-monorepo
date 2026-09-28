-- The brand's catalogue node: the Bee-only deployment the web2 admin writes the
-- brand's catalogue through, and the batch pinned for it, set on the Manager
-- settings page. The manager pushes the catalogue stamp record the admin writes
-- with from this row. docs/features/stages.md.
--
-- One row, always there, so a save names the revision it read and two
-- operators editing at once cannot overwrite each other unseen, as the admin
-- link's row does. A row with no deployment was never designated, and one whose
-- cleared_at is set is designated no longer.
--
-- profile_name names the deployment and batch_id the batch on its node, 64 hex
-- digits in lower case with no 0x, as Bee prints one and the record carries
-- it. They are set together on the first designation and stay after a clear:
-- the catalogue's slots are stamped by that batch, so a designation of another
-- batch is refused until moving the catalogue exists, and the same batch can be
-- designated again. The batch is pinned by id: buying or using another batch
-- on that node changes the deployment's stamp_id and never this row.
-- batch_depth is the depth the node reported at designation, which a record
-- carries while the node does not answer.
--
-- designated_at and cleared_at are the manager's own moments, the one the last
-- designation was made and the one it was taken out, which a clear carries to
-- the admin as its observedAt. A designation sets cleared_at back to NULL.
-- designated_by is who made the last change, a clear included.
--
-- No foreign key: the manager refuses to remove the deployment this row names,
-- cleared or not, and a row that names a gone one is shown as such.
--
-- Going back to an older manager needs no step: it never reads the table.
CREATE TABLE catalogue_designation (
  singleton      BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  profile_name   TEXT CHECK (profile_name IS NULL OR profile_name <> ''),
  batch_id       TEXT CHECK (batch_id IS NULL OR batch_id ~ '^[0-9a-f]{64}$'),
  batch_depth    INTEGER CHECK (batch_depth IS NULL OR batch_depth BETWEEN 17 AND 64),
  designated_at  TIMESTAMPTZ,
  designated_by  TEXT,
  cleared_at     TIMESTAMPTZ,
  revision       INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((profile_name IS NULL) = (batch_id IS NULL)),
  CHECK ((profile_name IS NULL) = (designated_at IS NULL)),
  CHECK (profile_name IS NULL OR batch_depth IS NOT NULL),
  CHECK (cleared_at IS NULL OR profile_name IS NOT NULL)
);

INSERT INTO catalogue_designation DEFAULT VALUES;
