import type {
  RecordingCheckState,
  RecordingReadings,
  RecordingVerdict,
  StreamStatus,
} from '@streaming-monorepo/web2-admin-common';
import { Pool, PoolClient } from 'pg';

/** One row of `recording_checks`, migration 031. */
export interface RecordingCheckRow {
  id: string;
  state: RecordingCheckState;
  stopMessage: string | null;
  round: number;
  nextRoundAt: Date | null;
  unjudged: number;
  startedBy: string;
  startedAt: Date;
  finishedAt: Date | null;
}

/** What a removal did with one lost recording. */
export type RecordingRemoval = 'removed' | 'unlisted' | 'kept';

/** One recording of a check, `recording_check_streams`: the stream as it was when the check started. */
export interface RecordingCheckStreamRow {
  streamId: string;
  title: string;
  status: StreamStatus;
  readings: RecordingReadings;
  verdict: RecordingVerdict | null;
  hasExportFile: boolean;
  removal: RecordingRemoval | null;
  keptReason: string | null;
  removedAt: Date | null;
}

/** What a finished check found of one stream. A null verdict leaves it unjudged: the one rule left it out at the end. */
export interface StreamVerdict {
  streamId: string;
  verdict: RecordingVerdict | null;
  hasExportFile: boolean;
}

/** Where the checks of the recordings are kept: Postgres, or memory in the unit tests. */
export interface RecordingCheckStore {
  latest(): Promise<RecordingCheckRow | null>;
  /** A new running check with the streams it judges, or null when one is running already. */
  create(check: {
    id: string;
    startedBy: string;
    startedByUserId: string | null;
    unjudged: number;
    streams: readonly { streamId: string; title: string; status: StreamStatus }[];
  }): Promise<RecordingCheckRow | null>;
  /** The check's recordings, by title. */
  streams(checkId: string): Promise<RecordingCheckStreamRow[]>;
  recordReadings(checkId: string, streamId: string, readings: RecordingReadings): Promise<void>;
  /** The round being read or last read, and when the next one starts, while the check runs; null otherwise. */
  recordRound(checkId: string, round: number, nextRoundAt: Date | null): Promise<RecordingCheckRow | null>;
  /**
   * Ends a running check with its verdicts, and marks each judged stream's row: `lost` or `partly_lost` with the
   * moment, or no mark for one that read. A stream live by then is left as it is. Null when the check was not running,
   * and nothing is written.
   */
  finish(checkId: string, verdicts: readonly StreamVerdict[], unjudged: number): Promise<RecordingCheckRow | null>;
  /** Ends a running check early with no result; null when it was not running. */
  stop(checkId: string, message: string): Promise<RecordingCheckRow | null>;
  /** Ends every running check with `message`: at boot, since the process that ran it is gone. */
  stopRunning(message: string): Promise<RecordingCheckRow[]>;
  /** Records what a removal did with one lost recording, once. */
  recordRemoval(checkId: string, streamId: string, removal: RecordingRemoval, keptReason: string | null): Promise<void>;
  /** Takes the mark off a stream's row: a read once more found its recording. */
  clearVerdict(streamId: string): Promise<void>;
}

interface CheckRow {
  id: string;
  state: RecordingCheckState;
  stop_message: string | null;
  round: number;
  next_round_at: Date | null;
  unjudged: number;
  started_by: string;
  started_at: Date;
  finished_at: Date | null;
}

const CHECK_COLUMNS = `id::text AS id, state, stop_message, round, next_round_at, unjudged, started_by, started_at,
  finished_at`;

