import type {
  FeedStreamEntry,
  StreamStatus,
} from '@streaming-monorepo/web2-admin-common';

import {
  PUBLISHABLE_STATUSES,
  UNPUBLISHABLE_STATUSES,
  type StreamRenditionRow,
  type StreamRow,
  type ThumbnailRow,
} from '../types/index.js';
import { getErrorMessage } from '../utils/errorUtils.js';

import {
  FeedOwnerMismatchError,
  PublishFailedError,
  StreamBusyError,
  StreamLiveError,
  StreamNotFoundError,
} from './errors/index.js';
import { buildFeedEntry, removeEntry, upsertEntry } from './feedEntries.js';
import type { FeedGateway } from './FeedGateway.js';
import type { FeedIdentity } from './feedIdentity.js';
import { Logger } from './Logger.js';
import { Mutex } from './Mutex.js';
import { toRendition } from './renditions.js';

const logger = Logger.getInstance();

/** The slice of StreamRepository publishing needs; a fake stands in for tests. */
export interface PublishStreamStore {
  findById(id: string, userId: string): Promise<StreamRow | null>;
  findThumbnail(id: string, userId: string): Promise<ThumbnailRow | null>;
  recordThumbnailRef(
    id: string,
    userId: string,
    thumbnailRef: string,
  ): Promise<void>;
  claimForPublish(
    id: string,
    userId: string,
    allowedFrom: readonly StreamStatus[],
  ): Promise<StreamRow | null>;
  finishPublish(
    id: string,
    userId: string,
    feedIndex: number,
    thumbnailRef: string | null,
  ): Promise<StreamRow | null>;
  finishUnpublish(id: string, userId: string): Promise<StreamRow | null>;
  recordRepublish(
    id: string,
    userId: string,
    feedIndex: number,
    thumbnailRef: string | null,
  ): Promise<StreamRow | null>;
  failPublish(
    id: string,
    userId: string,
    previousStatus: StreamStatus,
    message: string,
  ): Promise<void>;
}

/**
 * The slice of StreamRenditionRepository publishing needs: read-only. The
 * ladder is written by the rendition report, and every entry this service
 * builds — first publish, hand republish, state report — reads it back so the
 * catalogue never loses rungs that were reported between two writes.
 */
export interface PublishRenditionStore {
  listByStream(streamId: string): Promise<StreamRenditionRow[]>;
}

export interface FeedWriteLog {
  record(feedIndex: number, entryCount: number, payload: unknown[]): Promise<void>;
}

export interface PublishOutcome {
  stream: StreamRow;
  feed: {
    owner: string;
    topic: string;
    topicHex: string;
    index: number;
    entryCount: number;
  };
}

/** A stream the uploader has reported on; its entry carries that state. */
function hasReportedState(stream: StreamRow): boolean {
  return stream.status === 'live' || stream.status === 'vod';
}

