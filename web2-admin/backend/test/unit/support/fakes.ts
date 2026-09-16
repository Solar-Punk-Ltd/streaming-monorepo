/**
 * In-memory stand-ins for the two ports PublishService depends on, next to
 * FakeFeedGateway (which is production code, selected by FEED_GATEWAY=fake).
 *
 * FakeStreamStore copies the semantics that matter from StreamRepository: the
 * status transitions are conditional, exactly as the SQL is, so a claim on a
 * row that is already `publishing` returns null here too.
 */
import type { StreamStatus } from '@streaming-monorepo/web2-admin-common';

import type {
  FeedWriteLog,
  PublishStreamStore,
} from '../../../src/domain/PublishService.js';
import type { StreamRow, ThumbnailRow } from '../../../src/types/index.js';

export const TEST_OWNER = '19e7e376e7c213b7e7e7e46cc70a5dd086daff2a';
export const TEST_USER_ID = '00000000-0000-4000-8000-000000000001';

let sequence = 0;

export function streamRow(over: Partial<StreamRow> = {}): StreamRow {
  sequence += 1;
  const at = new Date('2026-09-11T10:00:00.000Z');
  return {
    id: `00000000-0000-4000-8000-0000000000${String(sequence).padStart(2, '0')}`,
    user_id: TEST_USER_ID,
    topic: `1867808f-7b1c-4e46-b437-f7423b4660${String(sequence).padStart(2, '0')}`,
    owner: TEST_OWNER,
    title: 'Devcon keynote',
    description: 'The opening talk.',
    tags: ['swarm'],
    media_type: 'video',
    scheduled_start_time: new Date('2026-10-01T09:00:00.000Z'),
    has_thumbnail: false,
    thumbnail_mime: null,
    thumbnail_ref: null,
    status: 'draft',
    published_at: null,
    published_feed_index: null,
    publish_error: null,
    publish_key: '0123456789abcdef0123456789abcdef',
    publish_key_rotated_at: null,
    manifest_index: null,
    duration_seconds: null,
    live_since: null,
    ended_at: null,
    created_at: at,
    updated_at: at,
    ...over,
  };
}

export class FakeStreamStore implements PublishStreamStore {
  readonly rows = new Map<string, StreamRow>();
  readonly thumbnails = new Map<string, ThumbnailRow>();
  /** Set to make the status write fail, as a lost connection would. */
  failNextFailPublish: Error | null = null;

  add(row: StreamRow, thumbnail?: ThumbnailRow): StreamRow {
    this.rows.set(row.id, row);
    if (thumbnail) this.thumbnails.set(row.id, thumbnail);
    return row;
  }

  get(id: string): StreamRow {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no such row: ${id}`);
    return row;
  }

  async findById(id: string, userId: string): Promise<StreamRow | null> {
    const row = this.rows.get(id);
    return row && row.user_id === userId ? { ...row } : null;
  }

  /** Unscoped, as the SQL is: reconcile has to see every user's rows. */
  async listOnFeed(): Promise<StreamRow[]> {
    return [...this.rows.values()]
      .filter((row) => ['published', 'live', 'vod'].includes(row.status))
      .map((row) => ({ ...row }));
  }

  async findThumbnail(
    id: string,
    userId: string,
  ): Promise<ThumbnailRow | null> {
    if (!(await this.findById(id, userId))) return null;
    return this.thumbnails.get(id) ?? null;
  }

  async recordThumbnailRef(
    id: string,
    userId: string,
    thumbnailRef: string,
  ): Promise<void> {
    if (!(await this.findById(id, userId))) return;
    this.patch(id, { thumbnail_ref: thumbnailRef });
  }

  async claimForPublish(
    id: string,
    userId: string,
    allowedFrom: readonly StreamStatus[],
  ): Promise<StreamRow | null> {
    const row = this.rows.get(id);
    if (!row || row.user_id !== userId || !allowedFrom.includes(row.status)) {
      return null;
    }
    return this.patch(id, { status: 'publishing' });
  }

  async finishPublish(
    id: string,
    userId: string,
    feedIndex: number,
    thumbnailRef: string | null,
  ): Promise<StreamRow | null> {
    if (!(await this.findById(id, userId))) return null;
    return this.patch(id, {
      status: 'published',
      published_at: new Date('2026-09-11T11:00:00.000Z'),
      published_feed_index: feedIndex,
      publish_error: null,
      thumbnail_ref: thumbnailRef,
    });
  }

  async finishUnpublish(
    id: string,
    userId: string,
  ): Promise<StreamRow | null> {
    if (!(await this.findById(id, userId))) return null;
    return this.patch(id, {
      status: 'draft',
      published_at: null,
      published_feed_index: null,
      publish_error: null,
    });
  }

  /** Status untouched, exactly as the SQL is: a republish keeps its state. */
  async recordRepublish(
    id: string,
    userId: string,
    feedIndex: number,
    thumbnailRef: string | null,
  ): Promise<StreamRow | null> {
    if (!(await this.findById(id, userId))) return null;
    return this.patch(id, {
      published_feed_index: feedIndex,
      publish_error: null,
      thumbnail_ref: thumbnailRef,
    });
  }

  async failPublish(
    id: string,
    userId: string,
    previousStatus: StreamStatus,
    message: string,
  ): Promise<void> {
    if (this.failNextFailPublish) {
      const failure = this.failNextFailPublish;
      this.failNextFailPublish = null;
      throw failure;
    }
    if (!(await this.findById(id, userId))) return;
    this.patch(id, { status: previousStatus, publish_error: message });
  }

  private patch(id: string, changes: Partial<StreamRow>): StreamRow {
    const updated: StreamRow = {
      ...this.get(id),
      ...changes,
      updated_at: new Date('2026-09-11T11:00:00.000Z'),
    };
    this.rows.set(id, updated);
    return { ...updated };
  }
}

interface FakeFeedWriteRecord {
  owner: string;
  topic: string;
  feedIndex: number;
  entryCount: number;
  payload: unknown[];
  reference: string | null;
}

/**
 * The log, and — as in production since migration 003 — the authority on the
 * next index. Keyed by `(owner, topic)` exactly as the partial unique index
 * is, so a test that rotates the feed key gets its own sequence.
 */
export class FakeFeedWriteLog implements FeedWriteLog {
  readonly records: FakeFeedWriteRecord[] = [];

  async record(
    owner: string,
    topic: string,
    feedIndex: number,
    entryCount: number,
    payload: unknown[],
    reference: string | null,
  ): Promise<void> {
    this.records.push({
      owner,
      topic,
      feedIndex,
      entryCount,
      payload,
      reference,
    });
  }

  async lastWrite(
    owner: string,
    topic: string,
  ): Promise<{ index: number; entries: unknown[] } | null> {
    const mine = this.records.filter(
      (r) => r.owner === owner && r.topic === topic,
    );
    if (mine.length === 0) return null;
    const last = mine.reduce((a, b) => (b.feedIndex > a.feedIndex ? b : a));
    return { index: last.feedIndex, entries: last.payload };
  }
}
