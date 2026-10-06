import { sameFeedOwner } from '@streaming-monorepo/contracts';
import type { FeedStreamEntry, Rendition, StreamStatus } from '@streaming-monorepo/web2-admin-common';

import {
  ON_FEED_STATUSES,
  PUBLISHABLE_STATUSES,
  UNPUBLISHABLE_STATUSES,
  type StreamRenditionRow,
  type StreamRow,
  type ThumbnailRow,
} from '../types/index.js';
import { getErrorMessage } from '../utils/errorUtils.js';

import { describeActor, describeStream, type Actor } from './actor.js';
import { recordAudit, type AuditLog } from './AuditLog.js';
import type { CatalogueBatchService } from './CatalogueBatch.js';
import { withoutCatalogueNode } from './catalogueNodeText.js';
import {
  CatalogueStampUnavailableError,
  FeedOwnerMismatchError,
  PublishFailedError,
  StageRequiredError,
  StageUnavailableError,
  StreamBusyError,
  StreamLiveError,
  StreamNotFoundError,
} from './errors/index.js';
import {
  buildFeedEntry,
  carriesEntry,
  ladderOnFeed,
  planReconcile,
  removeEntry,
  upsertEntry,
  withoutTopicUnderOtherOwners,
} from './feedEntries.js';
import { encodeFeedPayload, type CatalogueTarget, type FeedGateway, type FeedSnapshot } from './FeedGateway.js';
import type { FeedIdentity } from './feedIdentity.js';
import type { FeedWriteRecord } from './FeedWriteRepository.js';
import { Logger } from './Logger.js';
import { Mutex } from './Mutex.js';
import { toRendition } from './renditions.js';
import { holdsRecording, publishedStatusFor, type PublishedStatus } from './streamState.js';
import { stageUnavailability, type StreamStageLookup } from './StreamService.js';
import { hasPendingThumbnail } from './unpublishedEdits.js';

const logger = Logger.getInstance();

/**
 * How publishing reads the stages: one stage, for the checks a draft passes
 * before it goes on the catalogue, and the owner of every stage the admin
 * holds, retired ones included, for what a reconcile counts as ours.
 * StageRepository; a fake stands in.
 */
export interface PublishStageLookup extends StreamStageLookup {
  listOwners(): Promise<string[]>;
}