/** Feed owners are hex addresses; case has never been load-bearing. */
function sameOwner(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

const THUMBNAIL_FILE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * Publishing is one writer on one feed that this backend owns.
 *
 * Do not hand FEED_PRIVATE_KEY to a running swarm-hls-stream uploader: it
 * caches the feed's next index, and two writers at one index fork the feed.
 * Checkpoint 3 turns that around and has the uploader report into this API.
 */
export class PublishService {
  constructor(
    private readonly streams: PublishStreamStore,
    private readonly renditions: PublishRenditionStore,
    private readonly feedWrites: FeedWriteLog,
    private readonly gateway: FeedGateway,
    private readonly feed: FeedIdentity,
    /** Every feed write in this process goes through this one mutex. */
    private readonly mutex: Mutex = new Mutex(),
  ) {}

  async publish(id: string, userId: string): Promise<PublishOutcome> {
    return this.mutex.run(async () => {
      const before = await this.read(id, userId);
      // A stream the uploader has reported on is republished as it is: the
      // operator fixed a title mid-broadcast, and the entry must go back on
      // the feed still saying `live` (or `vod`, with its index and duration).
      // The `publishing` claim the first publish uses would lose that.
      return hasReportedState(before)
        ? this.doRepublishWithState(before)
        : this.doPublish(before, userId);
    });
  }

  async unpublish(id: string, userId: string): Promise<PublishOutcome> {
    return this.mutex.run(() => this.doUnpublish(id, userId));
  }

  /**
   * Rewrites the catalogue entry of a stream whose status the uploader has
   * already changed on the row. The caller persists the state first and then
   * calls this, so a feed write that fails costs only the write: the state
   * stands, and a retry redoes nothing but the write.
   */
  async republishWithState(stream: StreamRow): Promise<PublishOutcome> {
    return this.mutex.run(() => this.doRepublishWithState(stream));
  }

  private async doPublish(
    before: StreamRow,
    userId: string,
  ): Promise<PublishOutcome> {
    const id = before.id;
    // The entry carries the row's `owner`, while the gateway signs with the
    // configured key. If those have drifted apart — the feed key was rotated
    // after this stream was created — the entry would advertise an owner the
    // feed is not published under, so refuse instead of writing a lie.
    if (!sameOwner(before.owner, this.feed.owner)) {
      throw new FeedOwnerMismatchError(id, before.owner, this.feed.owner);
    }

    const { claimed, previousStatus } = await this.claim(before, userId);

    try {
      const thumbnailRef = await this.ensureThumbnailUploaded(claimed, userId);
      const entry = await this.entryFor(claimed, thumbnailRef);
      const snapshot = await this.gateway.readLatest();
      const entries = upsertEntry(snapshot.entries, entry);
      const index = await this.writeFeed(entries, snapshot.index);

      const stream = await this.streams.finishPublish(
        id,
        userId,
        index,
        thumbnailRef,
      );
      if (!stream) throw new StreamNotFoundError(id);

      logger.info(
        `[Publish] ${claimed.topic} published at feed index ${index} (${entries.length} entries)`,
      );
      return this.outcome(stream, index, entries.length);
    } catch (error) {
      throw await this.fail(id, userId, previousStatus, error);
    }
  }

  private async doUnpublish(
    id: string,
    userId: string,
  ): Promise<PublishOutcome> {
    // No owner check: an entry written under an older feed key is removed by
    // the owner stored on the row, and refusing here would strand it.
    const before = await this.read(id, userId);
    // A recording can come off the catalogue; a live broadcast cannot, because
    // nothing here can stop the encoder that is still pushing to it.
    if (before.status === 'live') throw new StreamLiveError(id);
    const { claimed, previousStatus } = await this.claim(
      before,
      userId,
      UNPUBLISHABLE_STATUSES,
    );

    try {
      const snapshot = await this.gateway.readLatest();
      const { entries, removed } = removeEntry(
        snapshot.entries,
        claimed.owner,
        claimed.topic,
      );

      // Nothing to take off the feed — a draft that was never published, or
      // one already removed. Skip the write rather than spend a stamp on an
      // identical list; `index` then reports the head, not a new write.
      const index = removed
        ? await this.writeFeed(entries, snapshot.index)
        : (snapshot.index ?? 0);

      const stream = await this.streams.finishUnpublish(id, userId);
      if (!stream) throw new StreamNotFoundError(id);

      logger.info(
        `[Publish] ${claimed.topic} unpublished${
          removed ? ` at feed index ${index}` : ' (was not on the feed)'
        }`,
      );
      return this.outcome(stream, index, entries.length);
    } catch (error) {
      throw await this.fail(id, userId, previousStatus, error);
    }
  }

  /**
   * The write half of a state report, and of a republish of a stream that is
   * live or recorded. No `publishing` claim: the row already says what the
   * entry must say, and claiming it would both lose that and make the console
   * flicker through a status the stream is not in. The mutex still serialises
   * the feed write, which is what the claim protected on the feed's side.
   */
  private async doRepublishWithState(
    stream: StreamRow,
  ): Promise<PublishOutcome> {
    const { id, user_id: userId } = stream;
    if (!sameOwner(stream.owner, this.feed.owner)) {
      throw new FeedOwnerMismatchError(id, stream.owner, this.feed.owner);
    }

    try {
      const thumbnailRef = await this.ensureThumbnailUploaded(stream, userId);
      const entry = await this.entryFor(stream, thumbnailRef);
      const snapshot = await this.gateway.readLatest();
      const entries = upsertEntry(snapshot.entries, entry);
      const index = await this.writeFeed(entries, snapshot.index);

      const updated = await this.streams.recordRepublish(
        id,
        userId,
        index,
        thumbnailRef,
      );
      if (!updated) throw new StreamNotFoundError(id);

      logger.info(
        `[Publish] ${stream.topic} rewritten as ${stream.status} at feed index ${index} (${entries.length} entries)`,
      );
      return this.outcome(updated, index, entries.length);
    } catch (error) {
      // `previousStatus` is the status the row already has: this path never
      // moved it, so this only records why the write failed.
      throw await this.fail(id, userId, stream.status, error);
    }
  }

  private async read(id: string, userId: string): Promise<StreamRow> {
    const stream = await this.streams.findById(id, userId);
    if (!stream) throw new StreamNotFoundError(id);
    return stream;
  }

  /**
   * The stream's entry as it should stand right now, ladder included.
   *
   * The rungs are read here, on every write, rather than handed in by the
   * caller: a hand republish and a state report have to carry the ladder just
   * as a rendition report does, and forgetting one of them would silently take
   * the renditions off the entry until the next rung reported. A stream with
   * no rungs reads back an empty list and an entry identical to what it was
   * before ABR existed.
   */
  private async entryFor(
    stream: StreamRow,
    thumbnailRef: string | null,
  ): Promise<FeedStreamEntry> {
    const rungs = await this.renditions.listByStream(stream.id);
    return buildFeedEntry(
      stream,
      thumbnailRef,
      Date.now(),
      rungs.map(toRendition),
    );
  }

  /**
   * Step 1: take the row into `publishing`, remembering where to put it back.
   * `before` is the row as it was read a moment earlier, inside this mutex.
   */
  private async claim(
    before: StreamRow,
    userId: string,
    allowedFrom: readonly StreamStatus[] = PUBLISHABLE_STATUSES,
  ): Promise<{ claimed: StreamRow; previousStatus: StreamStatus }> {
    const claimed = await this.streams.claimForPublish(
      before.id,
      userId,
      allowedFrom,
    );
    if (!claimed) {
      // Re-read rather than trusting `before`: the row may have been deleted
      // between the two statements, which is a 404, not a 409.
      const current = await this.streams.findById(before.id, userId);
      if (!current) throw new StreamNotFoundError(before.id);
      throw new StreamBusyError(before.id, current.status);
    }

    return { claimed, previousStatus: before.status };
  }

  /**
   * Uploads the stored image when the gateway has nothing to serve for it. A
   * thumbnail PUT clears `thumbnail_ref`, so a null ref means "these bytes
   * were never uploaded"; a non-null one is reused instead of paying twice,
   * but only once the gateway confirms it still holds it.
   *
   * That check is not paranoia. A stored reference outlives the gateway that
   * produced it: one written under FEED_GATEWAY=fake is a fabrication, and
   * BEE_URL can be repointed at a node that never saw the chunks. Carrying
   * such a reference onto the feed gives every viewer a 404. A gateway that
   * cannot answer throws instead, and the publish fails rather than paying to
   * re-upload an image that is probably fine.
   */
  private async ensureThumbnailUploaded(
    stream: StreamRow,
    userId: string,
  ): Promise<string | null> {
    if (!stream.has_thumbnail) return stream.thumbnail_ref;
    if (
      stream.thumbnail_ref &&
      (await this.gateway.hasReference(stream.thumbnail_ref))
    ) {
      return stream.thumbnail_ref;
    }

    const stored = await this.streams.findThumbnail(stream.id, userId);
    if (!stored) return null;

    if (stream.thumbnail_ref) {
      logger.warn(
        `[Publish] ${stream.topic} thumbnail ${stream.thumbnail_ref} is not on the gateway; re-uploading`,
      );
    }

    const mime = stored.thumbnail_mime ?? 'image/png';
    const extension = THUMBNAIL_FILE_EXTENSIONS[mime] ?? 'bin';
    const reference = await this.gateway.uploadThumbnail(
      stored.thumbnail,
      `${stream.topic}.${extension}`,
      mime,
    );
    // Written now, not with the rest of the publish: the chunk is paid for
    // already, and a feed write that fails after this must not make the next
    // attempt upload the same image again.
    await this.streams.recordThumbnailRef(stream.id, userId, reference);
    return reference;
  }

  /** Writes at the index after the head; index 0 when the feed is empty. */
  private async writeFeed(
    entries: unknown[],
    head: number | null,
  ): Promise<number> {
    const index = head === null ? 0 : head + 1;
    await this.gateway.write(entries, index);
    await this.feedWrites.record(index, entries.length, entries);
    return index;
  }

  private async fail(
    id: string,
    userId: string,
    previousStatus: StreamStatus,
    error: unknown,
  ): Promise<Error> {
    const message = getErrorMessage(error);
    try {
      await this.streams.failPublish(id, userId, previousStatus, message);
    } catch (restoreError) {
      // The row is stuck in `publishing`; boot clears it. Log both, and still
      // report the original failure to the caller.
      logger.error(
        `[Publish] Could not restore status of ${id}: ${getErrorMessage(restoreError)}`,
      );
    }
    logger.error(`[Publish] ${id} failed: ${message}`);
    return new PublishFailedError(id, message);
  }

  private outcome(
    stream: StreamRow,
    index: number,
    entryCount: number,
  ): PublishOutcome {
    return {
      stream,
      feed: {
        owner: this.feed.owner,
        topic: this.feed.topic,
        topicHex: this.feed.topicHex,
        index,
        entryCount,
      },
    };
  }
}
