CREATE TABLE continuation_operations (
  operation_id          UUID PRIMARY KEY,
  stream_id             UUID NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  request_id            UUID NOT NULL,
  request_digest        TEXT NOT NULL,
  assigned_uploader_id  TEXT NOT NULL,
  previous_run_number   INT NOT NULL,
  next_run_number       INT NOT NULL,
  retained_run_number   INT,
  revision              BIGINT NOT NULL,
  status                TEXT NOT NULL,
  checkpoint_reference  UUID,
  failure               TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (stream_id, request_id),
  UNIQUE (stream_id, next_run_number),
  FOREIGN KEY (stream_id, previous_run_number)
    REFERENCES stream_runs(stream_id, run_number),
  FOREIGN KEY (stream_id, retained_run_number)
    REFERENCES stream_run_recordings(stream_id, run_number),
  CONSTRAINT continuation_operation_request_digest CHECK (
    request_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT continuation_operation_uploader_present CHECK (
    length(assigned_uploader_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT continuation_operation_runs_advance CHECK (
    previous_run_number > 0
    AND next_run_number = previous_run_number + 1
    AND (
      retained_run_number IS NULL
      OR retained_run_number BETWEEN 1 AND previous_run_number
    )
  ),
  CONSTRAINT continuation_operation_revision_safe CHECK (
    revision BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT continuation_operation_status_known CHECK (
    status IN ('pending', 'ready', 'failed', 'cancelled', 'claimed')
  ),
  CONSTRAINT continuation_operation_result_shape CHECK (
    (status = 'pending' AND checkpoint_reference IS NULL AND failure IS NULL)
    OR (status IN ('ready', 'claimed') AND checkpoint_reference IS NOT NULL AND failure IS NULL)
    OR (status = 'failed' AND checkpoint_reference IS NULL AND failure IS NOT NULL)
    OR status = 'cancelled'
  ),
  CONSTRAINT continuation_operation_failure_bounded CHECK (
    failure IS NULL OR length(failure) BETWEEN 1 AND 500
  )
);

CREATE UNIQUE INDEX continuation_operations_one_open
  ON continuation_operations (stream_id)
  WHERE status IN ('pending', 'ready');

CREATE INDEX continuation_operations_uploader_pending
  ON continuation_operations (assigned_uploader_id, created_at)
  WHERE status = 'pending';

CREATE FUNCTION guard_continuation_operation_update() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.operation_id IS DISTINCT FROM OLD.operation_id
    OR NEW.stream_id IS DISTINCT FROM OLD.stream_id
    OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
    OR NEW.assigned_uploader_id IS DISTINCT FROM OLD.assigned_uploader_id
    OR NEW.previous_run_number IS DISTINCT FROM OLD.previous_run_number
    OR NEW.next_run_number IS DISTINCT FROM OLD.next_run_number
    OR NEW.retained_run_number IS DISTINCT FROM OLD.retained_run_number
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'continuation operation identity is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'continuation_operation_identity';
  END IF;

  IF NEW.revision < OLD.revision THEN
    RAISE EXCEPTION 'continuation operation revision cannot move backward'
      USING ERRCODE = '23514', CONSTRAINT = 'continuation_operation_revision';
  END IF;

  IF NOT (
    NEW.status = OLD.status
    OR (OLD.status = 'pending' AND NEW.status IN ('ready', 'failed', 'cancelled'))
    OR (OLD.status = 'ready' AND NEW.status IN ('claimed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'invalid continuation operation transition'
      USING ERRCODE = '23514', CONSTRAINT = 'continuation_operation_transition';
  END IF;

  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER continuation_operations_update_guard
BEFORE UPDATE ON continuation_operations
FOR EACH ROW EXECUTE FUNCTION guard_continuation_operation_update();
