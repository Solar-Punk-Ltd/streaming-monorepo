ALTER TABLE stream_runs
  ADD COLUMN rendition_revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN rendition_finished_revision BIGINT,
  ADD CONSTRAINT stream_runs_rendition_revision_safe CHECK (
    rendition_revision BETWEEN 0 AND 9007199254740991
  ),
  ADD CONSTRAINT stream_runs_rendition_finished_revision_safe CHECK (
    rendition_finished_revision IS NULL
    OR rendition_finished_revision BETWEEN 1 AND rendition_revision
  );

CREATE TABLE stream_run_renditions (
  stream_id           UUID NOT NULL,
  run_number          INT NOT NULL,
  name                TEXT NOT NULL,
  topic               UUID NOT NULL,
  width               INT NOT NULL,
  height              INT NOT NULL,
  bandwidth           BIGINT NOT NULL,
  avg_bandwidth       BIGINT NOT NULL,
  manifest_index      BIGINT,
  duration_seconds    DOUBLE PRECISION,
  last_sequence       BIGINT NOT NULL,
  last_digest         TEXT NOT NULL,
  last_observed_at    TIMESTAMPTZ NOT NULL,
  rendition_revision  BIGINT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stream_id, run_number, name),
  FOREIGN KEY (stream_id, run_number, name, topic)
    REFERENCES stream_run_expected_renditions(stream_id, run_number, name, topic)
    ON DELETE CASCADE,
  CONSTRAINT stream_run_renditions_name_format CHECK (
    name ~ '^[A-Za-z0-9.-]{1,32}$'
  ),
  CONSTRAINT stream_run_renditions_width_positive CHECK (width > 0),
  CONSTRAINT stream_run_renditions_height_positive CHECK (height > 0),
  CONSTRAINT stream_run_renditions_bandwidth_non_negative CHECK (bandwidth >= 0),
  CONSTRAINT stream_run_renditions_avg_bandwidth_non_negative CHECK (
    avg_bandwidth >= 0
  ),
  CONSTRAINT stream_run_renditions_index_safe CHECK (
    manifest_index IS NULL
    OR manifest_index BETWEEN 0 AND 9007199254740991
  ),
  CONSTRAINT stream_run_renditions_duration_non_negative CHECK (
    duration_seconds IS NULL OR duration_seconds >= 0
  ),
  CONSTRAINT stream_run_renditions_finished_together CHECK (
    (manifest_index IS NULL) = (duration_seconds IS NULL)
  ),
  CONSTRAINT stream_run_renditions_sequence_safe CHECK (
    last_sequence BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT stream_run_renditions_digest_format CHECK (
    last_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT stream_run_renditions_revision_safe CHECK (
    rendition_revision BETWEEN 1 AND 9007199254740991
  )
);
