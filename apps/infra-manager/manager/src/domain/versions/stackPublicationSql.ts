/** Bindings: $2 build id, $3 commit, $4 contract, $5 optional root anchor, $6 and $7 optional source url and folder. */
export const STACK_PUBLICATION_ASSIGNMENTS = `
  status = 'ready',
  publication_revision = publication_revision + 1,
  layout = 'builds',
  previous_build_id = CASE
    WHEN build_id IS NOT NULL AND build_id <> $2 THEN build_id
    ELSE previous_build_id
  END,
  tested = tested AND build_id IS NOT DISTINCT FROM $2,
  tested_invalidated_at = CASE WHEN tested AND build_id IS DISTINCT FROM $2
    THEN COALESCE(tested_invalidated_at, NOW()) ELSE tested_invalidated_at END,
  build_id = $2,
  commit_sha = $3,
  contract = $4::jsonb,
  root_path = COALESCE($5, root_path),
  source_url = COALESCE($6, source_url),
  source_folder = COALESCE($7, source_folder),
  built_at = NOW(),
  last_error = NULL
`;
