/**
 * In-memory stand-ins for the ports PublishService depends on, next to
 * FakeFeedGateway (which is production code, selected by FEED_GATEWAY=fake).
 *
 * FakeStreamStore copies the semantics that matter from StreamRepository: the
 * status transitions are conditional, exactly as the SQL is, so a claim on a
 * row that is already `publishing` returns null here too, and `finishUnpublish`
 * drops the stream's rungs the way the CTE in the real statement does.
 */
import type {
  Rendition,
  StreamStatus,
} from '@streaming-monorepo/web2-admin-common';

import type {
  LadderRenditionStore,
  LadderStreamStore,
} from '../../../src/domain/LadderService.js';
import type {
  FeedWriteLog,
  PublishRenditionStore,
  PublishStreamStore,
} from '../../../src/domain/PublishService.js';
import type { StateStreamStore } from '../../../src/domain/StreamStateService.js';
import type {
  StreamRenditionRow,
  StreamRow,
  ThumbnailRow,
} from '../../../src/types/index.js';

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

/**
 * The rungs of the ladders in play, keyed by stream. Ordered by height on the
 * way out, like the SQL, so a test that stores 720p after 1080p still sees the
 * order the master playlist and the catalogue entry use.
 */
export class FakeRenditionStore
  implements PublishRenditionStore, LadderRenditionStore
{
  readonly rows = new Map<string, StreamRenditionRow[]>();

  async listByStream(streamId: string): Promise<StreamRenditionRow[]> {
    return [...(this.rows.get(streamId) ?? [])].sort(
      (a, b) => a.height - b.height || a.name.localeCompare(b.name),
    );
  }

  async upsert(
    streamId: string,
    rendition: Rendition,
  ): Promise<StreamRenditionRow> {
    const row: StreamRenditionRow = {
      stream_id: streamId,
      name: rendition.name,
      width: rendition.width,
      height: rendition.height,
      topic: rendition.topic,
      bandwidth: rendition.bandwidth,
      avg_bandwidth: rendition.avgBandwidth,
      manifest_index: rendition.index ?? null,
      duration_seconds: rendition.duration ?? null,
      updated_at: new Date('2026-09-11T11:00:00.000Z'),
    };
    const kept = (this.rows.get(streamId) ?? []).filter(
      (existing) => existing.name !== row.name,
    );
    this.rows.set(streamId, [...kept, row]);
    return row;
  }

  async deleteByStream(streamId: string): Promise<number> {
    const dropped = this.rows.get(streamId)?.length ?? 0;
    this.rows.delete(streamId);
    return dropped;
  }

  /**
   * Un-finishes every rung, as the CTE in `markLive` does for a stream coming
   * back from `vod`. Index and duration go together, which is the migration's
   * CHECK and the reason nothing here clears one of them alone.
   */
  clearLadderIndexes(streamId: string): void {
    const rows = this.rows.get(streamId);
    if (!rows) return;
    this.rows.set(
      streamId,
      rows.map((row) => ({
        ...row,
        manifest_index: null,
        duration_seconds: null,
      })),
    );
  }
}

