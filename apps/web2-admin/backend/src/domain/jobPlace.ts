/**
 * The one place a job has, for the whole admin: an export and an archive never run together, since both read through
 * the one catalogue node. Each takes the same transaction-scoped advisory lock when it starts, or takes the place
 * again, and looks at the other's table under it. `docs/architecture/web2-admin.md`, "The job".
 *
 * - An export holds the place in every state but `done`; a kept export file holds none.
 * - An archive holds it unless it is `done`, waiting for a user to confirm a purchase, or paused by a user
 *   (`archiveHoldsPlace` of the admin's common types, which this SQL repeats).
 */

/** The advisory lock both take: `JOBS` in ASCII. */
export const JOB_PLACE_LOCK = 0x4a4f4253;

export const TAKE_JOB_PLACE_LOCK_SQL = `SELECT pg_advisory_xact_lock(${JOB_PLACE_LOCK})`;

/** A row when an export holds the place. */
export const EXPORT_HOLDS_PLACE_SQL = `SELECT 1 FROM stream_exports WHERE state <> 'done' LIMIT 1`;

/** A row when an archive holds the place. */
export const ARCHIVE_HOLDS_PLACE_SQL = `SELECT 1 FROM archive_jobs
  WHERE state NOT IN ('done', 'awaiting_purchase') AND NOT (state = 'paused' AND pause_reason = 'user')
  LIMIT 1`;

/**
 * What an export asks before it starts: whether an archive holds the place, and the sentence that says which. The
 * archive's service answers it; null when none does.
 */
export interface ArchivePlace {
  archiveHoldingPlace(): Promise<string | null>;
}
