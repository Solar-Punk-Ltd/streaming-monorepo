-- Managed SRS runs are opt-in. NULL lifecycle_version keeps every existing
-- stream on the legacy state rules. Version 1 rows use explicit run
-- permission, ordered reports and immutable completed recording snapshots.

CREATE TABLE schema_compatibility (
  component  TEXT PRIMARY KEY,
  version    INT NOT NULL CHECK (version > 0)
);

INSERT INTO schema_compatibility (component, version)
VALUES ('managed_stream_lifecycle', 1)
ON CONFLICT (component) DO NOTHING;

ALTER TABLE streams
  ADD COLUMN lifecycle_version     SMALLINT,
  ADD COLUMN lifecycle_revision    BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN current_run_number    INT,
  ADD COLUMN completed_run_number  INT;

ALTER TABLE streams
  ADD CONSTRAINT streams_lifecycle_version_supported
    CHECK (lifecycle_version IS NULL OR lifecycle_version = 1),
  ADD CONSTRAINT streams_lifecycle_shape
    CHECK (
      (
        lifecycle_version IS NULL
        AND lifecycle_revision = 0
        AND current_run_number IS NULL
        AND completed_run_number IS NULL
      )
      OR
      (
        lifecycle_version = 1
        AND lifecycle_revision BETWEEN 1 AND 9007199254740991
        AND current_run_number IS NOT NULL
        AND current_run_number > 0
        AND (
          completed_run_number IS NULL
          OR completed_run_number BETWEEN 1 AND current_run_number
        )
      )
    );

