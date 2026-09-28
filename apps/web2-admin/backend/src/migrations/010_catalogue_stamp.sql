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
-- One brand, one catalogue, one row: `id` can only be true.
--
--   manager_id   the id of the manager that pushed it.
--   batch_id     the pinned batch, copied out of the record.
--   record       the record as it arrived, the Bee API address included,
--                since that is where the catalogue will be written. The
--                console is never shown the address.
--   observed_at  when the manager read what the record says. A record
--                observed before the stored one never replaces it.
--   received_at  when the admin last stored a record.
--   cleared_at   when the manager cleared the designation, or null. The row
--                stays, so the last designation is still on record, and a
--                later record sets it again only when it was observed after
--                the clear arrived, as `stages.retired_at` does.

CREATE TABLE catalogue_stamp (
  id           BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  manager_id   UUID NOT NULL,
  batch_id     TEXT NOT NULL,
  record       JSONB NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  observed_at  TIMESTAMPTZ NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleared_at   TIMESTAMPTZ NULL
);