function checkOf(row: CheckRow): RecordingCheckRow {
  return {
    id: row.id,
    state: row.state,
    stopMessage: row.stop_message,
    round: row.round,
    nextRoundAt: row.next_round_at,
    unjudged: row.unjudged,
    startedBy: row.started_by,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The checks of the recordings and what each found, migration 031, and the verdict on a stream's row. */
export class RecordingCheckRepository implements RecordingCheckStore {
  constructor(private readonly pool: Pool) {}

  async latest(): Promise<RecordingCheckRow | null> {
    const result = await this.pool.query<CheckRow>(
      `SELECT ${CHECK_COLUMNS} FROM recording_checks ORDER BY started_at DESC, id DESC LIMIT 1`,
    );
    return result.rows[0] ? checkOf(result.rows[0]) : null;
  }

  create(check: {
    id: string;
    startedBy: string;
    startedByUserId: string | null;
    unjudged: number;
    streams: readonly { streamId: string; title: string; status: StreamStatus }[];
  }): Promise<RecordingCheckRow | null> {
    return inTransaction(this.pool, async (client) => {
      // The partial unique index holds one running check; a second start answers null rather than an error.
      const created = await client.query<CheckRow>(
        `INSERT INTO recording_checks (id, state, round, unjudged, started_by_user_id, started_by)
         VALUES ($1, 'running', 1, $2, $3, $4)
         ON CONFLICT ((TRUE)) WHERE state = 'running' DO NOTHING
         RETURNING ${CHECK_COLUMNS}`,
        [check.id, check.unjudged, check.startedByUserId, check.startedBy],
      );
      const row = created.rows[0];
      if (!row) return null;
      if (check.streams.length > 0) {
        await client.query(
          `INSERT INTO recording_check_streams (check_id, stream_id, title, status)
           SELECT $1, listed.stream_id, listed.title, listed.status
             FROM unnest($2::uuid[], $3::text[], $4::text[]) AS listed (stream_id, title, status)`,
          [
            check.id,
            check.streams.map((stream) => stream.streamId),
            check.streams.map((stream) => stream.title),
            check.streams.map((stream) => stream.status),
          ],
        );
      }
      return checkOf(row);
    });
  }

  async streams(checkId: string): Promise<RecordingCheckStreamRow[]> {
    const result = await this.pool.query<{
      stream_id: string;
      title: string;
      status: StreamStatus;
      readings: RecordingReadings;
      verdict: RecordingVerdict | null;
      has_export_file: boolean;
      removal: RecordingRemoval | null;
      kept_reason: string | null;
      removed_at: Date | null;
    }>(
      `SELECT stream_id::text AS stream_id, title, status, readings, verdict, has_export_file, removal, kept_reason,
              removed_at
         FROM recording_check_streams
        WHERE check_id = $1
        ORDER BY title, stream_id`,
      [checkId],
    );
    return result.rows.map((row) => ({
      streamId: row.stream_id,
      title: row.title,
      status: row.status,
      readings: row.readings,
      verdict: row.verdict,
      hasExportFile: row.has_export_file,
      removal: row.removal,
      keptReason: row.kept_reason,
      removedAt: row.removed_at,
    }));
  }

  async recordReadings(checkId: string, streamId: string, readings: RecordingReadings): Promise<void> {
    await this.pool.query(
      `UPDATE recording_check_streams SET readings = $3::jsonb WHERE check_id = $1 AND stream_id = $2`,
      [checkId, streamId, JSON.stringify(readings)],
    );
  }

  async recordRound(checkId: string, round: number, nextRoundAt: Date | null): Promise<RecordingCheckRow | null> {
    const result = await this.pool.query<CheckRow>(
      `UPDATE recording_checks
          SET round = $2, next_round_at = $3, updated_at = NOW()
        WHERE id = $1 AND state = 'running'
        RETURNING ${CHECK_COLUMNS}`,
      [checkId, round, nextRoundAt],
    );
    return result.rows[0] ? checkOf(result.rows[0]) : null;
  }

  finish(checkId: string, verdicts: readonly StreamVerdict[], unjudged: number): Promise<RecordingCheckRow | null> {
    return inTransaction(this.pool, async (client) => {
      const finished = await client.query<CheckRow>(
        `UPDATE recording_checks
            SET state = 'done', unjudged = $2, next_round_at = NULL, finished_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND state = 'running'
          RETURNING ${CHECK_COLUMNS}`,
        [checkId, unjudged],
      );
      const row = finished.rows[0];
      if (!row) return null;
      const ids = verdicts.map((one) => one.streamId);
      const found = verdicts.map((one) => one.verdict);
      await client.query(
        `UPDATE recording_check_streams AS checked
            SET verdict = given.verdict, has_export_file = given.has_export_file
           FROM unnest($2::uuid[], $3::text[], $4::boolean[]) AS given (stream_id, verdict, has_export_file)
          WHERE checked.check_id = $1 AND checked.stream_id = given.stream_id`,
        [checkId, ids, found, verdicts.map((one) => one.hasExportFile)],
      );
      await client.query(
        `UPDATE streams
            SET recording_verdict = CASE WHEN given.verdict = 'readable' THEN NULL ELSE given.verdict END,
                recording_checked_at = CASE WHEN given.verdict = 'readable' THEN NULL ELSE NOW() END
           FROM unnest($1::uuid[], $2::text[]) AS given (stream_id, verdict)
          WHERE streams.id = given.stream_id AND given.verdict IS NOT NULL AND streams.status <> 'live'`,
        [ids, found],
      );
      return checkOf(row);
    });
  }

  async stop(checkId: string, message: string): Promise<RecordingCheckRow | null> {
    const result = await this.pool.query<CheckRow>(
      `UPDATE recording_checks
          SET state = 'stopped', stop_message = $2, next_round_at = NULL, finished_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND state = 'running'
        RETURNING ${CHECK_COLUMNS}`,
      [checkId, message],
    );
    return result.rows[0] ? checkOf(result.rows[0]) : null;
  }

  async stopRunning(message: string): Promise<RecordingCheckRow[]> {
    const result = await this.pool.query<CheckRow>(
      `UPDATE recording_checks
          SET state = 'stopped', stop_message = $1, next_round_at = NULL, finished_at = NOW(), updated_at = NOW()
        WHERE state = 'running'
        RETURNING ${CHECK_COLUMNS}`,
      [message],
    );
    return result.rows.map(checkOf);
  }

  async recordRemoval(
    checkId: string,
    streamId: string,
    removal: RecordingRemoval,
    keptReason: string | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE recording_check_streams
          SET removal = $3, kept_reason = $4, removed_at = NOW()
        WHERE check_id = $1 AND stream_id = $2 AND removal IS NULL`,
      [checkId, streamId, removal, removal === 'kept' ? keptReason : null],
    );
  }

  async clearVerdict(streamId: string): Promise<void> {
    await this.pool.query(`UPDATE streams SET recording_verdict = NULL, recording_checked_at = NULL WHERE id = $1`, [
      streamId,
    ]);
  }
}
