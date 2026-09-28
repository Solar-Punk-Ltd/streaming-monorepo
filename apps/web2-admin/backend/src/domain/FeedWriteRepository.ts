import { Pool } from 'pg';

import { FeedFormatError } from './errors/index.js';

/** One row of `feed_writes`, as a write or the boot check's adoption records it. */
export interface FeedWriteRecord {
  owner: string;
  topic: string;
  feedIndex: number;
  entryCount: number;
  /** The list, element by element. */
  payload: unknown[];
  /**
   * The exact string uploaded as the payload (migration 013), or null for a head adopted from the network when the
   * gateway could not say what it read.
   */
  payloadText: string | null;
  /** Chunk reference hex, or null for a head adopted from the network at boot. */
  reference: string | null;
  /**
   * The batch that stamped the write, or null when the admin does not know it: a head adopted from the network, or a
   * write the in-memory gateway took with no catalogue stamp.
   */
  batchId: string | null;
}

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

  /**
   * `payload` is stored from `payloadText` when there is one, so the parsed column and the exact bytes cannot drift
   * apart; migration 013's CHECK holds them together as well.
   */
  async record(write: FeedWriteRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO feed_writes
         (feed_owner, feed_topic, feed_index, entry_count, payload, reference, payload_text, batch_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
      [
        normalise(write.owner),
        normalise(write.topic),
        write.feedIndex,
        write.entryCount,
        write.payloadText ?? JSON.stringify(write.payload),
        write.reference,
        write.payloadText,
        write.batchId,
      ],
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
