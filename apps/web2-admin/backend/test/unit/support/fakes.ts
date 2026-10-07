/**
 * In-memory stand-ins for the ports the stream services depend on, next to
 * FakeFeedGateway (which is production code, selected by FEED_GATEWAY=fake).
 *
 * FakeStreamStore copies the semantics that matter from StreamRepository: the
 * status transitions are conditional, exactly as the SQL is, so a claim on a
 * row that is already `publishing` returns null here too, and `markLive`
 * un-finishes the stream's rungs the way the CTE in the real statement does.
 *
 * InMemoryAuditLog keeps what the services record, and can be told to fail
 * its next write, which is how the tests prove a failed audit write never
 * fails the operation it describes.
 */
import { sameFeedOwner } from '@streaming-monorepo/contracts';
import type { Rendition, StreamStatus } from '@streaming-monorepo/web2-admin-common';

import type { OperatorActor } from '../../../src/domain/actor.js';
import type { AuditAction, AuditEntry, AuditLog } from '../../../src/domain/AuditLog.js';
import { asFeedOwner } from '../../../src/domain/feedIdentity.js';
import type { IngestStreamStore } from '../../../src/domain/IngestService.js';
import type { LadderRenditionStore, LadderStreamStore } from '../../../src/domain/LadderService.js';
import type { FeedWriteRecord } from '../../../src/domain/FeedWriteRepository.js';
import type {
  CatalogueTargets,
  FeedWriteLog,
  PublishRenditionStore,
  PublishStreamStore,
} from '../../../src/domain/PublishService.js';
import type { OrphanedPublishingStore } from '../../../src/domain/resetOrphanedPublishing.js';
import type {
  ClearedThumbnail,
  StoredThumbnail,
  StreamInsertData,
  StreamUpdateData,
} from '../../../src/domain/StreamRepository.js';
import type { StreamServiceStore } from '../../../src/domain/StreamService.js';
import type { StateStreamStore } from '../../../src/domain/StreamStateService.js';
import { holdsRecording, type PublishedStatus } from '../../../src/domain/streamState.js';
import type { StreamRenditionRow, StreamRow, ThumbnailRow } from '../../../src/types/index.js';

import { STAGE_ID } from './stageFakes.js';

export const TEST_OWNER = '19e7e376e7c213b7e7e7e46cc70a5dd086daff2a';
export const TEST_USER_ID = '00000000-0000-4000-8000-000000000001';

/** The signed-in operator the stream tests act as. */
export const TEST_OPERATOR: OperatorActor = { kind: 'operator', userId: TEST_USER_ID, username: 'test-operator' };

/**
 * The audit log in memory. `failNextWrite` makes the next `record` throw, as a
 * lost connection would, and nothing is kept for that one.
 */
export class InMemoryAuditLog implements AuditLog {
  readonly entries: AuditEntry[] = [];
  failNextWrite: Error | null = null;

  async record(entry: AuditEntry): Promise<void> {
    if (this.failNextWrite) {
      const failure = this.failNextWrite;
      this.failNextWrite = null;
      throw failure;
    }
    this.entries.push(entry);
  }

  /** The entries with one action, in the order they were recorded. */
  withAction(action: AuditAction): AuditEntry[] {
    return this.entries.filter((entry) => entry.action === action);
  }
}

let sequence = 0;

