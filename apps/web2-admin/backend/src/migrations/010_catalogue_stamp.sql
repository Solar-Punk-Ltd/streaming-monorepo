-- The brand's catalogue stamp, as the manager last pushed it.
--
-- The catalogue gets a batch of its own, immutable and deep, on a dedicated
-- catalogue node the manager runs (docs/architecture/stages.md). The manager
-- pushes one record for it, `catalogueStampRecordSchema` in
-- packages/contracts, into `PUT /api/internal/catalogue-stamp`, and clears it
-- with `DELETE`. Nothing writes the catalogue through it yet: until a later
-- phase of the stages work does, the admin keeps writing with `BEE_URL` and
-- `POSTAGE_BATCH_ID`.
--
-- One brand, one catalogue, one row: `id` can only be true. The moments it is
-- ordered by are the manager's, as in migration 009.
--
--   manager_id, batch_id, record
--                the record as it arrived, the Bee API address included,
--                since that is where the catalogue will be written, with the
--                manager's id and the pinned batch copied out of it. The
--                console is never shown the address. All three are null only
--                on a row that a clear made when no record had arrived yet.
--   observed_at  when the manager read what the record says, or, on a row a
--                clear made, the moment of that clear. A record observed
--                before it never replaces the row.
--   received_at  when the admin last stored a record or a clear.
--   cleared_observed_at
--                when the manager saw the designation gone, or null while
--                one is designated. The row stays, so the last designation is
--                still on record, and a later record sets it again only when
--                it was observed after this moment, as a retired stage comes
--                back. A clear that names a moment before the stored record's
--                is not taken, and a second clear keeps the later moment.
--   cleared_at   when the clear arrived. Both or neither.

CREATE TABLE catalogue_stamp (
  id                   BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  manager_id           UUID NULL,
  batch_id             TEXT NULL,
  record               JSONB NULL CHECK (record IS NULL OR jsonb_typeof(record) = 'object'),
  observed_at          TIMESTAMPTZ NOT NULL,
  received_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleared_observed_at  TIMESTAMPTZ NULL,
  cleared_at           TIMESTAMPTZ NULL,
  CHECK ((cleared_observed_at IS NULL) = (cleared_at IS NULL)),
  CHECK ((record IS NULL) = (manager_id IS NULL) AND (record IS NULL) = (batch_id IS NULL)),
  CHECK (record IS NOT NULL OR cleared_observed_at IS NOT NULL)
);
