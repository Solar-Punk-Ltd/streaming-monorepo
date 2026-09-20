ALTER TABLE streams
  ADD COLUMN enrollment_profile_digest TEXT,
  ADD CONSTRAINT streams_enrollment_profile_digest_format CHECK (
    enrollment_profile_digest IS NULL
    OR enrollment_profile_digest ~ '^[0-9a-f]{64}$'
  );

CREATE OR REPLACE FUNCTION guard_managed_stream_update() RETURNS TRIGGER AS $$
DECLARE
  current_state TEXT;
  current_permission TEXT;
  recorded_index BIGINT;
  recorded_duration DOUBLE PRECISION;
BEGIN
  IF OLD.lifecycle_version IS DISTINCT FROM 1 THEN
    RETURN NEW;
  END IF;

  IF NEW.lifecycle_version IS DISTINCT FROM 1
    OR NEW.lifecycle_revision < OLD.lifecycle_revision
    OR NEW.current_run_number IS NULL
    OR NEW.current_run_number < OLD.current_run_number
    OR NEW.enrollment_profile_digest IS DISTINCT FROM OLD.enrollment_profile_digest
    OR (
      OLD.completed_run_number IS NOT NULL
      AND (
        NEW.completed_run_number IS NULL
        OR NEW.completed_run_number < OLD.completed_run_number
      )
    )
  THEN
    RAISE EXCEPTION 'managed lifecycle identity cannot move backward'
      USING ERRCODE = '23514', CONSTRAINT = 'managed_stream_lifecycle_order';
  END IF;

  SELECT state, permission
    INTO current_state, current_permission
    FROM stream_runs
   WHERE stream_id = NEW.id AND run_number = NEW.current_run_number;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status IN ('draft', 'publishing', 'published')
      AND NEW.status IN ('draft', 'publishing', 'published')
      AND current_state = 'ready'
      AND current_permission = 'open'
    THEN
      NULL;
    ELSIF NEW.status = 'live'
      AND current_state = 'live'
      AND current_permission = 'claimed'
      AND (
        OLD.completed_run_number IS NULL
        OR (
          NEW.current_run_number > OLD.completed_run_number
          AND NEW.manifest_index IS NOT DISTINCT FROM OLD.manifest_index
          AND NEW.duration_seconds IS NOT DISTINCT FROM OLD.duration_seconds
          AND NEW.ended_at IS NOT DISTINCT FROM OLD.ended_at
        )
      )
    THEN
      NULL;
    ELSIF NEW.status = 'vod'
      AND current_state = 'vod'
      AND current_permission = 'closed'
      AND NEW.completed_run_number = NEW.current_run_number
      AND (
        OLD.completed_run_number IS NULL
        OR NEW.completed_run_number > OLD.completed_run_number
      )
    THEN
      SELECT master_index, duration_seconds
        INTO recorded_index, recorded_duration
        FROM stream_run_recordings
       WHERE stream_id = NEW.id AND run_number = NEW.current_run_number;
      IF NEW.manifest_index IS DISTINCT FROM recorded_index
        OR NEW.duration_seconds IS DISTINCT FROM recorded_duration
      THEN
        RAISE EXCEPTION 'managed VOD fields do not match its retained snapshot'
          USING ERRCODE = '23514', CONSTRAINT = 'managed_closed_stream_guard';
      END IF;
    ELSE
      RAISE EXCEPTION 'legacy SQL cannot change a managed stream state'
        USING ERRCODE = '23514', CONSTRAINT = 'managed_closed_stream_guard';
    END IF;
  ELSIF (
    NEW.manifest_index IS DISTINCT FROM OLD.manifest_index
    OR NEW.duration_seconds IS DISTINCT FROM OLD.duration_seconds
    OR NEW.ended_at IS DISTINCT FROM OLD.ended_at
  ) THEN
    RAISE EXCEPTION 'legacy SQL cannot replace a managed completed recording'
      USING ERRCODE = '23514', CONSTRAINT = 'managed_closed_stream_guard';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
