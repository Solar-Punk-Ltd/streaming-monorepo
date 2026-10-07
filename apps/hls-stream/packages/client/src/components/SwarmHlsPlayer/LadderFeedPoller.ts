import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { feedSlotPath } from '@swarm-hls-stream/shared';

import { TimedResponse } from '@/utils/fetchWithTimeout';

import { FeedReturnWatch } from './feedReturn';
import { FeedHealthTracker, UNSERVED_SLOT_STALL_MS } from './feedState';
import type { FeedEntry, FeedReader, FollowClock } from './following/feedReader';
import { followPredicted } from './following/followPredicted';
import { ManifestStateManager } from './ManifestManagement';
import { FeedRung, IndexSearchFinder, NewestIndex, NewestIndexFinder, SwitchHint } from './newestIndexFinder';
import { parseManifest } from './playlist';
import { isSlotNotWrittenYet } from './refusedSlot';
import { feedEntryOf, RungFeedReader } from './rungFeedReader';
import { firstSegmentStartMs, joinsOnto, RUNG_PROGRESS_BOUND_MS, switchRefusal } from './rungPosition';

/**
 * Follows only the rungs of a ladder the player is playing.
 *
 * A Swarm feed is read one SOC at a time: to reach index N you ask for N-1 first. The rung hls.js is
 * playing is followed by the polling study's predicted follower (`following/followPredicted.ts`), which
 * asks for the next slot when the next playlist is due rather than as often as it can, and looks one
 * slot past a slot that is late. The loader serves hls.js's level reloads out of what it has read.
 *
 * ⭐ **One rung at a time** (Levi, 2026-10-07: "only one quality request at the time. Not 4! We only
 * request what we watch."). Every rung of the ladder is registered, and only the playing rung is
 * walked, plus the one being switched to while a switch is under way. Walking all four used to make a
 * switch free, at up to about 320 requests a minute, half of them for an index not written yet. A
 * switch now pays the {@link NewestIndexFinder}'s reads for the new rung while hls.js plays the old one
 * from its buffer.
 */
const DEFAULT_POLL_INTERVAL_MS = 750;

/**
 * The wall clock, which a rung is followed and searched on. The strategies compare it with
 * PROGRAM-DATE-TIME stamps, so it has to be the viewer's idea of the date, not a monotonic count.
 */
export const WALL_CLOCK: FollowClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** How long a rung whose feed holds nothing yet waits before it is looked for again. */
const EMPTY_FEED_RETRY_MS = 2_000;

/**
 * Consecutive misses before saying so. A miss is the normal case: it means the next segment has
 * not been published yet, so the first several are silent, and only a run long enough to mean
 * "this feed has stopped, or the gateway is broken" is worth a line in the console.
 */
const MISSES_BEFORE_WARNING = 20;

/**
 * How long a stalled playing rung waits before a sibling is tried again, once one try found nothing.
 * A broadcast that paused stays paused for a while, and each try costs the sibling's finder reads and
 * a walk of it for {@link RUNG_PROGRESS_BOUND_MS}.
 */
export const STALL_REPROBE_MS = 30_000;

/**
 * How long a sibling tried as somewhere to fail over to may take to find its newest index. Its progress
 * bound starts once that is found, so a slow search cannot use up the bound and have a live sibling
 * judged paused. Past this the try ends as if the sibling had shown nothing. The polling study's
 * slowest searches from a hint, a quality 500 slots behind, took 12 s at p90 on the gateway profile.
 */
export const CANDIDATE_FIND_DEADLINE_MS = 15_000;

/**
 * How many older indexes a switch reads to reach a viewer who is behind the live edge. Past it the
 * switch goes to the live edge, because reading a long way back costs the viewer more waiting than the
 * minutes they would skip.
 */
export const MAX_READ_BACK_READS = 10;

/** A rung as a ladder names it. */
export interface LadderRung {
  readonly topic: Topic;
  /** Orders the rungs, so "the next lower rung" means something. Missing ranks lowest. */
  readonly bandwidth?: number;
}

/** What a level request finds once it has waited for a rung. */
export type RungReadiness = 'ready' | 'refused' | 'inactive' | 'unregistered';

/** The seams the walk is built from. Every one has a default that is today's behaviour. */
export interface LadderFeedPollerOptions {
  readonly finder?: NewestIndexFinder;
  /** The clock a rung is followed on. The wall clock unless a test drives time itself. */
  readonly followClock?: FollowClock;
  /** A monotonic clock, the same one the feed health reads. */
  readonly now?: () => number;
  /** The bound a rung has to show a new index in. See {@link RUNG_PROGRESS_BOUND_MS}. */
  readonly progressBoundMs?: number;
  /** See {@link CANDIDATE_FIND_DEADLINE_MS}. */
  readonly candidateFindDeadlineMs?: number;
  /**
   * When the frame the viewer is watching was presented, by PROGRAM-DATE-TIME, for a ladder's group, or
   * null when the player cannot say. Read only when switching, to keep a viewer behind live where they are.
   */
  readonly playheadMs?: (group: string | null) => number | null;
}