/** The slice of StreamRepository publishing needs; a fake stands in for tests. */
export interface PublishStreamStore {
  findById(id: string): Promise<StreamRow | null>;
  findThumbnail(id: string): Promise<ThumbnailRow | null>;
  /** `batchId` is the batch the image was uploaded under, or null when it went with no catalogue stamp. */
  recordThumbnailRef(id: string, thumbnailRef: string, batchId: string | null): Promise<void>;
  /**
   * Null as well, with `draftNeedsStage`, for a draft that has no stage. A
   * draft that holds no recording takes its stage's owner in the same step.
   */
  claimForPublish(
    id: string,
    allowedFrom: readonly StreamStatus[],
    draftNeedsStage?: boolean,
  ): Promise<StreamRow | null>;
  /**
   * `entryContentEditedAt` here, on `recordRepublish` and on
   * `finishWithoutWrite` is the `content_edited_at` of the row the entry was
   * built from: which edit the catalogue now carries, not when the write
   * finished. `status` is the one the entry was built with.
   */
  finishPublish(
    id: string,
    feedIndex: number,
    thumbnailRef: string | null,
    entryContentEditedAt: Date | null,
    status: PublishedStatus,
  ): Promise<StreamRow | null>;
  /**
   * A publish, or a hand republish when `status` is null, that wrote nothing:
   * `finishPublish` or `recordRepublish` without `published_at` and
   * `published_feed_index`, which stay with the write that last carried the
   * stream's entry.
   */
  finishWithoutWrite(
    id: string,
    thumbnailRef: string | null,
    entryContentEditedAt: Date | null,
    status: PublishedStatus | null,
  ): Promise<StreamRow | null>;
  /**
   * Back to `draft` and off the catalogue, keeping the recording and its rungs
   * for the next publish.
   */
  finishUnpublish(id: string): Promise<StreamRow | null>;
  recordRepublish(
    id: string,
    feedIndex: number,
    thumbnailRef: string | null,
    entryContentEditedAt: Date | null,
  ): Promise<StreamRow | null>;
  /**
   * Records a write that rebuilt a stream's entry without being a publish of
   * that stream, a reconcile: the index it wrote the entry at, and which edit
   * the entry carries. Touches nothing else.
   */
  recordEntryRebuilt(id: string, feedIndex: number, entryContentEditedAt: Date | null): Promise<void>;
  /**
   * Releases a `publishing` claim back to `previousStatus` with the reason. For
   * the first publish and the unpublish, which took the claim; nothing else.
   */
  failPublish(id: string, previousStatus: StreamStatus, message: string): Promise<void>;
  /**
   * Records why a feed write failed and touches nothing else. For the republish
   * path, which takes no claim: the status is whatever the row says, and it is
   * not this method's to put back.
   */
  recordPublishError(id: string, message: string): Promise<void>;
  /**
   * Every row that should be on the catalogue right now — status `published`,
   * `live` or `vod`. Only `reconcile` uses it, and it has to see all of them: a
   * row it cannot see reads as an entry with nothing behind it.
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
  record(write: FeedWriteRecord): Promise<void>;
  lastWrite(owner: string, topic: string): Promise<{ index: number; entries: unknown[] } | null>;
}

/** The slice of CatalogueBatchService publishing needs: where a write goes, and where the boot check reads. */
export type CatalogueTargets = Pick<CatalogueBatchService, 'forWrite' | 'forRead'>;

/** Where the entry says its recording is, and how long it runs. */
export interface EntryRecording {
  recording: string | null;
  duration: number | null;
}

export interface PublishOutcome {
  stream: StreamRow;
  /**
   * The status the stream's entry was written with, or null after an
   * unpublish, which takes the entry off the feed. A republish builds the
   * entry from the row as it reads it inside the mutex, while `stream` is
   * the row as the write left it, read after the write: a report that lands
   * while the write is on its way is on `stream` and not on the entry. This,
   * not `stream.status`, is the status the catalogue was told.
   */
  entryStatus: StreamStatus | null;
  /**
   * The recording the entry lists, or null when the entry is not `vod`, and
   * after an unpublish. Read back off the entry as it was written, for the
   * same reason as `entryStatus`: a report stored after the caller's can be
   * what the write carried, and `stream` can hold a later one still.
   */
  entryRecording: EntryRecording | null;
  feed: {
    owner: string;
    topic: string;
    topicHex: string;
    /** The index this call wrote at, or, when `written` is false, the one the feed already stands at. */
    index: number;
    entryCount: number;
  };
  /**
   * Whether this call wrote the feed. False for a republish by hand whose entry
   * the head already carries (`headCarrying`), and for an unpublish of a stream
   * that was not on the feed: neither spends a slot.
   */
  written: boolean;
  /**
   * The ladder the entry was written with, ascending by height. Read inside
   * the mutex, in the same step as the write, so a rendition report answers
   * with exactly what its write put on the catalogue. Empty for a stream with
   * no rungs, and after an unpublish, which takes the entry off the feed while
   * the rungs stay on the row.
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
  /**
   * Why the check did not run, or null when it did: with no catalogue batch designated there is no node to read the
   * head through, and the check waits for the manager to designate one.
   */
  skipped: string | null;
}

/**
 * A stream whose status the uploader set, `live` or `vod`, so its entry
 * carries that state. A draft that still holds a recording is not one:
 * `doPublish` claims it and lists it as `vod` again.
 */
function hasReportedState(stream: StreamRow): boolean {
  return stream.status === 'live' || stream.status === 'vod';
}

/**
 * The head's index when a republish by hand has nothing to write, or null
 * when it has. Nothing to write means: `row` is on the catalogue already, its
 * last publish did not fail, and the head carries `entry` exactly as it would
 * be written, apart from its `timestamp` (`carriesEntry`). A write then would
 * spend a slot on the catalogue batch, and lengthen the history a viewer
 * walks, on a list that says what the head says.
 *
 * `row` is the row as the call read it, before any claim, so a draft always
 * writes, a stream published again after an unpublish among them. So does a
 * row whose last attempt failed, which may have left the catalogue other than
 * the log says. That is also the only case in which a publish takes entries
 * off before it writes (`withoutTopicUnderOtherOwners`), so here the list the
 * write would start from is the head's own.
 */
function headCarrying(row: StreamRow, snapshot: FeedSnapshot, entry: FeedStreamEntry): number | null {
  if (!ON_FEED_STATUSES.includes(row.status) || row.publish_error !== null || snapshot.index === null) return null;
  return carriesEntry(snapshot.entries, entry) ? snapshot.index : null;
}

/**
 * The recording an entry lists: its `recording` and `duration` when it is `vod`,
 * null for any other. Read back off the entry `buildFeedEntry` built, rather
 * than worked out again from the row.
 */
function recordingOn(entry: FeedStreamEntry): EntryRecording | null {
  if (entry.state !== 'vod') return null;
  return { recording: entry.recording ?? null, duration: entry.duration ?? null };
}

/** Where a feed write landed, once the gateway has taken it; null until then. */
interface WrittenAt {
  index: number | null;
}

export const THUMBNAIL_FILE_EXTENSIONS: Record<string, string> = {
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
 * Every write goes through the node and batch of the catalogue stamp the
 * manager pushed, read on every write by `catalogue` (CatalogueBatchService).
 * A publish, an unpublish or a reconcile with no usable stamp is refused
 * before it touches a row or the feed.
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
    /** How a draft's stage is checked before it goes on the catalogue, and whose entries are ours. */
    private readonly stages: PublishStageLookup,
    private readonly feedWrites: FeedWriteLog,
    private readonly gateway: FeedGateway,
    private readonly catalogue: CatalogueTargets,
    private readonly feed: FeedIdentity,
    private readonly audit: AuditLog,
    /** Every feed write in this process goes through this one mutex. */
    private readonly mutex: Mutex = new Mutex(),
  ) {}

