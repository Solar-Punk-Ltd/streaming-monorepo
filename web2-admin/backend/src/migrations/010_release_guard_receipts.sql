CREATE TABLE release_guard_receipts (
  role                  TEXT NOT NULL,
  slot_id               TEXT NOT NULL,
  installation_id       UUID NOT NULL,
  generation            BIGINT NOT NULL,
  state_digest          TEXT NOT NULL,
  minimum_srs_lifecycle SMALLINT NOT NULL,
  tree_digest           TEXT NOT NULL,
  images                JSONB NOT NULL,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (role, slot_id),
  CONSTRAINT release_guard_role_known CHECK (
    role IN ('manager', 'admin', 'uploader', 'viewer')
  ),
  CONSTRAINT release_guard_slot_shape CHECK (
    (role IN ('manager', 'admin', 'viewer') AND slot_id = 'default')
    OR (
      role = 'uploader'
      AND slot_id ~ '^[A-Za-z0-9_.:-]{1,200}$'
    )
  ),
  CONSTRAINT release_guard_generation_safe CHECK (
    generation BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT release_guard_minimum_supported CHECK (
    minimum_srs_lifecycle = 1
  ),
  CONSTRAINT release_guard_state_digest CHECK (
    state_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT release_guard_tree_digest CHECK (
    tree_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT release_guard_images_array CHECK (
    jsonb_typeof(images) = 'array'
    AND jsonb_array_length(images) BETWEEN 1 AND 32
  )
);
