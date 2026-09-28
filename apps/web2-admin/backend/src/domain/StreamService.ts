import { randomBytes, randomUUID } from 'node:crypto';

import type { MediaType, StreamStatus } from '@streaming-monorepo/web2-admin-common';

import { EDITABLE_STATUSES, THUMBNAIL_MIME_TYPES, type StreamRow, type ThumbnailRow } from '../types/index.js';

import { describeActor, describeStream, type Actor, type OperatorActor } from './actor.js';
import { recordAudit, type AuditLog } from './AuditLog.js';

import {
  MediaTypeLockedError,
  StreamBusyError,
  StreamLiveError,
  StreamLockedError,
  StreamNotFoundError,
  StreamPublishedError,
  ThumbnailNotFoundError,
  UnsupportedMediaTypeError,
} from './errors/index.js';
import type { FeedIdentity } from './feedIdentity.js';
import { Logger } from './Logger.js';
import { isScheduleLocked } from './streamState.js';
import type { ClearedThumbnail, StreamInsertData, StreamUpdateData } from './StreamRepository.js';

const logger = Logger.getInstance();

/** The slice of StreamRepository the console's stream edits need; a fake stands in. */
export interface StreamServiceStore {
  list(): Promise<StreamRow[]>;
  findById(id: string): Promise<StreamRow | null>;
  findThumbnail(id: string): Promise<ThumbnailRow | null>;
  insert(data: StreamInsertData): Promise<StreamRow>;
  update(id: string, data: StreamUpdateData, allowedFrom: readonly StreamStatus[]): Promise<StreamRow | null>;
  deleteById(id: string, allowedFrom: readonly StreamStatus[]): Promise<boolean>;
  setThumbnail(
    id: string,
    bytes: Buffer,
    mime: string,
    allowedFrom: readonly StreamStatus[],
  ): Promise<StreamRow | null>;
  clearThumbnail(id: string, allowedFrom: readonly StreamStatus[]): Promise<ClearedThumbnail | null>;
}

/** A validated StreamInput, with tags and scheduledStartTime settled. */
export interface StreamInputValues {
  title: string;
  description: string;
  tags: string[];
  mediaType: MediaType;
  scheduledStartTime: string;
}

/**
 * Whether an edit would move a published stream's ingest address. The ingest
 * stream id is `<mediaType>/<topic>`, so the media type is half of what the
 * streamer has already typed into OBS — and, once the uploader looks drafts up
 * by that id, half of how the draft is found. A draft has told nobody anything
 * yet, and `publishing` is refused by the status transition instead.
 */
export function isMediaTypeLocked(stream: StreamRow, mediaType: MediaType): boolean {
  if (mediaType === stream.media_type) return false;
  return stream.status === 'published' || stream.status === 'live' || stream.status === 'vod';
}

/** The console's names for the fields an edit can change, as the form has them. */
export type EditableField = 'title' | 'description' | 'tags' | 'mediaType' | 'scheduledStartTime';

/**
 * Which of the form's fields differ between two versions of a row: what an
 * edit actually changed. The console PUTs the whole form on every save, so
 * this is usually shorter than what it sent, and often empty.
 */
export function changedFields(before: StreamRow, after: StreamRow): EditableField[] {
  const changed: EditableField[] = [];
  if (before.title !== after.title) changed.push('title');
  if (before.description !== after.description) changed.push('description');
  if (before.tags.length !== after.tags.length || before.tags.some((tag, i) => tag !== after.tags[i])) {
    changed.push('tags');
  }
  if (before.media_type !== after.media_type) changed.push('mediaType');
  if ((before.scheduled_start_time?.getTime() ?? null) !== (after.scheduled_start_time?.getTime() ?? null)) {
    changed.push('scheduledStartTime');
  }
  return changed;
}

/** 16 random bytes hex: the `key=` credential in an ingest URL. */
export function newPublishKey(): string {
  return randomBytes(16).toString('hex');
}

export class StreamService {
  constructor(
    private readonly streams: StreamServiceStore,
    private readonly feed: FeedIdentity,
    private readonly audit: AuditLog,
  ) {}

  async list(): Promise<StreamRow[]> {
    return this.streams.list();
  }

  async get(id: string): Promise<StreamRow> {
    const stream = await this.streams.findById(id);
    if (!stream) throw new StreamNotFoundError(id);
    return stream;
  }

  /**
   * The actor's user id is recorded on the row and never read back to scope
   * anything: it says who drafted the stream, not who may act on it. Only an
   * operator drafts one.
   */
  async create(actor: OperatorActor, input: StreamInputValues): Promise<StreamRow> {
    const created = await this.streams.insert({
      user_id: actor.userId,
      // The stream id viewers see. Minted here, not in the browser as
      // msrs-client did, so it is unique and owned by a row from the start.
      topic: randomUUID(),
      owner: this.feed.owner,
      title: input.title,
      description: input.description,
      tags: input.tags,
      media_type: input.mediaType,
      scheduled_start_time: input.scheduledStartTime,
      publish_key: newPublishKey(),
    });

    logger.info(`[Stream] ${describeActor(actor)} created ${describeStream(created)}`);
    await recordAudit(this.audit, {
      actor,
      action: 'stream.create',
      streamId: created.id,
      topic: created.topic,
      statusBefore: null,
      statusAfter: created.status,
      details: { title: created.title, mediaType: created.media_type },
    });
    return created;
  }

