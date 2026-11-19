-- The batches bought from the Stamps tab in place of a rung's batch or of the
-- catalogue batch that no longer pays. docs/architecture/funding.md, "Buying a
-- new batch". An archive stamp's purchase keeps its own table, 027.
--
-- A row is written before the manager is asked, and its id is the request id
-- the manager's funding API knows the purchase by, so a purchase is never
-- asked for twice and the manager's answer is found again after a restart.
--
-- purpose is 'rung', for a rung's node or a single-node stage's own, or
-- 'catalogue'. node_id is the manager's id of the node that buys and pays, and
-- node_label its name for a person when the purchase was started.
--
-- depth, immutable and days are what the user chose. amount_per_chunk_plur is
-- the PLUR each chunk is given for those days at the price read then, and
-- cost_plur that amount for every chunk of the batch, which is what the user
-- confirmed.
--
-- replaces_batch_id is the batch the row of the Funding page showed, 64 hex
-- digits in lower case, as the admin keeps a batch id; null for a node that
-- had none set. batch_id is the batch bought, in the same form, and null
-- until the manager answered with it.
--
-- state follows BatchPurchaseState in the admin's common package: 'buying',
-- 'waiting_usable', 'restarting' for a rung whose stages' uploaders are being
-- restarted, 'moving' for a catalogue batch the catalogue is being moved onto,
-- 'done' and 'failed'. error says why a failed one stopped.
--
-- stages is the manager's last answer about the stages of a rung purchase, a
-- JSON list of { stageId, name, apply, message }, kept so the page has it
-- while the manager is not reached. It is '[]' before the batch is set and for
-- the catalogue.
--
-- released_at is when the manager released the batch the catalogue moved
-- from, on the admin's call after its move was done.
--
-- relayed_at is when the purchase reached the manager, and null for one that
-- was written and not sent yet, which is sent again under the same id.
CREATE TABLE batch_purchases (
  id                     UUID PRIMARY KEY,
  purpose                TEXT NOT NULL CHECK (purpose IN ('rung', 'catalogue')),
  node_id                TEXT NOT NULL CHECK (node_id ~ '^[A-Za-z0-9:._-]{1,200}$'),
  node_label             TEXT NOT NULL CHECK (node_label <> ''),
  depth                  SMALLINT NOT NULL CHECK (depth BETWEEN 17 AND 40),
  immutable              BOOLEAN NOT NULL,
  days                   INTEGER NOT NULL CHECK (days >= 2),
  amount_per_chunk_plur  NUMERIC(78, 0) NOT NULL CHECK (amount_per_chunk_plur > 0),
  cost_plur              NUMERIC(78, 0) NOT NULL CHECK (cost_plur > 0),
  replaces_batch_id      TEXT CHECK (replaces_batch_id IS NULL OR replaces_batch_id ~ '^[0-9a-f]{64}$'),
  state                  TEXT NOT NULL,
  batch_id               TEXT CHECK (batch_id IS NULL OR batch_id ~ '^[0-9a-f]{64}$'),
  tx_hash                TEXT CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
  error                  TEXT,
  stages                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  released_at            TIMESTAMPTZ,
  relayed_at             TIMESTAMPTZ,
  started_by_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  started_by             TEXT NOT NULL,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at            TIMESTAMPTZ,
  CONSTRAINT batch_purchases_state
    CHECK (state IN ('buying', 'waiting_usable', 'restarting', 'moving', 'done', 'failed')),
  CONSTRAINT batch_purchases_catalogue_immutable CHECK (purpose <> 'catalogue' OR (immutable AND depth >= 18)),
  CONSTRAINT batch_purchases_state_of_purpose
    CHECK ((state <> 'restarting' OR purpose = 'rung') AND (state <> 'moving' OR purpose = 'catalogue')),
  CONSTRAINT batch_purchases_bought_with_batch
    CHECK (state NOT IN ('waiting_usable', 'restarting', 'moving', 'done') OR batch_id IS NOT NULL),
  CONSTRAINT batch_purchases_failed_with_error CHECK (state <> 'failed' OR error IS NOT NULL),
  CONSTRAINT batch_purchases_finished_when_over CHECK ((state IN ('done', 'failed')) = (finished_at IS NOT NULL)),
  CONSTRAINT batch_purchases_released_catalogue CHECK (released_at IS NULL OR purpose = 'catalogue')
);

-- One purchase is under way on a node at a time, since a second would buy for
-- the same role and spend the same wallet.
CREATE UNIQUE INDEX batch_purchases_one_open_per_node
  ON batch_purchases (node_id)
  WHERE state IN ('buying', 'waiting_usable', 'restarting', 'moving');

CREATE INDEX batch_purchases_latest ON batch_purchases (started_at DESC);

-- A move of the catalogue onto a batch that was bought after the old one
-- lapsed clears a thumbnail it can read from nowhere and goes on. This is the
-- list of the streams it cleared one on, a JSON list of { streamId, title },
-- which the Stamps tab and the Stages page show.
ALTER TABLE catalogue_moves
  ADD COLUMN cleared_thumbnails JSONB NOT NULL DEFAULT '[]'::jsonb;