export function streamRow(over: Partial<StreamRow> = {}): StreamRow {
  sequence += 1;
  const at = new Date('2026-09-11T10:00:00.000Z');
  return {
    id: `00000000-0000-4000-8000-0000000000${String(sequence).padStart(2, '0')}`,
    user_id: TEST_USER_ID,
    topic: `1867808f-7b1c-4e46-b437-f7423b4660${String(sequence).padStart(2, '0')}`,
    owner: TEST_OWNER,
    title: 'Opening keynote',
    description: 'The opening talk.',
    tags: ['swarm'],
    media_type: 'video',
    scheduled_start_time: new Date('2026-10-01T09:00:00.000Z'),
    has_thumbnail: false,
    thumbnail_mime: null,
    thumbnail_ref: null,
    thumbnail_batch_id: null,
    status: 'draft',
    published_at: null,
    published_feed_index: null,
    publish_error: null,
    publish_key: '0123456789abcdef0123456789abcdef',
    publish_key_rotated_at: null,
    recording_ref: null,
    duration_seconds: null,
    live_since: null,
    ended_at: null,
    content_edited_at: null,
    entry_content_edited_at: null,
    // On the stage `stageFakes` pushes, as every stream picked in the form now
    // is. A test about a stream without one says so.
    stage_id: STAGE_ID,
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
export class FakeRenditionStore implements PublishRenditionStore, LadderRenditionStore {
  readonly rows = new Map<string, StreamRenditionRow[]>();

  async listByStream(streamId: string): Promise<StreamRenditionRow[]> {
    return [...(this.rows.get(streamId) ?? [])].sort((a, b) => a.height - b.height || a.name.localeCompare(b.name));
  }

  async upsert(streamId: string, rendition: Rendition): Promise<StreamRenditionRow> {
    const row: StreamRenditionRow = {
      stream_id: streamId,
      name: rendition.name,
      width: rendition.width,
      height: rendition.height,
      topic: rendition.topic,
      bandwidth: rendition.bandwidth,
      avg_bandwidth: rendition.avgBandwidth,
      recording_ref: rendition.recording ?? null,
      duration_seconds: rendition.duration ?? null,
      updated_at: new Date('2026-09-11T11:00:00.000Z'),
    };
    const kept = (this.rows.get(streamId) ?? []).filter((existing) => existing.name !== row.name);
    this.rows.set(streamId, [...kept, row]);
    return row;
  }

  /**
   * Un-finishes every rung, as the CTE in `markLive` does for a stream coming
   * back from `vod`. A recording and its duration go together, which is the
   * migrations' CHECK and the reason nothing here clears one of them alone.
   */
  clearLadderIndexes(streamId: string): void {
    const rows = this.rows.get(streamId);
    if (!rows) return;
    this.rows.set(
      streamId,
      rows.map((row) => ({
        ...row,
        recording_ref: null,
        duration_seconds: null,
      })),
    );
  }
}

export class FakeStreamStore
  implements
    PublishStreamStore,
    LadderStreamStore,
    StateStreamStore,
    StreamServiceStore,
    IngestStreamStore,
    OrphanedPublishingStore
{
  readonly rows = new Map<string, StreamRow>();
  readonly thumbnails = new Map<string, ThumbnailRow>();
  /** Set to make the status write fail, as a lost connection would. */
  failNextFailPublish: Error | null = null;

  /**
   * The stages the move branch of `update` checks a new stage against, as the
   * SQL checks the stages table. Unset, every stage takes streams.
   */
  stages: { takesStreams(stageId: string): boolean; ownerOf(stageId: string): string | null } | null = null;

  /** Linked so `markLive` un-finishes the ladder, as the real SQL does. */
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
  async list(): Promise<StreamRow[]> {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  async insert(data: StreamInsertData): Promise<StreamRow> {
    return { ...this.add(streamRow({ ...data, scheduled_start_time: toDate(data.scheduled_start_time) })) };
  }

  /**
   * Conditional on `allowedFrom`, and `content_edited_at` moves only when a
   * value changes, as the SQL has it. A stage change is refused as the SQL
   * refuses it: unless the row is a draft that does not hold both a
   * recording and a stage, and the new stage, if any, takes streams.
   */
  async update(id: string, data: StreamUpdateData, allowedFrom: readonly StreamStatus[]): Promise<StreamRow | null> {
    const row = this.rows.get(id);
    if (!row || !allowedFrom.includes(row.status)) return null;
    const stageMoves = data.stage_id !== undefined && data.stage_id !== row.stage_id;
    if (stageMoves && !(row.status === 'draft' && (!holdsRecording(row) || row.stage_id === null))) {
      return null;
    }
    if (stageMoves && data.stage_id && this.stages && !this.stages.takesStreams(data.stage_id)) return null;
    // A row that holds a recording takes only a stage that signs as its owner.
    if (stageMoves && data.stage_id && this.stages && holdsRecording(row)) {
      const stageOwner = this.stages.ownerOf(data.stage_id);
      if (stageOwner === null || !sameFeedOwner(stageOwner, row.owner)) return null;
    }
    const scheduled = toDate(data.scheduled_start_time);
    const changed =
      row.title !== data.title ||
      row.description !== data.description ||
      row.tags.join('\n') !== data.tags.join('\n') ||
      row.media_type !== data.media_type ||
      (row.scheduled_start_time?.getTime() ?? null) !== (scheduled?.getTime() ?? null);
    return this.patch(id, {
      title: data.title,
      description: data.description,
      tags: [...data.tags],
      media_type: data.media_type,
      scheduled_start_time: scheduled,
      ...(changed ? { content_edited_at: new Date('2026-09-11T11:00:00.000Z') } : {}),
      ...(data.stage_id !== undefined ? { stage_id: data.stage_id } : {}),
      ...(data.owner !== undefined && !holdsRecording(row) ? { owner: data.owner } : {}),
    });
  }

  async deleteById(id: string, allowedFrom: readonly StreamStatus[]): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || !allowedFrom.includes(row.status)) return false;
    this.rows.delete(id);
    this.thumbnails.delete(id);
    return true;
  }

  async setThumbnail(
    id: string,
    bytes: Buffer,
    mime: string,
    allowedFrom: readonly StreamStatus[],
  ): Promise<StreamRow | null> {
    const row = this.rows.get(id);
    if (!row || !allowedFrom.includes(row.status)) return null;
    this.thumbnails.set(id, { thumbnail: bytes, thumbnail_mime: mime });
    return this.patch(id, {
      has_thumbnail: true,
      thumbnail_mime: mime,
      thumbnail_ref: null,
      thumbnail_batch_id: null,
      content_edited_at: new Date('2026-09-11T11:00:00.000Z'),
    });
  }

  /** An edit only when there was an image, and says whether there was, as the SQL does. */
  async clearThumbnail(id: string, allowedFrom: readonly StreamStatus[]): Promise<ClearedThumbnail | null> {
    const row = this.rows.get(id);
    if (!row || !allowedFrom.includes(row.status)) return null;
    this.thumbnails.delete(id);
    const stream = this.patch(id, {
      has_thumbnail: false,
      thumbnail_mime: null,
      thumbnail_ref: null,
      thumbnail_batch_id: null,
      ...(row.has_thumbnail ? { content_edited_at: new Date('2026-09-11T11:00:00.000Z') } : {}),
    });
    return { stream, removed: row.has_thumbnail };
  }

  async rotatePublishKey(id: string, publishKey: string): Promise<StreamRow | null> {
    if (!this.rows.has(id)) return null;
    return this.patch(id, { publish_key: publishKey, publish_key_rotated_at: new Date('2026-09-11T11:00:00.000Z') });
  }

  /** As the SQL is: back to `published` when the row was on the feed before. */
  async resetOrphanedPublishing(): Promise<StreamRow[]> {
    const orphans = [...this.rows.values()].filter((row) => row.status === 'publishing');
    return orphans.map((row) =>
      this.patch(row.id, {
        status: row.published_feed_index === null ? 'draft' : 'published',
        publish_error: 'backend restarted while publishing',
      }),
    );
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
   * every rung's recording and duration through the linked ladder.
   *
   * ⚠️ That the rungs are cleared at all is a property of the CTE in
   * `markLive`, and no fake can stand in for it — a statement that clears none
   * of them returns exactly the row one that clears them all returns, so this
   * method would keep the tests below green either way. It has been wrong once.
   * The real SQL is pinned in `test/integration/streamRepository.test.ts`; the
   * tests here say what the service does with the answer, not that the answer
   * is right.
   */
  async markLive(id: string, allowedFrom: readonly StreamStatus[]): Promise<StreamRow | null> {
    const row = this.rows.get(id);
    if (!row || !allowedFrom.includes(row.status)) return null;
    if (row.status === 'vod') this.renditions?.clearLadderIndexes(id);
    return this.patch(id, {
      status: 'live',
      live_since:
        row.status === 'live' && row.live_since !== null ? row.live_since : new Date('2026-09-11T11:00:00.000Z'),
      recording_ref: null,
      duration_seconds: null,
      ended_at: null,
      publish_error: null,
    });
  }

  /** The `vod` report: where the recording is. `live_since` is left alone. */
  async markVod(
    id: string,
    allowedFrom: readonly StreamStatus[],
    recordingRef: string,
    durationSeconds: number,
  ): Promise<StreamRow | null> {
    const row = this.rows.get(id);
    if (!row || !allowedFrom.includes(row.status)) return null;
    return this.patch(id, {
      status: 'vod',
      recording_ref: recordingRef,
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

  async recordThumbnailRef(id: string, thumbnailRef: string, batchId: string | null = null): Promise<void> {
    if (!(await this.findById(id))) return;
    this.patch(id, { thumbnail_ref: thumbnailRef, thumbnail_batch_id: batchId });
  }

  /** As the SQL is: every stream's named thumbnail, once per reference, with its bytes while the row holds them. */
  async listStoredThumbnails(): Promise<StoredThumbnail[]> {
    const seen = new Map<string, StoredThumbnail>();
    for (const row of this.rows.values()) {
      if (!row.thumbnail_ref) continue;
      const stored = this.thumbnails.get(row.id);
      const candidate = {
        reference: row.thumbnail_ref,
        thumbnail: stored?.thumbnail ?? null,
        thumbnail_mime: stored?.thumbnail_mime ?? row.thumbnail_mime,
        topic: row.topic,
      };
      if (!seen.get(row.thumbnail_ref)?.thumbnail) seen.set(row.thumbnail_ref, candidate);
    }
    return [...seen.values()];
  }

  async recordThumbnailBatch(reference: string, batchId: string): Promise<void> {
    for (const row of this.rows.values()) {
      if (row.thumbnail_ref === reference) this.patch(row.id, { thumbnail_batch_id: batchId });
    }
  }

  /** The SQL's `CASE WHEN thumbnail_ref IS DISTINCT FROM $3 THEN NULL ELSE thumbnail_batch_id END`. */
  private thumbnailBatchAfter(id: string, thumbnailRef: string | null): { thumbnail_batch_id?: null } {
    return this.rows.get(id)?.thumbnail_ref === thumbnailRef ? {} : { thumbnail_batch_id: null };
  }

  /** As the SQL is: with `draftNeedsStage`, a draft with no stage is not claimed either. */
  async claimForPublish(
    id: string,
    allowedFrom: readonly StreamStatus[],
    draftNeedsStage = false,
  ): Promise<StreamRow | null> {
    const row = this.rows.get(id);
    if (!row || !allowedFrom.includes(row.status)) return null;
    if (draftNeedsStage && row.status === 'draft' && row.stage_id === null) return null;
    // A recorded draft is claimed only while its stage signs as its owner.
    if (draftNeedsStage && row.status === 'draft' && holdsRecording(row) && row.stage_id !== null) {
      const stageOwner = this.stages?.ownerOf(row.stage_id) ?? null;
      if (stageOwner !== null && !sameFeedOwner(stageOwner, row.owner)) return null;
    }
    // A draft with no recording takes its stage's owner as the stages table
    // holds it now, as the SQL does in the same statement.
    const stageOwner =
      draftNeedsStage && row.status === 'draft' && !holdsRecording(row) && row.stage_id !== null
        ? (this.stages?.ownerOf(row.stage_id) ?? null)
        : null;
    return this.patch(id, { status: 'publishing', ...(stageOwner !== null ? { owner: asFeedOwner(stageOwner) } : {}) });
  }

  async finishPublish(
    id: string,
    feedIndex: number,
    thumbnailRef: string | null,
    entryContentEditedAt: Date | null,
    status: PublishedStatus,
  ): Promise<StreamRow | null> {
    if (!(await this.findById(id))) return null;
    return this.patch(id, {
      status,
      published_at: new Date('2026-09-11T11:00:00.000Z'),
      published_feed_index: feedIndex,
      publish_error: null,
      ...this.thumbnailBatchAfter(id, thumbnailRef),
      thumbnail_ref: thumbnailRef,
      entry_content_edited_at: entryContentEditedAt,
    });
  }

  /** As the SQL is: `published_at` and `published_feed_index` stay, and a null status leaves the row's. */
  async finishWithoutWrite(
    id: string,
    thumbnailRef: string | null,
    entryContentEditedAt: Date | null,
    status: PublishedStatus | null,
  ): Promise<StreamRow | null> {
    if (!(await this.findById(id))) return null;
    return this.patch(id, {
      ...(status !== null ? { status } : {}),
      publish_error: null,
      ...this.thumbnailBatchAfter(id, thumbnailRef),
      thumbnail_ref: thumbnailRef,
      entry_content_edited_at: entryContentEditedAt,
    });
  }

  /** Keeps the recording and the rungs, as the SQL does. */
  async finishUnpublish(id: string): Promise<StreamRow | null> {
    if (!(await this.findById(id))) return null;
    return this.patch(id, {
      status: 'draft',
      published_at: null,
      published_feed_index: null,
      publish_error: null,
    });
  }

  /**
   * Status untouched, exactly as the SQL is: a republish keeps its state. The
   * rest of the row is read as it is now, so an edit that landed while the
   * entry was being written survives this, as it does in Postgres.
   */
  async recordRepublish(
    id: string,
    feedIndex: number,
    thumbnailRef: string | null,
    entryContentEditedAt: Date | null,
  ): Promise<StreamRow | null> {
    if (!(await this.findById(id))) return null;
    return this.patch(id, {
      published_feed_index: feedIndex,
      publish_error: null,
      ...this.thumbnailBatchAfter(id, thumbnailRef),
      thumbnail_ref: thumbnailRef,
      entry_content_edited_at: entryContentEditedAt,
    });
  }

  /** Only where the entry is and which edit it carries, as the SQL is. */
  async recordEntryRebuilt(id: string, feedIndex: number, entryContentEditedAt: Date | null): Promise<void> {
    if (!this.rows.has(id)) return;
    this.patch(id, { published_feed_index: feedIndex, entry_content_edited_at: entryContentEditedAt });
  }

  async failPublish(id: string, previousStatus: StreamStatus, message: string): Promise<void> {
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

function toDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

/**
 * The log, and — as in production since migration 003 — the authority on the
 * next index. Keyed by `(owner, topic)` exactly as the partial unique index
 * is, so a test that rotates the feed key gets its own sequence.
 */
export class FakeFeedWriteLog implements FeedWriteLog {
  readonly records: FeedWriteRecord[] = [];

  async record(write: FeedWriteRecord): Promise<void> {
    this.records.push(structuredClone(write));
  }

  async lastWrite(owner: string, topic: string): Promise<{ index: number; entries: unknown[] } | null> {
    const mine = this.records.filter((r) => r.owner === owner && r.topic === topic);
    if (mine.length === 0) return null;
    const last = mine.reduce((a, b) => (b.feedIndex > a.feedIndex ? b : a));
    return { index: last.feedIndex, entries: last.payload };
  }

  async countUnrecordedBatch(owner: string, topic: string): Promise<number> {
    return this.records.filter((r) => r.owner === owner && r.topic === topic && r.batchId === null).length;
  }
}

/**
 * No catalogue stamp, and none needed: what the in-memory gateway gets in a local run with no manager. The suites
 * about publishing itself use it; the catalogue batch rules have suites of their own over CatalogueBatchService.
 */
export function noCatalogueStamp(): CatalogueTargets {
  return {
    forWrite: async () => null,
    forRead: async () => ({ target: null }),
  };
}