export class FakeStreamStore
  implements PublishStreamStore, LadderStreamStore, StateStreamStore
{
  readonly rows = new Map<string, StreamRow>();
  readonly thumbnails = new Map<string, ThumbnailRow>();
  /** Set to make the status write fail, as a lost connection would. */
  failNextFailPublish: Error | null = null;

  /** Linked so `finishUnpublish` clears the ladder, as the real SQL does. */
  constructor(private readonly renditions?: FakeRenditionStore) {}

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

  /** Unscoped, as the SQL is: a stream belongs to the installation. */
  async findById(id: string): Promise<StreamRow | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  /** Unscoped, as the SQL is: `topic` is UNIQUE, so this is still one row. */
  async findByTopic(topic: string): Promise<StreamRow | null> {
    const row = [...this.rows.values()].find((r) => r.topic === topic);
    return row ? { ...row } : null;
  }

  /**
   * The `live` report, conditional exactly as the SQL is. A row coming back
   * from `vod` is un-finished in the same step: the recording columns, and
   * every rung's index and duration through the linked ladder.
   *
   * ⚠️ That the rungs are cleared at all is a property of the CTE in
   * `markLive`, and no fake can stand in for it — a statement that clears none
   * of them returns exactly the row one that clears them all returns, so this
   * method would keep the tests below green either way. It has been wrong once.
   * The real SQL is pinned in `test/integration/streamRepository.test.ts`; the
   * tests here say what the service does with the answer, not that the answer
   * is right.
   */
  async markLive(
    id: string,
    allowedFrom: readonly StreamStatus[],
  ): Promise<StreamRow | null> {
    const row = this.rows.get(id);
    if (!row || !allowedFrom.includes(row.status)) return null;
    if (row.status === 'vod') this.renditions?.clearLadderIndexes(id);
    return this.patch(id, {
      status: 'live',
      live_since:
        row.status === 'live' && row.live_since !== null
          ? row.live_since
          : new Date('2026-09-11T11:00:00.000Z'),
      manifest_index: null,
      duration_seconds: null,
      ended_at: null,
      publish_error: null,
    });
  }

  /** The `vod` report: where the recording is. `live_since` is left alone. */
  async markVod(
    id: string,
    allowedFrom: readonly StreamStatus[],
    manifestIndex: number,
    durationSeconds: number,
  ): Promise<StreamRow | null> {
    const row = this.rows.get(id);
    if (!row || !allowedFrom.includes(row.status)) return null;
    return this.patch(id, {
      status: 'vod',
      manifest_index: manifestIndex,
      duration_seconds: durationSeconds,
      ended_at: new Date('2026-09-11T11:00:00.000Z'),
      publish_error: null,
    });
  }

  /** As the SQL is: reconcile has to see every row that should be on the feed. */
  async listOnFeed(): Promise<StreamRow[]> {
    return [...this.rows.values()]
      .filter((row) => ['published', 'live', 'vod'].includes(row.status))
      .map((row) => ({ ...row }));
  }

  async findThumbnail(id: string): Promise<ThumbnailRow | null> {
    if (!(await this.findById(id))) return null;
    return this.thumbnails.get(id) ?? null;
  }

  async recordThumbnailRef(id: string, thumbnailRef: string): Promise<void> {
    if (!(await this.findById(id))) return;
    this.patch(id, { thumbnail_ref: thumbnailRef });
  }

  async claimForPublish(
    id: string,
    allowedFrom: readonly StreamStatus[],
  ): Promise<StreamRow | null> {
    const row = this.rows.get(id);
    if (!row || !allowedFrom.includes(row.status)) return null;
    return this.patch(id, { status: 'publishing' });
  }

  async finishPublish(
    id: string,
    feedIndex: number,
    thumbnailRef: string | null,
  ): Promise<StreamRow | null> {
    if (!(await this.findById(id))) return null;
    return this.patch(id, {
      status: 'published',
      published_at: new Date('2026-09-11T11:00:00.000Z'),
      published_feed_index: feedIndex,
      publish_error: null,
      thumbnail_ref: thumbnailRef,
    });
  }

  async finishUnpublish(id: string): Promise<StreamRow | null> {
    if (!(await this.findById(id))) return null;
    await this.renditions?.deleteByStream(id);
    // Everything the uploader reported goes with it, as the SQL does it: a
    // draft still carrying a manifest index or a `live_since` would describe a
    // recording that is no longer on the catalogue.
    return this.patch(id, {
      status: 'draft',
      published_at: null,
      published_feed_index: null,
      publish_error: null,
      manifest_index: null,
      duration_seconds: null,
      live_since: null,
      ended_at: null,
    });
  }

  /** Status untouched, exactly as the SQL is: a republish keeps its state. */
  async recordRepublish(
    id: string,
    feedIndex: number,
    thumbnailRef: string | null,
  ): Promise<StreamRow | null> {
    if (!(await this.findById(id))) return null;
    return this.patch(id, {
      published_feed_index: feedIndex,
      publish_error: null,
      thumbnail_ref: thumbnailRef,
    });
  }

  async failPublish(
    id: string,
    previousStatus: StreamStatus,
    message: string,
  ): Promise<void> {
    if (this.failNextFailPublish) {
      const failure = this.failNextFailPublish;
      this.failNextFailPublish = null;
      throw failure;
    }
    if (!(await this.findById(id))) return;
    this.patch(id, { status: previousStatus, publish_error: message });
  }

  /** Only the reason, as the SQL is: a republish has no claim to undo. */
  async recordPublishError(id: string, message: string): Promise<void> {
    if (!(await this.findById(id))) return;
    this.patch(id, { publish_error: message });
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
