-- The purchases of the funding API buy for three purposes, where 055 bought
-- archive stamps alone: a batch for a rung, a batch for the catalogue, and an
-- archive stamp. One table and one route hold all three, and the purpose
-- decides where the manager puts the batch once it is bought. README.md,
-- "Funding API", and docs/features/postage-stamps.md, "Bought from the admin".
--
-- purpose is 'rung', 'catalogue' or 'archive'. A row of 055 is an archive
-- stamp's, which the default says.
--
-- immutable is the kind the purchase asked for. A catalogue batch and an
-- archive stamp are immutable; a rung's is either.
--
-- replaces_batch_id is the batch that held the role when the purchase was
-- asked for, 0x and 64 hex digits in lower case: the batch set on the rung or
-- on the stage, or the designated catalogue batch. It is null when the node
-- had none set, and for an archive stamp, which replaces none. With the
-- purpose and the node it lets whatever is kept about a batch's role, a mark
-- for instance, pass from the batch replaced to the one bought.
--
-- node_label is the label the batch carries on its node: the purpose, a hyphen
-- and the first twelve hex digits of the request id.
--
-- step is where the purchase and its follow-up stand, as the contract's
-- FUNDING_PURCHASE_STEPS name it: 'buying' until the purchase is confirmed,
-- 'waiting_usable' until the node calls the batch usable, 'set' once the batch
-- is where its purpose puts it, 'done' when nothing is left to do, and
-- 'failed' when nothing was bought, the batch was not usable an hour after it
-- was bought, or it could not be set, with the reason in error. The manager
-- follows a purchase up in the background and writes each step here, so one
-- that restarts goes on from the step the row holds.
--
-- bought_at is when the purchase became confirmed, which the hour of waiting
-- for a usable batch is counted from. set_at is when the batch was set on its
-- rung or stage, or designated for the catalogue.
--
-- previous_batch_id is, for a catalogue purchase, the batch the catalogue was
-- designated with before, which the designation keeps as the batch it moves
-- from; null when there was none. released_at is when the manager released
-- that batch on the admin's word that its move was done.
--
-- recorded_at keeps its meaning for an archive stamp and stays null for the
-- other two purposes.
--
-- The rows 055 wrote take the step their state says: a failed one 'failed', a
-- confirmed one that was recorded 'done', a confirmed one not recorded yet
-- 'waiting_usable', and the rest 'buying'.
--
-- Going back to the manager of 055 needs no step: it writes rows that take the
-- defaults here, and reads none of the new columns.
ALTER TABLE funding_stamp_purchases
  ADD COLUMN purpose            TEXT NOT NULL DEFAULT 'archive'
    CHECK (purpose IN ('rung', 'catalogue', 'archive')),
  ADD COLUMN immutable          BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN replaces_batch_id  TEXT CHECK (replaces_batch_id ~ '^0x[0-9a-f]{64}$'),
  ADD COLUMN step               TEXT NOT NULL DEFAULT 'buying'
    CHECK (step IN ('buying', 'waiting_usable', 'set', 'done', 'failed')),
  ADD COLUMN bought_at          TIMESTAMPTZ,
  ADD COLUMN set_at             TIMESTAMPTZ,
  ADD COLUMN previous_batch_id  TEXT CHECK (previous_batch_id ~ '^0x[0-9a-f]{64}$'),
  ADD COLUMN released_at        TIMESTAMPTZ;

UPDATE funding_stamp_purchases
   SET step = CASE
                WHEN state = 'failed' THEN 'failed'
                WHEN state = 'confirmed' AND recorded_at IS NOT NULL THEN 'done'
                WHEN state = 'confirmed' THEN 'waiting_usable'
                ELSE 'buying'
              END,
       bought_at = CASE WHEN state = 'confirmed' THEN updated_at END;

ALTER TABLE funding_stamp_purchases
  DROP CONSTRAINT funding_stamp_purchases_node_label_check,
  ADD CONSTRAINT funding_stamp_purchases_node_label_check
    CHECK (node_label ~ '^(rung|catalogue|archive)-[0-9a-f]{12}$'),
  ADD CONSTRAINT funding_stamp_purchases_immutable_but_a_rung
    CHECK (purpose = 'rung' OR immutable),
  ADD CONSTRAINT funding_stamp_purchases_archive_replaces_none
    CHECK (purpose <> 'archive' OR replaces_batch_id IS NULL),
  ADD CONSTRAINT funding_stamp_purchases_catalogue_alone_moves
    CHECK (purpose = 'catalogue' OR (previous_batch_id IS NULL AND released_at IS NULL)),
  ADD CONSTRAINT funding_stamp_purchases_archive_alone_recorded
    CHECK (purpose = 'archive' OR recorded_at IS NULL),
  ADD CONSTRAINT funding_stamp_purchases_set_with_batch
    CHECK (step NOT IN ('waiting_usable', 'set', 'done') OR batch_id IS NOT NULL);

-- At most one purchase is under way on a node at a time: a second one is
-- answered 409 conflict while the first is being bought or its batch is not
-- usable yet, since both would spend the same wallet and, for a rung or the
-- catalogue, buy for the same role.
DROP INDEX funding_stamp_purchases_one_open_per_node;
CREATE UNIQUE INDEX funding_stamp_purchases_one_open_per_node
  ON funding_stamp_purchases (node_id)
  WHERE state IN ('unknown', 'submitted') OR step = 'waiting_usable';

-- The stages whose uploader follows the rung a purchase bought for, written
-- when the batch is set, and where the restart of each stands, as the
-- contract's FUNDING_PURCHASE_APPLY_STATES name it. The manager takes them in
-- the order of position, one at a time, and looks at a waiting one again every
-- 30 seconds.
--
-- stage_id is the deployment's instance_id, and stage_name its name when the
-- batch was set. message is a sentence about the state where there is one:
-- why an Apply failed, which settings wait. forced_at is when the admin asked
-- for the restart of a stage that waited for a broadcast, and null otherwise.
--
-- A stage deleted meanwhile keeps its row, with the state it had.
CREATE TABLE funding_purchase_stages (
  request_id  UUID NOT NULL REFERENCES funding_stamp_purchases (request_id) ON DELETE CASCADE,
  stage_id    UUID NOT NULL,
  stage_name  TEXT NOT NULL CHECK (stage_name <> ''),
  position    SMALLINT NOT NULL CHECK (position >= 0),
  apply       TEXT NOT NULL CHECK (apply IN (
                'pending', 'waiting_live', 'waiting_unknown', 'waiting_settings', 'applying',
                'applied', 'failed', 'not_following', 'stopped')),
  message     TEXT,
  forced_at   TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (request_id, stage_id),
  UNIQUE (request_id, position)
);
