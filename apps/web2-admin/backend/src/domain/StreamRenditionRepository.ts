import type { Rendition } from '@streaming-monorepo/web2-admin-common';
import { Pool } from 'pg';

import type { StreamRenditionRow } from '../types/index.js';

import { STREAM_RENDITION_COLUMNS } from './streamSql.js';

/**
 * The rungs of each stream's ABR ladder (migration 004). No user scope, for
 * the same reason `StreamRepository` has none: a stream belongs to the
 * installation, and so does its ladder. The rungs are written by the internal
 * API, which acts on the stream id it handed the uploader and has no session
 * behind it, and read back whenever an entry is built.
 *
 * Deleting a stream takes its rungs with it through the foreign key. An
 * unpublish keeps them with the rest of the recording, so publishing the
 * draft again lists the recording with its ladder.
 */
export class StreamRenditionRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * The ladder, ascending by height — the order the master playlist and the
   * catalogue entry both use. `name` breaks a tie between two rungs of the
   * same height so the order is stable across reads.
   */
  async listByStream(streamId: string): Promise<StreamRenditionRow[]> {
    const result = await this.pool.query<StreamRenditionRow>(
      `SELECT ${STREAM_RENDITION_COLUMNS} FROM stream_renditions
        WHERE stream_id = $1
        ORDER BY height ASC, name ASC`,
      [streamId],
    );
    return result.rows;
  }

  /**
   * Stores one rung, replacing whatever that name held. The caller has already
   * merged the incoming report into the stored one, so what arrives here is
   * the whole row as it should now stand — including a null index, recording
   * and duration for a rung that has not finalized.
   */
  async upsert(streamId: string, rendition: Rendition): Promise<StreamRenditionRow> {
    const result = await this.pool.query<StreamRenditionRow>(
      `INSERT INTO stream_renditions (
         stream_id, name, width, height, topic, bandwidth, avg_bandwidth,
         manifest_index, recording_ref, duration_seconds, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (stream_id, name) DO UPDATE
          SET width = EXCLUDED.width,
              height = EXCLUDED.height,
              topic = EXCLUDED.topic,
              bandwidth = EXCLUDED.bandwidth,
              avg_bandwidth = EXCLUDED.avg_bandwidth,
              manifest_index = EXCLUDED.manifest_index,
              recording_ref = EXCLUDED.recording_ref,
              duration_seconds = EXCLUDED.duration_seconds,
              updated_at = NOW()
       RETURNING ${STREAM_RENDITION_COLUMNS}`,
      [
        streamId,
        rendition.name,
        rendition.width,
        rendition.height,
        rendition.topic,
        rendition.bandwidth,
        rendition.avgBandwidth,
        rendition.index ?? null,
        rendition.recording ?? null,
        rendition.duration ?? null,
      ],
    );
    return result.rows[0]!;
  }
}