  async publish(actor: Actor, id: string): Promise<PublishOutcome> {
    return this.mutex.run(async () => {
      const before = await this.read(id);
      // A stream that is `live` or `vod` is republished as it is: the
      // operator fixed a title mid-broadcast, and the entry must go back on
      // the feed still saying `live` (or `vod`, with its index and duration).
      // The `publishing` claim the first publish uses would lose that.
      return hasReportedState(before) ? this.republishByHand(actor, before) : this.doPublish(actor, before);
    });
  }

  async unpublish(actor: Actor, id: string): Promise<PublishOutcome> {
    return this.mutex.run(() => this.doUnpublish(actor, id));
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
   *
   * Nothing is audited here. The caller's own action — a state report, a
   * rendition report — is the entry, and it carries this write's feed index
   * and what the write published: `entryStatus`, `entryRecording` and
   * `renditions`. All three come from the read in here, so they can be a
   * later report's than the caller's. `actor` is only for the log line.
   */
  async republishWithState(actor: Actor, stream: StreamRow): Promise<PublishOutcome> {
    return this.mutex.run(async () => this.doRepublishWithState(actor, await this.read(stream.id), false));
  }

  /**
   * Rebuilds the catalogue from the database: drops entries of ours with no
   * published row behind them, rewrites entries that no longer match their
   * row, appends rows that are missing, and leaves everyone else's elements
   * exactly where they are.
   *
   * The operator repair for what the stale feed read left on the live feed —
   * an entry whose stream was unpublished, then deleted, so no request could
   * ever name it again. Nothing here changes what a row says about its
   * stream: the database is the truth this rewrites *towards*. A row whose
   * entry it rewrote or added is told only where that entry now is and which
   * edit it carries.
   *
   * Writes only when something changed, so running it on a clean catalogue
   * costs nothing. A failure is left as it is rather than dressed as a publish
   * failure: no status was moved, so there is nothing to put back. Only a
   * reconcile that wrote is audited; one that found nothing to do changed
   * nothing.
   */
  async reconcile(actor: Actor): Promise<ReconcileOutcome> {
    return this.mutex.run(async () => {
      const target = await this.catalogue.forWrite(actor);
      const base = await this.baseSnapshot(target);
      const rows = await this.streams.listOnFeed();
      const plan = planReconcile(
        base.entries,
        rows,
        await this.ourOwners(rows),
        Date.now(),
        await this.laddersOf(rows),
      );

      if (!plan.changed) {
        logger.info(
          `[Reconcile] ${describeActor(actor)} found the catalogue already matches the database (${base.entries.length} entries); nothing written`,
        );
        return {
          index: null,
          removed: [],
          added: [],
          updated: [],
          entryCount: base.entries.length,
        };
      }

      const index = await this.writeFeed(plan.entries, base.index, target);
      logger.warn(
        `[Reconcile] ${describeActor(actor)} rewrote the catalogue at feed index ${index} (${plan.entries.length} entries): removed [${plan.removed.join(', ')}], added [${plan.added.join(', ')}], updated [${plan.updated.join(', ')}]`,
      );
      await this.recordRebuiltEntries(rows, [...plan.updated, ...plan.added], index);
      await recordAudit(this.audit, {
        actor,
        action: 'feed.reconcile',
        details: {
          feedIndex: index,
          entryCount: plan.entries.length,
          removed: plan.removed,
          added: plan.added,
          updated: plan.updated,
        },
      });
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
   * the backend has everything it needs without it. The head is read through
   * the catalogue node; with no catalogue batch designated there is none, and
   * the check is skipped with its reason, for the caller to run again once the
   * manager designates one.
   */
  async checkFeedOnBoot(): Promise<FeedBootCheck> {
    return this.mutex.run(async () => {
      const last = await this.feedWrites.lastWrite(this.feed.owner, this.feed.topicHex);

      const read = await this.catalogue.forRead();
      if ('skipped' in read) {
        return { recorded: last?.index ?? null, network: null, adopted: false, ghosts: [], skipped: read.skipped };
      }

      let network: FeedSnapshot | null = null;
      try {
        network = await this.gateway.readLatest(read.target);
      } catch (error) {
        logger.warn(`[Boot] could not read the feed head to cross-check it: ${getErrorMessage(error)}`);
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
          // Not a write of ours, so no reference and no batch: the admin does not
          // know what stamped it. The bytes are kept when the node said them.
          await this.feedWrites.record({
            owner: this.feed.owner,
            topic: this.feed.topicHex,
            feedIndex: network.index,
            entryCount: network.entries.length,
            payload: network.entries,
            payloadText: network.payloadText ?? null,
            reference: null,
            batchId: null,
          });
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
        await this.ourOwners(rows),
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
        skipped: null,
      };
    });
  }

  private async doPublish(actor: Actor, before: StreamRow): Promise<PublishOutcome> {
    const id = before.id;
    // A draft goes on the catalogue only once it says which stage it is
    // broadcast on. A stream that is on the catalogue already is republished
    // as it is: one published before stages existed has none, and cannot be
    // given one until it is unpublished.
    if (before.status === 'draft' && before.stage_id === null) throw new StageRequiredError(id);
    // A draft goes on the catalogue only on a stage that still takes streams:
    // the manager may have retired it since it was picked. A draft that holds
    // a recording is listed as that recording, which needs no broadcast, and
    // keeps the stage it was made on, so it is published whatever became of
    // the stage.
    if (before.status === 'draft' && before.stage_id !== null && !holdsRecording(before)) {
      const reason = stageUnavailability(await this.stages.findSummary(before.stage_id));
      if (reason) throw new StageUnavailableError(before.stage_id, reason);
    }
    // The entry carries the row's `owner`, which is its stage's: the stage's
    // uploader signs every feed of the stream, and the brand key signs only
    // the catalogue. The claim below gives a draft with no recording the
    // stage's owner as it stands now, and refuses one that holds a recording
    // when its stage now signs as another than the owner it was recorded
    // under, since its feeds resolve under that alone: the manager rotated the
    // stage's key since. `claim` turns that refusal into its sentence.
    // Before the claim: a publish with no catalogue batch to write with is
    // refused with the row as it was, and nothing to put back.
    const target = await this.catalogue.forWrite(actor);

    const { claimed, previousStatus } = await this.claim(before, PUBLISHABLE_STATUSES, true);
    // The uploader's reports are refused while the row is claimed, so the
    // recording this reads cannot change before the row is finished.
    const status = publishedStatusFor(claimed);
    const written: WrittenAt = { index: null };

    try {
      const thumbnailRef = await this.ensureThumbnailUploaded(claimed, target);
      const { entry, renditions } = await this.entryFor({ ...claimed, status }, thumbnailRef);
      const snapshot = await this.baseSnapshot(target);
      const previous = ladderOnFeed(snapshot.entries, entry.owner, entry.topic);
      // A publish that failed may have put the entry on the catalogue after
      // all, under the owner the row had then, and the claim may have given
      // the row its stage's new owner since. Any entry of ours for this topic
      // under another owner is that one, and goes, so the stream is listed
      // once.
      const base =
        before.publish_error !== null
          ? withoutTopicUnderOtherOwners(snapshot.entries, entry, await this.ourOwners([before, claimed]))
          : snapshot.entries;
      const entries = upsertEntry(base, entry);
      // Nothing is written for a stream whose entry the head already carries
      // (`headCarrying`). The publish is finished all the same, which releases
      // the claim and records which edit the entry carries, with the image the
      // entry names; `published_at` and `published_feed_index` stay with the
      // write that last carried this stream's entry.
      const carriedAt = headCarrying(before, snapshot, entry);
      const wrote = carriedAt === null;
      const index = carriedAt ?? (await this.writeFeed(entries, snapshot.index, target, written));

      // The claim refuses every edit until this returns, so `claimed` still
      // holds the edit the entry was built from.
      const stream = wrote
        ? await this.streams.finishPublish(id, index, thumbnailRef, claimed.content_edited_at, status)
        : await this.streams.finishWithoutWrite(id, thumbnailRef, claimed.content_edited_at, status);
      if (!stream) throw new StreamNotFoundError(id);

      logger.info(
        `[Publish] ${describeActor(actor)} published ${describeStream(claimed)}: ${previousStatus} → ${status}${
          status === 'vod' ? ' (its recording)' : ''
        }${
          wrote ? ` at feed index ${index}` : `, nothing written: the entry at feed index ${index} already says this`
        } (${entries.length} entries)`,
      );
      await recordAudit(this.audit, {
        actor,
        action: 'stream.publish',
        streamId: id,
        topic: claimed.topic,
        statusBefore: previousStatus,
        statusAfter: stream.status,
        details: { feedIndex: index, entryCount: entries.length, written: wrote },
      });
      return this.outcome(stream, { status, entry }, index, entries.length, renditions, previous, wrote);
    } catch (error) {
      throw await this.fail(actor, 'stream.publish.failed', claimed, previousStatus, written, error, target);
    }
  }

  private async doUnpublish(actor: Actor, id: string): Promise<PublishOutcome> {
    // No owner check: an entry written under an older feed key is removed by
    // the owner stored on the row, and refusing here would strand it.
    const before = await this.read(id);
    // A recording can come off the catalogue; a live broadcast cannot, because
    // nothing here can stop the encoder that is still pushing to it.
    if (before.status === 'live') throw new StreamLiveError(id);
    // Before the claim, as for a publish. Refused even when the entry turns out
    // not to be on the feed: whether it is comes from the write log, and the
    // refusal should not depend on it.
    const target = await this.catalogue.forWrite(actor);
    const { claimed, previousStatus } = await this.claim(before, UNPUBLISHABLE_STATUSES);
    const written: WrittenAt = { index: null };

    try {
      const snapshot = await this.baseSnapshot(target);
      const previous = ladderOnFeed(snapshot.entries, claimed.owner, claimed.topic);
      const { entries, removed } = removeEntry(snapshot.entries, claimed.owner, claimed.topic);

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
      const index = removed ? await this.writeFeed(entries, snapshot.index, target, written) : (snapshot.index ?? 0);

      const stream = await this.streams.finishUnpublish(id);
      if (!stream) throw new StreamNotFoundError(id);

      logger.info(
        `[Publish] ${describeActor(actor)} unpublished ${describeStream(claimed)}: ${previousStatus} → ${stream.status}${
          removed ? ` at feed index ${index}` : ' (was not on the feed)'
        }`,
      );
      await recordAudit(this.audit, {
        actor,
        action: 'stream.unpublish',
        streamId: id,
        topic: claimed.topic,
        statusBefore: previousStatus,
        statusAfter: stream.status,
        details: { feedIndex: removed ? index : null, wasOnFeed: removed },
      });
      return this.outcome(stream, null, index, entries.length, [], previous, removed);
    } catch (error) {
      throw await this.fail(actor, 'stream.unpublish.failed', claimed, previousStatus, written, error, target);
    }
  }

  /**
   * An operator republishing a stream that is live or recorded: the write is
   * the uploader's path, the audit entry is this one's. A failure is recorded
   * as a failed publish, with the status it stayed in on both sides. One the
   * head already carries writes nothing, as a publish does (`headCarrying`).
   */
  private async republishByHand(actor: Actor, current: StreamRow): Promise<PublishOutcome> {
    let outcome: PublishOutcome;
    try {
      outcome = await this.doRepublishWithState(actor, current, true);
    } catch (error) {
      if (error instanceof PublishFailedError || error instanceof CatalogueStampUnavailableError) {
        await recordAudit(this.audit, {
          actor,
          action: 'stream.publish.failed',
          streamId: current.id,
          topic: current.topic,
          statusBefore: current.status,
          statusAfter: current.status,
          details: { error: error instanceof PublishFailedError ? error.reason : error.message, republish: true },
        });
      }
      throw error;
    }

    // `current` was read inside the mutex, and the entry says its status. The
    // row returned by the write can already carry a newer report, which is
    // the uploader's transition, not this one.
    await recordAudit(this.audit, {
      actor,
      action: 'stream.republish',
      streamId: current.id,
      topic: current.topic,
      statusBefore: current.status,
      statusAfter: current.status,
      details: { feedIndex: outcome.feed.index, entryCount: outcome.feed.entryCount, written: outcome.written },
    });
    return outcome;
  }

  /**
   * The write half of a state report, and of a republish of a stream that is
   * live or recorded. No `publishing` claim: the row already says what the
   * entry must say, and claiming it would both lose that and make the console
   * flicker through a status the stream is not in. The mutex still serialises
   * the feed write, which is what the claim protected on the feed's side.
   *
   * `current` is the row as it was read inside this mutex, and everything here
   * — the entry, the log line, what a failure records — is about that row,
   * never about whatever the caller read before queueing. Its owner is the
   * one its broadcast was signed as, which publishing fixed, so it is written
   * as it is.
   *
   * `byHand` is an operator's republish, which writes nothing when the head
   * already carries the entry (`headCarrying`), and leaves the row's status
   * as it is either way. A report always writes, as its answer names the
   * write it caused.
   */
  private async doRepublishWithState(actor: Actor, current: StreamRow, byHand: boolean): Promise<PublishOutcome> {
    const { id } = current;

    let target: CatalogueTarget | null = null;
    try {
      // Inside the try, unlike a publish: the uploader's report has already
      // moved the row, so a refusal here is recorded on it like any failed
      // write, and the console says why the catalogue did not follow.
      target = await this.catalogue.forWrite(actor);
      const thumbnailRef = await this.ensureThumbnailUploaded(current, target);
      const { entry, renditions } = await this.entryFor(current, thumbnailRef);
      const snapshot = await this.baseSnapshot(target);
      const previous = ladderOnFeed(snapshot.entries, entry.owner, entry.topic);
      const entries = upsertEntry(snapshot.entries, entry);
      const carriedAt = byHand ? headCarrying(current, snapshot, entry) : null;
      const wrote = carriedAt === null;
      const index = carriedAt ?? (await this.writeFeed(entries, snapshot.index, target));

      // `current`'s edit, not whatever the row holds now: no claim is taken
      // here, so the console can save an edit while this write is on its way,
      // and that edit is not on the entry. A republish that wrote nothing
      // leaves the status, `published_at` and `published_feed_index` alone.
      const updated = wrote
        ? await this.streams.recordRepublish(id, index, thumbnailRef, current.content_edited_at)
        : await this.streams.finishWithoutWrite(id, thumbnailRef, current.content_edited_at, null);
      if (!updated) throw new StreamNotFoundError(id);

      logger.info(
        `[Publish] ${describeActor(actor)} republished ${describeStream(current)}${
          wrote ? ` at feed index ${index}` : `, nothing written: the entry at feed index ${index} already says this`
        } (${entries.length} entries): stays ${current.status}`,
      );
      return this.outcome(
        updated,
        { status: current.status, entry },
        index,
        entries.length,
        renditions,
        previous,
        wrote,
      );
    } catch (error) {
      // No claim was taken, so there is no status to put back — and none may
      // be: the row's status is the uploader's last report, which can be newer
      // than anything this call has seen. Only the reason is recorded.
      throw await this.failRepublish(actor, current, error, target);
    }
  }

  /**
   * Whose entries on the catalogue are this admin's: the brand key's, which
   * the entries older than stages carry; every stage's the admin holds,
   * retired ones included, since a retired stage's streams and old entries
   * still name it; and the owner of each of `rows`, which keeps a stream
   * published under a key its stage signed with before the manager rotated it
   * counted as ours, so its entry can still be rebuilt or added again.
   */
  private async ourOwners(rows: readonly StreamRow[] = []): Promise<string[]> {
    return [this.feed.owner, ...(await this.stages.listOwners()), ...rows.map((row) => row.owner)];
  }

  private async read(id: string): Promise<StreamRow> {
    const stream = await this.streams.findById(id);
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
  private async laddersOf(rows: readonly StreamRow[]): Promise<Map<string, Rendition[]>> {
    const ladders = new Map<string, Rendition[]>();
    for (const row of rows) {
      const rungs = await this.renditions.listByStream(row.id);
      if (rungs.length > 0) ladders.set(row.id, rungs.map(toRendition));
    }
    return ladders;
  }

  /**
   * Tells each row whose entry a reconcile rewrote or added the index that
   * entry was written at, and which edit it now carries, as a publish does
   * for its one row. `topics` are the ones the plan rewrote or added, and each
   * of those entries was built from its row in `rows`, read inside this same
   * mutex, so that row's `content_edited_at` is the edit the entry carries.
   *
   * A row with an image waiting to be uploaded keeps the edit it was counted
   * as carrying. A reconcile uploads nothing, so its entry went out without
   * that image, and the console has to keep asking for the republish that
   * uploads it. Its index moves all the same, since the entry was written
   * there. Only this service writes `entry_content_edited_at`, under this
   * mutex, so the one read with the row is still the row's.
   */
  private async recordRebuiltEntries(
    rows: readonly StreamRow[],
    topics: readonly string[],
    feedIndex: number,
  ): Promise<void> {
    const rebuilt = new Set(topics.map((topic) => topic.toLowerCase()));
    const recorded = rows.filter((row) => rebuilt.has(row.topic.toLowerCase()));
    await Promise.all(
      recorded.map((row) =>
        this.streams.recordEntryRebuilt(
          row.id,
          feedIndex,
          hasPendingThumbnail(row) ? row.entry_content_edited_at : row.content_edited_at,
        ),
      ),
    );
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
    const renditions = (await this.renditions.listByStream(stream.id)).map(toRendition);
    const entry = buildFeedEntry(stream, thumbnailRef, Date.now(), renditions);
    return { entry, renditions };
  }

  /**
   * Step 1: take the row into `publishing`, remembering where to put it back.
   * `before` is the row as it was read a moment earlier, inside this mutex.
   */
  private async claim(
    before: StreamRow,
    allowedFrom: readonly StreamStatus[] = PUBLISHABLE_STATUSES,
    draftNeedsStage = false,
  ): Promise<{ claimed: StreamRow; previousStatus: StreamStatus }> {
    const claimed = await this.streams.claimForPublish(before.id, allowedFrom, draftNeedsStage);
    if (!claimed) {
      // Re-read rather than trusting `before`: the row may have been deleted
      // between the two statements, which is a 404, not a 409, and an edit
      // may have taken its stage away.
      const current = await this.streams.findById(before.id);
      if (!current) throw new StreamNotFoundError(before.id);
      if (draftNeedsStage && current.status === 'draft' && current.stage_id === null) {
        throw new StageRequiredError(before.id);
      }
      // The claim takes a draft that holds a recording only while its stage
      // signs as the owner the recording was made under.
      if (draftNeedsStage && current.status === 'draft' && current.stage_id !== null && holdsRecording(current)) {
        const stage = await this.stages.findSummary(current.stage_id);
        if (stage && !sameFeedOwner(current.owner, stage.owner)) {
          throw new FeedOwnerMismatchError(current.id, current.owner, current.stage_id, stage.owner);
        }
      }
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
   * the catalogue stamp can name a node that never saw the chunks. Carrying
   * such a reference onto the feed gives every viewer a 404. A gateway that
   * cannot answer throws instead, and the publish fails rather than paying to
   * re-upload an image that is probably fine.
   *
   * Asked of, and uploaded through, the catalogue node, stamped with the
   * catalogue's batch: an image the catalogue names lives as long as the
   * catalogue does.
   */
  private async ensureThumbnailUploaded(stream: StreamRow, target: CatalogueTarget | null): Promise<string | null> {
    if (!stream.has_thumbnail) return stream.thumbnail_ref;
    // Reused only when it was uploaded under the batch this write goes with: an image only an older batch holds
    // lapses with it. The same bytes upload to the same reference, so another batch costs a stamp and changes
    // nothing the entry says.
    const batchId = target?.batchId ?? null;
    if (
      stream.thumbnail_ref &&
      stream.thumbnail_batch_id === batchId &&
      (await this.gateway.hasReference(stream.thumbnail_ref, target))
    ) {
      return stream.thumbnail_ref;
    }

    const stored = await this.streams.findThumbnail(stream.id);
    if (!stored) return null;

    if (stream.thumbnail_ref) {
      logger.warn(
        stream.thumbnail_batch_id === batchId
          ? `[Publish] ${stream.topic} thumbnail ${stream.thumbnail_ref} is not on the gateway; re-uploading`
          : `[Publish] ${stream.topic} thumbnail ${stream.thumbnail_ref} was uploaded under another batch than the catalogue's; re-uploading`,
      );
    }

    const mime = stored.thumbnail_mime ?? 'image/png';
    const extension = THUMBNAIL_FILE_EXTENSIONS[mime] ?? 'bin';
    const reference = await this.gateway.uploadThumbnail(
      stored.thumbnail,
      `${stream.topic}.${extension}`,
      mime,
      target,
    );
    // Written now, not with the rest of the publish: the chunk is paid for
    // already, and a feed write that fails after this must not make the next
    // attempt upload the same image again.
    await this.streams.recordThumbnailRef(stream.id, reference, batchId);
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
  private async baseSnapshot(target: CatalogueTarget | null): Promise<FeedSnapshot> {
    const last = await this.feedWrites.lastWrite(this.feed.owner, this.feed.topicHex);
    if (last) return { index: last.index, entries: last.entries };

    const snapshot = await this.gateway.readLatest(target);
    logger.info(
      `[Publish] no recorded write for feed ${this.feed.owner}/${this.feed.topicHex}; falling back to the network head (${snapshot.index ?? 'none'})`,
    );
    return snapshot;
  }

  /**
   * Writes at the index after the base; index 0 when the feed is empty.
   * `written`, when given, learns the index the moment the gateway has taken
   * the write, so a failure after that point can say the catalogue carries it.
   *
   * The payload is encoded once, here, and the same string goes to the
   * gateway and into `feed_writes.payload_text`, with the batch that stamped
   * it: the exact bytes are what moving the catalogue to another batch
   * uploads again.
   */
  private async writeFeed(
    entries: unknown[],
    head: number | null,
    target: CatalogueTarget | null,
    written?: WrittenAt,
  ): Promise<number> {
    const index = head === null ? 0 : head + 1;
    const payloadText = encodeFeedPayload(entries);
    const reference = await this.gateway.write(payloadText, index, target);
    if (written) written.index = index;
    await this.feedWrites.record({
      owner: this.feed.owner,
      topic: this.feed.topicHex,
      feedIndex: index,
      entryCount: entries.length,
      payload: entries,
      payloadText,
      reference,
      batchId: target?.batchId ?? null,
    });
    return index;
  }

  /**
   * A publish or unpublish failed: release the claim, record why, and audit
   * it. The status it is left in is the one it was claimed from, unless the
   * release itself failed, in which case it is still `publishing` until boot
   * clears it. `feedIndex` is set when the gateway had already taken the
   * write, so the entry is on the catalogue even though the row says it is
   * not.
   */
  private async fail(
    actor: Actor,
    action: 'stream.publish.failed' | 'stream.unpublish.failed',
    claimed: StreamRow,
    previousStatus: StreamStatus,
    written: WrittenAt,
    error: unknown,
    target: CatalogueTarget | null,
  ): Promise<PublishFailedError> {
    const verb = action === 'stream.publish.failed' ? 'publish' : 'unpublish';
    const { failure, released } = await this.failed(actor, verb, claimed, error, target, (message) =>
      this.streams.failPublish(claimed.id, previousStatus, message),
    );
    await recordAudit(this.audit, {
      actor,
      action,
      streamId: claimed.id,
      topic: claimed.topic,
      statusBefore: previousStatus,
      statusAfter: released ? previousStatus : 'publishing',
      details: { error: failure.reason, feedIndex: written.index },
    });
    return failure;
  }

  /**
   * A republish failed: there is no claim to release, so only record why. A
   * refusal for want of a catalogue batch keeps its own type, so the caller
   * can tell it from a write that was tried and failed.
   */
  private async failRepublish(
    actor: Actor,
    current: StreamRow,
    error: unknown,
    target: CatalogueTarget | null,
  ): Promise<PublishFailedError | CatalogueStampUnavailableError> {
    const { failure } = await this.failed(actor, 'republish', current, error, target, (message) =>
      this.streams.recordPublishError(current.id, message),
    );
    return error instanceof CatalogueStampUnavailableError ? error : failure;
  }

  /**
   * Records and answers the reason without the catalogue node's address, which bee-js and Node print in their errors
   * and the console is never told (`withoutCatalogueNode`). The log line keeps the error as it was.
   */
  private async failed(
    actor: Actor,
    verb: string,
    stream: StreamRow,
    error: unknown,
    target: CatalogueTarget | null,
    record: (message: string) => Promise<void>,
  ): Promise<{ failure: PublishFailedError; released: boolean }> {
    const raw = getErrorMessage(error);
    const message = withoutCatalogueNode(raw, target);
    const who = describeActor(actor);
    let released = true;
    try {
      await record(message);
    } catch (recordError) {
      // After a publish the row is stuck in `publishing` and boot clears it;
      // after a republish only the reason is lost. Log both, and still report
      // the original failure to the caller.
      released = false;
      logger.error(
        `[Publish] ${who} could not record the failed ${verb} of ${describeStream(stream)}: ${getErrorMessage(recordError)}`,
      );
    }
    logger.error(`[Publish] ${who} could not ${verb} ${describeStream(stream)}: ${raw}`);
    return { failure: new PublishFailedError(stream.id, message), released };
  }

  /**
   * `listed` is the entry the feed carries for the stream after this call and
   * the status it was built with, or null for an unpublish, which took the
   * entry off. `written` is whether this call wrote the feed to get there.
   */
  private outcome(
    stream: StreamRow,
    listed: { status: StreamStatus; entry: FeedStreamEntry } | null,
    index: number,
    entryCount: number,
    renditions: Rendition[],
    previousRenditions: Rendition[],
    written: boolean,
  ): PublishOutcome {
    return {
      stream,
      entryStatus: listed?.status ?? null,
      entryRecording: listed ? recordingOn(listed.entry) : null,
      feed: {
        owner: this.feed.owner,
        topic: this.feed.topic,
        topicHex: this.feed.topicHex,
        index,
        entryCount,
      },
      written,
      renditions,
      previousRenditions,
    };
  }
}
