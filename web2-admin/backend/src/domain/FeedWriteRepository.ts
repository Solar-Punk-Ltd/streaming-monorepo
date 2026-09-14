import { Pool } from 'pg';

export class FeedWriteRepository {
  constructor(private readonly pool: Pool) {}

  /** Append-only log of what this backend wrote to the stream list feed. */
  async record(
    feedIndex: number,
    entryCount: number,
    payload: unknown[],
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO feed_writes (feed_index, entry_count, payload)
       VALUES ($1, $2, $3::jsonb)`,
      [feedIndex, entryCount, JSON.stringify(payload)],
    );
  }
}
