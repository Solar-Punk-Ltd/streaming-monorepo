import { Bee, BeeResponseError, PrivateKey } from '@ethersphere/bee-js';
import {
  addingStreamToList,
  createLiveWindowWriter,
  engineSkippedSegments,
  ladderFinalized,
  LIVE_PLAYLIST_WINDOW_MS,
  liveWindowWritten,
  originDeclaredDiscontinuity,
  parseLiveWindowPayload,
  publishingRendition,
  recordingUploaded,
  rungBatchRefused,
  segmentsNeverArrived,
  segmentUploaded,
  segmentUploadFailed,
  updatingStreamToVod,
  windowIdentifier,
  windowOf,
  type WindowSlot,
  type WindowWriteEvent,
  type WindowWriterClock,
} from '@swarm-hls-stream/shared';
import PQueue from 'p-queue';

import {
  BitrateSample,
  BroadcastAnchor,
  InheritedTimeline,
  LadderMembership,
  MediaType,
  Rendition,
  SegmentEntry,
  STREAM_STATUS_LIVE,
  STREAM_STATUS_VOD,
  StreamState,
} from '../types.js';
import { beeAnswer, getErrorMessage, nonRetryableStatus, retryUntilDeadlineAsync } from '../utils/common.js';

import {
  ADMIN_STATE_LIVE,
  ADMIN_STATE_VOD,
  AdminApiClient,
  AdminStateReport,
  stateWasReported,
} from './AdminApiClient.js';
import {
  AnnounceReadiness,
  needsCatalogAnnounce,
  onCatalogAnnounced,
  onFirstSegmentUploaded,
  READINESS_ANNOUNCED,
  READINESS_PENDING,
  readinessFromPersisted,
  readinessToPersisted,
} from './AnnounceReadiness.js';
import { BeePublisher } from './BeePublisherPool.js';
import { averageBandwidth, emptyBitrateSample, peakBandwidth, recordSegment } from './BitrateMeter.js';
import { BroadcastDating } from './broadcastDating.js';
import { ErrorHandler } from './ErrorHandler.js';
import { LadderIdentity, LadderRegistry, RenditionAnnouncement } from './LadderRegistry.js';
import { Logger } from './Logger.js';
import { continuesFrom, ManifestManager } from './ManifestManager.js';
import { RecoveryStore } from './RecoveryStore.js';
import { ServiceMetrics } from './ServiceMetrics.js';
import { StreamCatalog } from './StreamCatalog.js';

const SEGMENT_UPLOAD_RETRY_WINDOW_MS = 15_000;
/** How long the recording playlist's upload keeps trying at the end, the same as a segment's. */
const RECORDING_UPLOAD_RETRY_WINDOW_MS = 15_000;
const UPLOAD_RETRY_BASE_MS = 350;
const UPLOAD_RETRY_CAP_MS = 2_000;

/**
 * How far back a new session on a topic that outlived its predecessor looks for that predecessor's
 * newest window, which is where its media sequence carries on from.
 *
 * A minute, thirty windows of 2 s, read once and in parallel when the session opens. A rung
 * restarting mid-broadcast comes back within seconds of its predecessor's closing window, which this
 * finds. A declared stream that broadcasts again after a longer silence finds nothing and numbers from
 * 0, which a viewer meets as a new broadcast rather than as the next update of one it is playing.
 */
const OPENING_SCAN_MS = 60_000;

/**
 * How many window outcomes the closing window gets before a finalize goes on without it.
 *
 * A failed window is never retried at its address, so the closing playlist is offered again to the
 * next window, and the next. Past this many the recording is still worth uploading, and what is lost
 * is the clean ending for whoever is watching right now.
 */
const CLOSING_WINDOW_ATTEMPTS = 4;

/**
 * The window writer's clock and timers when nothing is injected. The timers are unreferenced, so a
 * session left open never holds the process open on its own: the service is held open by its server.
 */
