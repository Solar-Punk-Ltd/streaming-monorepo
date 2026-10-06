import { FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';
import {
  catalogStateLost,
  createNoteWindowWriter,
  ladderFinalized,
  STREAM_LIST_HEARTBEAT_MS,
  STREAM_LIST_NOTE_WINDOW_MS,
  windowIdentifier,
  type WindowSlot,
  type WindowWriteEvent,
  type WindowWriterClock,
} from '@swarm-hls-stream/shared';
import PQueue from 'p-queue';

import { MediaType, Rendition, STREAM_STATUS_LIVE, STREAM_STATUS_VOD, StreamStatus } from '../types.js';
import { extractHttpStatus, getErrorMessage, isFeedAbsent, retryUntilDeadlineAsync } from '../utils/common.js';
import { isTransferLost } from '../utils/transportFailure.js';

import { BeePublisher, BeePublisherPool, safeUrl } from './BeePublisherPool.js';
import { CatalogIndexStore } from './CatalogIndexStore.js';
import { ErrorHandler } from './ErrorHandler.js';
import { hasRecording, isFinishedLadder, recordedRungs, recordingDuration } from './LadderCompletion.js';
import { LadderIdentity, LadderRegistry, RenditionAnnouncement } from './LadderRegistry.js';
import { Logger } from './Logger.js';
import { NodeUnreachableError } from './NodeUnreachableError.js';

const CATALOG_RETRY_WINDOW_MS = 10_000;

// Re-exported from where it is now declared, so nothing that named it here has to move. The identity
// moved out because it describes a ladder rather than a catalog, and both registries are handed one.
export type { LadderIdentity } from './LadderRegistry.js';

/**
 * How many consecutive failures to read the resumed state it takes before the entries there are
 * treated as gone. Each attempt spends its own retry window and belongs to a different segment, so
 * this is tens of seconds of trying rather than an instant.
 */
export const TREAT_STATE_AS_LOST_AFTER = 3;

export interface StreamEntry {
  title: string;
  owner: string;
  /**
   * The topic a viewer opens: a single-rendition stream's own, and a ladder's lowest rung's, which is
   * what a player that knows nothing of `renditions` plays. A player that does builds the ladder's
   * master playlist from `renditions`.
   */
  topic: string;
  state: StreamStatus;
  mediatype: MediaType;
  timestamp: number;
  /**
   * Where the recording is: the reference of its recording playlist, read with `GET /bytes/<recording>`.
   * For a ladder, its lowest finished rung's.
   */
  recording?: string;
  duration?: number;
  /**
   * Ladder identity, absent on single-rendition streams. Present, it — not `topic` — is what
   * makes the entry unique, because four rungs merge into one entry and each of them writes it.
   */
  group?: string;
  renditions?: Rendition[];
  /**
   * Rungs of this ladder whose session ended without a recording, by name, and absent while there are
   * none. See `LadderRegistry.recordRungUnfinished`.
   *
   * ⛔ Kept beside `renditions` rather than as a mark on a rendition, so that a finished entry's
   * `renditions` names only rungs that have a recording. A viewer built before this field existed reads
   * nothing but `renditions`, and every rung it finds there on a finished entry is one it can play.
   */
  unfinishedRungs?: string[];
}

/** What merging one rung into its ladder says about that rung, beyond its own record. */
interface RungMerge {
  /** The rung's session ended without a recording, so the ladder is not to wait for it. */
  unfinished?: boolean;
}

export class StreamCatalog implements LadderRegistry {
  private publishers: BeePublisherPool;
  private signer: PrivateKey;
  private feedTopic: Topic;
  /** The text the feed topic is made from, and the topic of the list's notes, which readers compute from it. */
  private readonly feedTopicName: string;
  private indexStore?: CatalogIndexStore;
  private feedIndex: FeedIndex | null = null;
  private queue = new PQueue({ concurrency: 1 });
  private logger = Logger.getInstance();
  private errorHandler = ErrorHandler.getInstance();

  /** Running while this process writes the list, which is standalone only. See {@link startNotes}. */
  private notes?: ReturnType<typeof createNoteWindowWriter>;

  /**
   * Set when boot resumed to an index whose state it never read — the head was below the persisted
   * floor, or absent, or unreadable — and cleared by the first read or write that succeeds.
   *
   * Only inside this window may a failed read of that state be taken for the state being gone. A
   * read that fails outside it stays fatal to the write: continuing from an empty list would drop
   * every other stream's entry from the catalog, which is far worse than losing one update.
   */
  private resumedToUnreadState = false;

  /** Consecutive failures to read that unread state. See {@link TREAT_STATE_AS_LOST_AFTER}. */
  private unreadableStateReads = 0;

  constructor(publishers: BeePublisherPool, streamKey: string, feedTopic: string, indexStore?: CatalogIndexStore) {
    this.publishers = publishers;
    this.signer = new PrivateKey(streamKey);
    this.feedTopic = Topic.fromString(feedTopic);
    this.feedTopicName = feedTopic;
    this.indexStore = indexStore;

    const publisher = this.publisher;
    this.logger.debug(
      `[StreamCatalog] bee=${publisher.url} owner=${this.signer
        .publicKey()
        .address()
        .toString()} topic="${feedTopic}" topicHex=${this.feedTopic.toString()} stamp=${publisher.stamp.slice(0, 12)}…`,
    );
  }

  /**
   * How long the persisted feed index has been failing to update, or null when the last save landed
   * and when no index is persisted at all. See `CatalogIndexStore.getMsSinceSaveFailed`.
   */
  public getMsSinceIndexSaveFailed(): number | null {
    return this.indexStore?.getMsSinceSaveFailed() ?? null;
  }

  /**
   * Starts writing the list's notes: in each 10 s window that saw a new version, and in every aligned
   * heartbeat window once a minute, a note naming the newest index this process has stored. A viewer
   * reads one note a window instead of polling the next feed index, which is the early ask that makes
   * Bee skip its peers for that address. See "Time windows on Swarm" in the architecture overview.
   *
   * Only after {@link init}, which settles the index a note names, and only where this process writes
   * the list. In admin mode the admin writes the list and its notes, and a second writer here would
   * sign different notes at the same addresses.
   *
   * @param options.clock the writer's clock and timers, the system's unless a test hands its own.
   * @param options.clockTrusted asked before each note, the clock check's verdict in production. A note
   * dated by a wrong clock sits at an address no reader asks, so an untrusted clock skips it and the
   * news waits for the next window the clock is trusted in.
   */
  public startNotes(options: { clock?: WindowWriterClock; clockTrusted?: () => boolean } = {}): void {
    if (this.notes !== undefined) {
      return;
    }
    this.notes = createNoteWindowWriter({
      topic: this.feedTopicName,
      windowMs: STREAM_LIST_NOTE_WINDOW_MS,
      heartbeatMs: STREAM_LIST_HEARTBEAT_MS,
      newestStored: () => this.newestStored(),
      write: (slot, payload) => this.writeNote(slot, payload),
      onEvent: (event) => this.logNoteEvent(event),
      clock: options.clock,
      clockTrusted: options.clockTrusted,
    });
    this.notes.start();
  }

  /** Stops the note writer. Settles once the notes already being written have finished. */
  public async stopNotes(): Promise<void> {
    await this.notes?.stop();
  }

  /**
   * The newest feed index whose own write finished, or -1 before any has. `feedIndex` moves only after
   * a write's receipt, and at boot it is the head the node answered or the last index this uploader
   * persisted after a write of its own, both stored.
   */
  private newestStored(): number {
    return this.feedIndex === null ? -1 : Number(this.feedIndex.toBigInt());
  }

  /** One note, signed by the list's key over the window's identifier, direct and tried once. */
  private async writeNote(slot: WindowSlot, payload: Uint8Array): Promise<void> {
    const publisher = this.publisher;
    await publisher.bee.soc
      .makeWriter(this.signer)
      .upload(publisher.stamp, windowIdentifier(slot), payload, { deferred: false });
  }

  private logNoteEvent(event: WindowWriteEvent): void {
    if (event.outcome === 'failed') {
      this.logger.warn(
        `[StreamCatalog] List note for window ${event.window} not written, the next window carries it: ${getErrorMessage(event.error)}`,
      );
    } else if (event.outcome === 'written') {
      this.logger.debug(`[StreamCatalog] List note written window=${event.window} in ${event.durationMs}ms`);
    } else if (event.outcome === 'missed') {
      this.logger.warn(`[StreamCatalog] List note windows ${event.fromWindow} to ${event.toWindow} passed unwritten`);
    }
  }

  /**
   * The node the catalog is written through. Coordination rides the lowest rung's publisher — see
   * {@link BeePublisherPool.coordinator} for why that one.
   */
  private get publisher(): BeePublisher {
    return this.publishers.coordinator();
  }

  public async init(): Promise<void> {
    const owner = this.signer.publicKey().address();
    // The lookup asks the local bee for the feed head, but a freshly restarted node without
    // warmed peers can answer with a stale (or missing) head. Never resume below the last
    // index this uploader wrote — writing into already-occupied indices forks the feed
    // invisibly for readers, who keep following the original chain.
    const persisted = this.indexStore?.load(owner.toString(), this.feedTopic.toString()) ?? null;

    try {
      const feedReader = this.publisher.bee.feed.makeReader(this.feedTopic, owner);
      const data = await feedReader.downloadPayload();

      if (persisted !== null && persisted.toBigInt() > data.feedIndex.toBigInt()) {
        this.resumeFromPersisted(persisted, `Boot lookup returned stale index ${data.feedIndex.toString()}`);
        return;
      }

      this.feedIndex = data.feedIndex;
      this.logger.info(`[StreamCatalog] Loaded feed at index ${data.feedIndex.toString()}`);
    } catch (error) {
      // ⚠️ An absent feed is an answer here and is no answer at all on the uploader's
      // recovered-finalize read, which retries both of these statuses instead. The asymmetry is not
      // an oversight: boot has no prior knowledge of this feed, so "topic exists, no update yet"
      // really is an empty catalog, while that read runs only over a feed the stream has already
      // written to. Answering "empty" to either status there republishes a recording.
      if (isFeedAbsent(error)) {
        if (persisted !== null) {
          this.resumeFromPersisted(persisted, 'Boot lookup found no feed');
          return;
        }

        // ⛔⛔⛔ Only when the node said so. Beginning at index 0 is the one answer here that cannot
        // be taken back: every reader following the original chain keeps following it, and the
        // entries this process writes are invisible to all of them.
        if (!(await this.absenceIsAnAnswer(error))) {
          throw new NodeUnreachableError(
            `[StreamCatalog] ${safeUrl(this.publisher.url)} answered ${extractHttpStatus(error)} for the catalog ` +
              'feed head and does not report itself ready, so whether this feed exists is unknown. Refusing to ' +
              'begin at index 0, which would fork the feed for every reader that keeps following the original chain.',
          );
        }

        this.feedIndex = null;
        this.logger.info('[StreamCatalog] No existing feed found, starting fresh');
        return;
      }

      // The head resolved and its payload did not arrive: bee answers a retrieval it cannot finish
      // with the headers and then a dropped body, which carries no HTTP status to match on. The
      // usual cause is the postage batch that paid for the catalog having expired, so the chunks
      // are gone from every reserve except the node that wrote them — a different node as soon as
      // the catalog moves onto a publisher pool's coordinator. That must not take the uploader off
      // the air over a catalog no reader can load either, so continue above the last index this
      // uploader wrote and let the writes discover whether the entries are still there.
      if (persisted !== null && (await this.payloadUnreadableOnLiveNode(error))) {
        this.resumeFromPersisted(persisted, `Boot lookup could not read the feed head (${getErrorMessage(error)})`);
        return;
      }

      // Everything else stays as loud as it was. A request that never reached the node, a wrong url,
      // a wrong port, a node that is down, is rethrown here so the wait around the boot retries it
      // rather than starting an uploader that cannot publish, and without a persisted index there is
      // no floor to continue above: the head's index is unknown, and beginning at 0 would write into
      // occupied indices and fork the feed invisibly for every reader that keeps following the
      // original chain.
      this.errorHandler.handleError(error, 'StreamCatalog.init');
      throw error;
    }
  }

  /**
   * Continue the feed from the last index this uploader wrote, without having read the state there.
   *
   * Every caller arrives here without a payload in hand, so the entries at `persisted` are unproven
   * and the writes are allowed to find them gone — see {@link resumedToUnreadState}. Never resume
   * *below* that index: writing into already-occupied indices forks the feed invisibly for readers,
   * who keep following the original chain.
   */
  private resumeFromPersisted(persisted: FeedIndex, reason: string): void {
    this.feedIndex = persisted;
    this.resumedToUnreadState = true;
    this.unreadableStateReads = 0;
    this.logger.warn(`[StreamCatalog] ${reason}; resuming from persisted index ${persisted.toString()}`);
  }

  /**
   * Whether "there is no feed here" is something the node actually said.
   *
   * ⛔ `isFeedAbsent` accepts 404 and 503, and the two are not the same evidence. Only a serving node
   * answers 404, so that one settles it. bee answers 503 both for a feed with no update yet and for a
   * node that cannot serve the request at all, and an intermediary in front of a node that is not
   * there answers it too, so a 503 on its own says nothing about the feed.
   *
   * Before the boot learned to wait for its node this could not be reached with a node that was
   * down, because `ChequebookGate` threw on the same node first. That shield was removed on
   * purpose, so the question is asked here instead.
   */
  private async absenceIsAnAnswer(error: unknown): Promise<boolean> {
    if (extractHttpStatus(error) === 404) {
      return true;
    }

    try {
      await this.publisher.bee.status.getReadiness();
      return true;
    } catch (readinessError) {
      this.logger.error(
        `[StreamCatalog] ${safeUrl(this.publisher.url)} answered 503 for the boot lookup and its readiness ` +
          `check did not answer either (${getErrorMessage(readinessError)})`,
      );
      return false;
    }
  }

  /**
   * Whether the node is up and it was only the head's payload that failed to arrive.
   *
   * The error codes for a transfer that broke on the way back cover a request that timed out as
   * well as one whose body was dropped, so the code alone cannot say which happened. A node that
   * answers a liveness check immediately afterwards is the evidence that the payload was the
   * problem. One that does not answer makes this false, so `init` rethrows instead of resuming from
   * the persisted index.
   *
   * That rethrow is waited on like any other. Until 2026-09-17 this one was not: under bee-js 9 a
   * dropped body arrived as `ECONNABORTED` on `statusText` with the message "response stream aborted",
   * and the wait read neither of those, so the boot ended here while every other rethrow was retried.
   * Under bee-js 13 the same body arrives as fetch's `TypeError: terminated`. See `transportCodeOf` in
   * `utils/transportFailure.ts` for where each client leaves a transport code.
   */
  private async payloadUnreadableOnLiveNode(error: unknown): Promise<boolean> {
    if (!isTransferLost(error)) {
      return false;
    }

    if (await this.publisher.bee.connectivity.isConnected()) {
      return true;
    }

    this.logger.error(
      `[StreamCatalog] ${this.publisher.url} did not answer a liveness check — the boot lookup failed on the node, not on the catalog`,
    );
    return false;
  }

  /**
   * Publish one single-rendition stream's entry, replacing whatever this owner last wrote for the
   * same topic.
   *
   * @returns whether this write is the moment the entry became a recording, meaning it carries
   * `vod` and what the catalog held did not. The caller announces the flip off this rather than off
   * its own intent, for the reason {@link upsertRendition} records on the ladder's side of the same
   * question: a resumed finalize rewrites an entry that already says `vod`, and a session announcing
   * a flip it did not cause reports one broadcast ending twice. False is also the honest answer for
   * the live announce, which flips nothing.
   */
  public async addStream(entry: StreamEntry): Promise<boolean> {
    let flippedToVod = false;

    await this.queue.add(() =>
      this.writeFeed((previous) => {
        const held = previous.find((e) => e.owner === entry.owner && e.topic === entry.topic);
        flippedToVod = entry.state === STREAM_STATUS_VOD && held?.state !== STREAM_STATUS_VOD;
        return [...withoutTopic(previous, entry.owner, entry.topic), entry];
      }),
    );

    return flippedToVod;
  }

  /**
   * Merges one rung into its ladder's single catalog entry, creating the entry if this is the
   * first rung up.
   *
   * Four uploaders call this concurrently for the same ladder, each holding only its own rung.
   * The read-merge-write that reconciles them is only safe because the catalog's queue serialises
   * every write to this feed, so the merge always sees the previous rung's result.
   *
   * @returns what this announce achieved for the whole ladder. See {@link RenditionAnnouncement}: the
   * flip is read off the entry the catalog held rather than off the caller's intent, for the reason
   * the `ladderFinalized` line below is written after the write and only when it really flipped.
   */
  public async upsertRendition(identity: LadderIdentity, rendition: Rendition): Promise<RenditionAnnouncement> {
    return this.mergeIntoLadder(identity, rendition, {});
  }

  /**
   * Record that this rung ended without a recording, so its ladder no longer waits for it. See
   * {@link LadderRegistry.recordRungUnfinished}.
   *
   * The same merge and the same write as {@link upsertRendition}, so the `ladderFinalized` line keeps
   * its one meaning: said once, after the write that made the entry a
   * recording, whichever path that write came from. On 2026-09-23 it would have been a sibling's
   * announce, because 1080p stopped two seconds before the last three rungs finalized. Stopping after
   * them, this is the write that finishes the ladder.
   */
  public async recordRungUnfinished(identity: LadderIdentity, rendition: Rendition): Promise<RenditionAnnouncement> {
    return this.mergeIntoLadder(identity, rendition, { unfinished: true });
  }

  private async mergeIntoLadder(
    identity: LadderIdentity,
    rendition: Rendition,
    merge: RungMerge,
  ): Promise<RenditionAnnouncement> {
    let flippedToVod = false;
    let duration: number | null = null;
    let recording: string | null = null;

    await this.queue.add(async () => {
      await this.writeFeed((previous) => {
        const held = previous.find((e) => e.owner === identity.owner && e.group === identity.group);
        if (merge.unfinished && held === undefined) {
          // No rung of this ladder was ever listed, so nothing waits for this one and no viewer can
          // find the ladder. An entry written now would list a broadcast that was never announced.
          return null;
        }
        const wasVod = held?.state === STREAM_STATUS_VOD;
        const entry = buildLadderEntry(identity, previous, rendition, merge);
        // ⛔ The guard's own input, which has never been recorded and is why scenario H has cost
        // three sittings. Every round has been able to see the DECISION (`Ladder … finalized to VOD`)
        // and never the STATE it was made from, so each explanation had to be reasoned rather than
        // read, and three of them were wrong. Debug rather than log: it fires on every announce.
        this.logger.debug(
          `[StreamCatalog] Ladder ${identity.group}: the catalog held ` +
            `${held === undefined ? 'no entry' : `state=${held.state} renditions=${held.renditions?.length ?? 0}`}` +
            `, this announce carries ${rendition.name}` +
            `${hasRecording(rendition) ? ' with its recording' : ' with no recording'}` +
            `${merge.unfinished ? ' that will not finish' : ''}` +
            `, so the entry becomes ${entry.state}`,
        );
        flippedToVod = entry.state === STREAM_STATUS_VOD && !wasVod;
        duration = entry.duration ?? null;
        recording = entry.recording ?? null;

        return [...withoutGroup(previous, identity.owner, identity.group), entry];
      });

      // ⛔⛔⛔ After the write, never inside the update. The one externally visible moment a ladder
      // ends, and the line scenario H arms its kill on, so written from inside the callback it
      // announced a flip the feed had not taken yet. A crash there left the log claiming a finished
      // ladder over an entry that honestly still said `live`, and the reboot then flipped it for real
      // and said so again. Two lines, one flip, and no process wrong about itself. Here it means the
      // entry IS vod.
      if (flippedToVod) {
        this.logger.log(ladderFinalized(identity.group));
      }
    });

    return { recording, flippedToFinished: flippedToVod, duration };
  }

  /** @param update the entries to write, or null when it found nothing to change, which writes nothing. */
  private async writeFeed(
    update: (previous: StreamEntry[]) => StreamEntry[] | null | Promise<StreamEntry[] | null>,
  ): Promise<void> {
    let previous: StreamEntry[] = [];

    if (this.feedIndex !== null) {
      previous = await this.readPreviousState();
    }

    const state = await update(previous);
    if (state === null) {
      return;
    }

    const nextIndex = this.feedIndex ? this.feedIndex.next() : FeedIndex.fromBigInt(BigInt(0));
    const publisher = this.publisher;
    const feedWriter = publisher.bee.feed.makeWriter(this.feedTopic, this.signer);

    const payload = JSON.stringify(state);
    const result = await retryUntilDeadlineAsync(
      // Direct, so the write returns on the storer's receipt and a note may name this index at once.
      // It was deferred to avoid blocking on push-sync, the reason the manifest feed once had too. A
      // deferred version is only on this node when the write returns, so a note naming it would send
      // a viewer to an index the network may not hold yet. Phase 0 measured direct receipts 84 ms after
      // a window end at the median, 2026-10-06.
      () => feedWriter.uploadPayload(publisher.stamp, payload, { index: nextIndex, deferred: false }),
      CATALOG_RETRY_WINDOW_MS,
    );

    this.feedIndex = nextIndex;
    // Whatever boot could not read, this index can be: it is what was just written, through the
    // same node, so a later read failure here is a real one again.
    this.resumedToUnreadState = false;
    this.unreadableStateReads = 0;
    const ownerAddr = this.signer.publicKey().address().toString();
    this.indexStore?.save(ownerAddr, this.feedTopic.toString(), nextIndex);
    this.logger.debug(
      `[StreamCatalog] Feed updated index=${nextIndex.toString()} entries=${state.length} bytes=${payload.length} ref=${
        result?.reference?.toHex?.() ?? '?'
      } owner=${ownerAddr} topic="${this.feedTopicName}" topicHex=${this.feedTopic.toString()}`,
    );
  }

  /**
   * The entries the next update is appended to.
   *
   * Tolerant only inside the window {@link resumedToUnreadState} opens, and even there only once
   * the state has failed to read {@link TREAT_STATE_AS_LOST_AFTER} times over. Retrievability on
   * Swarm flaps — the same index has been watched going unreadable, readable and unreadable again
   * within an hour — so giving up on the first failure would throw away a catalog that a later
   * attempt would have loaded, and that loss cannot be undone. Failing the write instead costs one
   * update, is logged, and is retried by the next segment.
   */
  private async readPreviousState(): Promise<StreamEntry[]> {
    const index = this.feedIndex!.toString();

    try {
      const state = await this.fetchCurrentState();
      this.resumedToUnreadState = false;
      this.unreadableStateReads = 0;
      return state;
    } catch (error) {
      if (!this.resumedToUnreadState) {
        throw error;
      }

      this.unreadableStateReads++;
      if (this.unreadableStateReads < TREAT_STATE_AS_LOST_AFTER) {
        this.logger.warn(
          `[StreamCatalog] State at index ${index} did not read (${getErrorMessage(error)}); ` +
            `attempt ${this.unreadableStateReads} of ${TREAT_STATE_AS_LOST_AFTER} before it counts as gone`,
        );
        throw error;
      }

      this.logger.error(catalogStateLost(index, this.unreadableStateReads));
      return [];
    }
  }

  private async fetchCurrentState(): Promise<StreamEntry[]> {
    const owner = this.signer.publicKey().address();
    const feedReader = this.publisher.bee.feed.makeReader(this.feedTopic, owner);
    const data = await retryUntilDeadlineAsync(
      () => feedReader.downloadPayload({ index: this.feedIndex! }),
      CATALOG_RETRY_WINDOW_MS,
    );
    return data.payload.toJSON() as StreamEntry[];
  }
}

/**
 * The ladder's entry after merging one rung's latest state into it.
 *
 * A ladder goes to VOD once every rung it has announced has finalized or is known not to finish, and
 * at least one of them finalized. See `LadderCompletion`. Doing it per rung would flip the whole entry
 * to VOD on the first one to drain, and the other three are still live.
 *
 * ⛔ A finished entry's `renditions` names only rungs that have a recording, and `topic`, `recording`
 * and `duration` are all read off those, so nothing in it or built from it offers a viewer a rung with
 * nothing to play. A rung that did not finish is named in `unfinishedRungs` instead.
 */
export function buildLadderEntry(
  identity: LadderIdentity,
  previous: StreamEntry[],
  rendition: Rendition,
  merge: RungMerge = {},
): StreamEntry {
  const existing = previous.find((e) => e.owner === identity.owner && e.group === identity.group);
  const merged = mergeRendition(existing?.renditions ?? [], rendition);
  const unfinishedRungs = unfinishedAfter(existing?.unfinishedRungs ?? [], merged, rendition.name, merge);
  const finished = isFinishedLadder(merged, new Set(unfinishedRungs));
  const renditions = finished ? recordedRungs(merged) : merged;

  // Lowest rung first: it is the cheapest to bootstrap, and it is what a client that knows
  // nothing about `renditions` will play when it follows `topic`.
  const primary = renditions[0];

  const entry: StreamEntry = {
    title: identity.title,
    owner: identity.owner,
    topic: primary.topic,
    state: finished ? STREAM_STATUS_VOD : STREAM_STATUS_LIVE,
    mediatype: identity.mediatype,
    timestamp: Date.now(),
    group: identity.group,
    renditions,
  };

  if (unfinishedRungs.length > 0) {
    entry.unfinishedRungs = unfinishedRungs;
  }

  if (finished) {
    entry.recording = primary.recording;
    entry.duration = recordingDuration(renditions);
  }

  return entry;
}

/**
 * The rungs still known not to finish once this merge is in.
 *
 * ⛔ The mark survives every later merge of its rung that carries no recording, because that is what a rung
 * recovered at the next boot sends before it finalizes, and dropping the mark there would turn a
 * finished recording back into a live broadcast. It goes only once the rung has a recording to point
 * at. A rung that already has one is never marked, since the ladder can offer that recording.
 */
function unfinishedAfter(
  held: readonly string[],
  merged: readonly Rendition[],
  rung: string,
  merge: RungMerge,
): string[] {
  const record = merged.find((rendition) => rendition.name === rung);
  if (record !== undefined && hasRecording(record)) {
    return held.filter((name) => name !== rung);
  }
  return merge.unfinished && !held.includes(rung) ? [...held, rung] : [...held];
}

function withoutTopic(entries: StreamEntry[], owner: string, topic: string): StreamEntry[] {
  return entries.filter((e) => e.owner !== owner || e.topic !== topic);
}

function withoutGroup(entries: StreamEntry[], owner: string, group: string): StreamEntry[] {
  return entries.filter((e) => e.owner !== owner || e.group !== group);
}

function mergeRendition(existing: Rendition[], incoming: Rendition): Rendition[] {
  const previous = existing.find((r) => r.name === incoming.name);
  const merged = existing.filter((r) => r.name !== incoming.name);
  merged.push(keepingWhatFinished(previous, incoming));
  return merged.sort((a, b) => a.height - b.height);
}

/**
 * A rung that has already finished stays finished when it announces itself again.
 *
 * ⛔⛔⛔ Scenario H, caused 2026-09-01 after being an open red since 2026-08-31. A rung recovered
 * from a crash announces itself before it finalizes, and that announcement carries no recording
 * because it has not uploaded one yet. The merge replaced the finished rendition
 * wholesale, so what the rung recorded when it DID finalize was thrown away, the check that every
 * rung had finished went false, and **the whole finished ladder went
 * back to `live` in the catalog**. Read off the host log: ladder `fdbd7167` finalized at 05:58:04,
 * was killed, rebooted with a clean catalog read, and finalized again at 05:59:08 when the recovery
 * timer fired. For that minute a recording that had ended was advertised as a live broadcast, and
 * the second flip paid for another catalog write.
 *
 * `recording`, `duration` and `topic` move together or not at all: they are one finished
 * recording of one rung, and keeping part of it would describe two. Everything the re-announce
 * genuinely knows better, the measured bitrates, is taken from it.
 *
 * ⛔ **A rung's topic is stable, and this rule is written for that and NOT against it.** Since a
 * rung's feed topic is derived from its ladder group and its rung name, the re-announce carries the
 * same topic the finished record already holds, and a rung that stopped and started again is live
 * again on the same feed. That is not a reason to compare topics here. The question this answers is
 * whether a recording that has been published is still the one to point at, and until the returning
 * session finalizes there is nothing else to point at: its own recording does not exist yet, and the
 * previous one is whole as kept here. The next finalize arrives WITH a recording and replaces the
 * record wholesale, which is the first branch below and which is how the entry comes to name the
 * latest of however many recordings that rung has made.
 */
function keepingWhatFinished(previous: Rendition | undefined, incoming: Rendition): Rendition {
  if (previous === undefined || !hasRecording(previous) || hasRecording(incoming)) {
    return incoming;
  }
  return {
    ...incoming,
    topic: previous.topic,
    recording: previous.recording,
    duration: previous.duration,
  };
}