CREATE TABLE stream_runs (
  stream_id              UUID NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  run_number             INT NOT NULL,
  state                  TEXT NOT NULL,
  permission             TEXT NOT NULL,
  assigned_uploader_id   TEXT NOT NULL,
  claim_id               UUID,
  claim_request_id       UUID,
  claim_request_digest   TEXT,
  revision               BIGINT NOT NULL,
  last_event_sequence    BIGINT,
  last_event_digest      TEXT,
  last_observed_at       TIMESTAMPTZ,
  last_received_at       TIMESTAMPTZ,
  reconnect_deadline     TIMESTAMPTZ,
  close_reason           TEXT,
  empty_checkpoint_reference UUID,
  accepted_media_count   BIGINT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stream_id, run_number),
  CONSTRAINT stream_runs_number_positive CHECK (run_number > 0),
  CONSTRAINT stream_runs_state_known CHECK (
    state IN ('ready', 'claimed', 'live', 'waiting', 'closed', 'vod')
  ),
  CONSTRAINT stream_runs_permission_known CHECK (
    permission IN ('open', 'claimed', 'closed')
  ),
  CONSTRAINT stream_runs_uploader_present CHECK (
    length(assigned_uploader_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT stream_runs_revision_safe CHECK (
    revision BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT stream_runs_event_sequence_safe CHECK (
    last_event_sequence IS NULL
    OR last_event_sequence BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT stream_runs_event_complete CHECK (
    (last_event_sequence IS NULL)
      = (last_event_digest IS NULL)
    AND (last_event_sequence IS NULL)
      = (last_observed_at IS NULL)
    AND (last_event_sequence IS NULL)
      = (last_received_at IS NULL)
  ),
  CONSTRAINT stream_runs_permission_shape CHECK (
    (
      permission = 'open'
      AND state = 'ready'
      AND claim_id IS NULL
      AND claim_request_id IS NULL
      AND claim_request_digest IS NULL
    )
    OR
    (
      permission = 'claimed'
      AND state IN ('claimed', 'live', 'waiting')
      AND claim_id IS NOT NULL
      AND claim_request_id IS NOT NULL
      AND claim_request_digest IS NOT NULL
    )
    OR (
      permission = 'closed'
      AND state IN ('closed', 'vod')
      AND (
        claim_id IS NULL
        OR (
          claim_request_id IS NOT NULL
          AND claim_request_digest IS NOT NULL
        )
      )
    )
  ),
  CONSTRAINT stream_runs_waiting_deadline CHECK (
    state <> 'waiting' OR reconnect_deadline IS NOT NULL
  ),
  CONSTRAINT stream_runs_close_reason CHECK (
    (
      state IN ('closed', 'vod')
      AND close_reason IN (
        'reconnect_timeout',
        'cancelled',
        'recovery_required',
        'finalization_failed',
        'empty'
      )
    )
    OR (state NOT IN ('closed', 'vod') AND close_reason IS NULL)
  ),
  CONSTRAINT stream_runs_empty_outcome CHECK (
    (
      close_reason = 'empty'
      AND empty_checkpoint_reference IS NOT NULL
      AND accepted_media_count = 0
    )
    OR (
      close_reason IS DISTINCT FROM 'empty'
      AND empty_checkpoint_reference IS NULL
      AND accepted_media_count IS NULL
    )
  )
);

CREATE TABLE stream_run_expected_renditions (
  stream_id      UUID NOT NULL,
  run_number     INT NOT NULL,
  name           TEXT NOT NULL,
  topic          UUID NOT NULL,
  width          INT NOT NULL,
  height         INT NOT NULL,
  bandwidth      BIGINT NOT NULL,
  avg_bandwidth  BIGINT NOT NULL,
  PRIMARY KEY (stream_id, run_number, name),
  UNIQUE (stream_id, run_number, name, topic),
  FOREIGN KEY (stream_id, run_number)
    REFERENCES stream_runs(stream_id, run_number) ON DELETE CASCADE,
  CONSTRAINT stream_run_expected_name_format
    CHECK (name ~ '^[A-Za-z0-9.-]{1,32}$'),
  CONSTRAINT stream_run_expected_width_positive CHECK (width > 0),
  CONSTRAINT stream_run_expected_height_positive CHECK (height > 0),
  CONSTRAINT stream_run_expected_bandwidth_non_negative CHECK (bandwidth >= 0),
  CONSTRAINT stream_run_expected_avg_bandwidth_non_negative
    CHECK (avg_bandwidth >= 0)
);

CREATE TABLE stream_run_recordings (
  stream_id             UUID NOT NULL,
  run_number            INT NOT NULL,
  checkpoint_reference  UUID NOT NULL,
  master_topic          UUID NOT NULL,
  master_index          BIGINT NOT NULL,
  master_reference      TEXT NOT NULL,
  duration_seconds      DOUBLE PRECISION NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stream_id, run_number),
  UNIQUE (checkpoint_reference),
  FOREIGN KEY (stream_id, run_number)
    REFERENCES stream_runs(stream_id, run_number) ON DELETE CASCADE,
  CONSTRAINT stream_run_recordings_master_index_safe CHECK (
    master_index BETWEEN 0 AND 9007199254740991
  ),
  CONSTRAINT stream_run_recordings_master_reference_format CHECK (
    master_reference ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT stream_run_recordings_duration_non_negative
    CHECK (duration_seconds >= 0)
);

CREATE TABLE stream_run_recording_renditions (
  stream_id        UUID NOT NULL,
  run_number       INT NOT NULL,
  name             TEXT NOT NULL,
  topic            UUID NOT NULL,
  manifest_index   BIGINT NOT NULL,
  reference        TEXT NOT NULL,
  duration_seconds DOUBLE PRECISION NOT NULL,
  width            INT NOT NULL,
  height           INT NOT NULL,
  bandwidth        BIGINT NOT NULL,
  avg_bandwidth    BIGINT NOT NULL,
  PRIMARY KEY (stream_id, run_number, name),
  FOREIGN KEY (stream_id, run_number)
    REFERENCES stream_run_recordings(stream_id, run_number) ON DELETE CASCADE,
  FOREIGN KEY (stream_id, run_number, name, topic)
    REFERENCES stream_run_expected_renditions(stream_id, run_number, name, topic),
  CONSTRAINT stream_run_recording_rendition_index_safe CHECK (
    manifest_index BETWEEN 0 AND 9007199254740991
  ),
  CONSTRAINT stream_run_recording_rendition_reference_format CHECK (
    reference ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT stream_run_recording_rendition_duration_non_negative
    CHECK (duration_seconds >= 0),
  CONSTRAINT stream_run_recording_rendition_width_positive CHECK (width > 0),
  CONSTRAINT stream_run_recording_rendition_height_positive CHECK (height > 0),
  CONSTRAINT stream_run_recording_rendition_bandwidth_non_negative
    CHECK (bandwidth >= 0),
  CONSTRAINT stream_run_recording_rendition_avg_bandwidth_non_negative
    CHECK (avg_bandwidth >= 0)
);

CREATE FUNCTION stamp_managed_run_receipt() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.last_event_sequence IS NULL THEN
    NEW.last_received_at = NULL;
  ELSIF TG_OP = 'INSERT'
    OR OLD.last_event_sequence IS DISTINCT FROM NEW.last_event_sequence
    OR OLD.last_event_digest IS DISTINCT FROM NEW.last_event_digest
  THEN
    NEW.last_received_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stream_runs_receive_stamp
BEFORE INSERT OR UPDATE ON stream_runs
FOR EACH ROW EXECUTE FUNCTION stamp_managed_run_receipt();

CREATE FUNCTION guard_managed_run_update() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.assigned_uploader_id IS DISTINCT FROM NEW.assigned_uploader_id
    OR (
      OLD.claim_id IS NOT NULL
      AND OLD.claim_id IS DISTINCT FROM NEW.claim_id
    )
    OR (
      OLD.claim_request_id IS NOT NULL
      AND OLD.claim_request_id IS DISTINCT FROM NEW.claim_request_id
    )
    OR (
      OLD.claim_request_digest IS NOT NULL
      AND OLD.claim_request_digest IS DISTINCT FROM NEW.claim_request_digest
    )
  THEN
    RAISE EXCEPTION 'a managed run claim identity is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'managed_run_claim_identity';
  END IF;

  IF NEW.revision < OLD.revision THEN
    RAISE EXCEPTION 'a managed run revision cannot move backward'
      USING ERRCODE = '23514', CONSTRAINT = 'managed_run_revision_order';
  END IF;

  IF OLD.permission IS DISTINCT FROM NEW.permission AND NOT (
    (OLD.permission = 'open' AND NEW.permission IN ('claimed', 'closed'))
    OR (OLD.permission = 'claimed' AND NEW.permission = 'closed')
  ) THEN
    RAISE EXCEPTION 'a managed run permission cannot reopen'
      USING ERRCODE = '23514', CONSTRAINT = 'managed_run_permission_transition';
  END IF;

  IF OLD.state IS DISTINCT FROM NEW.state AND NOT (
    (OLD.state = 'ready' AND NEW.state IN ('claimed', 'closed'))
    OR (OLD.state = 'claimed' AND NEW.state IN ('live', 'waiting', 'closed'))
    OR (OLD.state = 'live' AND NEW.state IN ('waiting', 'closed'))
    OR (OLD.state = 'waiting' AND NEW.state IN ('live', 'closed'))
    OR (OLD.state = 'closed' AND NEW.state = 'vod')
  ) THEN
    RAISE EXCEPTION 'invalid managed run state transition'
      USING ERRCODE = '23514', CONSTRAINT = 'managed_run_state_transition';
  END IF;

  IF OLD.last_event_sequence IS NOT NULL AND (
    NEW.last_event_sequence IS NULL
    OR NEW.last_event_sequence < OLD.last_event_sequence
    OR (
      NEW.last_event_sequence = OLD.last_event_sequence
      AND NEW.last_event_digest IS DISTINCT FROM OLD.last_event_digest
    )
  ) THEN
    RAISE EXCEPTION 'a managed run event is stale or conflicts with its sequence'
      USING ERRCODE = '23514', CONSTRAINT = 'managed_run_event_order';
  END IF;

  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stream_runs_update_guard
BEFORE UPDATE ON stream_runs
FOR EACH ROW EXECUTE FUNCTION guard_managed_run_update();

CREATE FUNCTION require_complete_managed_recording() RETURNS TRIGGER AS $$
DECLARE
  expected_count INT;
  recorded_count INT;
  has_master BOOLEAN;
BEGIN
  IF NEW.state <> 'vod' OR (TG_OP = 'UPDATE' AND OLD.state = 'vod') THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM stream_run_recordings recording
      JOIN streams stream ON stream.id = recording.stream_id
     WHERE recording.stream_id = NEW.stream_id
       AND recording.run_number = NEW.run_number
       AND recording.master_topic = stream.topic
  ) INTO has_master;

  SELECT COUNT(*) INTO expected_count
    FROM stream_run_expected_renditions
   WHERE stream_id = NEW.stream_id AND run_number = NEW.run_number;

  SELECT COUNT(*) INTO recorded_count
    FROM stream_run_recording_renditions
   WHERE stream_id = NEW.stream_id AND run_number = NEW.run_number;

  IF NOT has_master OR recorded_count <> expected_count THEN
    RAISE EXCEPTION 'a managed VOD requires its exact master and expected ladder'
      USING ERRCODE = '23514', CONSTRAINT = 'managed_run_recording_incomplete';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stream_runs_recording_guard
BEFORE INSERT OR UPDATE ON stream_runs
FOR EACH ROW EXECUTE FUNCTION require_complete_managed_recording();

CREATE FUNCTION guard_completed_recording_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM streams WHERE id = OLD.stream_id
  ) THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'a completed managed recording is immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'managed_recording_immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stream_run_recordings_immutable
BEFORE UPDATE OR DELETE ON stream_run_recordings
FOR EACH ROW EXECUTE FUNCTION guard_completed_recording_mutation();

CREATE TRIGGER stream_run_recording_renditions_immutable
BEFORE UPDATE OR DELETE ON stream_run_recording_renditions
FOR EACH ROW EXECUTE FUNCTION guard_completed_recording_mutation();

CREATE FUNCTION guard_managed_stream_update() RETURNS TRIGGER AS $$
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
    IF NEW.status = 'live'
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

CREATE TRIGGER streams_managed_update_guard
BEFORE UPDATE ON streams
FOR EACH ROW EXECUTE FUNCTION guard_managed_stream_update();
