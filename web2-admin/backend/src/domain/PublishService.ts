import type {
  FeedStreamEntry,
  Rendition,
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
import {
  buildFeedEntry,
  ladderOnFeed,
  planReconcile,
  removeEntry,
  upsertEntry,
} from './feedEntries.js';
import type { FeedGateway, FeedSnapshot } from './FeedGateway.js';
import type { FeedIdentity } from './feedIdentity.js';
import { Logger } from './Logger.js';
import { Mutex } from './Mutex.js';
import { toRendition } from './renditions.js';
import { hasPendingThumbnail } from './unpublishedEdits.js';

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
  /**
   * `entryContentEditedAt` here and on `recordRepublish` is the
   * `content_edited_at` of the row the entry was built from: which edit the
   * catalogue now carries, not when the write finished.
   */
  finishPublish(
    id: string,
    userId: string,
    feedIndex: number,
    thumbnailRef: string | null,
    entryContentEditedAt: Date | null,
  ): Promise<StreamRow | null>;
  finishUnpublish(id: string, userId: string): Promise<StreamRow | null>;
  recordRepublish(
    id: string,
    userId: string,
    feedIndex: number,
    thumbnailRef: string | null,
    entryContentEditedAt: Date | null,
  ): Promise<StreamRow | null>;
  /**
   * Records which edit a stream's entry carries after a write that rebuilt it
   * without being a publish of that stream: a reconcile. Touches nothing else.
   */
  recordEntryRebuilt(
    id: string,
    entryContentEditedAt: Date | null,
  ): Promise<void>;
  /**
   * Releases a `publishing` claim back to `previousStatus` with the reason. For
   * the first publish and the unpublish, which took the claim; nothing else.
   */
  failPublish(
    id: string,
    userId: string,
    previousStatus: StreamStatus,
    message: string,
  ): Promise<void>;
  /**
   * Records why a feed write failed and touches nothing else. For the republish
   * path, which takes no claim: the status is whatever the row says, and it is
   * not this method's to put back.
   */
  recordPublishError(
    id: string,
    userId: string,
    message: string,
  ): Promise<void>;
  /**
   * Every row that should be on the catalogue right now — status `published`,
   * `live` or `vod`, every user. Only `reconcile` uses it, and it has to see
   * all of them: a row it cannot see reads as an entry with nothing behind it.
   */
  listOnFeed(): Promise<StreamRow[]>;
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

/**
 * The record of what this backend wrote, and — since the Bee lookup turned out
 * to lag its own writes — the authority on where the next write goes.
 */
export interface FeedWriteLog {
  record(
    owner: string,
    topic: string,
    feedIndex: number,
    entryCount: number,
    payload: unknown[],
    reference: string | null,
  ): Promise<void>;
  lastWrite(
    owner: string,
    topic: string,
  ): Promise<{ index: number; entries: unknown[] } | null>;
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
  /**
   * The ladder the entry was written with, ascending by height. Read inside
   * the mutex, in the same step as the write, so a rendition report answers
   * with exactly what its write put on the catalogue. Empty for a stream with
   * no rungs, and after an unpublish.
   */
  renditions: Rendition[];
  /**
   * The ladder the stream's entry carried on the feed before this write: what
   * `upsertEntry` replaced, or `removeEntry` took off. Empty when there was no
   * entry, or it carried none.
   */
  previousRenditions: Rendition[];
}

/** What `reconcile` changed, or would have changed. Topics, not row ids. */
export interface ReconcileOutcome {
  /** Feed index of the repair write, or null when nothing needed repairing. */
  index: number | null;
  removed: string[];
  added: string[];
  updated: string[];
  entryCount: number;
}

/** What the boot check found when it compared the network to `feed_writes`. */
export interface FeedBootCheck {
  /** Index of the last write this backend recorded; null when it has none. */
  recorded: number | null;
  /** The network head, or null when there is none or Bee could not answer. */
  network: number | null;
  /** True when the network was ahead and its head became the new base. */
  adopted: boolean;
  /** Topics on the feed under our owner with no row behind them. */
  ghosts: string[];
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
 * The index and the base payload come from `feed_writes`, not from the
 * network. Bee's feed lookup does not reflect an update the node itself made
 * for up to ~30 s, and `head + 1` read from it put two writes on one index —
 * the second overwriting the first — and handed the next publish a payload
 * from before the previous one, which resurrected unpublished entries. The
 * database is written in the same step as the feed, under this mutex, by the
 * one process holding the key, so it cannot lag. The network is compared
 * against it once at boot (`checkFeedOnBoot`) and is the fallback only when
 * there is no recorded write at all.
 *
 * That makes "exactly one backend process writes a given feed key" an
 * invariant rather than a convention. Do not hand FEED_PRIVATE_KEY to a
 * running swarm-hls-stream uploader — it caches the feed's next index — and do
 * not run two backends against one key and two databases; the boot check will
 * shout, but only after the damage.
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
   *
   * `stream` only names the row. It is read again once the mutex is held,
   * because the wait for it can be long enough for another report to land — a
   * `live` arriving while a rung's write queues — and the entry has to say
   * what the row says at write time, not what the caller saw.
   */
  async republishWithState(stream: StreamRow): Promise<PublishOutcome> {
    return this.mutex.run(async () =>
      this.doRepublishWithState(await this.read(stream.id, stream.user_id)),
    );
  }

  /**
   * Rebuilds the catalogue from the database: drops entries of ours with no
   * published row behind them, rewrites entries that no longer match their
   * row, appends rows that are missing, and leaves everyone else's elements
   * exactly where they are.
   *
   * The operator repair for what the stale feed read left on the live feed —
   * an entry whose stream was unpublished, then deleted, so no request could
   * ever name it again. Nothing here touches a row: the database is the truth
   * this rewrites *towards*.
   *
   * Writes only when something changed, so running it on a clean catalogue
   * costs nothing. A failure is left as it is rather than dressed as a publish
   * failure: no status was moved, so there is nothing to put back.
   */
  async reconcile(userId?: string): Promise<ReconcileOutcome> {
    return this.mutex.run(async () => {
      const base = await this.baseSnapshot();
      const rows = await this.streams.listOnFeed();
      const plan = planReconcile(
        base.entries,
        rows,
        this.feed.owner,
        userId,
        Date.now(),
        await this.laddersOf(rows),
      );

      if (!plan.changed) {
        logger.info(
          `[Reconcile] catalogue already matches the database (${base.entries.length} entries); nothing written`,
        );
        return {
          index: null,
          removed: [],
          added: [],
          updated: [],
          entryCount: base.entries.length,
        };
      }

      const index = await this.writeFeed(plan.entries, base.index);
      logger.warn(
        `[Reconcile] rewrote the catalogue at feed index ${index} (${plan.entries.length} entries): removed [${plan.removed.join(', ')}], added [${plan.added.join(', ')}], updated [${plan.updated.join(', ')}]`,
      );
      await this.recordRebuiltEntries(rows, [...plan.updated, ...plan.added]);
      return {
        index,
        removed: plan.removed,
        added: plan.added,
        updated: plan.updated,
        entryCount: plan.entries.length,
      };
    });
  }

  /**
   * Boot-time cross-check of the one assumption the new index scheme rests on:
   * that this process is the only writer of this feed key.
   *
   * The network being *behind* `feed_writes` is the normal case — it is the
   * lookup lag that caused all of this. The network being *ahead* means
   * something else wrote under our key, or this database is not the one that
   * wrote the feed; the head and its payload are adopted as the base so the
   * next write goes after it rather than over it, and it is logged loudly
   * because no automatic repair can tell those two apart.
   *
   * Bee being unreachable is not fatal here: the check is a cross-check, and
   * the backend has everything it needs without it.
   */
  async checkFeedOnBoot(): Promise<FeedBootCheck> {
    return this.mutex.run(async () => {
      const last = await this.feedWrites.lastWrite(
        this.feed.owner,
        this.feed.topicHex,
      );

      let network: FeedSnapshot | null = null;
      try {
        network = await this.gateway.readLatest();
      } catch (error) {
        logger.warn(
          `[Boot] could not read the feed head to cross-check it: ${getErrorMessage(error)}`,
        );
      }

      let base: FeedSnapshot = last
        ? { index: last.index, entries: last.entries }
        : (network ?? { index: null, entries: [] });
      let adopted = false;

      if (last && network) {
        if (network.index === null || network.index < last.index) {
          logger.info(
            `[Boot] feed head is ${network.index ?? 'unwritten'}, the last write recorded here is ${last.index}: the node has not caught up with its own write yet`,
          );
        } else if (network.index > last.index) {
          logger.warn(
            `[Boot] feed head ${network.index} is AHEAD of the last write this backend recorded (${last.index}) — another writer under this key? Adopting the network head as the base, so the next write goes after it.`,
          );
          await this.feedWrites.record(
            this.feed.owner,
            this.feed.topicHex,
            network.index,
            network.entries.length,
            network.entries,
            null,
          );
          base = network;
          adopted = true;
        }
      }

      // The same diff `reconcile` would write, without writing it: a ghost
      // entry is invisible in the console (its row is gone) and only shows up
      // as a viewer seeing a stream that does not exist.
      const rows = await this.streams.listOnFeed();
      const plan = planReconcile(
        base.entries,
        rows,
        this.feed.owner,
        undefined,
        Date.now(),
        await this.laddersOf(rows),
      );
      if (plan.removed.length > 0) {
        logger.warn(
          `[Boot] ${plan.removed.length} catalogue entr${plan.removed.length === 1 ? 'y has' : 'ies have'} no stream row behind ${plan.removed.length === 1 ? 'it' : 'them'}: ${plan.removed.join(', ')} — POST /api/feed/reconcile removes ${plan.removed.length === 1 ? 'it' : 'them'}`,
        );
      }

      return {
        recorded: last?.index ?? null,
        network: network?.index ?? null,
        adopted,
        ghosts: plan.removed,
      };
    });
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
      const { entry, renditions } = await this.entryFor(claimed, thumbnailRef);
      const snapshot = await this.baseSnapshot();
      const previous = ladderOnFeed(snapshot.entries, entry.owner, entry.topic);
      const entries = upsertEntry(snapshot.entries, entry);
      const index = await this.writeFeed(entries, snapshot.index);

      // The claim refuses every edit until this returns, so `claimed` still
      // holds the edit the entry was built from.
      const stream = await this.streams.finishPublish(
        id,
        userId,
        index,
        thumbnailRef,
        claimed.content_edited_at,
      );
      if (!stream) throw new StreamNotFoundError(id);

      logger.info(
        `[Publish] ${claimed.topic} published at feed index ${index} (${entries.length} entries)`,
      );
      return this.outcome(stream, index, entries.length, renditions, previous);
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
      const snapshot = await this.baseSnapshot();
      const previous = ladderOnFeed(
        snapshot.entries,
        claimed.owner,
        claimed.topic,
      );
      const { entries, removed } = removeEntry(
        snapshot.entries,
        claimed.owner,
        claimed.topic,
      );

      // Nothing to take off the feed — a draft that was never published, or
      // one already removed. Skip the write rather than spend a stamp on an
      // identical list; `index` then reports the base, not a new write.
      //
      // This shortcut used to lie. The snapshot came from Bee's lookup, which
      // could still be showing the list from before the publish that put this
      // entry there, so "was not on the feed" meant "the node has not caught
      // up" and the entry stayed on the catalogue with the row back in
      // `draft`. The base is now the payload this backend last wrote, so the
      // absence is real.
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
      return this.outcome(stream, index, entries.length, [], previous);
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
   *
   * `current` is the row as it was read inside this mutex, and everything here
   * — the owner check, the entry, the log line, what a failure records — is
   * about that row, never about whatever the caller read before queueing.
   */
  private async doRepublishWithState(
    current: StreamRow,
  ): Promise<PublishOutcome> {
    const { id, user_id: userId } = current;
    if (!sameOwner(current.owner, this.feed.owner)) {
      throw new FeedOwnerMismatchError(id, current.owner, this.feed.owner);
    }

    try {
      const thumbnailRef = await this.ensureThumbnailUploaded(current, userId);
      const { entry, renditions } = await this.entryFor(current, thumbnailRef);
      const snapshot = await this.baseSnapshot();
      const previous = ladderOnFeed(snapshot.entries, entry.owner, entry.topic);
      const entries = upsertEntry(snapshot.entries, entry);
      const index = await this.writeFeed(entries, snapshot.index);

      // `current`'s edit, not whatever the row holds now: no claim is taken
      // here, so the console can save an edit while this write is on its way,
      // and that edit is not on the entry.
      const updated = await this.streams.recordRepublish(
        id,
        userId,
        index,
        thumbnailRef,
        current.content_edited_at,
      );
      if (!updated) throw new StreamNotFoundError(id);

      logger.info(
        `[Publish] ${current.topic} rewritten as ${current.status} at feed index ${index} (${entries.length} entries)`,
      );
      return this.outcome(updated, index, entries.length, renditions, previous);
    } catch (error) {
      // No claim was taken, so there is no status to put back — and none may
      // be: the row's status is the uploader's last report, which can be newer
      // than anything this call has seen. Only the reason is recorded.
      throw await this.failRepublish(id, userId, error);
    }
  }

  private async read(id: string, userId: string): Promise<StreamRow> {
    const stream = await this.streams.findById(id, userId);
    if (!stream) throw new StreamNotFoundError(id);
    return stream;
  }

  /**
   * The ladder of every row a reconcile rebuilds an entry for, by stream id.
   *
   * Read for the same reason `entryFor` reads it on every single write: an
   * entry rebuilt from the row alone has no `renditions`, so a reconcile that
   * did not look would count every ladder as drifted and then write the drift,
   * taking the ladder off the catalogue until its next rung report. One query
   * per row, and a reconcile is rare and already reads every row.
   */
  private async laddersOf(
    rows: readonly StreamRow[],
  ): Promise<Map<string, Rendition[]>> {
    const ladders = new Map<string, Rendition[]>();
    for (const row of rows) {
      const rungs = await this.renditions.listByStream(row.id);
      if (rungs.length > 0) ladders.set(row.id, rungs.map(toRendition));
    }
    return ladders;
  }

  /**
   * Tells each row whose entry a reconcile rewrote or added which edit that
   * entry now carries, as a publish does for its one row. `topics` are the
   * ones the plan rewrote or added, and each of those entries was built from
   * its row in `rows`, read inside this same mutex, so that row's
   * `content_edited_at` is the edit the entry carries.
   *
   * A row with an image waiting to be uploaded is left out. A reconcile
   * uploads nothing, so its entry went out without that image, and the
   * console has to keep asking for the republish that uploads it.
   */
  private async recordRebuiltEntries(
    rows: readonly StreamRow[],
    topics: readonly string[],
  ): Promise<void> {
    const rebuilt = new Set(topics.map((topic) => topic.toLowerCase()));
    for (const row of rows) {
      if (!rebuilt.has(row.topic.toLowerCase())) continue;
      if (hasPendingThumbnail(row)) continue;
      await this.streams.recordEntryRebuilt(row.id, row.content_edited_at);
    }
  }

  /**
   * The stream's entry as it should stand right now, ladder included — and
   * that ladder on its own, for the outcome.
   *
   * The rungs are read here, on every write, rather than handed in by the
   * caller: a hand republish and a state report have to carry the ladder just
   * as a rendition report does, and forgetting one of them would silently take
   * the renditions off the entry until the next rung reported. A stream with
   * no rungs reads back an empty list and an entry identical to what it was
   * before ABR existed. Handing the ladder back is what lets a rendition
   * report answer with the ladder its write actually put on the catalogue,
   * rather than with a second read that may already describe a later write.
   */
  private async entryFor(
    stream: StreamRow,
    thumbnailRef: string | null,
  ): Promise<{ entry: FeedStreamEntry; renditions: Rendition[] }> {
    const renditions = (await this.renditions.listByStream(stream.id)).map(
      toRendition,
    );
    const entry = buildFeedEntry(stream, thumbnailRef, Date.now(), renditions);
    return { entry, renditions };
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

  /**
   * The list this write starts from, and the index it goes after.
   *
   * `feed_writes` first, because it is the only record that is never stale.
   * The network is asked only when this feed has no recorded write — a fresh
   * install, or a database whose rows all predate migration 003 — and that is
   * logged, because it is the one moment the old failure mode can still bite.
   */
  private async baseSnapshot(): Promise<FeedSnapshot> {
    const last = await this.feedWrites.lastWrite(
      this.feed.owner,
      this.feed.topicHex,
    );
    if (last) return { index: last.index, entries: last.entries };

    const snapshot = await this.gateway.readLatest();
    logger.info(
      `[Publish] no recorded write for feed ${this.feed.owner}/${this.feed.topicHex}; falling back to the network head (${snapshot.index ?? 'none'})`,
    );
    return snapshot;
  }

  /** Writes at the index after the base; index 0 when the feed is empty. */
  private async writeFeed(
    entries: unknown[],
    head: number | null,
  ): Promise<number> {
    const index = head === null ? 0 : head + 1;
    const reference = await this.gateway.write(entries, index);
    await this.feedWrites.record(
      this.feed.owner,
      this.feed.topicHex,
      index,
      entries.length,
      entries,
      reference,
    );
    return index;
  }

  /** A publish or unpublish failed: release the claim, and record why. */
  private fail(
    id: string,
    userId: string,
    previousStatus: StreamStatus,
    error: unknown,
  ): Promise<Error> {
    return this.failed(id, error, (message) =>
      this.streams.failPublish(id, userId, previousStatus, message),
    );
  }

  /** A republish failed: there is no claim to release, so only record why. */
  private failRepublish(
    id: string,
    userId: string,
    error: unknown,
  ): Promise<Error> {
    return this.failed(id, error, (message) =>
      this.streams.recordPublishError(id, userId, message),
    );
  }

  private async failed(
    id: string,
    error: unknown,
    record: (message: string) => Promise<void>,
  ): Promise<Error> {
    const message = getErrorMessage(error);
    try {
      await record(message);
    } catch (recordError) {
      // After a publish the row is stuck in `publishing` and boot clears it;
      // after a republish only the reason is lost. Log both, and still report
      // the original failure to the caller.
      logger.error(
        `[Publish] Could not record the failure of ${id}: ${getErrorMessage(recordError)}`,
      );
    }
    logger.error(`[Publish] ${id} failed: ${message}`);
    return new PublishFailedError(id, message);
  }

  private outcome(
    stream: StreamRow,
    index: number,
    entryCount: number,
    renditions: Rendition[],
    previousRenditions: Rendition[],
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
      renditions,
      previousRenditions,
    };
  }
}
