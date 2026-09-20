ALTER TABLE continuation_operations
  DROP CONSTRAINT continuation_operation_runs_advance,
  ADD CONSTRAINT continuation_operation_runs_advance CHECK (
    previous_run_number > 0
    AND next_run_number > previous_run_number
    AND (
      retained_run_number IS NULL
      OR retained_run_number BETWEEN 1 AND previous_run_number
    )
  );