const WINDOW_TIMERS: WindowWriterClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => {
    const timer = globalThis.setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

/** Bee's answers for a single owner chunk nobody wrote, which the opening scan reads as no window. */
function isChunkAbsent(error: unknown): boolean {
  return error instanceof BeeResponseError && (error.status === 404 || error.status === 500);
}

/** What one window's playlist named when it was composed, applied only once that window is stored. */
interface WindowNaming {
  newestNamed: number | null;
  neverNamed: number;
}

/**
 * How long to wait before re-attempting a catalog announce that failed.
 *
 * The announce has to keep retrying, because the catalog entry is the only thing that makes a live
 * broadcast discoverable and a stream that gives up is unwatchable for its whole duration. What it
 * must not do is retry on the segment cadence, which is what tied a dead catalog to a feed read, a
 * feed write and the postage for it every two seconds. The right rate is how long a viewer can wait
 * for a broadcast to appear, not how often media arrives.
 */
const CATALOG_ANNOUNCE_RETRY_MS = 30_000;

/**
 * How far the measured bitrate has to drift, and how long between corrections, before a rung
 * rewrites the catalog.
 *
 * BANDWIDTH is the whole supply-side input to the player's ABR decision, so it has to end up
 * honest — but the catalog is one feed shared by every stream, and republishing per segment would
 * have four rungs contending on it every fragment. Announce on the encoder's target, then correct
 * only when the measurement has actually moved.
 */
const BITRATE_REFRESH_RATIO = 0.15;
const BITRATE_REFRESH_INTERVAL_MS = 30_000;

/**
 * The admin service and this broadcast's place in it, when `ADMIN_API_URL` is set. Absent is the
 * standalone deployment, where the stream catalog on Swarm is this service's own to write.
 *
 * Its presence changes four things in this class and nothing else, and every one of them follows from
 * the single fact that the topic is the declaration's rather than this session's:
 *
 * 1. **No catalog write, ever.** Not the live announce, not the VOD flip. The admin owns the list of
 *    streams in admin mode, and a second writer would publish entries nothing reconciles.
 * 2. **A state report in each of their places**, at the same two moments and in the same order, so
 *    the memoization and the ordering the comments here describe go on meaning what they say.
 * ⚠️ A rung of a ladder in admin mode holds (1) and (2) unchanged, with the reports made at ladder
 * granularity — see {@link notifyStart} and {@link completeFinalize}. Its own manifest topic is not
 * the declared one, which is the ladder's master feed; what it publishes on is derived from its
 * ladder group and its rung name, and outlives its session for reasons of its own. See
 * {@link topicOutlivesThisSession}.
 */
interface AdminReporting {
  client: AdminApiClient;
  /** The admin's own id for this stream, which every report names. */
  id: string;
}

interface RestoreState {
  streamRawTopic: string;
  segments: SegmentEntry[];
  hlsHeaders: string[];
  isFirstSegmentReady: boolean;
  isFirstManifestReady: boolean;
  pendingDiscontinuity?: boolean;
  bitrate?: BitrateSample;
  /** Absent on an entry written before playlists carried a wall clock. See {@link BroadcastAnchor}. */
  anchor?: BroadcastAnchor;
  /** Absent on an entry written before a rung's feed outlived its session. See {@link StreamState}. */
  sequenceOffset?: number;
  /** Absent on an entry written before recordings were glued, and on a session over an empty feed. */
  inherited?: InheritedTimeline;
  /**
   * Absent on an entry written before a disconnect held a session open, and on every session whose
   * encoder was still feeding it. See {@link StreamUploader.resumeAfterReconnect}.
   */
  resumingAfterReconnect?: string;
}

export interface StreamUploaderOptions {
  /**
   * The Bee node this session publishes through and the postage batch it pays with, as one value.
   *
   * One value rather than a client and a batch id passed side by side, because they are one routing
   * decision taken in `BeePublisherPool` and a session that held a client from one node and a batch
   * from another would spend a batch that node cannot issue against. It also carries the node's own
   * rung and url, which is the identity a refused batch is reported under. See
   * {@link StreamUploader.reportBatchRefusal}.
   */
  publisher: BeePublisher;
  streamCatalog: StreamCatalog;
  /**
   * Where a ladder rung's rendition record goes, and where its deliveries are counted.
   *
   * Defaults to `streamCatalog`, which is the standalone deployment: the catalog merges the four rungs
   * into one entry and writes the master from it. In admin mode the merge state belongs to the admin,
   * so an `AdminLadderRegistry` takes its place — and nothing else in this class changes, because a rung
   * announcing itself is the same act either way. Unread on a stream with no ladder.
   */
  ladderRegistry?: LadderRegistry;
  recoveryStore: RecoveryStore;
  streamKey: string;
  streamId: string;
  /**
   * The topic this stream's live windows are written under, and the one the stream list's rendition
   * names. Supplied rather than generated, because a ladder's
   * rungs derive theirs from a shared group id and the orchestrator is what knows the group.
   */
  streamTopic: string;
  mediatype: MediaType;
  /**
   * Erasure-coding level for segment uploads.
   *
   * Parity is durability insurance, and it is paid for twice on a live stream: once on upload, and
   * again by every viewer, because the extra chunks widen the retrieval fan-out that dominates how
   * long a segment takes to arrive. A segment that outlives its playlist window is of no use to
   * anyone, so for live the insurance mostly buys nothing. 0 turns it off.
   */
  redundancyLevel: number;
  ladder?: LadderMembership;
  /**
   * The instant this broadcast started and the fragment length it cuts at, which together date every
   * segment this session publishes. One value for the whole ladder. See {@link BroadcastAnchor}.
   */
  anchor: BroadcastAnchor;
  /**
   * Where a restart's re-anchoring of that dating is minted, once for the whole ladder. Absent
   * leaves this session re-anchoring on its own wall clock, which is a ladder of one.
   */
  dating?: BroadcastDating;
  /** State from a previous run of this stream id, so a restart resumes rather than starting over. */
  restoreState?: RestoreState;
  /**
   * How long to wait before re-attempting a failed catalog announce. Injectable only so the retry can
   * be driven in a test: at its default the sequence takes half a minute of wall clock.
   */
  catalogAnnounceRetryMs?: number;
  /** Process-lifetime counters this session reports into. Absent in tests that do not read them. */
  metrics?: ServiceMetrics;
  /** The admin service, when the deployment has one. See {@link AdminReporting}. */
  admin?: AdminReporting;
  /**
   * The actual write completion of every earlier session on this topic, when any are still pending.
   *
   * ⛔ **It is what keeps two sessions off one topic.** A re-announce retires the live session and
   * starts this one in the same synchronous turn, then drains the retired one in the background. An
   * explicit stop can also time out and free the id while its I/O continues. Both cases share the
   * same topic wherever that topic outlives a session, a declared stream in admin mode or a rung of
   * a ladder in either deployment. An earlier session's closing windows are written on the topic this
   * session is about to write on, and two writers on one window address are as bad as two on one feed
   * index. `retire()` does not stop them. It only gives up the recovery entry, the admin report and the
   * catalog entry.
   *
   * Unset means no earlier writer is still outstanding on this topic. A standalone single-rendition
   * stream always qualifies because its topic is a fresh uuid nothing else has ever held.
   *
   * See {@link predecessorHasDrained}.
   */
  predecessorDrained?: Promise<void>;
  /**
   * Whether this host's clock may name a window right now, asked before every window write. Defaults
   * to always. A window named by a clock that is off is a window at the wrong address, so a clock
   * check answers false while it cannot vouch for the clock and the window goes unwritten.
   */
  clockTrusted?: () => boolean;
  /**
   * The live window's length and the clock its windows are timed on. Injectable only so a test can
   * step windows rather than wait for them: at the defaults, `LIVE_PLAYLIST_WINDOW_MS` and the wall
   * clock, a window is two seconds of real time.
   */
  liveWindowMs?: number;
  windowClock?: WindowWriterClock;
}

/** The live window writer, as `createLiveWindowWriter` returns it. */
type LiveWindowWriter = ReturnType<typeof createLiveWindowWriter>;

export class StreamUploader {
  public readonly segmentQueue = new PQueue({ concurrency: 1 });
  /** The engine index of every segment handed over whose upload has not finished, oldest first. */
  private readonly unplacedIndexes: number[] = [];
  /**
   * How many of {@link unplacedIndexes} were handed over before the return now waiting in the queue,
   * or null when no return is waiting. See {@link publishedCountBeforeReturn}.
   */
  private handedBeforeReturn: number | null = null;
  /** Where the catalog announce runs, one at a time, off the window that first landed. */
  private announceQueue = new PQueue({ concurrency: 1 });
  private announceQueued = false;
  private logger = Logger.getInstance();
  private errorHandler = ErrorHandler.getInstance();

  private publisher: BeePublisher;
  private bee: Bee;
  private streamSigner: PrivateKey;
  private streamRawTopic: string;
  private streamCatalog: StreamCatalog;
  private ladderRegistry: LadderRegistry;
  private recoveryStore: RecoveryStore;
  private streamId: string;
  private stamp: string;
  private redundancyLevel: number;
  private mediatype: MediaType;
  private readiness: AnnounceReadiness = READINESS_PENDING;
  private ladder?: LadderMembership;
  private pendingDiscontinuity = false;
  private consecutiveManifestFailures = 0;
  private consecutiveSegmentFailures = 0;
  /**
   * The upload statuses this stream has already reported a postage refusal for, so the line is said
   * once for each answer bee gives rather than once per segment a filling batch loses.
   *
   * ⛔⛔ Keyed on the status rather than on a single flag, and that is the difference between a
   * diagnosis and a wrong one. A batch fills over a minute or two, so identical refusals repeat and
   * one line is right for them. A DIFFERENT status is a different condition, and a flag would let an
   * early 413 or 404 claim the report for the whole process and silence the postage refusal that
   * followed it: the log would then carry one refusal naming the wrong answer, a harness counting
   * refusals would still count one, and a drain would be filed as proven against evidence of
   * something else.
   *
   * Deliberately not persisted with the rest of the stream state. A restart is the only way the batch
   * changes, because `BEE_PUBLISHERS` is read once at process start, and a restart starts this set
   * empty again, so the first refusal of a batch this process has never uploaded against is still
   * said.
   */
  private readonly batchRefusalStatuses = new Set<number>();
  /**
   * The newest segment index a written live window has named, or null before the first window.
   *
   * Null rather than restored from persisted state after a crash: the window a recovered uploader
   * publishes is built from segments it did reload, so a restored value would report the whole
   * outage as segments this uploader failed to name when nothing here failed at all.
   */
  private announcedThrough: number | null = null;
  private segmentsNeverNamed = 0;
  /** Whether the recovery entry under this stream id still describes this uploader. See `retire`. */
  private ownsRecoveryEntry = true;
  /**
   * Whether this session was rebuilt from a recovery entry rather than announced by an engine.
   *
   * The only thing it decides is whether a session on a topic that outlives it looks for its
   * predecessor's newest window. A recovered session already holds the numbering it published, in
   * its recovery entry, and the newest window on its topic is its own. See
   * {@link topicOutlivesThisSession}.
   */
  private readonly resumedFromCrash: boolean;
  /** The one finalize this session gets, so a second caller joins it rather than repeating it. */
  private finalizing: Promise<void> | undefined;
  /** When the catalog announce first failed and has not since succeeded, or null while it is listed. */
  private catalogAnnounceFailedAt: number | null = null;
  private lastCatalogAnnounceAt: number | null = null;
  private readonly catalogAnnounceRetryMs: number;
  /** When this stream's state first failed to reach disk and has not since landed. */
  private statePersistFailedAt: number | null = null;
  private readonly metrics?: ServiceMetrics;
  /** Playing time of everything still queued, in seconds, which is how far behind live this stream is. */
  private queuedSeconds = 0;
  /** Segments this session was handed, so an empty finalize can tell "nothing to record" from "lost it all". */
  private segmentsOffered = 0;

  private bitrate: BitrateSample = emptyBitrateSample();
  private driftBaselineBps = 0;
  private lastAnnounceAttemptAt = 0;

  /** The admin service and this stream's id in it, or undefined in the standalone deployment. */
  private readonly admin?: AdminReporting;
  /**
   * Whether this session knows the media sequence it numbers from. True from the start unless its
   * topic outlived the session before it, and then once the opening scan has answered. See
   * {@link findPosition}.
   */
  private positionKnown: boolean;
  /** The opening scan while it runs, so a second segment does not start a second one. */
  private settling: Promise<void> | undefined;
  /** Every earlier session on this topic having finished writing, or already settled when there are none. */
  private readonly predecessorDrained: Promise<void>;
  /**
   * Whether every earlier session has finished writing to the topic they share.
   *
   * True from the start unless the orchestrator still tracks an earlier writer on a topic that
   * outlives its sessions. This covers a replacement and a fresh start after an earlier stop timed
   * out. See
   * {@link StreamUploaderOptions.predecessorDrained} and {@link topicOutlivesThisSession}.
   */
  private predecessorHasDrained = true;

  private manifestManager: ManifestManager;

  /** Writes this quality's live playlist as the `live` chunk of every window while the stream is live. */
  private readonly liveWindows: LiveWindowWriter;
  private readonly windowMs: number;
  private readonly windowClock: WindowWriterClock;
  private windowsStarted = false;
  /** Set when the broadcast ends, so every window from then on carries the closing playlist. */
  private closing = false;
  /** The windows composed with the closing playlist, so its landing can be told from an earlier one. */
  private readonly closingWindows = new Set<number>();
  /** What each window composed but not yet settled named. See {@link WindowNaming}. */
  private readonly namedByWindow = new Map<number, WindowNaming>();
  /** Who is waiting on window outcomes, which is the finalize waiting for its closing window. */
  private readonly windowWaiters = new Set<(event: WindowWriteEvent) => void>();

  constructor(options: StreamUploaderOptions) {
    this.catalogAnnounceRetryMs = options.catalogAnnounceRetryMs ?? CATALOG_ANNOUNCE_RETRY_MS;
    this.metrics = options.metrics;
    this.admin = options.admin;
    // The orchestrator normalizes expected drain failures, so the catch is a backstop for a rejection
    // no current caller produces. Every window is composed empty while it is pending, so a stuck
    // predecessor holds this session's windows and nothing else: segments keep uploading.
    this.predecessorDrained = options.predecessorDrained?.catch(() => {}) ?? Promise.resolve();
    if (options.predecessorDrained) {
      this.predecessorHasDrained = false;
      void this.predecessorDrained.finally(() => {
        this.predecessorHasDrained = true;
      });
    }
    this.publisher = options.publisher;
    this.bee = options.publisher.bee;
    this.streamSigner = new PrivateKey(options.streamKey);
    this.streamCatalog = options.streamCatalog;
    this.ladderRegistry = options.ladderRegistry ?? options.streamCatalog;
    this.recoveryStore = options.recoveryStore;
    this.streamId = options.streamId;
    this.stamp = options.publisher.stamp;
    this.redundancyLevel = options.redundancyLevel;
    this.mediatype = options.mediatype;
    this.ladder = options.ladder;
    this.streamRawTopic = options.streamTopic;
    // Restored in preference to the one this session was handed, so a recovered broadcast keeps the
    // wall clock its earlier segments were dated against. Taking the fresh one would restamp the
    // recording's whole history at the moment of the recovery.
    const anchor = options.restoreState?.anchor ?? options.anchor;

    this.manifestManager = new ManifestManager(anchor, options.dating);

    const restoreState = options.restoreState;
    this.resumedFromCrash = restoreState !== undefined;
    if (restoreState) {
      this.streamRawTopic = restoreState.streamRawTopic;
      const restored = readinessFromPersisted(restoreState);
      this.readiness = restored.readiness;
      if (restored.repairedFrom) {
        // Loud, because this pair cannot be produced by any live sequence, so the entry on disk was
        // corrupted or hand-edited and whoever owns the deployment should know. Repaired rather than
        // refused: see the note on `readinessFromPersisted`.
        this.logger.warn(
          `[StreamUploader] Recovery entry for ${options.streamId} claims the catalog announce happened ` +
            'before its first segment, which is not reachable. Treating the stream as not yet ' +
            'announced so it is published rather than left invisible.',
        );
      }
      this.pendingDiscontinuity = restoreState.pendingDiscontinuity ?? false;
      // Restored for a sharper version of the reason the flag above is: the window between arming it
      // and the segment that consumes it is precisely one in which nothing is arriving. Lost, the
      // first segment after the encoder returned would publish at its own index with the dating the
      // broadcast opened with, and the seam across the outage would go unsaid.
      if (restoreState.resumingAfterReconnect) {
        this.manifestManager.resumeAfterReconnect(restoreState.resumingAfterReconnect);
      }
      if (restoreState.bitrate) {
        this.bitrate = restoreState.bitrate;
      }
      // The inherited prefix goes in with the segments rather than after them, because it is part of
      // what this session's recording is and `restoreState` is where that is settled.
      this.manifestManager.restoreState(restoreState.segments, restoreState.hlsHeaders, restoreState.inherited);
      // After the segments, because it is about how they are published rather than about what they
      // are: `restoreState` replays a numbering viewers have already been handed, and this is the
      // offset that numbering was published under.
      if (restoreState.sequenceOffset) {
        this.manifestManager.continueFrom(restoreState.sequenceOffset);
      }
      this.logger.info(
        `[StreamUploader] Restored stream ${options.streamId} with ${restoreState.segments.length} segment(s)`,
      );
    }
    this.positionKnown = !this.topicOutlivesThisSession();

    // Built last, because a recovered session takes its topic from its recovery entry above.
    this.windowMs = options.liveWindowMs ?? LIVE_PLAYLIST_WINDOW_MS;
    this.windowClock = options.windowClock ?? WINDOW_TIMERS;
    this.liveWindows = createLiveWindowWriter({
      topic: this.streamRawTopic,
      windowMs: this.windowMs,
      clock: this.windowClock,
      clockTrusted: options.clockTrusted,
      compose: (window) => this.composeWindow(window),
      write: (slot, payload) => this.writeWindow(slot, payload),
      onEvent: (event) => this.onWindowEvent(event),
    });
  }

  public handleSegment(segmentIndex: number, duration: number, data: Buffer): void {
    // Counted when queued and released however the job ends, so a stream whose uploads are failing
    // reports a backlog that drains rather than one that grows forever.
    this.queuedSeconds += duration;
    this.segmentsOffered += 1;
    recordSegment(this.bitrate, data.length, duration);
    this.unplacedIndexes.push(segmentIndex);
    // Started by the first segment rather than at construction, so a session nothing was sent to
    // writes no window, and a recovered one waits for its encoder or its finalize.
    this.startWindows();
    // uploadSegment answers a failed upload as a gap entry rather than rejecting.
    void this.segmentQueue.add(async () => {
      try {
        await this.uploadSegment(segmentIndex, duration, data);
      } finally {
        this.queuedSeconds -= duration;
      }
    });
  }

  public getQueuedSeconds(): number {
    return this.queuedSeconds;
  }

  private async uploadSegment(segmentIndex: number, duration: number, data: Buffer): Promise<void> {
    const result = await this.uploadDataToBee(data);
    this.settleOldestHanded();
    if (!result) {
      // Nothing landed within the retry window, so this segment's sequence stays empty and
      // `ManifestManager` lists it as a gap entry. No discontinuity: the encoder did not restart, so
      // the media behind the hole is a continuation, and telling a player otherwise makes it flush
      // what it had buffered.
      this.consecutiveSegmentFailures += 1;
      this.logger.error(segmentUploadFailed(this.streamId, segmentIndex));
      this.metrics?.recordSegmentDropped(this.ladder?.rung.name);
      this.persistState();
      return;
    }

    this.consecutiveSegmentFailures = 0;
    const ref = result.reference.toHex();
    this.manifestManager.addSegment(segmentIndex, duration, ref, this.pendingDiscontinuity);
    this.pendingDiscontinuity = false;
    this.readiness = onFirstSegmentUploaded(this.readiness);

    this.logger.log(segmentUploaded(this.streamId, segmentIndex, ref));

    this.metrics?.recordSegmentUploaded(Date.now(), this.ladder?.rung.name);
    await this.refreshBandwidthIfDrifted();
    this.persistState();
  }

  /**
   * Segments that never reached this uploader, because the engine could not download them from the
   * origin. One contiguous gap is one call, however many it spans.
   *
   * ⛔ **Reported, not marked.** The lost sequences stay empty and `ManifestManager` lists each of
   * them as a gap entry, which is what tells a player there is media there it cannot have. No
   * discontinuity, because nothing restarted the encoder: the media behind the hole carries on from
   * the media in front of it, and a break would tell a player to flush what it had buffered for a
   * join that never happened. See the gap-entry section of {@link ManifestManager}.
   *
   * Deliberately does **not** touch `consecutiveSegmentFailures`. That counter clears on the next
   * successful segment, and the engine writes a segment off and then downloads the one behind it in
   * the same pass, so the clearing success always lands before anything can read the count. The
   * signal for a loss is an age recorded by the orchestrator, which no later event makes untrue.
   */
  public handleSegmentLoss(firstIndex: number, count: number): void {
    const subject = count === 1 ? `Segment ${firstIndex}` : `${count} segments from index ${firstIndex}`;
    this.queueAnnouncement(() => this.logger.error(segmentsNeverArrived(subject, this.streamId)));
  }

  /**
   * A gap nobody reported, which the orchestrator found between the index it last accounted for and
   * the one it has just taken. Everything {@link handleSegmentLoss} does, announced as its own family.
   *
   * ⛔ **The two must not share a line.** A reported loss is the engine saying it could not fetch
   * something, which only the OME puller ever says. This is the SRS path, where a segment closed
   * while this process was dead is never posted again and the following index is the only evidence
   * there is. Scenario F waits on this family by itself to prove the gap after a crash was reported,
   * and a wait on the reported-loss wording would be satisfied by an OME broadcast losing a segment.
   *
   * @param fromIndex the last index accounted for, whose own segment is already queued or published
   * @param toIndex the index that has just arrived, which the hole runs up to
   */
  public handleInferredSegmentLoss(fromIndex: number, toIndex: number, count: number): void {
    this.queueAnnouncement(() => this.logger.error(engineSkippedSegments(fromIndex, toIndex, this.streamId, count)));
  }

  /**
   * A discontinuity the origin declared with `#EXT-X-DISCONTINUITY`, meaning the media from here on is
   * not a continuation of what came before it. An encoder restart upstream produces exactly this, and
   * a manifest that omits it tells players the join is seamless, which is what they stall on.
   *
   * ⛔ One of only two things that still arm the flag, the other being the engine's own counter
   * restarting inside `ManifestManager.placeInBroadcast`. A lost segment is not one of them: it
   * leaves a hole, and a hole is said with gap entries.
   *
   * Ordinary rather than an error, unlike a loss: nothing went wrong here and nothing was dropped.
   */
  public markDiscontinuity(): void {
    this.queueDiscontinuity(() => this.logger.info(originDeclaredDiscontinuity(this.streamId)));
  }

  /**
   * The encoder feeding this session went away and has come back inside the window that held the
   * session open, so this broadcast carries on rather than a new one starting.
   *
   * What it changes is exactly the two things that are not true across a reconnect. The media either
   * side of the gap is not continuous, so the next segment carries a break. And the encoder's clock
   * restarted while ours did not, or, for a rung SRS held through the drop, ran on without the gap in
   * it, so the dating re-anchors at the sequence the numbering resumes at, through
   * `ManifestManager.resumeAfterReconnect`. Everything else about the session is untouched:
   * the recording, the topic, the windows being written, the admin report, the inherited prefix.
   *
   * ⛔ **One flag rather than two, and `pendingDiscontinuity` is deliberately NOT one of them.** The
   * manifest's own one-shot declares the break where it places the seam, so arming the uploader's
   * flag as well would only mean the same break twice over — and, for an encoder that reconnects and
   * then delivers nothing, a break on a segment that has nothing in front of it to be separated from.
   * The one-shot is persisted, so a crash between the return and its first segment still owes both.
   *
   * ⛔ **Nothing countable is logged here.** The contract line belongs where the seam is actually
   * placed, or an encoder that reconnects six times and delivers nothing puts six armings into a
   * count that has to equal the breaks in the playlist. This line names the stream, which the one at
   * the placement cannot, and an operator reads the two as a pair.
   *
   * @param returnToken which return of the broadcast this is, so the rungs of one ladder date it
   * alike however far apart their numbering is. See {@link BroadcastEpoch.returnToken}.
   *
   * ⛔ Queued rather than applied inline, for {@link queueAnnouncement}'s own reason and one more: a
   * segment already awaiting upload when the encoder returned belongs to the run BEFORE the gap, and
   * arming inline would put the seam and the re-anchoring on that one instead of on the first segment
   * of the run after it.
   */
  public resumeAfterReconnect(returnToken: string): void {
    this.handedBeforeReturn ??= this.unplacedIndexes.length;
    this.queueAnnouncement(() => {
      this.handedBeforeReturn = null;
      this.manifestManager.resumeAfterReconnect(returnToken);
      this.logger.info(
        `[StreamUploader] The encoder feeding ${this.streamId} is back, so the next segment it delivers ` +
          'opens a resumed run rather than continuing the one before the gap',
      );
    });
  }

  /**
   * Say something about the media and write the state down, behind whatever is already queued.
   *
   * Queued rather than run inline so it takes its place behind segments already awaiting upload.
   * Inline, a loss would be announced in front of media that arrived before it, and a suite reading a
   * log window bounded by the fault would charge it to the wrong moment.
   */
  private queueAnnouncement(announce: () => void): void {
    // Announcements only log, and persistState catches its own failure.
    void this.segmentQueue.add(() => {
      announce();
      this.persistState();
    });
  }

  /**
   * {@link queueAnnouncement} for the one caller that also arms the break, so the marker attaches to
   * the next segment taken rather than to one that arrived before it.
   */
  private queueDiscontinuity(announce: () => void): void {
    this.queueAnnouncement(() => {
      this.pendingDiscontinuity = true;
      announce();
    });
  }

  public async notifyStart(): Promise<void> {
    if (this.admin && this.ladder) {
      // ⛔ The rung first and the ladder's state second, which is the same ordering as everywhere
      // else here: the rendition a player builds its master from has to be in the ladder before
      // anything says the broadcast is live. `live` is a statement about the LADDER, and it may be
      // said more than once, by each rung in turn and again after a restart, which is why the admin
      // accepts `live -> live`.
      const announced = await this.announceRendition();
      if (announced !== null) {
        await this.reportAdminState(
          { state: ADMIN_STATE_LIVE },
          'so the admin will go on showing it as a draft until the next attempt',
        );
      }
      return;
    }

    if (this.admin) {
      return this.reportAdminState(
        { state: ADMIN_STATE_LIVE },
        'so the admin will go on showing it as a draft until the next attempt',
      );
    }

    if (this.ladder) {
      await this.announceRendition();
      return;
    }

    const entry = {
      title: this.getFormattedDate(),
      owner: this.streamSigner.publicKey().address().toHex(),
      topic: this.streamRawTopic,
      state: STREAM_STATUS_LIVE,
      mediatype: this.mediatype,
      timestamp: Date.now(),
    };

    this.logger.log(addingStreamToList(JSON.stringify(entry)));
    // The flip answer is `false` for a live announce by construction, so it is discarded here rather
    // than checked. `completeFinalize` is the caller that reads it.
    await this.streamCatalog.addStream(entry);
  }

  /**
   * Finalize this session as a VOD, once, however many callers ask.
   *
   * Two of them reach here for one session and neither can see the other. A reconnect during a drain
   * retires the live session and hands it to `finalizeRetiredSession`, which deliberately stays out of
   * the orchestrator's `drainPromises` because the id belongs to the replacement by then, so the guard
   * that answers a duplicate stop with the drain already running never sees it. Unguarded, both ran the
   * body below: two recordings uploaded and the second rewriting the catalog entry the first had
   * published.
   *
   * A finalize that throws is shared rather than retried, which is what the callers already did with
   * the orchestrator's drain promise, and no path retries one today.
   */
  public async notifyStop(): Promise<void> {
    this.finalizing ??= this.finalize();
    return this.finalizing;
  }

  private async finalize(): Promise<void> {
    await this.segmentQueue.onIdle();
    await this.announceQueue.onIdle();

    if (!this.manifestManager.hasSegments()) {
      await this.liveWindows.stop();
      // A session nobody sent anything to ends cleanly: there is no recording because there was
      // nothing to record. A session that was handed media and has none to publish is the opposite,
      // and it used to end the same way, so a broadcast whose every upload failed answered
      // `finalized` byte for byte like a healthy stop and counted as one.
      if (this.segmentsOffered > 0) {
        throw new Error(
          `Stream ${this.streamId} was handed ${this.segmentsOffered} segment(s) and published none, so it has no VOD`,
        );
      }
      this.logger.warn(`Stream ${this.streamId} has no segments, skipping VOD finalization`);
      this.clearRecoveryEntry();
      return;
    }

    // The closing window first. It ends the playlist live viewers are already on, so they play out
    // what they hold and stop, and no window is written after it: a window after the end would tell a
    // reader joining then that the stream is live again.
    const closed = await this.writeClosingWindow();
    await this.liveWindows.stop();
    // A broadcast whose first window was its closing one announces itself off that window, and the
    // live announce has to land before the recording's, or the list ends up saying live.
    await this.announceQueue.onIdle();
    if (!closed) {
      // Not fatal to finalization. The recording below is what the stream list names and it is still
      // worth uploading. What is lost is the clean ending for whoever is watching right now.
      this.logger.warn(
        `Failed to write the closing live window for stream ${this.streamId}, so viewers watching live ` +
          'will see the stream go silent rather than end',
      );
    }
    // ⛔ Refused rather than published while this session does not know where its numbering stands,
    // which is a predecessor that never finished writing or an opening scan that never answered. Its
    // recording would be numbered from zero over a topic that may already hold a broadcast, and the
    // recovery entry was never written either, for the reason `persistState` gives.
    if (!this.positionSettled()) {
      throw new Error(
        `Stream ${this.streamId} ended before it knew where its numbering stands on its topic, so it ` +
          'uploads no recording',
      );
    }

    // ⛔ Addressed by its content, which is what makes a crash between this upload and the report
    // below safe. A recovered session builds the same recording from the same recovery entry, uploads
    // the same bytes, gets the same reference, and repeats the report: one entry, one recording, and
    // nothing to read back first. Behaviour B18 of the windows plan.
    const recording = await this.uploadRecording(this.manifestManager.buildVODManifest());
    if (recording === null) {
      throw new Error(`Failed to upload the recording of stream ${this.streamId}`);
    }
    this.logger.log(recordingUploaded(this.streamId, recording));

    return this.completeFinalize(recording);
  }

  /**
   * Everything a finalize still owes once the recording is uploaded: name it in the catalog, and
   * only then stop claiming the broadcast is recoverable.
   *
   * The ordering of what follows the upload is the whole of scenario H. The recovery entry goes last
   * of all: it is the only record the broadcast was live, so deleting it before the catalog names the
   * recording is the one step that cannot be taken back.
   *
   * @param recording the reference of this quality's recording playlist, which is what the catalog
   * entry, the rung or the admin report points a viewer at.
   */
  private async completeFinalize(recording: string): Promise<void> {
    if (this.admin && this.ladder) {
      // This rung's own recording goes on its own rung. What the stream's report carries is the
      // ladder's, read off the merge, because one declared stream is one ladder.
      const announced = await this.announceRendition({
        recording,
        duration: this.manifestManager.getTotalDuration(),
      });

      // ⛔ Reported only by the rung whose own report finished the ladder, and only once. A rung
      // draining while its siblings are still live ends its own recording and nothing more: the
      // broadcast is over when the LAST of them finalizes, or when the last one outstanding is a rung
      // whose stop failed, and then `announceUnfinished` reports the flip instead of this. A rung
      // announcing the end off its own drain would take three live rungs off the air in the admin's
      // list. This is `StreamCatalog.upsertRendition`'s `flippedToVod` rule, read off the other side
      // of a wire rather than off a feed read.
      if (announced && announced.flippedToFinished && announced.recording !== null) {
        await this.reportAdminState(
          this.ladderRecordingReport(announced, announced.recording),
          'so the recording is in the feed and the admin does not know it, which the recovery entry lets the next boot retry',
        );
        // ⛔⛔⛔ After the report and only when the ladder really flipped, which is the same rule the
        // standalone halves of this method both state at length: written earlier it announces a flip
        // the admin has not taken yet, and written unconditionally a resumed finalize announces a
        // second flip for one broadcast.
        this.logger.log(ladderFinalized(this.ladder.group));
      }

      this.metrics?.recordStreamFinalized();
      this.clearRecoveryEntry();
      return;
    }

    if (this.admin) {
      // ⛔ Exactly where the catalog's VOD entry is written below, and carrying exactly the two values
      // that entry would have carried, because they answer the same question: where the recording is
      // and how long it plays. The recovery entry is still cleared last of all,
      // and the report is still allowed to throw, for the reason the catalog write is: it is the only
      // thing that tells anyone the broadcast became a recording, so a finalize that could not say so
      // has to leave the entry on disk for the next boot rather than report itself finished.
      await this.reportAdminState(
        { state: ADMIN_STATE_VOD, recording, duration: this.manifestManager.getTotalDuration() },
        'so the recording is in the feed and the admin does not know it, which the recovery entry lets the next boot retry',
      );
      this.metrics?.recordStreamFinalized();
      this.clearRecoveryEntry();
      return;
    }

    if (this.ladder) {
      await this.announceRendition({ recording, duration: this.manifestManager.getTotalDuration() });
      this.metrics?.recordStreamFinalized();
      this.clearRecoveryEntry();
      return;
    }

    const entry = {
      title: this.getFormattedDate(),
      owner: this.streamSigner.publicKey().address().toHex(),
      topic: this.streamRawTopic,
      state: STREAM_STATUS_VOD,
      recording,
      duration: this.manifestManager.getTotalDuration(),
      mediatype: this.mediatype,
      timestamp: Date.now(),
    };

    // ⛔⛔⛔ After the write and only when the entry really flipped, which is the single-rendition
    // half of what `StreamCatalog.upsertRendition` records at length for a ladder. Both halves were
    // wrong here. Written before the write, the line announced a flip the feed had not taken yet, so
    // a crash in that gap left the log claiming a finished broadcast over an entry that honestly
    // still said `live`. Written unconditionally, a resumed finalize over a catalog that already
    // said `vod` announced a second flip for one broadcast, and `vodFinalizeCount` reads exactly
    // this line, so the fix for the double publish reported itself as the double publish.
    const flippedToVod = await this.streamCatalog.addStream(entry);
    if (flippedToVod) {
      this.logger.log(updatingStreamToVod(JSON.stringify(entry)));
    }

    // Counted here rather than by the orchestrator because `notifyStop` is memoized, so this line
    // runs exactly once however many drains ask. Counting it from a drain double-counted a session
    // that a reconnect replaced, since two drains await this one promise.
    this.metrics?.recordStreamFinalized();
    this.clearRecoveryEntry();
  }

  /**
   * Tell this rung's ladder that the rung ended without a recording, so the ladder stops waiting for it.
   *
   * ⛔⛔⛔ 2026-09-23: 1080p's batch refused its recording, the orchestrator force-stopped it, and the
   * ladder stayed `live` for good, because a ladder finished only once every rung carried an index. See
   * `LadderCompletion`.
   *
   * ⛔ Called by the orchestrator once this session's stop has failed, and only when no newer session
   * holds this id. That is why nothing here asks whether this session still owns its recovery entry,
   * the guard every other report in this class passes: the failed drain gave the entry up so that it
   * survives for the next boot, and the next boot is how this rung can still finish and join the
   * recording then.
   *
   * In admin mode the flip this causes is reported here, after the master naming the recording landed,
   * exactly as `completeFinalize` reports the flip a finalize causes.
   */
  public async announceUnfinished(): Promise<void> {
    if (!this.ladder) {
      return;
    }

    this.logger.warn(
      `[StreamUploader] ${this.streamId} stopped without a recording, so ladder ${this.ladder.group} no longer ` +
        `waits for its ${this.ladder.rung.name} rung`,
    );
    const announced = await this.ladderRegistry.recordRungUnfinished(this.ladderIdentity(), this.buildRendition());

    if (this.admin && announced.flippedToFinished && announced.recording !== null) {
      await this.sendAdminState(
        this.ladderRecordingReport(announced, announced.recording),
        'so the ladder is a recording in its master and the admin still lists it as live',
      );
      this.logger.log(ladderFinalized(this.ladder.group));
    }
  }

  /**
   * Whether this session's topic was written on before it started, so where its numbering stands has
   * to be found rather than assumed.
   *
   * Two kinds of session own a topic that outlives them, and they are the two this returns true for.
   * A **declared** stream in admin mode: the admin mints the topic when the stream is created and
   * hands it to viewers before anything has ever published on it, so one declaration is many
   * broadcasts on one topic. And a **rung** of a ladder, in either deployment: its topic is derived
   * from its ladder group and its rung name (`rungTopicFor`), so a rung that restarts mid-broadcast
   * comes back onto the topic it was already writing.
   *
   * ⛔ A standalone single-rendition stream is the one that does not, and it is the only one. Its
   * topic is a fresh `crypto.randomUUID()` per session, so nothing was ever written on it and asking
   * would spend a scan per broadcast to be told so.
   *
   * ⚠️ Nor does a session rebuilt from a recovery entry, whatever kind it is. That one already holds
   * the numbering it published, and the newest window on its topic is its own. See
   * {@link StreamState.sequenceOffset}.
   */
  private topicOutlivesThisSession(): boolean {
    return (this.admin !== undefined || this.ladder !== undefined) && !this.resumedFromCrash;
  }

  /**
   * Find where this session's numbering continues from, once every session before it on its topic
   * has stopped writing. Started by the first segment, and again by the next one when a scan could
   * not answer.
   *
   * ⛔ **After the predecessor, never beside it.** Two writers on one window address are as bad as two
   * on one feed index, and the predecessor's closing window is the newest window this looks for.
   * Behaviour B16 of the windows plan.
   *
   * ⛔ **The window, never the feed.** A returning session takes its media sequence from its recovery
   * store, else from its topic's newest window, else starts fresh. Behaviours B14 and B15. A viewer
   * who was following the last session is handed this session's first window as the next update of
   * the playlist they are playing, and hls.js reads a media sequence that moved backwards as a parsing
   * error rather than as a new broadcast. See {@link continuesFrom}.
   *
   * What a window holds is a live window and not a recording, so nothing of the last session's media
   * is carried into this session's recording: each session's recording is its own.
   */
  private settlePosition(): void {
    if (this.positionKnown || this.settling !== undefined) {
      return;
    }
    this.settling = this.findPosition().finally(() => {
      this.settling = undefined;
    });
  }

  private async findPosition(): Promise<void> {
    await this.predecessorDrained;
    if (!this.positionKnown) {
      let newest: string | null;
      try {
        newest = await this.newestWindowPlaylist();
      } catch (error) {
        // Asked again at the next segment rather than guessed, because starting at 0 on a topic that
        // holds a broadcast moves a viewer's media sequence backwards.
        this.logger.error(
          `[StreamUploader] Could not read the recent windows of ${this.streamId}'s topic, so its windows ` +
            `wait for the next segment to ask again: ${getErrorMessage(error)}`,
        );
        return;
      }
      const continueAt = newest === null ? null : continuesFrom(newest);
      if (continueAt !== null) {
        this.manifestManager.continueFrom(continueAt);
      }
      this.positionKnown = true;
      this.logger.info(
        `[StreamUploader] Stream ${this.streamId} numbers its playlist from media sequence ${continueAt ?? 0}` +
          (newest === null ? ', having found no recent window on its topic' : ', after the newest window on its topic'),
      );
    }
    // ⛔ Written here rather than left to the next segment, because this is the moment the entry
    // becomes writable at all: everything before this point was refused by {@link persistState} for
    // having nothing true to say about where this session's numbering stands.
    this.persistState();
  }

  /**
   * The playlist in the newest window written on this topic within {@link OPENING_SCAN_MS}, or
   * null when there is none.
   *
   * ⛔ Only windows that have already ended are asked for. Bee answers a chunk asked for before it
   * exists by skipping its peers for that address for about a minute, so asking for the window still
   * open would delay this session's own first window for every reader.
   *
   * @throws when no window was found and at least one read failed for a reason other than the
   * chunk being absent, since that says nothing about whether the topic holds a broadcast.
   */
  private async newestWindowPlaylist(): Promise<string | null> {
    const current = windowOf(Math.floor(this.windowClock.now()), this.windowMs);
    const reader = this.bee.soc.makeReader(this.streamSigner.publicKey().address());
    const scanned = Math.ceil(OPENING_SCAN_MS / this.windowMs);
    const windows = Array.from({ length: scanned }, (_, back) => current - 1 - back).filter((w) => w >= 0);
    const reads = await Promise.allSettled(
      windows.map(async (window) => {
        const slot: WindowSlot = { topic: this.streamRawTopic, kind: 'live', windowMs: this.windowMs, window };
        try {
          const chunk = await reader.download(windowIdentifier(slot));
          return parseLiveWindowPayload(chunk.payload.toUint8Array())?.playlist ?? null;
        } catch (error) {
          if (isChunkAbsent(error)) {
            return null;
          }
          throw error;
        }
      }),
    );
    const newest = reads.find((read) => read.status === 'fulfilled' && read.value !== null);
    if (newest !== undefined && newest.status === 'fulfilled') {
      return newest.value;
    }
    const failed = reads.find((read) => read.status === 'rejected');
    if (failed !== undefined && failed.status === 'rejected') {
      throw failed.reason;
    }
    return null;
  }

  /** Whether this session may compose a window: every predecessor stopped and its numbering known. */
  private positionSettled(): boolean {
    return this.predecessorHasDrained && this.positionKnown;
  }

  private startWindows(): void {
    this.settlePosition();
    if (this.windowsStarted) {
      return;
    }
    this.windowsStarted = true;
    this.liveWindows.start();
  }

  /**
   * The quality's live playlist for a window that just ended, naming only segments whose own upload
   * finished, or null while there is nothing to publish.
   */
  private composeWindow(window: number): string | null {
    if (!this.positionSettled()) {
      return null;
    }
    const playlist = this.closing
      ? this.manifestManager.buildClosingLiveManifest()
      : this.manifestManager.buildLiveManifest();
    if (playlist === '') {
      return null;
    }
    if (this.closing) {
      this.closingWindows.add(window);
    }
    // Read beside the build, since the next segment can land before the write returns, and either
    // read taken after it would describe a playlist other than the one being written.
    this.namedByWindow.set(window, {
      newestNamed: this.manifestManager.liveWindowNewestIndex(),
      neverNamed: this.announcedThrough === null ? 0 : this.manifestManager.segmentsNeverNamed(this.announcedThrough),
    });
    return playlist;
  }

  /**
   * Signs one window's single owner chunk with the stream's key over the window's identifier, and
   * uploads it direct with this quality's own node and batch. One attempt: a window that failed is
   * never written again at its address, and the next window carries the same news.
   */
  private async writeWindow(slot: WindowSlot, payload: Uint8Array): Promise<void> {
    await this.bee.soc
      .makeWriter(this.streamSigner)
      .upload(this.stamp, windowIdentifier(slot), payload, { deferred: false });
  }

  /**
   * End the live playlist: every window from now on carries `#EXT-X-ENDLIST`, until one of them is
   * written or {@link CLOSING_WINDOW_ATTEMPTS} have gone by.
   *
   * @returns whether a closing window was written.
   */
  private writeClosingWindow(): Promise<boolean> {
    this.closing = true;
    this.startWindows();
    return new Promise((resolve) => {
      let outcomes = 0;
      const waiter = (event: WindowWriteEvent): void => {
        if (event.outcome === 'written' && this.closingWindows.has(event.window)) {
          this.windowWaiters.delete(waiter);
          resolve(true);
          return;
        }
        if (event.outcome === 'written') {
          // A window composed before the end, landing after it was asked for.
          return;
        }
        outcomes += 1;
        if (outcomes >= CLOSING_WINDOW_ATTEMPTS) {
          this.windowWaiters.delete(waiter);
          resolve(false);
        }
      };
      this.windowWaiters.add(waiter);
    });
  }

  /** Every window's outcome, into this session's log, metrics and stale signal. Never throws. */
  private onWindowEvent(event: WindowWriteEvent): void {
    try {
      this.recordWindowOutcome(event);
    } catch (error) {
      this.errorHandler.handleError(error, 'StreamUploader.onWindowEvent');
    }
    for (const waiter of [...this.windowWaiters]) {
      waiter(event);
    }
  }

  private recordWindowOutcome(event: WindowWriteEvent): void {
    if (event.outcome === 'missed') {
      this.recordWindowNotWritten(
        `windows ${event.fromWindow} to ${event.toWindow} were passed over, the clock jumped or the process stalled`,
      );
      return;
    }
    const named = this.namedByWindow.get(event.window);
    this.namedByWindow.delete(event.window);
    if (event.outcome === 'written') {
      this.consecutiveManifestFailures = 0;
      if (named !== undefined) {
        this.reportSegmentsNeverNamed(named.neverNamed);
        this.announcedThrough = named.newestNamed;
      }
      this.logger.log(liveWindowWritten(this.streamId, event.window));
      this.announceOnFirstWindow();
      return;
    }
    if (event.outcome === 'failed') {
      this.recordWindowNotWritten(`window ${event.window} was refused: ${getErrorMessage(event.error)}`);
      return;
    }
    // Nothing to write is not a failure, and neither is a writer stopping at the end.
    if (event.reason === 'nothing' || event.reason === 'stopped' || !this.manifestManager.hasSegments()) {
      return;
    }
    if (event.reason === 'tooLarge') {
      this.logger.error(
        `[StreamUploader] The live playlist of ${this.streamId} is over one window chunk, which its budget ` +
          'is meant to make impossible',
      );
    }
    this.recordWindowNotWritten(`window ${event.window} was skipped as ${event.reason}`);
  }

  /**
   * The catalog announce, off the first window that landed: the list must not say live before a
   * viewer has a window to read. Queued, so announces run one at a time.
   */
  private announceOnFirstWindow(): void {
    if (!needsCatalogAnnounce(this.readiness) || this.announceQueued) {
      return;
    }
    this.announceQueued = true;
    // ⛔ Persisted first, so the admin is never told a stream is live while no recovery entry exists
    // to flip it back. See {@link persistState}.
    this.persistState();
    void this.announceQueue.add(async () => {
      this.announceQueued = false;
      await this.announceToCatalog();
      this.persistState();
    });
  }

  /**
   * Stop owning the crash-recovery entry under this stream id, because a newer session now holds it.
   *
   * A re-announce starts the replacement while this uploader is still finalizing, and both carry the
   * same stream id. Everything this one writes to or deletes from the recovery store after that point
   * lands on a broadcast that is still running: a save replaces the live session's state with an
   * outgoing session's, and the delete at the end of `notifyStop` discards it outright.
   *
   * ⛔ **What this does NOT stop is the window writes, and reading it as though it did is what let
   * two sessions onto one topic.** It gives up three things and they are all keyed by stream id: the
   * recovery entry here, the admin state report in {@link reportAdminState}, and the shared ladder
   * entry in {@link announceRendition}. A retired session goes on writing windows on the topic it was
   * built with, which is the whole point: its closing window and its recording are what give the
   * broadcast it recorded an ending.
   *
   * ⚠️ That was safe for as long as the topic was a per-session `crypto.randomUUID()`, and this doc
   * said so — "the published media is unaffected, since each uploader owns its own feed topic". Admin
   * mode removed the premise without removing the sentence. There the topic comes from the declaration
   * and outlives every session on it, so a retired session and its replacement hold the same topic, and
   * the retired one's closing windows would race the replacement's live ones for the same addresses.
   *
   * What makes it safe again is not this method: the orchestrator hands the replacement the retired
   * session's finalize, and the replacement writes no window until it settles. See
   * {@link StreamUploaderOptions.predecessorDrained}, and `StreamOrchestrator.startStream`'s
   * re-announce branch for where the two are tied together.
   */
  public retire(): void {
    this.ownsRecoveryEntry = false;
  }

  private clearRecoveryEntry(): void {
    if (this.ownsRecoveryEntry) {
      this.recoveryStore.remove(this.streamId);
    }
  }

  public getStreamState(): StreamState {
    const manifestState = this.manifestManager.getState();
    return {
      streamId: this.streamId,
      streamRawTopic: this.streamRawTopic,
      mediatype: this.mediatype,
      segments: manifestState.segments,
      hlsHeaders: manifestState.hlsHeaders,
      ...readinessToPersisted(this.readiness),
      pendingDiscontinuity: this.pendingDiscontinuity,
      liveManifestStale: this.hasStaleLiveManifest(),
      updatedAt: Date.now(),
      ladder: this.ladder,
      bitrate: this.bitrate,
      // Read from the manifest manager rather than from what this session was constructed with,
      // because a restart re-anchors it mid-session. See `ManifestManager.broadcastAnchor`.
      anchor: this.manifestManager.broadcastAnchor(),
      // Persisted for the same reason the anchor is: it is a property of the numbering viewers have
      // already been handed, and a recovered session that lost it would publish this broadcast's
      // history again from a number a viewer has already been handed.
      sequenceOffset: this.manifestManager.publishedSequenceOffset(),
      // Carried for an entry written by a session on feeds, which glued the recording it inherited from
      // the feed head in front of its own. A session on windows inherits nothing, so this is absent.
      inherited: this.manifestManager.inheritedPrefix() ?? undefined,
      // Read off the manifest manager rather than mirrored here, so there is one holder of the one
      // shot and a crash between the encoder returning and its first segment landing comes back with
      // the seam and the re-anchoring still owed. See {@link resumeAfterReconnect}.
      resumingAfterReconnect: this.manifestManager.armedReturn() ?? undefined,
      // Absent outside admin mode, and absent on every entry written before admin mode existed. See
      // {@link StreamState.adminStreamId} for why a recovered session cannot resolve it again.
      adminStreamId: this.admin?.id,
    };
  }

  /**
   * What the ladder rung looks like to a player right now.
   *
   * Falls back to the encoder's configured target until segments have actually been measured, so
   * the master playlist is complete and usable from the first one rather than advertising a
   * bandwidth of zero.
   */
  private buildRendition(final?: { recording: string; duration: number }): Rendition {
    const rung = this.ladder!.rung;
    const configuredBps = rung.configuredKbps * 1000;

    return {
      name: rung.name,
      width: rung.width,
      height: rung.height,
      topic: this.streamRawTopic,
      bandwidth: peakBandwidth(this.bitrate, configuredBps),
      avgBandwidth: averageBandwidth(this.bitrate, configuredBps),
      ...(final ?? {}),
    };
  }

  public hasStaleLiveManifest(): boolean {
    return this.consecutiveManifestFailures > 0;
  }

  /**
   * The published sequence this rung would resume at on its own, counting every segment it was handed
   * before its return as already placed. What its siblings agree a return's point from. See
   * `ManifestManager.publishedNextSequenceAfter`.
   *
   * ⛔ **A segment handed over after the return reached this rung is not counted.** It is media from
   * after the outage, and counted, it would raise every sibling past the point this rung itself is
   * about to resume at. So the segments still uploading count up to the return waiting in the queue,
   * none count while the return is armed and unplaced, and all of them count otherwise.
   */
  public publishedCountBeforeReturn(): number | null {
    const beforeReturn =
      this.handedBeforeReturn !== null
        ? this.unplacedIndexes.slice(0, this.handedBeforeReturn)
        : this.manifestManager.armedReturn() === null
          ? this.unplacedIndexes
          : [];
    return this.manifestManager.publishedNextSequenceAfter(beforeReturn);
  }

  /** The handed segment at the head of the queue has landed or been given up on. */
  private settleOldestHanded(): void {
    this.unplacedIndexes.shift();
    if (this.handedBeforeReturn !== null && this.handedBeforeReturn > 0) {
      this.handedBeforeReturn -= 1;
    }
  }

  public getConsecutiveManifestFailures(): number {
    return this.consecutiveManifestFailures;
  }

  /**
   * Segments dropped back to back, each after its retry window was already spent. Unlike a manifest
   * publish, a dropped segment is not retried later: the data is gone and its sequence is published as
   * a gap entry, so this counter is the only trace an upload failure leaves in this class.
   */
  public getConsecutiveSegmentFailures(): number {
    return this.consecutiveSegmentFailures;
  }

  /**
   * Tell the admin where this broadcast got to, and throw if it could not be told.
   *
   * ⛔ **Throws on failure, even though `AdminApiClient.reportState` never does.** That split is the
   * whole point of the client answering with a value: the client's job is to keep trying for four
   * seconds without an exception escaping into a network path, and this method's job is to make a
   * report that never landed cost the same as a catalog write that never landed. It has to cost the
   * same, because both callers are built around it doing so — `announceToCatalog` catches, records
   * the age and re-attempts on its own cadence, and `finalize` lets it propagate so the drain records
   * a failure and the recovery entry stays on disk for the next boot.
   *
   * A report this stream already delivered before a crash is accepted again by the admin. A refusal,
   * a stream unpublished on the admin, is a failure like any other, and says so in the log.
   *
   * ⚠️ Skipped entirely once a newer session holds this stream id, and this is sharper than the same
   * guard on `announceRendition`. Outside admin mode a retired session still owns its own feed topic,
   * so its VOD entry describes a recording nobody else is writing. In admin mode both sessions share
   * one declared stream, so a retired session reporting `vod` would mark the broadcast that replaced
   * it as finished.
   *
   * ⛔ This covers the *report* and nothing else. The retired session still publishes manifests to the
   * declared topic the two of them share, and `ownsRecoveryEntry` does not gate that — what keeps the
   * two off one feed is the replacement waiting, not this session stopping. See {@link retire}.
   */
  private async reportAdminState(report: AdminStateReport, whatIsLost: string): Promise<void> {
    if (!this.ownsRecoveryEntry) {
      this.logger.warn(
        `[StreamUploader] Not reporting ${report.state} for ${this.streamId}: a newer session holds it, ` +
          'and the admin stream is shared between them',
      );
      return;
    }

    await this.sendAdminState(report, whatIsLost);
  }

  /** {@link reportAdminState} without its guard, for the one caller that has settled it another way. */
  private async sendAdminState(report: AdminStateReport, whatIsLost: string): Promise<void> {
    const admin = this.admin!;
    const outcome = await admin.client.reportState(admin.id, report);
    if (!stateWasReported(outcome)) {
      throw new Error(`Could not report ${report.state} for stream ${this.streamId} to the admin API, ${whatIsLost}`);
    }
  }

  /**
   * The `vod` report for a ladder that has just become a recording, naming the ladder's recording as
   * the merge answered it rather than this rung's own, for the reason `completeFinalize` gives.
   */
  private ladderRecordingReport(announced: RenditionAnnouncement, recording: string): AdminStateReport {
    return {
      state: ADMIN_STATE_VOD,
      recording,
      duration: announced.duration ?? this.manifestManager.getTotalDuration(),
    };
  }

  /**
   * Merge this rung into its ladder, wherever the ladder is kept, and answer what that achieved.
   *
   * @returns `null` when nothing was announced because a newer session holds this rung. Only admin
   * mode reads the announcement: standalone, the catalog carries the ladder's whole state itself and
   * a rung has nothing to do with the answer.
   */
  private async announceRendition(final?: {
    recording: string;
    duration: number;
  }): Promise<RenditionAnnouncement | null> {
    if (!this.ownsRecoveryEntry) {
      // A re-announce has handed this rung to a newer session. The catalog and master entry are keyed
      // by rung name, which this outgoing session shares, so any upsert from here overwrites the live
      // rung with a retired session's recording. The recording this session uploaded stands on its
      // own. Only the shared ladder entry is off limits. Mirrors persistState.
      return null;
    }

    const rendition = this.buildRendition(final);

    this.lastAnnounceAttemptAt = Date.now();

    this.logger.log(publishingRendition(rendition.name, this.ladder!.group));
    const announced = await this.ladderRegistry.upsertRendition(this.ladderIdentity(), rendition);

    this.driftBaselineBps = rendition.bandwidth;
    return announced;
  }

  /** What this rung shares with every other rung of its ladder, which is what the ladder is merged under. */
  private ladderIdentity(): LadderIdentity {
    return {
      title: this.getFormattedDate(),
      owner: this.streamSigner.publicKey().address().toHex(),
      group: this.ladder!.group,
      mediatype: this.mediatype,
      // Absent standalone, where the catalog never reads it. In admin mode it is what addresses the
      // report, and it is the ladder's rather than this rung's: one declared stream is one ladder.
      adminStreamId: this.admin?.id,
    };
  }

  private async refreshBandwidthIfDrifted(): Promise<void> {
    if (!this.ladder || this.readiness !== READINESS_ANNOUNCED || this.driftBaselineBps <= 0) {
      return;
    }

    if (Date.now() - this.lastAnnounceAttemptAt < BITRATE_REFRESH_INTERVAL_MS) {
      return;
    }

    const drift = Math.abs(this.bitrate.peakBps - this.driftBaselineBps) / this.driftBaselineBps;
    if (drift < BITRATE_REFRESH_RATIO) {
      return;
    }

    // Swallowed rather than propagated: the caller is an unawaited segment task that must go on to
    // persist its progress, and this is a correction to a bandwidth already published.
    try {
      await this.announceRendition();
    } catch (error) {
      this.errorHandler.handleError(error, 'StreamUploader.refreshBandwidthIfDrifted');
    }
  }

  /**
   * One window that was due and was not written, however it was lost. The stale signal counts these
   * until a window lands.
   */
  private recordWindowNotWritten(detail: string): void {
    this.consecutiveManifestFailures += 1;
    this.metrics?.recordManifestPublishFailure();
    this.logger.warn(
      `Live window for stream ${this.streamId} is stale: ${this.consecutiveManifestFailures} consecutive ` +
        `window(s) not written, the last because ${detail}`,
    );
  }

  /**
   * Segments that were uploaded and that no written window will ever name.
   *
   * Their bytes are in Swarm and any viewer handed the address could fetch them. A viewer learns of a
   * segment only from a playlist, and the playlist slid past these before a window naming them was
   * written, so the media is simply missing from every playlist with not even a gap entry to mark
   * it: their sequences are filled, by segments this uploader is holding and nobody was told about.
   * That makes this the quietest way this uploader can lose a piece of a broadcast:
   * `recordSegmentDropped` answers a failed upload and `recordSegmentsLost` answers segments the
   * engine never had.
   *
   * It takes windows going unwritten while segments keep landing for this to happen, a node refusing
   * window writes or a clock that cannot be trusted.
   */
  private reportSegmentsNeverNamed(count: number): void {
    if (count === 0) {
      return;
    }
    this.segmentsNeverNamed += count;
    this.metrics?.recordSegmentsNeverNamed(count);
    this.logger.warn(
      `Stream ${this.streamId} wrote a live window that skipped ${count} uploaded segment(s): ` +
        `the playlist advanced past them before a window naming them was written, so no viewer can ` +
        `reach them. ${this.segmentsNeverNamed} total this stream.`,
    );
  }

  /** Segments uploaded but never named in any written window, for the life of this stream. */
  public getSegmentsNeverNamed(): number {
    return this.segmentsNeverNamed;
  }

  /**
   * Publish this stream to the catalog, at most once per `CATALOG_ANNOUNCE_RETRY_MS`.
   *
   * The rate limit is the whole point: a failure leaves the stream short of `announced`, and every later
   * window then re-attempts, so a catalog that was down would cost a list write per window. Giving up instead would be worse, since the entry is the only thing that
   * makes a live broadcast discoverable, so this keeps trying at a rate set by the viewer rather than
   * by the encoder.
   */
  private async announceToCatalog(): Promise<void> {
    const now = Date.now();
    if (this.lastCatalogAnnounceAt !== null && now - this.lastCatalogAnnounceAt < this.catalogAnnounceRetryMs) {
      return;
    }

    this.lastCatalogAnnounceAt = now;
    try {
      await this.notifyStart();
      this.readiness = onCatalogAnnounced(this.readiness);
      this.catalogAnnounceFailedAt = null;
    } catch (error) {
      this.catalogAnnounceFailedAt ??= now;
      this.errorHandler.handleError(error, 'StreamUploader.notifyStart');
    }
  }

  /**
   * How long this stream has been live and absent from the catalog, or null while it is listed.
   *
   * An age rather than a count of failures, because the retry window and the segment cadence are
   * unrelated: a count says how many times the write was attempted, and the thing an operator needs
   * is how long a viewer has been unable to find a broadcast that is running.
   */
  public getMsSinceCatalogAnnounceFailed(): number | null {
    return this.catalogAnnounceFailedAt === null ? null : Date.now() - this.catalogAnnounceFailedAt;
  }

  /**
   * How long this stream's state has been failing to reach disk, or null when the last save landed.
   *
   * The failure was logged and otherwise swallowed, which made it the quietest way to lose a
   * broadcast: recovery reads whatever did land, so a crash then re-uploads or drops everything
   * written since, and until it happens the stream looks perfectly healthy.
   */
  public getMsSinceStatePersistFailed(): number | null {
    return this.statePersistFailedAt === null ? null : Date.now() - this.statePersistFailedAt;
  }

  /**
   * Write the recovery entry, once there is anything true to write in it.
   *
   * ⛔⛔ **A session whose position is not settled persists nothing at all, and that is the safe half
   * of the trade.** On a topic that outlived its predecessor, the opening scan decides the media
   * sequence this session numbers from, and this entry is the only surviving record of it. An entry
   * written before the scan answered says `sequenceOffset: 0`, which is not "unknown yet" but a
   * positive claim that nothing was on the topic, and a recovered session never scans
   * ({@link topicOutlivesThisSession} is false for one), so it would number the broadcast again from a
   * number viewers had already been handed.
   *
   * Nothing is lost by waiting. No window is composed until the position is settled, so a session that
   * has not settled it has told no viewer anything. The segments it uploaded are in Swarm and
   * unnamed, which is exactly what they would be had the process died one moment earlier.
   *
   * ⛔⛔ **That includes the admin, and it is load bearing.** The `live` report is `notifyStart`'s,
   * reached only through `announceToCatalog` off the first written window, which is composed only once
   * the position is settled, and {@link announceOnFirstWindow} persists before it announces. So the
   * admin cannot be told a stream is `live` while no recovery entry exists to flip it back.
   *
   * A standalone single-rendition stream settles at once, its topic being fresh per session, so it
   * persists from its first segment exactly as it always did.
   */
  private persistState(): void {
    if (!this.ownsRecoveryEntry) {
      return;
    }
    if (!this.positionSettled()) {
      return;
    }
    try {
      this.recoveryStore.save(this.streamId, this.getStreamState());
      this.statePersistFailedAt = null;
    } catch (error) {
      this.statePersistFailedAt ??= Date.now();
      this.logger.error(`Failed to persist state for ${this.streamId}:`, error);
    }
  }

  /**
   * The recording playlist's bytes, uploaded once and direct, answering its reference or null when
   * nothing landed within the retry window. No erasure coding, so the reference depends on the bytes
   * alone and a recovered session uploading the same recording gets the same one.
   */
  private async uploadRecording(playlist: string): Promise<string | null> {
    try {
      const result = await retryUntilDeadlineAsync(
        () => this.bee.data.upload(this.stamp, Buffer.from(playlist, 'utf-8'), { deferred: false }),
        RECORDING_UPLOAD_RETRY_WINDOW_MS,
        UPLOAD_RETRY_BASE_MS,
        UPLOAD_RETRY_CAP_MS,
      );
      return result.reference.toHex();
    } catch (error) {
      this.errorHandler.handleError(error, 'StreamUploader.uploadRecording');
      return null;
    }
  }

  /**
   * A segment's bytes, uploaded direct. Decision 23 of the windows plan, measured in phase 0: a
   * direct segment is named 309 ms sooner at the median and readable from other nodes 0.35 to 0.39 s
   * sooner than a deferred one, because the playlist names it as soon as this upload returns.
   */
  private async uploadDataToBee(data: Uint8Array) {
    try {
      return await retryUntilDeadlineAsync(
        () => this.bee.data.upload(this.stamp, data, { redundancyLevel: this.redundancyLevel, deferred: false }),
        SEGMENT_UPLOAD_RETRY_WINDOW_MS,
        UPLOAD_RETRY_BASE_MS,
        UPLOAD_RETRY_CAP_MS,
      );
    } catch (error) {
      this.reportBatchRefusal(error);
      this.errorHandler.handleError(error, 'StreamUploader.uploadDataToBee');
      return null;
    }
  }

  /**
   * The one named line for a postage batch bee will not take a segment against.
   *
   * ⛔⛔⛔ **A filling batch does not fall silent, it ramps, and one answer from bee gets one line
   * whatever the ramp does.** Measured on the first live drain, 2026-09-04: bee refused one rung's
   * depth 17 batch four times in about fifty seconds with segments landing in between. A batch stops
   * accepting a chunk whose own bucket is full, so at the first overflow almost every bucket still has
   * room and a segment of about 300 chunks is refused with roughly a quarter of the probability,
   * rising to nearly all of it a few thousand chunks later. So a landed segment after a refusal is the
   * ramp rather than a new batch, and it must not re-arm the line: the batch id is fixed for the life
   * of this process, since `BEE_PUBLISHERS` is read once at start, and the only thing that can replace
   * it is a redeploy, which is a new process with {@link batchRefusalStatuses} empty again.
   *
   * ⛔ **Why the retry verdict decides it and not the mere fact of a failure.** A bee node that is
   * down throws with no status, spends the whole retry window, and drops the segment exactly as a
   * refused batch does. Reporting that as a refused batch would send an operator to the postage side
   * of a node that is simply gone, which is the confusion this line exists to remove rather than
   * cause. So it fires only for a status the policy refuses to retry, and it carries that status and
   * bee's own words instead of a guess at which of them means "empty".
   *
   * ⚠️ Segment uploads only. A window write spends the same batch and a refused one is evidence of
   * the same condition, but the next window carries the news and the rung goes on publishing media, so
   * reporting it would say a rung had gone quiet while it was up.
   *
   * ⚠️ `segmentUploadFailed` still fires for every segment the ramp costs, and the per-rung drop
   * counter still climbs on each one. This line is the diagnosis, those are the consequences.
   */
  private reportBatchRefusal(error: unknown): void {
    const status = nonRetryableStatus(error);
    if (status === undefined) {
      return;
    }

    // Recorded against the publisher before the log is deduplicated, and on the process-lifetime
    // counters rather than on anything this session owns. Everything else this uploader reports is
    // read back off the orchestrator's `activeStreams`, which the end of a broadcast empties, and this
    // is the one condition that outlives the broadcast: the batch stays dead, the finalize fails on it
    // and leaves no recording, and the catalog goes on saying `live`. See `ServiceMetrics`.
    this.metrics?.recordPostageRefusal(this.publisher, status, Date.now());

    if (this.batchRefusalStatuses.has(status)) {
      return;
    }
    this.batchRefusalStatuses.add(status);
    this.logger.error(rungBatchRefused(this.stamp, this.streamId, status, beeAnswer(error)));
  }

  private getFormattedDate(): string {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    return `${day}/${month}/${year}`;
  }
}