interface Walk {
  stopped: boolean;
  /** Settles once the walk is stopped, so a follower asleep on an injected clock is let go at once. */
  ended: Promise<void>;
  markEnded: () => void;
  ready: Promise<void>;
  markReady: () => void;
  /** The newest slot this walk has taken, or null before it has found one. */
  current: FeedEntry | null;
  /** When `current` was taken, on the follow clock, which a switch's search is hinted with. */
  currentSeenAtMs: number;
  /** The last search found the feed empty, so the walk waits for its first slot before searching again. */
  waitingForFirstSlot: boolean;
  misses: number;
  /** Set while the walk is waiting out a pause, so stopping does not have to wait for it. */
  wake?: () => void;
  /** A newest index already found for this rung, taken instead of asking the finder again. */
  seed: NewestIndex | null;
  /** A rung tried as somewhere to fail over to: it is not refused and not read back. */
  isCandidate: boolean;
  /** Whether the walk has taken an index after the one it started at. */
  progressed: boolean;
  /** Told once, when the walk first progresses or ends, by whoever is waiting on it. */
  onSettled?: (progressed: boolean) => void;
  /** Told once, when the walk has found its newest index, by whoever is timing it from there. */
  onFound?: () => void;
  /** When this rung's current stall last had a sibling tried, or null when it has not. */
  stallTriedAtMs: number | null;
}

interface RungEntry {
  readonly topic: Topic;
  readonly hexTopic: string;
  readonly owner: string;
  readonly bandwidth: number;
  readonly ladder: LadderEntry;
  /** Null while the rung is registered but not followed. */
  walk: Walk | null;
  /** Taken out of this session: refused at a switch, or failed over from. Never activated again. */
  retired: boolean;
  /** Refused at a switch, which a level request for it reads as an error. */
  refused: boolean;
}

interface LadderEntry {
  readonly key: string;
  /** The topic the overlay watches, or null for a ladder registered without one. */
  readonly group: string | null;
  /** Lowest bandwidth first. */
  rungs: RungEntry[];
  playing: RungEntry | null;
  /** A sibling is being walked as a candidate, so a second try waits for the first. */
  isTrying: boolean;
  /**
   * The rung the player was failed over to, until hls.js reports it playing. Its ENDLIST runs the end
   * check as the playing rung's would, since it can finish before the switch to it lands.
   */
  failoverTarget: RungEntry | null;
  /** The watch on the rung that was playing when the broadcast ended. */
  returnWatch: FeedReturnWatch | null;
  returnWatchedRung: RungEntry | null;
}

export class LadderFeedPoller {
  private readonly rungs = new Map<string, RungEntry>();
  private readonly ladders = new Map<string, LadderEntry>();
  private unnamedLadders = 0;
  private readonly finder: NewestIndexFinder;
  private readonly followClock: FollowClock;
  private readonly now: () => number;
  private readonly progressBoundMs: number;
  /** See {@link CANDIDATE_FIND_DEADLINE_MS}. Public because a level request's wait is sized from it. */
  public readonly candidateFindDeadlineMs: number;
  private readonly playheadMs: (group: string | null) => number | null;

  constructor(
    private readonly stateManager: ManifestStateManager,
    private readonly fetchResource: (path: string) => Promise<TimedResponse>,
    /** How long a walk waits after a read the gateway did not answer, and the slice a backoff is waited out in. */
    private readonly pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
    /**
     * Shared with the single-rendition path, so a rung read reaching or losing the gateway records
     * against the same tracker the overlay reads.
     */
    private readonly feedHealth: FeedHealthTracker = new FeedHealthTracker(),
    /**
     * The jittered backoff this rung's gateway has earned, honoured before each pass. Zero by default.
     */
    private readonly backoffMs: (hexTopic: string) => number = () => 0,
    /** The wait before each ask a finished rung makes for its broadcaster, drawn afresh per ask. */
    private readonly returnWatchWaitMs?: () => number,
    options: LadderFeedPollerOptions = {},
  ) {
    this.followClock = options.followClock ?? WALL_CLOCK;
    this.finder = options.finder ?? new IndexSearchFinder(fetchResource, this.followClock);
    this.now = options.now ?? (() => performance.now());
    this.progressBoundMs = options.progressBoundMs ?? RUNG_PROGRESS_BOUND_MS;
    this.candidateFindDeadlineMs = options.candidateFindDeadlineMs ?? CANDIDATE_FIND_DEADLINE_MS;
    this.playheadMs = options.playheadMs ?? (() => null);
  }

