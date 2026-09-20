ALTER TABLE stream_runs DROP CONSTRAINT stream_runs_close_reason;
ALTER TABLE stream_runs
  ADD CONSTRAINT stream_runs_close_reason CHECK (
    (
      state IN ('closed', 'vod')
      AND close_reason IN (
        'reconnect_timeout',
        'cancelled',
        'recovery_required',
        'finalization_failed',
        'empty',
        'adopted'
      )
    )
    OR (state NOT IN ('closed', 'vod') AND close_reason IS NULL)
  );

CREATE TABLE legacy_adoption_operations (
  operation_id          UUID PRIMARY KEY,
  stream_id             UUID NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  request_id            UUID NOT NULL,
  request_digest        TEXT NOT NULL,
  assigned_uploader_id  TEXT NOT NULL,
  candidate_digest      TEXT NOT NULL,
  candidate             JSONB NOT NULL,
  profile_digest        TEXT NOT NULL,
  revision              BIGINT NOT NULL,
  status                TEXT NOT NULL,
  preparation_digest    TEXT,
  completed_recording   JSONB,
  validation            JSONB,
  failure               TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (stream_id, request_id),
  CONSTRAINT legacy_adoption_request_digest_format CHECK (
    request_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT legacy_adoption_candidate_digest_format CHECK (
    candidate_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT legacy_adoption_profile_digest_format CHECK (
    profile_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT legacy_adoption_preparation_digest_format CHECK (
    preparation_digest IS NULL OR preparation_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT legacy_adoption_uploader_present CHECK (
    assigned_uploader_id ~ '^[A-Za-z0-9_.:-]{1,200}$'
  ),
  CONSTRAINT legacy_adoption_revision_safe CHECK (
    revision BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT legacy_adoption_status_known CHECK (
    status IN ('pending', 'failed', 'cancelled', 'committed')
  ),
  CONSTRAINT legacy_adoption_result_shape CHECK (
    (
      status = 'pending'
      AND preparation_digest IS NULL
      AND completed_recording IS NULL
      AND validation IS NULL
      AND failure IS NULL
    )
    OR (
      status = 'failed'
      AND preparation_digest IS NOT NULL
      AND completed_recording IS NULL
      AND validation IS NULL
      AND failure IS NOT NULL
    )
    OR (
      status = 'committed'
      AND preparation_digest IS NOT NULL
      AND completed_recording IS NOT NULL
      AND validation IS NOT NULL
      AND failure IS NULL
    )
    OR (
      status = 'cancelled'
      AND completed_recording IS NULL
      AND validation IS NULL
      AND failure IS NULL
    )
  ),
  CONSTRAINT legacy_adoption_failure_bounded CHECK (
    failure IS NULL OR length(failure) BETWEEN 1 AND 500
  )
);

CREATE UNIQUE INDEX legacy_adoption_one_pending
  ON legacy_adoption_operations (stream_id)
  WHERE status = 'pending';

CREATE INDEX legacy_adoption_uploader_pending
  ON legacy_adoption_operations (assigned_uploader_id, created_at)
  WHERE status = 'pending';

CREATE FUNCTION guard_legacy_adoption_operation_update() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.operation_id IS DISTINCT FROM OLD.operation_id
    OR NEW.stream_id IS DISTINCT FROM OLD.stream_id
    OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
    OR NEW.assigned_uploader_id IS DISTINCT FROM OLD.assigned_uploader_id
    OR NEW.candidate_digest IS DISTINCT FROM OLD.candidate_digest
    OR NEW.candidate IS DISTINCT FROM OLD.candidate
    OR NEW.profile_digest IS DISTINCT FROM OLD.profile_digest
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'legacy adoption operation identity is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'legacy_adoption_identity';
  END IF;

  IF NEW.revision < OLD.revision THEN
    RAISE EXCEPTION 'legacy adoption revision cannot move backward'
      USING ERRCODE = '23514', CONSTRAINT = 'legacy_adoption_revision';
  END IF;

  IF NOT (
    NEW.status = OLD.status
    OR (
      OLD.status = 'pending'
      AND NEW.status IN ('failed', 'cancelled', 'committed')
    )
  ) THEN
    RAISE EXCEPTION 'invalid legacy adoption transition'
      USING ERRCODE = '23514', CONSTRAINT = 'legacy_adoption_transition';
  END IF;

  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER legacy_adoption_update_guard
BEFORE UPDATE ON legacy_adoption_operations
FOR EACH ROW EXECUTE FUNCTION guard_legacy_adoption_operation_update();
