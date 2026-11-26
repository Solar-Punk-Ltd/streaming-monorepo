import type { UnmarkedStampHolder, UnmarkedStampLevel } from '@streaming-monorepo/web2-admin-common';
import { Pool } from 'pg';

import type { UnmarkedStampReading, UnmarkedStampRow, UnmarkedStampStore } from './UnmarkedStampStore.js';

interface WatchDbRow {
  batch_id: string;
  node_id: string;
  holder: UnmarkedStampHolder;
  level: UnmarkedStampLevel;
  since: Date;
  level_since: Date;
  message: string;
  notified_level: UnmarkedStampLevel | null;
  notified_at: Date | null;
}

function rowOf(row: WatchDbRow): UnmarkedStampRow {
  return {
    batchId: row.batch_id,
    nodeId: row.node_id,
    holder: row.holder,
    level: row.level,
    since: row.since,
    levelSince: row.level_since,
    message: row.message,
    notifiedLevel: row.notified_level,
    notifiedAt: row.notified_at,
  };
}

/**
 * The unmarked stamps that are running low, in Postgres: `stamp_watch_notices`, migration 037. A run's reading of a
 * stamp is one upsert. A stamp with a row takes the node and holder it was read with, as well as the message, and
 * keeps its `since` and what it was notified of. Its `level_since` moves only when its level changed, and never to
 * before its `since`, which the table's check holds it to.
 */
export class UnmarkedStampRepository implements UnmarkedStampStore {
  constructor(private readonly pool: Pool) {}

  async rows(): Promise<UnmarkedStampRow[]> {
    const result = await this.pool.query<WatchDbRow>(
      `SELECT batch_id, node_id, holder, level, since, level_since, message, notified_level, notified_at
         FROM stamp_watch_notices
        ORDER BY since, batch_id`,
    );
    return result.rows.map(rowOf);
  }

  async record(reading: UnmarkedStampReading, at: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO stamp_watch_notices (batch_id, node_id, holder, level, since, level_since, message)
       VALUES ($1, $2, $3, $4, $5, $5, $6)
       ON CONFLICT (batch_id) DO UPDATE
          SET node_id = EXCLUDED.node_id,
              holder = EXCLUDED.holder,
              level = EXCLUDED.level,
              level_since = CASE
                WHEN stamp_watch_notices.level = EXCLUDED.level THEN stamp_watch_notices.level_since
                ELSE GREATEST(EXCLUDED.level_since, stamp_watch_notices.since)
              END,
              message = EXCLUDED.message`,
      [reading.batchId, reading.nodeId, reading.holder, reading.level, at, reading.message],
    );
  }

  async remove(batchIds: readonly string[]): Promise<void> {
    if (batchIds.length === 0) return;
    await this.pool.query('DELETE FROM stamp_watch_notices WHERE batch_id = ANY($1::text[])', [batchIds]);
  }

  async setNotified(stamps: readonly { batchId: string; level: UnmarkedStampLevel }[], at: Date): Promise<void> {
    if (stamps.length === 0) return;
    await this.pool.query(
      `UPDATE stamp_watch_notices AS watched
          SET notified_level = told.level, notified_at = $3
         FROM unnest($1::text[], $2::text[]) AS told (batch_id, level)
        WHERE watched.batch_id = told.batch_id`,
      [stamps.map((stamp) => stamp.batchId), stamps.map((stamp) => stamp.level), at],
    );
  }
}