  /**
   * Registers a ladder's rungs. Nothing is read until hls.js asks for one of them.
   *
   * Registering again for the same group merges, because the catalog and a published master can both
   * name a ladder's rungs.
   */
  public register(owner: string, rungs: readonly LadderRung[], groupHexTopic: string | null = null): void {
    const ladder = this.ladderFor(groupHexTopic);
    for (const { topic, bandwidth } of rungs) {
      const hexTopic = topic.toString();
      if (this.rungs.has(hexTopic)) {
        continue;
      }
      const entry: RungEntry = {
        topic,
        hexTopic,
        owner,
        bandwidth: bandwidth ?? 0,
        ladder,
        walk: null,
        retired: false,
        refused: false,
      };
      this.rungs.set(hexTopic, entry);
      ladder.rungs.push(entry);
    }
    ladder.rungs.sort((a, b) => a.bandwidth - b.bandwidth);
  }

  /** Stops and forgets these rungs. Their playlists are the caller's to clear. */
  public unregister(topics: readonly Topic[]): void {
    const touched = new Set<LadderEntry>();
    for (const topic of topics) {
      const entry = this.rungs.get(topic.toString());
      if (!entry) {
        continue;
      }
      const { ladder } = entry;
      touched.add(ladder);
      this.endWalk(entry);
      this.rungs.delete(entry.hexTopic);
      ladder.rungs = ladder.rungs.filter((rung) => rung !== entry);
      if (ladder.playing === entry) {
        ladder.playing = null;
      }
      if (ladder.failoverTarget === entry) {
        ladder.failoverTarget = null;
      }
      if (ladder.returnWatchedRung === entry) {
        this.stopReturnWatch(ladder);
      }
    }

    for (const ladder of touched) {
      if (ladder.rungs.length === 0) {
        this.stopReturnWatch(ladder);
        this.ladders.delete(ladder.key);
      }
      this.retrack(ladder);
    }
  }

  public isRegistered(hexTopic: string): boolean {
    return this.rungs.has(hexTopic);
  }

  /** Whether this rung is being followed, or holds what its finished walk read. */
  public isActive(hexTopic: string): boolean {
    return this.rungs.get(hexTopic)?.walk != null;
  }

  /**
   * Starts following a registered rung at its newest index, which is what a level request does. The
   * first rung of a ladder to be activated becomes the playing one.
   */
  public activate(hexTopic: string): void {
    const entry = this.rungs.get(hexTopic);
    if (!entry || entry.walk || entry.retired) {
      return;
    }
    this.startWalk(entry, null, false);
    entry.ladder.playing ??= entry;
  }

  /**
   * The player is now playing this rung, so every other rung of its ladder stops being followed. What
   * hls.js reports on `LEVEL_SWITCHED`.
   *
   * @param loadingHexTopic The rung hls.js is loading as its next level, when that is another one. It
   *   keeps being followed, since a switch to it is under way.
   */
  public followOnly(hexTopic: string, loadingHexTopic: string | null = null): void {
    const entry = this.rungs.get(hexTopic);
    if (!entry) {
      return;
    }
    const { ladder } = entry;
    ladder.playing = entry;
    ladder.failoverTarget = null;
    if (entry.walk) {
      entry.walk.isCandidate = false;
    }
    for (const other of ladder.rungs) {
      if (other !== entry && other.hexTopic !== loadingHexTopic && other.walk) {
        this.deactivate(other);
      }
    }
  }

  /** Resolves once this rung holds a playlist, or once it stopped being followed, so nothing waits for ever. */
  public ready(hexTopic: string): Promise<void> {
    return this.rungs.get(hexTopic)?.walk?.ready ?? Promise.resolve();
  }

  public readiness(hexTopic: string): RungReadiness {
    const entry = this.rungs.get(hexTopic);
    if (!entry) {
      return 'unregistered';
    }
    if (entry.refused) {
      return 'refused';
    }
    return entry.walk ? 'ready' : 'inactive';
  }

  private ladderFor(group: string | null): LadderEntry {
    const key = group ?? `unnamed-${++this.unnamedLadders}`;
    const known = this.ladders.get(key);
    if (known) {
      return known;
    }
    const ladder: LadderEntry = {
      key,
      group,
      rungs: [],
      playing: null,
      isTrying: false,
      failoverTarget: null,
      returnWatch: null,
      returnWatchedRung: null,
    };
    this.ladders.set(key, ladder);
    return ladder;
  }

  private startWalk(entry: RungEntry, seed: NewestIndex | null, isCandidate: boolean): Walk {
    let markReady = () => {};
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    let markEnded = () => {};
    const ended = new Promise<void>((resolve) => {
      markEnded = resolve;
    });
    const walk: Walk = {
      stopped: false,
      ended,
      markEnded,
      ready,
      markReady,
      current: null,
      currentSeenAtMs: 0,
      waitingForFirstSlot: false,
      misses: 0,
      seed,
      isCandidate,
      progressed: false,
      stallTriedAtMs: null,
    };
    entry.walk = walk;
    this.retrack(entry.ladder);
    void this.walkLoop(entry, walk);
    return walk;
  }

