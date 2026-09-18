import { randomBytes, randomUUID } from 'node:crypto';

import type { MediaType } from '@streaming-monorepo/web2-admin-common';

import {
  EDITABLE_STATUSES,
  THUMBNAIL_MIME_TYPES,
  type StreamRow,
  type ThumbnailRow,
} from '../types/index.js';

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
import { isScheduleLocked } from './streamState.js';
import type { FeedIdentity } from './feedIdentity.js';
import { StreamRepository } from './StreamRepository.js';

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
export function isMediaTypeLocked(
  stream: StreamRow,
  mediaType: MediaType,
): boolean {
  if (mediaType === stream.media_type) return false;
  return (
    stream.status === 'published' ||
    stream.status === 'live' ||
    stream.status === 'vod'
  );
}

/** 16 random bytes hex: the `key=` credential in an ingest URL. */
export function newPublishKey(): string {
  return randomBytes(16).toString('hex');
}

export class StreamService {
  constructor(
    private readonly streams: StreamRepository,
    private readonly feed: FeedIdentity,
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
   * `userId` is recorded on the row and never read back to scope anything: it
   * says who drafted the stream, not who may act on it.
   */
  async create(userId: string, input: StreamInputValues): Promise<StreamRow> {
    return this.streams.insert({
      user_id: userId,
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
  }

  /**
   * Editing a published stream leaves it published and does not touch the
   * feed: what the feed says is what was published, until the operator
   * republishes explicitly. The same holds once the stream is live or
   * recorded — a title fixed mid-broadcast reaches viewers on the next
   * republish, which keeps the state it is in.
   */
  async update(id: string, input: StreamInputValues): Promise<StreamRow> {
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
    return updated ?? (await this.refuse(id));
  }

  async remove(id: string): Promise<void> {
    const deleted = await this.streams.deleteById(id, ['draft']);
    if (deleted) return;

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

  async setThumbnail(
    id: string,
    contentType: string,
    bytes: Buffer,
  ): Promise<StreamRow> {
    const mime = normaliseThumbnailMime(contentType);
    if (!THUMBNAIL_MIME_TYPES.includes(mime)) {
      throw new UnsupportedMediaTypeError(contentType, THUMBNAIL_MIME_TYPES);
    }
    const updated = await this.streams.setThumbnail(
      id,
      bytes,
      mime,
      EDITABLE_STATUSES,
    );
    return updated ?? (await this.refuse(id));
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

  async removeThumbnail(id: string): Promise<StreamRow> {
    const updated = await this.streams.clearThumbnail(id, EDITABLE_STATUSES);
    return updated ?? (await this.refuse(id));
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
