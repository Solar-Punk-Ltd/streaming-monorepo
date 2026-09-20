CREATE TABLE uploader_capability_receipts (
  uploader_id                       TEXT PRIMARY KEY,
  lifecycle_version                 SMALLINT NOT NULL,
  durable_checkpoint_store_version  SMALLINT NOT NULL,
  legacy_recording_adoption_version SMALLINT NOT NULL,
  profiles                          JSONB NOT NULL,
  received_at                       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uploader_capability_identity_present CHECK (
    length(uploader_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT uploader_capability_versions_supported CHECK (
    lifecycle_version = 1
    AND durable_checkpoint_store_version = 1
    AND legacy_recording_adoption_version = 1
  ),
  CONSTRAINT uploader_capability_profiles_array CHECK (
    jsonb_typeof(profiles) = 'array'
    AND jsonb_array_length(profiles) BETWEEN 1 AND 2
  )
);

ALTER TABLE stream_run_expected_renditions
  ADD CONSTRAINT stream_run_expected_topic_unique
  UNIQUE (stream_id, run_number, topic);