  /** Ends a walk without forgetting what it read, which is what a teardown needs. */
  private endWalk(entry: RungEntry): void {
    const walk = entry.walk;
    if (!walk) {
      return;
    }
    walk.stopped = true;
    walk.wake?.();
    walk.markEnded();
    walk.markReady();
    this.settle(walk, false);
    entry.walk = null;
  }

  /**
   * Stops following a rung and forgets everything it read.
   *
   * ⛔ Forgotten rather than kept, so coming back to it starts at its newest index. A kept index would
   * be resumed from, and two minutes away is about eighty indexes walked one at a time before the
   * viewer sees anything new. Its feed health goes too, or an unserved run from before would call it
   * stalled the moment it was played again.
   */
  private deactivate(entry: RungEntry): void {
    this.endWalk(entry);
    this.stateManager.clear(entry.hexTopic);
    this.feedHealth.clear(entry.hexTopic);
    this.retrack(entry.ladder);
  }

  /**
   * Tells the feed health which rungs the group's state is folded from: the followed ones only. A rung
   * nobody reads records nothing, and counting it would read as a healthy rung outvoting the one the
   * viewer is on.
   */
  private retrack(ladder: LadderEntry): void {
    if (ladder.group === null) {
      return;
    }
    const followed = ladder.rungs.filter((rung) => rung.walk).map((rung) => rung.hexTopic);
    if (followed.length === 0) {
      this.feedHealth.untrackGroup(ladder.group);
    } else {
      this.feedHealth.trackGroup(ladder.group, followed);
    }
  }

  private async walkLoop(entry: RungEntry, walk: Walk): Promise<void> {
    while (!walk.stopped) {
      // Before every start, not after it. A gateway recorded as failing has earned a backoff, so a dead
      // gateway is asked at 2s then 4s then 8s up to the cap rather than flat.
      await this.honourBackoff(entry, walk);
      if (walk.stopped) {
        return;
      }

      // Nothing thrown in here may end the walk. A walk that dies leaves anything awaiting its
      // `ready()` waiting for a promise that never settles, which for the loader means an hls.js level
      // request that never succeeds and never fails.
      try {
        if (walk.current === null && !(await this.bootstrap(entry, walk))) {
          if (!walk.stopped) {
            await this.pauseFor(walk, EMPTY_FEED_RETRY_MS);
          }
          continue;
        }
        await this.follow(entry, walk);
      } catch (error) {
        this.recordFailure(entry, walk, error);
        if (walk.stopped) {
          return;
        }
        this.tryFailoverIfStalled(entry, walk);
        await this.pauseFor(walk, this.pollIntervalMs);
      }
    }
  }

  /**
   * Follows the rung from the slot the walk holds until the walk stops. A read the gateway did not
   * answer ends it by throwing, and the walk starts it again from the same slot once any backoff is
   * over.
   */
  private async follow(entry: RungEntry, walk: Walk): Promise<void> {
    const from = walk.current;
    if (from === null || walk.stopped) {
      return;
    }
    const reader = new RungFeedReader(this.fetchResource, entry.owner, entry.topic, this.followClock.now);
    const counted: FeedReader = {
      read: async (index) => {
        const read = await reader.read(index);
        if (walk.stopped) {
          return read;
        }
        if (read.found) {
          this.feedHealth.recordGatewayReachable(entry.hexTopic);
          walk.misses = 0;
        } else {
          this.recordMiss(entry, walk, null);
          this.feedHealth.recordUnservedSlot(entry.hexTopic);
          this.tryFailoverIfStalled(entry, walk);
        }
        return read;
      },
    };

    await followPredicted({
      reader: counted,
      clock: { now: this.followClock.now, sleep: (ms) => Promise.race([this.followClock.sleep(ms), walk.ended]) },
      from,
      isStopped: () => walk.stopped,
      onEntry: (found) => this.take(entry, walk, found, reader.playlistOf(found)),
    });
  }

  /** Folds in a slot the follower found. The follower never hands over a slot out of order. */
  private take(entry: RungEntry, walk: Walk, found: FeedEntry, playlist: string | undefined): void {
    // Re-checked here, after the follower's await. A response that lands after the walk was stopped
    // would otherwise recreate state a teardown or a switch has just cleared.
    if (walk.stopped || playlist === undefined) {
      return;
    }
    const index = FeedIndex.fromBigInt(BigInt(found.index));
    if (!this.ingest(entry, walk, playlist, index)) {
      return;
    }
    walk.current = found;
    walk.currentSeenAtMs = this.followClock.now();
    this.stateManager.setIndex(entry.hexTopic, index);
    // A slot actually arrived, which is the only thing that ends an unserved run.
    this.feedHealth.recordGatewayResponse(entry.hexTopic);
    this.noteProgress(walk);
  }