  /**
   * Editing a published stream leaves it published and does not touch the
   * feed: what the feed says is what was published, until the operator
   * republishes explicitly. The same holds once the stream is live or
   * recorded — a title fixed mid-broadcast reaches viewers on the next
   * republish, which keeps the state it is in.
   *
   * A save that changed nothing is logged but not audited: nothing moved, in
   * the row or in `content_edited_at`, and the console saves the whole form
   * every time.
   */
  async update(actor: Actor, id: string, input: StreamInputValues): Promise<StreamRow> {
    const existing = await this.streams.findById(id);
    if (!existing) throw new StreamNotFoundError(id);
    if (isMediaTypeLocked(existing, input.mediaType)) {
      throw new MediaTypeLockedError(id, existing.media_type);
    }
    if (isScheduleLocked(existing, input.scheduledStartTime)) {
      throw new StreamLockedError(id, 'scheduledStartTime');
    }

    const updated = await this.streams.update(
      id,
      {
        title: input.title,
        description: input.description,
        tags: input.tags,
        media_type: input.mediaType,
        scheduled_start_time: input.scheduledStartTime,
      },
      EDITABLE_STATUSES,
    );
    if (!updated) return this.refuse(id);

    const changed = changedFields(existing, updated);
    if (changed.length === 0) {
      logger.info(`[Stream] ${describeActor(actor)} saved ${describeStream(updated)} with no changes`);
      return updated;
    }

    logger.info(`[Stream] ${describeActor(actor)} updated ${describeStream(updated)}: ${changed.join(', ')}`);
    await recordAudit(this.audit, {
      actor,
      action: 'stream.update',
      streamId: updated.id,
      topic: updated.topic,
      statusBefore: existing.status,
      statusAfter: updated.status,
      details: { changed },
    });
    return updated;
  }

  /**
   * Read first so the log line and the audit row can still name the stream
   * once it is gone. The DELETE is conditional on its own, so a row that moves
   * out of `draft` between the two is refused, not deleted.
   */
  async remove(actor: Actor, id: string): Promise<void> {
    const before = await this.streams.findById(id);
    const deleted = await this.streams.deleteById(id, ['draft']);
    if (deleted) {
      const name = before ? describeStream(before) : id;
      logger.info(`[Stream] ${describeActor(actor)} deleted ${name}`);
      await recordAudit(this.audit, {
        actor,
        action: 'stream.delete',
        streamId: id,
        topic: before?.topic ?? null,
        statusBefore: 'draft',
        statusAfter: null,
        details: before ? { title: before.title } : null,
      });
      return;
    }

    const existing = await this.streams.findById(id);
    if (!existing) throw new StreamNotFoundError(id);
    if (existing.status === 'publishing') {
      throw new StreamBusyError(id, existing.status);
    }
    // A live stream cannot even be unpublished: only the streamer can end it.
    if (existing.status === 'live') throw new StreamLiveError(id);
    // published / vod: it is in the feed, so unpublish comes first.
    throw new StreamPublishedError(id, existing.status);
  }

  async setThumbnail(actor: Actor, id: string, contentType: string, bytes: Buffer): Promise<StreamRow> {
    const mime = normaliseThumbnailMime(contentType);
    if (!THUMBNAIL_MIME_TYPES.includes(mime)) {
      throw new UnsupportedMediaTypeError(contentType, THUMBNAIL_MIME_TYPES);
    }
    const updated = await this.streams.setThumbnail(id, bytes, mime, EDITABLE_STATUSES);
    if (!updated) return this.refuse(id);

    logger.info(
      `[Stream] ${describeActor(actor)} set the thumbnail of ${describeStream(updated)}: ${mime}, ${bytes.length} bytes`,
    );
    await recordAudit(this.audit, {
      actor,
      action: 'stream.thumbnail.set',
      streamId: updated.id,
      topic: updated.topic,
      statusBefore: updated.status,
      statusAfter: updated.status,
      details: { mime, bytes: bytes.length },
    });
    return updated;
  }

  async getThumbnail(id: string): Promise<ThumbnailRow> {
    const found = await this.streams.findThumbnail(id);
    if (found) return found;

    // Distinguish "no such stream" from "stream without a thumbnail": both are
    // 404s, but not the same one.
    const stream = await this.streams.findById(id);
    if (!stream) throw new StreamNotFoundError(id);
    throw new ThumbnailNotFoundError(id);
  }

  /**
   * Logged and audited only when there was an image to remove, which the
   * clear itself reports: it reads the row under its own lock, so an image
   * another operator set a moment earlier counts as removed, and two clears
   * that race record one entry between them.
   */
  async removeThumbnail(actor: Actor, id: string): Promise<StreamRow> {
    const cleared = await this.streams.clearThumbnail(id, EDITABLE_STATUSES);
    if (!cleared) return this.refuse(id);
    const { stream, removed } = cleared;
    if (!removed) return stream;

    logger.info(`[Stream] ${describeActor(actor)} cleared the thumbnail of ${describeStream(stream)}`);
    await recordAudit(this.audit, {
      actor,
      action: 'stream.thumbnail.clear',
      streamId: stream.id,
      topic: stream.topic,
      statusBefore: stream.status,
      statusAfter: stream.status,
    });
    return stream;
  }

  /**
   * A conditional UPDATE returned nothing: say which of the two reasons it
   * was. Always throws.
   */
  private async refuse(id: string): Promise<never> {
    const existing = await this.streams.findById(id);
    if (!existing) throw new StreamNotFoundError(id);
    throw new StreamBusyError(id, existing.status);
  }
}

/** `image/png; charset=binary` → `image/png`. */
export function normaliseThumbnailMime(contentType: string): string {
  return contentType.split(';')[0]!.trim().toLowerCase();
}
