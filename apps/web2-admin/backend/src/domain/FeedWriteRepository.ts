import { Pool } from 'pg';

import { FeedFormatError } from './errors/index.js';

/** The newest write this backend recorded for one feed. */
export interface LastFeedWrite {
  index: number;
  /** The payload of that write, element by element, exactly as it was sent. */
  entries: unknown[];
  /** Chunk reference hex, or null for a head adopted from the network at boot. */
  reference: string | null;
}

/**
 * The log of what this backend put on the stream list feed — and, since
 * migration 003, the authority on where the next write goes.
 *
 * Bee's feed lookup lags the node's own previous write by up to ~30 s, so
 * `head + 1` read from the network put two different writes on one index and
 * lost the earlier one. This table never lags: it is written in the same step
 * as the feed write, under the publish mutex, by the one process that owns the
 * key. `lastWrite` is what the next index and the next base payload come from;
 * the network is a cross-check at boot, not the source.
 *
 * Rows from before migration 003 carry NULL owner/topic and are invisible here
 * on purpose — they cannot be attributed to a feed key, and one that belongs
 * to a rotated key would answer for the wrong feed.
 */
export class FeedWriteRepository {
  constructor(private readonly pool: Pool) {}

  async record(
    owner: string,
    topic: string,
    feedIndex: number,
    entryCount: number,
    payload: unknown[],
    reference: string | null,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO feed_writes
         (feed_owner, feed_topic, feed_index, entry_count, payload, reference)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [normalise(owner), normalise(topic), feedIndex, entryCount, JSON.stringify(payload), reference],
    );
  }

  /** The highest index recorded for this feed, with the payload written there. */
  async lastWrite(owner: string, topic: string): Promise<LastFeedWrite | null> {
    const result = await this.pool.query<{
      feed_index: number;
      payload: unknown;
      reference: string | null;
    }>(
      `SELECT feed_index, payload, reference
         FROM feed_writes
        WHERE feed_owner = $1 AND feed_topic = $2
        ORDER BY feed_index DESC
        LIMIT 1`,
      [normalise(owner), normalise(topic)],
    );

    const row = result.rows[0];
    if (!row) return null;
    if (!Array.isArray(row.payload)) {
      // Only this backend writes the column, so this is corruption rather than
      // someone else's format. Stop instead of rewriting the catalogue from it.
      throw new FeedFormatError(`feed_writes row at index ${row.feed_index} is not a JSON array`);
    }
    return {
      index: row.feed_index,
      entries: row.payload,
      reference: row.reference,
    };
  }
}

/** Owner and topic are hex; case has never been load-bearing. */
function normalise(value: string): string {
  return value.toLowerCase();
}