  /**
   * The backoff the shared tracker has set for this rung's gateway, waited out interruptibly.
   *
   * ⛔ **Waited out in slices rather than in one committed timer.** A rung at the cap used to schedule
   * one timer for the whole of it, so it could not find out the fault was over. Measured 2026-08-29:
   * three unrelated faults each froze the picture for 58.5 to 59.0 seconds, an eight second
   * writer-bee pause included. A slice is the poll interval, and each slice asks the unjittered
   * question of whether the hold still stands, because what `backoffMs` returns is a fresh jittered
   * draw rather than a deadline.
   */
  private async honourBackoff(entry: RungEntry, walk: Walk): Promise<void> {
    let remainingMs = this.backoffMs(entry.hexTopic);
    while (remainingMs > 0 && !walk.stopped) {
      // Never zero, or a poll interval of zero would stop the countdown converging.
      const sliceMs = Math.max(1, Math.min(remainingMs, this.pollIntervalMs));
      await this.pauseFor(walk, sliceMs);
      remainingMs -= sliceMs;

      if (this.feedHealth.backoffRemainingMs(entry.hexTopic) === 0) {
        return;
      }
    }
  }

  /** Sleeps `ms`, or until the walk is stopped, so a torn-down player never holds the timer. */
  private pauseFor(walk: Walk, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        walk.wake = undefined;
        resolve();
      }, ms);

      walk.wake = () => {
        clearTimeout(timer);
        walk.wake = undefined;
        resolve();
      };
    });
  }

  private noteProgress(walk: Walk): void {
    walk.stallTriedAtMs = null;
    walk.progressed = true;
    this.settle(walk, true);
  }

  private settle(walk: Walk, progressed: boolean): void {
    const onSettled = walk.onSettled;
    walk.onSettled = undefined;
    onSettled?.(progressed);
  }

  /**
   * Starts a rung at its newest index, which is the only place a walk may skip indexes. The walk that
   * follows must be contiguous, because a gap in an EVENT playlist is a gap in the timeline hls.js
   * buffers.
   */
  private async bootstrap(entry: RungEntry, walk: Walk): Promise<boolean> {
    const playing = this.playingBeside(entry);
    const rung = feedRungOf(entry);

    // A feed found empty gains slot 0 first, so one read says when to search again, where a search
    // from nothing would cost a round of eight each time.
    if (walk.waitingForFirstSlot && walk.seed === null) {
      const first = await new RungFeedReader(this.fetchResource, rung.owner, rung.topic, this.followClock.now).read(0);
      if (walk.stopped) {
        return false;
      }
      if (!first.found) {
        this.recordMiss(entry, walk, null);
        this.feedHealth.recordUnservedSlot(entry.hexTopic);
        return false;
      }
    }

    const found =
      walk.seed ?? (await this.finder.findNewest(rung, playing ? this.hintFrom(playing) : null, () => walk.stopped));
    walk.seed = null;
    if (walk.stopped) {
      return false;
    }
    walk.waitingForFirstSlot = found === null;
    if (found === null) {
      // The feed holds nothing yet, the search's own form of a slot not written yet.
      this.recordMiss(entry, walk, null);
      this.feedHealth.recordUnservedSlot(entry.hexTopic);
      return false;
    }

    this.feedHealth.recordGatewayReachable(entry.hexTopic);
    walk.misses = 0;
    const parsed = parseManifest(found.playlist);

    if (playing && !walk.isCandidate) {
      const snapshot = this.stateManager.snapshot(playing.hexTopic);
      const refusal = snapshot ? switchRefusal(parsed, snapshot) : null;
      if (refusal !== null) {
        this.refuse(entry, playing, refusal);
        return false;
      }
    }

    const older = playing && !walk.isCandidate ? await this.readBackToPlayhead(entry, walk, found) : [];
    if (walk.stopped) {
      return false;
    }

    for (const playlist of older) {
      this.ingest(entry, walk, playlist, found.index);
    }
    if (!this.ingest(entry, walk, found.playlist, found.index)) {
      return false;
    }

    this.stateManager.setIndex(entry.hexTopic, found.index);
    walk.current = feedEntryOf(Number(found.index.toBigInt()), found.playlist, this.followClock.now());
    walk.currentSeenAtMs = this.followClock.now();
    const onFound = walk.onFound;
    walk.onFound = undefined;
    onFound?.();
    // This session's first read found the rung open, so an end still recorded against it or its group
    // was left by an earlier session and is over. See `FeedHealthTracker.forgetStaleEnd`.
    this.feedHealth.forgetStaleEnd(entry.hexTopic);
    if (entry.ladder.group !== null) {
      this.feedHealth.forgetStaleEnd(entry.ladder.group);
    }
    return true;
  }

  /** Where the playing rung stands, for a search of another rung to start from, or null before it has a slot. */
  private hintFrom(playing: RungEntry): SwitchHint | null {
    const current = playing.walk?.current;
    if (!playing.walk || !current) {
      return null;
    }
    return {
      index: current.index,
      newestSegmentEndMs: current.newestSegmentEndMs,
      seenAtMs: playing.walk.currentSeenAtMs,
    };
  }

  /** The rung the viewer is playing beside this one, when it holds a playlist. */
  private playingBeside(entry: RungEntry): RungEntry | null {
    const playing = entry.ladder.playing;
    if (!playing || playing === entry || !this.stateManager.hasSegments(playing.hexTopic)) {
      return null;
    }
    return playing;
  }

  /**
   * Reads a switch target's older indexes back to where the viewer is playing, so a viewer behind the
   * live edge keeps their place.
   *
   * Each read steps back by about one window, the newest playlist's length less one segment so two
   * windows share a segment. A step that lands past a hole, which a coalesced publish leaves, is halved
   * and tried again. Every read names an index between zero and the newest, so each one exists.
   *
   * @returns The older playlists, oldest first, or none when the viewer is at the live edge, the
   *   position is more than {@link MAX_READ_BACK_READS} reads back, or a read back fails.
   */
  private async readBackToPlayhead(entry: RungEntry, walk: Walk, found: NewestIndex): Promise<string[]> {
    const playheadMs = this.playheadMs(entry.ladder.group);
    let newer = parseManifest(found.playlist).segments;
    const newestStartMs = firstSegmentStartMs(newer);
    if (playheadMs === null || newestStartMs === null || playheadMs >= newestStartMs) {
      return [];
    }

    const older: string[] = [];
    let at = found.index.toBigInt();
    let step = BigInt(Math.max(1, newer.length - 1));
    for (let reads = 0; reads < MAX_READ_BACK_READS && at > 0n; reads++) {
      const target = at > step ? at - step : 0n;
      let text: string;
      try {
        text = (await this.fetchResource(feedSlotPath(entry.owner, entry.topic, FeedIndex.fromBigInt(target)))).text;
      } catch (error) {
        this.reportReadBackFailure(entry, target, error);
        return [];
      }
      if (walk.stopped) {
        return [];
      }

      const segments = parseManifest(text).segments;
      if (!joinsOnto(segments, newer)) {
        if (step === 1n) {
          break;
        }
        step /= 2n;
        continue;
      }

      older.unshift(text);
      newer = segments;
      at = target;
      const startMs = firstSegmentStartMs(segments);
      if (startMs !== null && playheadMs >= startMs) {
        return older;
      }
    }

    console.debug(
      `[SwarmHls] the viewer is further behind than ${MAX_READ_BACK_READS} reads of rung ${entry.hexTopic} ` +
        'reach, so the switch goes to the live edge',
    );
    return [];
  }

  /**
   * A read back to the viewer's position that failed, said as what it was. The switch then goes to the
   * live edge, as it does for a viewer too far behind, but a gateway fault is recorded as one, so the
   * walk that follows backs off and the overlay hears it.
   */
  private reportReadBackFailure(entry: RungEntry, index: bigint, error: unknown): void {
    if (isSlotNotWrittenYet(error)) {
      console.debug(
        `[SwarmHls] index ${index} of rung ${entry.hexTopic} was not served, so the switch goes to the live edge`,
      );
      return;
    }
    this.feedHealth.recordGatewayFailure(entry.hexTopic);
    console.warn(
      `[SwarmHls] could not read index ${index} of rung ${entry.hexTopic} back to the viewer's position, so ` +
        'the switch goes to the live edge',
      error,
    );
  }

  /**
   * Refuses a switch to a rung that has clearly stopped, and leaves the viewer on the rung they play.
   * The rung is announced once, for the player to take its level out.
   */
  private refuse(entry: RungEntry, playing: RungEntry, reason: string): void {
    entry.refused = true;
    entry.retired = true;
    this.deactivate(entry);
    this.feedHealth.recordRungStopped(entry.hexTopic, { reason, failoverTo: playing.hexTopic });
  }

  /**
   * Returns false once this rung is finalized and there is nothing further to walk.
   *
   * @param index The slot `text` was read from, which is where a finished rung's watch starts.
   */
  private ingest(entry: RungEntry, walk: Walk, text: string, index: FeedIndex): boolean {
    const parsed = parseManifest(text);
    const shouldContinue = this.stateManager.updateManifest(
      entry.hexTopic,
      parsed.headers,
      parsed.segments,
      parsed.isFinalized,
    );

    if (this.stateManager.hasSegments(entry.hexTopic)) {
      walk.markReady();
    }

    if (!shouldContinue) {
      walk.stopped = true;
      this.settle(walk, false);
    }

    const { ladder } = entry;
    const watched = ladder.playing === entry || ladder.failoverTarget === entry;
    if (parsed.isFinalized && watched && !walk.isCandidate) {
      const finished = feedEntryOf(Number(index.toBigInt()), text, this.followClock.now());
      void this.confirmEnd(entry, index, { ...finished, seenAtMs: this.followClock.now() });
    }

    return shouldContinue;
  }

  /** Whether the stall rule may try a sibling for the playing rung now. */
  private tryFailoverIfStalled(entry: RungEntry, walk: Walk): void {
    const { ladder } = entry;
    if (ladder.playing !== entry || ladder.isTrying || walk.isCandidate) {
      return;
    }
    const unservedMs = this.feedHealth.unservedRunMs(entry.hexTopic);
    if (unservedMs === null || unservedMs < UNSERVED_SLOT_STALL_MS) {
      return;
    }
    const now = this.now();
    if (walk.stallTriedAtMs !== null && now - walk.stallTriedAtMs < STALL_REPROBE_MS) {
      return;
    }
    walk.stallTriedAtMs = now;
    const sibling = this.siblingOf(entry);
    if (sibling) {
      void this.failOverIfSiblingProgresses(entry, walk, sibling);
    }
  }

  /**
   * The playing rung has been unserved for the stall threshold. Walks the next lower rung for
   * {@link RUNG_PROGRESS_BOUND_MS} from when its newest index is found: a new index there means the
   * playing rung alone stopped, and the player fails over to it. None means the broadcast paused, and
   * the stall shows as it always did.
   */
  private async failOverIfSiblingProgresses(entry: RungEntry, walk: Walk, sibling: RungEntry): Promise<void> {
    const { ladder } = entry;
    ladder.isTrying = true;
    try {
      const wasFollowed = sibling.walk !== null;
      const progressed = await this.walkForProgress(sibling, null);
      if (!this.isCurrent(entry) || entry.walk !== walk) {
        return;
      }
      if (progressed && this.feedHealth.unservedRunMs(entry.hexTopic) !== null) {
        this.failOver(entry, sibling, 'it has stopped while the next lower quality carries on');
        return;
      }
      if (!wasFollowed && sibling.walk && ladder.playing !== sibling) {
        this.deactivate(sibling);
      }
      console.debug(
        `[SwarmHls] rung ${entry.hexTopic} stalled and its sibling did not move either, so the broadcast paused`,
      );
    } finally {
      ladder.isTrying = false;
    }
  }

  /**
   * The playing rung published ENDLIST. One sibling confirms it: a sibling that finished too means the
   * broadcast ended, one that carries on through the bound means this rung alone stopped and the
   * player fails over to it.
   *
   * ⛔ **The sibling is watched for the whole bound, not to its first new index.** The qualities of one
   * broadcast finish moments apart, each as its own upload drains, so a sibling still publishing its
   * last playlists is finishing too. Taking its first new index as proof it carries on failed the viewer
   * over to a quality about to end, and the ended overlay came late or not at all.
   */
  private async confirmEnd(entry: RungEntry, finishedAt: FeedIndex, hint: SwitchHint): Promise<void> {
    const sibling = this.siblingOf(entry);
    if (!sibling) {
      this.recordEnded(entry, finishedAt);
      return;
    }

    let found: NewestIndex | null;
    try {
      found = await this.finder.findNewest(feedRungOf(sibling), hint, () => !this.isCurrent(entry));
    } catch {
      // Nothing to confirm with. The playing rung's own ENDLIST is the stronger evidence.
      found = null;
    }
    if (!this.isCurrent(entry)) {
      return;
    }
    if (found === null || parseManifest(found.playlist).isFinalized) {
      this.recordEnded(entry, finishedAt);
      return;
    }

    const progressed = await this.walkForProgress(sibling, found, 'wholeBound');
    if (!this.isCurrent(entry)) {
      return;
    }
    if (progressed) {
      this.failOver(entry, sibling, 'it finished while the next quality carries on');
      return;
    }
    if (sibling.walk && entry.ladder.playing !== sibling) {
      this.deactivate(sibling);
    }
    this.recordEnded(entry, finishedAt);
  }

  /**
   * Follows a rung as a candidate until it shows a new index or the bound passes. The bound counts from
   * when its newest index is known, and the search for it has {@link CANDIDATE_FIND_DEADLINE_MS} of its
   * own. A rung that shows ENDLIST has not progressed, however many indexes came before it.
   *
   * @param seed Its newest index when already found, so the walk does not ask the finder again.
   * @param rule `firstIndex` answers at the first new index. `wholeBound` keeps watching until the bound
   *   passes, so a rung that publishes and then finishes inside it counts as finished.
   */
  private walkForProgress(
    entry: RungEntry,
    seed: NewestIndex | null,
    rule: 'firstIndex' | 'wholeBound' = 'firstIndex',
  ): Promise<boolean> {
    if (entry.retired) {
      return Promise.resolve(false);
    }
    const walk = entry.walk ?? this.startWalk(entry, seed, true);
    if (walk.stopped || this.stateManager.snapshot(entry.hexTopic)?.isFinalized) {
      return Promise.resolve(false);
    }
    if (walk.progressed && rule === 'firstIndex') {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      let progressedInBound = false;
      const finish = (progressed: boolean) => {
        clearTimeout(timer);
        walk.onSettled = undefined;
        walk.onFound = undefined;
        resolve(progressed);
      };
      const atBound = () => finish(rule === 'wholeBound' && progressedInBound && !walk.stopped);
      const onSettled = (progressed: boolean) => {
        if (progressed && rule === 'wholeBound') {
          progressedInBound = true;
          walk.onSettled = onSettled;
          return;
        }
        finish(progressed);
      };
      timer = setTimeout(atBound, walk.current === null ? this.candidateFindDeadlineMs : this.progressBoundMs);
      if (walk.current === null) {
        walk.onFound = () => {
          clearTimeout(timer);
          timer = setTimeout(atBound, this.progressBoundMs);
        };
      }
      walk.onSettled = onSettled;
    });
  }

  /**
   * Takes the playing rung out and points the player at `to`, which is already followed. The rung is
   * deactivated once hls.js reports the switch, through {@link followOnly}.
   */
  private failOver(from: RungEntry, to: RungEntry, reason: string): void {
    from.retired = true;
    from.ladder.failoverTarget = to;
    if (to.walk) {
      to.walk.isCandidate = false;
    }
    this.feedHealth.recordRungStopped(from.hexTopic, { reason, failoverTo: to.hexTopic });
  }

  private recordEnded(entry: RungEntry, finishedAt: FeedIndex): void {
    const { group } = entry.ladder;
    if (group !== null) {
      this.feedHealth.recordFeedEnded(group);
    }
    this.watchForReturn(entry, finishedAt);
  }

  /**
   * The next lower registered rung still in the ladder, or the next higher when this is the lowest.
   * It is what tells a rung that stopped from a broadcast that did.
   */
  private siblingOf(entry: RungEntry): RungEntry | null {
    const rungs = entry.ladder.rungs;
    const at = rungs.indexOf(entry);
    for (let index = at - 1; index >= 0; index--) {
      if (!rungs[index].retired) {
        return rungs[index];
      }
    }
    for (let index = at + 1; index < rungs.length; index++) {
      if (!rungs[index].retired) {
        return rungs[index];
      }
    }
    return null;
  }

  private isCurrent(entry: RungEntry): boolean {
    return this.rungs.get(entry.hexTopic) === entry;
  }

  /**
   * Keep asking whether the broadcaster has come back to the rung that was playing when it ended.
   *
   * ⛔ **A finished playlist is the end of a session, not of the feed.** A declared stream's rungs keep
   * their topics for the life of the declaration, so a broadcaster who stops and comes back continues
   * every rung at the next index. Measured live 2026-09-24: a viewer who had watched the end was told it
   * had ended for fifteen minutes past the return. One watch, on the rung that was playing, and the
   * player's restart joins whatever comes back. See {@link FeedReturnWatch}.
   */
  private watchForReturn(entry: RungEntry, finishedAt: FeedIndex): void {
    const { ladder } = entry;
    this.stopReturnWatch(ladder);
    ladder.returnWatchedRung = entry;
    ladder.returnWatch = new FeedReturnWatch({
      fetchResource: this.fetchResource,
      owner: entry.owner,
      topic: entry.topic,
      finishedAt,
      onReturned: () => {
        ladder.returnWatch = null;
        ladder.returnWatchedRung = null;
        this.feedHealth.recordFeedResumed(entry.hexTopic);
        if (ladder.group !== null) {
          this.feedHealth.recordFeedResumed(ladder.group);
        }
      },
      nextWaitMs: this.returnWatchWaitMs,
    });
    ladder.returnWatch.start();
  }

  private stopReturnWatch(ladder: LadderEntry): void {
    ladder.returnWatch?.stop();
    ladder.returnWatch = null;
    ladder.returnWatchedRung = null;
  }

  /**
   * A failed rung read, recorded against the local miss counter and, when it is a real gateway
   * fault, the shared feed health.
   *
   * A 404 is only the next slot not being published yet, the ordinary case for a viewer at the live
   * edge, so it earns no backoff. Anything else, a transport error or a 5xx, is the gateway not
   * answering: it earns the backoff {@link honourBackoff} waits out and turns the overlay to
   * reconnecting.
   *
   * @returns How long a run of refusals this poll extends, or null when the read failed for a reason
   *   that is not a refusal.
   */
  private recordFailure(entry: RungEntry, walk: Walk, error: unknown): number | null {
    this.recordMiss(entry, walk, error);
    if (isSlotNotWrittenYet(error)) {
      return this.feedHealth.recordUnservedSlot(entry.hexTopic);
    }
    this.feedHealth.recordGatewayFailure(entry.hexTopic);
    return null;
  }

  private recordMiss(entry: RungEntry, walk: Walk, error: unknown): void {
    walk.misses++;
    if (walk.misses === MISSES_BEFORE_WARNING) {
      console.warn(
        `Feed ${entry.hexTopic} has not advanced in ${walk.misses} attempts. The stream may have ` +
          `ended, or the gateway may be unreachable.`,
        error,
      );
    }
  }
}

/** A rung as the finder is asked about it, with the ladder whose time markers name it. */
function feedRungOf(entry: RungEntry): FeedRung {
  return { owner: entry.owner, topic: entry.topic, group: entry.ladder.group };
}
