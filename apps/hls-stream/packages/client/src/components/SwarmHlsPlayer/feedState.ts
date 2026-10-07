/** The gateway is answering. The feed may still be waiting on the publisher, which is ordinary. */
export const FEED_STATE_LIVE = 'live';

/** The gateway is not answering at all, and attempts are being held off between retries. */
export const FEED_STATE_RECONNECTING = 'reconnecting';

/** The gateway is answering, but has not served the slot the player waits on, for a long run. */
export const FEED_STATE_STALLED = 'stalled';

/**
 * The gateway is answering, and serving what it is asked for, more slowly than the player consumes
 * it. Nothing has failed and the picture keeps stopping anyway.
 */
export const FEED_STATE_DEGRADED = 'degraded';

/**
 * The broadcaster ended the stream. The other three describe something still being retried, and this
 * one describes there being nothing left to retry, so nothing a gateway does moves a feed out of it.
 *
 * ⛔ **Not terminal, although it was written as terminal until 2026-09-24.** A declared stream's feeds
 * outlive its session: a broadcaster who stops and comes back continues the same feeds at the next
 * index, and the admin accepts `live` after `vod`. A viewer who had watched such a broadcast end was
 * still being told it had ended fifteen minutes after it came back. So the followers keep a slow watch
 * on the slot after a finished playlist, and {@link FeedHealthTracker.recordFeedResumed} is what takes
 * a topic back out of this state when that slot is served a playlist that is still open.
 */
export const FEED_STATE_ENDED = 'ended';

export type FeedState =
  | typeof FEED_STATE_LIVE
  | typeof FEED_STATE_RECONNECTING
  | typeof FEED_STATE_STALLED
  | typeof FEED_STATE_DEGRADED
  | typeof FEED_STATE_ENDED;

type FeedStateListener = (state: FeedState) => void;

/** Why the poller took a rung out, and the rung the player should play instead. */
interface RungStoppedDetail {
  /** Said in the console line that drops the level, so a drop can be checked against the broadcast. */
  readonly reason: string;
  /** The rung to load next, or null to leave the choice to ABR. */
  readonly failoverTo: string | null;
}

type RungStoppedListener = (rungTopicId: string, detail: RungStoppedDetail) => void;

/**
 * How long to wait before asking a failing gateway again, after its first failure. Doubles per
 * consecutive failure up to {@link MANIFEST_RETRY_CAP_MS}.
 *
 * One target duration, so a single flake costs at most one poll cycle rather than a visible pause.
 * The deadline is stamped when the request failed, not when it was issued, so a request that spent
 * time before failing pushes the next poll that much further inside the window. Only a run of
 * failures actually slows the polling down.
 */
const MANIFEST_RETRY_BASE_MS = 2_000;

/**
 * The longest gap between attempts on a failing gateway, which is also the longest a viewer whose
 * gateway has come back can sit in front of a frozen picture without anything finding out.
 *
 * ⛔ **This was thirty seconds, and thirty seconds was measured to be most of the freeze.** Three
 * unrelated faults injected under a watching viewer on the four rung ABR ladder, 2026-08-29, live,
 * in a real browser: killing the uploader process froze the picture **59.0s**, pausing the writer
 * bee node for **eight seconds** froze it **58.9s**, and a writer bee outage froze it **58.5s**.
 * Three faults of three very different lengths landing within half a second of each other is one
 * timer rather than three coincidences, and 2 + 4 + 8 + 16 and then a first cap period is exactly
 * the sixty seconds all three sat on. An eight second pause costing 58.9 seconds is the sharpest
 * reading of it: fifty of those seconds were the client's own.
 *
 * ## Why eight
 *
 * ⭐ **It is the largest ceiling that keeps a ladder viewer no worse off than a single rendition
 * one.** The same client on one rendition was measured on 2026-08-27 taking **10.7s and 9.9s to
 * recover after the gateway had started answering again**, across both byte sources, on a 20.5
 * second gateway stop. See the `crash-at-an-in-tab-viewer-2026-08-27` measurement (kept outside the repository). A ladder walks five
 * feeds where a single rendition walks one, and walking more of them must not cost more to recover
 * than the one-rung case a ladder is built out of.
 *
 * It is also where this client already draws the line for itself. {@link UNSERVED_SLOT_STALL_MS}
 * is thirty polls, which its own corrected note puts at about eight seconds of healthy polling, so
 * eight seconds is the interval at which the player decides a quiet feed is worth telling a viewer
 * about. A retry ceiling longer than that is a client complaining about a fault it has stopped
 * looking for.
 *
 * The same number was reached from a third direction, three weeks before any of this was measured:
 * `docs/reviews/roadmap.md` item 0.8b named 8s as the secondary lever if clearing the hold on a
 * segment arrival turned out not to be enough. On the ladder it was not enough, because a ladder then
 * held five feeds and the segment path only ever cleared one of them at a time.
 *
 * ## Why the load argument that set thirty still holds
 *
 * The flood this bounds is flat polling. Since 2026-10-07 a viewer follows the one quality it plays,
 * two during a switch, and one rung at the 750ms poll interval is **40 requests per 30s**. At a thirty
 * second ceiling a fully dark gateway sees one of those per 30s from a viewer, and at eight it sees
 * about four. That is still a **10.7x** reduction against the flood, and one request every eight
 * seconds is not what tips a gateway that is already struggling.
 *
 * The ceiling is also no longer the only thing shortening a recovery. A rung is released the moment
 * a rung beside it is served (see {@link FeedHealthTracker.recordGatewayReachable}), so this bounds
 * the case where *nothing* is getting through, which is the only case where holding off is the
 * right answer.
 */
export const MANIFEST_RETRY_CAP_MS = 8_000;

/**
 * How long a feed may sit on a slot the gateway answered for, but had nothing in, before the feed
 * is called stalled.
 *
 * ⛔⛔⛔ **This was a POLL COUNT, and the poll rate is not a constant.** It collapses during exactly
 * the stall it counts. Measured on two recorded uploader crashes
 * (the `overlay-silence-during-a-crash-2026-08-07` measurement (kept outside the repository)), feed reads went from a 264ms gap
 * before the crash to 1064ms during the freeze, because each read takes about three times as long
 * and the client also spaces unserved reads about four times wider. So thirty polls was about eight
 * seconds while healthy and about thirty-two during a stall, and when a viewer heard anything was a
 * by-product rather than a decision. A 12.4 second freeze accumulated 13 polls, never reached the
 * threshold, and that viewer watched a dead picture for twelve seconds and was told nothing.
 *
 * ⭐ **Eight is what the old count meant while healthy**, so a viewer at the live edge is no more
 * likely to see the overlay than they were. Only the stall case moves, which is the case that was
 * wrong. It is also {@link MANIFEST_RETRY_CAP_MS}, already this client's answer to how long a quiet
 * feed may go unmentioned, reached there from three independent directions.
 *
 * A viewer who has merely caught up with the publisher cannot reach this. A segment lands every 0.5
 * to 2 seconds and every one of them ends the run. Eight seconds of an unbroken unserved run means
 * the publisher really has stopped.
 */
export const UNSERVED_SLOT_STALL_MS = 8_000;

/**
 * How many consecutive unserved polls the walk keeps probing past a refusal for.
 *
 * ⚠️ **Not what decides the overlay any more.** That is {@link UNSERVED_SLOT_STALL_MS}. This bounds
 * only the extra request the ladder walk makes to ask what is behind a refused slot: below
 * `UNSERVED_POLLS_BEFORE_PROBE` a refusal is too likely to be the publisher's own head to be worth
 * asking about, and above this the walk has asked on every poll and found nothing every time, so
 * what is missing is not within its reach.
 */
export const UNSERVED_POLLS_PROBE_CEILING = 30;

/**
 * How many times the picture may stop inside {@link PLAYBACK_STALL_WINDOW_MS} before the stream is
 * called degraded.
 *
 * Counted from the viewer's own symptom rather than from a transfer time, which is what makes one
 * pair of numbers work across every profile. A read slow enough to matter is one the buffer stops
 * absorbing, and how slow that is depends on the segment length, the bitrate and the deployment. How
 * often the picture stops does not.
 *
 * ⭐ **Both numbers are measured rather than chosen**, by replaying every archived browser run's
 * rebuffer counter through candidate rules. Within a rolling twenty seconds and after the first
 * frame, the fourteen-minute collapse of the `the-fourteen-minute-collapse-2026-08-07` measurement (kept outside the repository)
 * reaches 4 stalls, the one other run with viewer-visible degradation reaches 4, and the worst run a
 * viewer would call healthy reaches 1, including four separate clean hours. The next rule down, 3
 * stalls in fifteen seconds, fires 2786 seconds into one of those hours.
 *
 * On the collapse this is reached 9 seconds after the picture first stopped, against the six minutes
 * of silence that run actually shipped.
 */
export const PLAYBACK_STALL_BURST = 4;

/** The span the burst is counted over. See {@link PLAYBACK_STALL_BURST} for where the pair comes from. */
export const PLAYBACK_STALL_WINDOW_MS = 20_000;

/**
 * How many topics may be tracked at once.
 *
 * Only topics in trouble are held, and a topic is dropped the moment its gateway answers, so this
 * is a backstop rather than a working limit: what accumulates otherwise is topics a viewer left
 * while they were failing, which nothing would ever come back to clear. Evicts the least recently
 * updated, which is the one furthest from being watched.
 */
export const TRACKED_TOPIC_LIMIT = 32;

interface TopicHealth {
  /** Consecutive failures to reach the gateway at all. */
  gatewayFailures: number;
  /** The clock reading before which no further attempt should be made. */
  retryAtMs: number;
  /** Consecutive polls spent on a slot the gateway answered for, but had nothing in. */
  unservedSlotPolls: number;
  /**
   * When the current unserved run began, or null when a slot was last served.
   *
   * Kept beside the poll count rather than replacing it: the count bounds the probe, the clock
   * decides the overlay, and the two answer different questions. See {@link UNSERVED_SLOT_STALL_MS}.
   */
  unservedSinceMs: number | null;
  /**
   * Whether the broadcaster published a manifest that ends the playlist. Goes back to false only when
   * the broadcaster is found publishing to the feed again. See {@link FeedHealthTracker.recordFeedResumed}.
   */
  hasEnded: boolean;
  /** When the picture last stopped, most recent last, trimmed by {@link recentStalls}. */
  stallsAtMs: readonly number[];
}

const HEALTHY: TopicHealth = {
  gatewayFailures: 0,
  retryAtMs: 0,
  unservedSlotPolls: 0,
  unservedSinceMs: null,
  hasEnded: false,
  stallsAtMs: [],
};

/** How long to hold off after `failures` consecutive failures, doubling and then flat at the cap. */
export function backoffDelayMs(failures: number): number {
  return Math.min(MANIFEST_RETRY_CAP_MS, MANIFEST_RETRY_BASE_MS * 2 ** (failures - 1));
}

/**
 * The stalls still inside the window, and never more of them than it takes to reach the burst.
 *
 * Both halves matter. The window is what makes this a burst rather than a lifetime total, so that a
 * stream which stalls four times in an hour is not described as struggling for the rest of the
 * session. The cap is what stops a stream that never recovers from accumulating a timestamp per
 * stall for as long as the tab is open, and it costs nothing: if more than a burst's worth sit in
 * the window, the most recent burst's worth are all in it too.
 */
function recentStalls(stallsAtMs: readonly number[], nowMs: number): readonly number[] {
  const inWindow = stallsAtMs.filter((at) => nowMs - at < PLAYBACK_STALL_WINDOW_MS);
  return inWindow.slice(-PLAYBACK_STALL_BURST);
}

/**
 * Whether an entry still says anything. Not the same question as whether the topic looks unwell: a
 * run of unserved slots reads as live until it is long enough to mean something, and dropping it
 * before then is dropping the count that decides when that is.
 */
function isWorthTracking(health: TopicHealth): boolean {
  return (
    health.gatewayFailures > 0 ||
    health.unservedSlotPolls > 0 ||
    health.unservedSinceMs !== null ||
    health.hasEnded ||
    health.stallsAtMs.length > 0
  );
}

function stateOfHealth(health: TopicHealth | undefined, nowMs: number): FeedState {
  if (!health) {
    return FEED_STATE_LIVE;
  }
  // First, and deliberately. A gateway going down after the broadcast finished does not make the
  // broadcast unfinished, and a feed that stops advancing because it ended is not stalled.
  if (health.hasEnded) {
    return FEED_STATE_ENDED;
  }
  if (health.gatewayFailures > 0) {
    return FEED_STATE_RECONNECTING;
  }
  if (health.unservedSinceMs !== null && nowMs - health.unservedSinceMs >= UNSERVED_SLOT_STALL_MS) {
    return FEED_STATE_STALLED;
  }
  // Last of the four, because it is the least specific. Each of the others names why the picture
  // stopped, and this one only names that it did, so a viewer whose gateway has gone away entirely
  // would be told the smaller half of the truth.
  if (recentStalls(health.stallsAtMs, nowMs).length >= PLAYBACK_STALL_BURST) {
    return FEED_STATE_DEGRADED;
  }
  return FEED_STATE_LIVE;
}

/**
 * One ladder's health as its viewer experiences it: what every followed rung agrees on, plus what was
 * recorded against the entry topic directly. The poller follows only the playing rung, and the one
 * being switched to during a switch, so the rungs folded here are one or two.
 *
 * ⭐ **Agreement across the rungs, not the worst of them.** One gateway serves every feed, so a
 * rung being served is proof the gateway answers, and a rung failing beside it is behind for a
 * reason of its own rather than cut off. Taking the worst would raise the overlay on any single
 * rung's flake. This is the same all-rungs rule the ended signal already uses.
 *
 * The end of the broadcast and the record of stopped pictures come from the entry topic alone,
 * because that is where they are recorded and neither belongs to a rung: the broadcast ends across
 * the whole group, and a stall is counted off the video element, which plays one rung at a time
 * without saying which.
 *
 * The entry topic's own failures are deliberately left out. It is read once per load by the source
 * fetch and never again, so a failure recorded there has nothing that would ever clear it, and the
 * rungs report the same outage within a poll anyway.
 *
 * ⭐⭐⭐ **One rung going quiet is a fault the whole group has to report, and only when it is the rung
 * the viewer is on.** Agreement is right for reaching the gateway, which is what it was built for: a
 * rung that cannot reach the host its siblings are reaching has a flake of its own, and the viewer is
 * still watching. It is wrong for a feed that stops advancing. Measured 2026-08-30, live, on both
 * byte paths: one rung of four was silenced under a watching viewer, the picture stopped for 87 and
 * 103 seconds, three rungs published throughout, and the overlay said `live` the whole time because
 * three rungs out of four disagreed that anything was wrong. So `watched` overrides the unserved run
 * when the player has said which rung it is on, and nothing else about the fold changes.
 *
 * @param watched The rung this viewer is playing, or null when none has been named, which is every
 *   single-rendition stream and every ladder before its first level switch.
 */
function foldLadderHealth(
  own: TopicHealth | undefined,
  rungs: readonly (TopicHealth | undefined)[],
  watched: TopicHealth | null,
): TopicHealth {
  const entry = own ?? HEALTHY;
  if (rungs.length === 0) {
    return entry;
  }
  const agreedOn = (read: (health: TopicHealth) => number): number =>
    rungs.reduce((least, rung) => Math.min(least, read(rung ?? HEALTHY)), Number.POSITIVE_INFINITY);

  const rungHealths = rungs.map((rung) => rung ?? HEALTHY);
  // The latest of them, because the group has only been unserved since the last rung stopped being
  // served. One rung still getting slots leaves the group not unserved at all.
  const agreedUnservedSinceMs = rungHealths.every((health) => health.unservedSinceMs !== null)
    ? Math.max(...rungHealths.map((health) => health.unservedSinceMs as number))
    : null;

  // Both taken from the same place, so the run's age and the run's length describe one rung rather
  // than two different readings of the ladder.
  const unserved = watched ?? {
    unservedSinceMs: agreedUnservedSinceMs,
    unservedSlotPolls: agreedOn((health) => health.unservedSlotPolls),
  };

  return {
    gatewayFailures: agreedOn((health) => health.gatewayFailures),
    retryAtMs: entry.retryAtMs,
    unservedSlotPolls: unserved.unservedSlotPolls,
    unservedSinceMs: unserved.unservedSinceMs,
    hasEnded: entry.hasEnded,
    stallsAtMs: entry.stallsAtMs,
  };
}

/**
 * Whether each topic's gateway is answering, and how long to leave a failing one alone.
 *
 * Separate from the fetcher and from the manifest state because it has to outlive both. The player
 * tears its topic down and rebuilds it on every restart, and a fatal network error is what triggers
 * a restart, so the outage that this describes is also what destroys anything scoped to a mount.
 * Held here, the signal survives the restart it caused, and a viewer sees one continuous message
 * instead of the overlay flickering off and on.
 *
 * The two counters are opposite cases wearing similar shapes and are deliberately not merged: an
 * unserved slot means the publisher is behind the viewer and must be polled at full cadence, a
 * failure means the gateway is not answering and must not be.
 */
export class FeedHealthTracker {
  private readonly topics = new Map<string, TopicHealth>();
  private readonly listeners = new Map<string, Set<FeedStateListener>>();

  /**
   * What subscribers were last told, for topics not currently live.
   *
   * The comparison that decides whether to publish cannot be made by reading the state twice around
   * a change, because one of the four states is a function of the clock as well as of the entry: a
   * burst of stalls that ages out changes the state with nothing recorded. Read that way the state
   * before the change is already the state after it, so the one transition nothing else can announce
   * is the one that gets swallowed, and the overlay stays up until the next real fault.
   *
   * Holds only topics in a non-live state, so it is bounded by the same limit the entries are.
   */
  private readonly lastPublished = new Map<string, FeedState>();

  /**
   * The rungs each ladder follows right now, keyed by the topic the viewer's own link names.
   *
   * ⛔ **Without this the overlay is blind on a ladder.** A viewer subscribes to the entry topic,
   * the only one their link carries and the only one that survives a restart, while the rung topics
   * are per session and are discovered from the master playlist. Every gateway fault is recorded
   * against a rung, so `reconnecting` and `stalled` had no way to reach a watching viewer. Caught
   * live by the gateway outage arm on 2026-08-29: a gateway taken away froze the picture for 26.6 seconds and the client
   * said nothing at all, which is how it says the feed is live.
   */
  private readonly rungsOfGroup = new Map<string, readonly string[]>();

  /** Reverse of {@link rungsOfGroup}, so a rung's change can find the group that has to republish. */
  private readonly groupOfRung = new Map<string, string>();

  /**
   * The rung each ladder's viewer is actually playing, where the player has said.
   *
   * ⛔ Absent for every single-rendition stream, and for a ladder until its first level switch. The
   * fold falls back to the agreement rule then, which is what it did for every stream before this
   * existed. See {@link foldLadderHealth}.
   */
  private readonly watchedRungOfGroup = new Map<string, string>();

  private readonly rungStoppedListeners = new Set<RungStoppedListener>();

  private readonly feedResumedListeners = new Set<(topicId: string) => void>();

  /**
   * @param now A monotonic clock. `Date.now` is not one: a system clock correction during an outage
   *   moves every deadline already scheduled against it, either releasing the backoff at once or
   *   holding it for as long as the correction was large.
   */
  constructor(private readonly now: () => number = () => performance.now()) {}

  state(topicId: string): FeedState {
    return stateOfHealth(this.healthFor(topicId), this.now());
  }

  /**
   * Declare that `groupId` is watched on behalf of these rungs, replacing any previous membership.
   *
   * Idempotent, and safe to call with rungs already being walked: membership decides only how the
   * group's state is read, never what any topic has recorded against it.
   */
  trackGroup(groupId: string, rungTopicIds: readonly string[]): void {
    // Read before the untrack that clears it. A poller that stops following one rung re-tracks the
    // group with the rest, and losing the watched rung there would put the overlay back on the
    // agreement rule for a viewer who is still on a rung this walk follows.
    const watched = this.watchedRungOfGroup.get(groupId);
    // Forgotten without publishing, then published once below. Publishing between the two would tell
    // the overlay the group was healthy for an instant every time the followed rungs change, which a
    // switch and every sibling try do.
    this.forgetMembership(groupId);
    const rungs = [...new Set(rungTopicIds)].filter((rung) => rung !== groupId);
    if (rungs.length === 0) {
      this.publish(groupId, this.state(groupId));
      return;
    }

    this.rungsOfGroup.set(groupId, rungs);
    for (const rung of rungs) {
      this.groupOfRung.set(rung, groupId);
    }
    if (watched !== undefined && rungs.includes(watched)) {
      this.watchedRungOfGroup.set(groupId, watched);
    }
    this.publish(groupId, this.state(groupId));
  }

  /** Forget a ladder's membership. Each topic keeps whatever it had recorded against it. */
  untrackGroup(groupId: string): void {
    if (this.forgetMembership(groupId)) {
      this.publish(groupId, this.state(groupId));
    }
  }

  /** @returns Whether there was a membership to forget. */
  private forgetMembership(groupId: string): boolean {
    const rungs = this.rungsOfGroup.get(groupId);
    if (rungs === undefined) {
      return false;
    }

    for (const rung of rungs) {
      this.groupOfRung.delete(rung);
    }
    this.rungsOfGroup.delete(groupId);
    this.watchedRungOfGroup.delete(groupId);
    return true;
  }

  /**
   * Say which rung of a ladder this viewer is playing, or null once nothing is selected.
   *
   * ⭐ The overlay watches the group and only the group, so without this a fault on the one rung a
   * viewer can actually see is outvoted by three rungs they cannot. See {@link foldLadderHealth}.
   *
   * Ignored for a topic that is not a tracked ladder, and for a rung that ladder does not walk. Both
   * are a player and a poller disagreeing about the shape of the stream, and believing the player
   * would point the overlay at a feed nothing is reading.
   */
  watchRung(groupId: string, rungTopicId: string | null): void {
    const rungs = this.rungsOfGroup.get(groupId);
    if (rungs === undefined) {
      return;
    }
    if (rungTopicId !== null && !rungs.includes(rungTopicId)) {
      console.warn(`Rung ${rungTopicId} is not walked for ${groupId}, so it is not what this viewer is watching`);
      return;
    }

    if (rungTopicId === null) {
      this.watchedRungOfGroup.delete(groupId);
    } else {
      this.watchedRungOfGroup.set(groupId, rungTopicId);
    }
    this.publish(groupId, this.state(groupId));
  }

  /**
   * Watch for a rung the poller has found stopped, which the player takes out of its ladder.
   *
   * Announced by the poller and never judged here. A rung is judged by its own progress, a new index
   * within `RUNG_PROGRESS_BOUND_MS`, and only the poller sees that: the rungs of one ladder drift
   * apart without bound, so nothing recorded against one says where another should be.
   */
  onRungStopped(listener: RungStoppedListener): () => void {
    this.rungStoppedListeners.add(listener);
    return () => {
      this.rungStoppedListeners.delete(listener);
    };
  }

  /** Tells every {@link onRungStopped} listener that this rung stopped, and where to go instead. */
  recordRungStopped(rungTopicId: string, detail: RungStoppedDetail): void {
    for (const listener of [...this.rungStoppedListeners]) {
      try {
        listener(rungTopicId, detail);
      } catch (error) {
        console.error('Rung stopped listener threw:', error);
      }
    }
  }

  /**
   * Watch for a finished feed whose broadcaster has come back, which is what a player rejoins on.
   *
   * ⛔ Announced from here rather than read off {@link subscribe} as a state leaving
   * {@link FEED_STATE_ENDED}, because that is not the only way a state leaves it. An ended topic can
   * be evicted past {@link TRACKED_TOPIC_LIMIT} or forgotten by {@link clear}, and both read as `live`
   * afterwards. A player that restarted on either would be handed the finished recording again from
   * its first second. Only a watch that was served an open playlist calls {@link recordFeedResumed},
   * and only that is announced.
   *
   * @param listener Called with the topic that came back, which for a ladder is each rung and then its
   *   group, so a listener filters for the topic it plays.
   */
  onFeedResumed(listener: (topicId: string) => void): () => void {
    this.feedResumedListeners.add(listener);
    return () => {
      this.feedResumedListeners.delete(listener);
    };
  }

  private healthFor(topicId: string): TopicHealth | undefined {
    const rungs = this.rungsOfGroup.get(topicId);
    if (rungs === undefined) {
      return this.topics.get(topicId);
    }
    // `HEALTHY` rather than undefined for a named rung, so "watching a rung with nothing recorded
    // against it" stays distinct from "no rung named", which is what falls back to agreement.
    const watched = this.watchedRungOfGroup.get(topicId);
    return foldLadderHealth(
      this.topics.get(topicId),
      rungs.map((rung) => this.topics.get(rung)),
      watched === undefined ? null : (this.topics.get(watched) ?? HEALTHY),
    );
  }

  /**
   * How many stalls are held against a topic right now.
   *
   * Read by tests only, and there because the bound on {@link recentStalls} is otherwise invisible:
   * a stream that stalls without pause reports the same state whether four timestamps are kept or
   * four hundred thousand.
   */
  stallsRecorded(topicId: string): number {
    return this.topics.get(topicId)?.stallsAtMs.length ?? 0;
  }

  /**
   * How long a run of unserved polls a topic is currently riding.
   *
   * Read by tests only, and there because a walk that never records one is indistinguishable from a
   * walk whose feed is advancing. That was the whole of the ladder fault: `recordUnservedSlot` was
   * never called from `LadderFeedPoller`, so the state it feeds could not fire and nothing failed.
   */
  unservedPollsRecorded(topicId: string): number {
    return this.topics.get(topicId)?.unservedSlotPolls ?? 0;
  }

  /**
   * How long this topic has been on an unserved run, or null when its last read was served or the
   * gateway is failing. What the poller's stall rule reads, against {@link UNSERVED_SLOT_STALL_MS}.
   */
  unservedRunMs(topicId: string): number | null {
    const since = this.topics.get(topicId)?.unservedSinceMs;
    return since === undefined || since === null ? null : this.now() - since;
  }

  /**
   * Watch one topic. The current state arrives immediately, before this returns.
   *
   * Replaying is the point rather than a convenience. A subscriber arrives after a mount, and a
   * player mounting into an outage that is already under way is the common case, not the rare one:
   * it is what a restart is.
   */
  subscribe(topicId: string, listener: FeedStateListener): () => void {
    const forTopic = this.listeners.get(topicId) ?? new Set<FeedStateListener>();
    forTopic.add(listener);
    this.listeners.set(topicId, forTopic);
    this.notify(listener, this.state(topicId));

    return () => {
      forTopic.delete(listener);
      if (forTopic.size === 0) {
        this.listeners.delete(topicId);
      }
    };
  }

  /** How much of this topic's backoff is left to wait out. Zero when there is nothing to wait for. */
  backoffRemainingMs(topicId: string): number {
    const health = this.topics.get(topicId);
    if (!health) {
      return 0;
    }
    return Math.max(0, health.retryAtMs - this.now());
  }

  /**
   * A gateway that answered with a failure, or did not answer. Counted apart from an unserved slot:
   * this one gets asked less often, because asking a gateway that is down every two seconds for as
   * long as the tab is open helps nobody and adds load to something already struggling.
   *
   * @param atLeastMs The wait the gateway itself asked for, a rate limit's Retry-After, which the
   *   backoff never undercuts.
   */
  recordGatewayFailure(topicId: string, atLeastMs = 0): void {
    this.update(topicId, (health) => {
      const gatewayFailures = health.gatewayFailures + 1;
      return {
        ...health,
        gatewayFailures,
        retryAtMs: this.now() + Math.max(backoffDelayMs(gatewayFailures), atLeastMs),
        // ⛔⛔⛔ **The unserved run ends here, and leaving it running cost a viewer their picture.**
        // An unserved slot means the gateway ANSWERED and had nothing in it. A gateway that did not
        // answer is no evidence at all about the slot, so a run carried through an outage measures
        // the outage. Caught live by the gateway outage arm on 2026-08-30: a 20.5 second gateway outage under a watching
        // viewer, and 480p was dropped from the ladder on the other side of it while the uploader
        // was publishing it normally, 24 segments across the window it was removed in. That rung had
        // simply been between segments when the gateway went away, so it came back looking silent
        // for the whole outage. A run carried through an outage would also trip the poller's stall
        // rule on the far side of every outage longer than its threshold.
        //
        // The poll count goes with it, for the same reason and so the two describe one run.
        unservedSinceMs: null,
        unservedSlotPolls: 0,
      };
    });
  }

  /**
   * The gateway is reachable, whether or not it had the thing that was asked for.
   *
   * Deliberately narrower than {@link recordGatewayResponse}, and the distinction is the whole of
   * why both exist. Reaching the gateway says nothing about whether the feed is advancing: the feed
   * endpoint answers with the publisher's last update, so it answers identically for a broadcast in
   * progress and one that stopped an hour ago. Anything that clears the unserved run on the strength
   * of reaching the gateway erases a stall the player has already reported, and the path that would
   * do it is the one every restart takes.
   *
   * ⭐ **Every topic held off stops waiting, whichever one was proven.** One gateway serves every
   * feed this tracker holds, so a read getting through is the same evidence a segment arriving is.
   * A ladder viewer holds an entry for the quality it plays, one more while a switch is under way,
   * each backing off on its own count, and leaving the switch target asleep while the playing rung is
   * demonstrably being served is a switch with nothing to switch to. Measured 2026-08-29, when every
   * rung was followed: three unrelated faults under a watching ladder viewer each froze the picture
   * for 58.5 to 59.0 seconds, an eight second writer-bee pause included.
   *
   * What the other topics do **not** get is their failure counts back, because a named read proves
   * two different things about two different sets. That the gateway answers is proven for everyone.
   * That *this* feed reads cleanly is proven only where it was read. So the count stands: the
   * overlay keeps saying reconnecting rather than flickering once per sibling poll, a rung that
   * fails again returns to the wait it had earned rather than to the base, and the walk loop's own
   * poll interval is left as the floor on how often a rung with a fault of its own can ask.
   *
   * @param topicId The feed whose own read proved it, or omitted when the proof was not a feed read
   *   at all. A segment is fetched by chunk address rather than against any feed, so there is no
   *   topic to credit and every held one is forgiven outright.
   */
  recordGatewayReachable(topicId?: string): void {
    // Snapshotted because writing to a topic rewrites the entry being walked: `update` deletes
    // before it writes, so that eviction takes the least recently updated rather than the oldest.
    for (const held of [...this.topics.keys()]) {
      if (held === topicId) {
        continue;
      }
      if (topicId === undefined) {
        this.forgetFailures(held);
      } else {
        this.endHold(held);
      }
    }

    if (topicId !== undefined) {
      this.forgetFailures(topicId);
    }
  }

  /**
   * No longer waiting on an unwritten slot, with everything else it recorded kept.
   *
   * Guarded for the reason {@link endHold} gives: a write that changes nothing still moves the topic
   * in the eviction order.
   */
  private endUnservedRun(topicId: string): void {
    const health = this.topics.get(topicId);
    if (health === undefined || (health.unservedSinceMs === null && health.unservedSlotPolls === 0)) {
      return;
    }
    this.update(topicId, (current) => ({ ...current, unservedSlotPolls: 0, unservedSinceMs: null }));
  }

  /** Back to healthy as far as reaching the gateway goes: nothing counted against it, nothing owed. */
  private forgetFailures(topicId: string): void {
    this.update(topicId, (health) => ({ ...health, gatewayFailures: 0, retryAtMs: 0 }));
  }

  /**
   * Free to attempt now, with everything it has already failed still counted against it.
   *
   * Guarded rather than written unconditionally, because this runs for every held topic on every
   * successful read. An unguarded write would rewrite an entry that did not change, which moves it
   * to the end of the eviction order and makes the least recently *updated* topic no longer the one
   * furthest from being watched.
   */
  private endHold(topicId: string): void {
    if ((this.topics.get(topicId)?.retryAtMs ?? 0) === 0) {
      return;
    }
    this.update(topicId, (health) => ({ ...health, retryAtMs: 0 }));
  }

  /**
   * A slot was served. Forgets both runs, since serving one ends either.
   *
   * An ended broadcast is kept rather than forgotten. Forgetting it would read as `live` again, and
   * the last thing a finished stream does is serve the manifest that finished it. What does forget it
   * is {@link recordFeedResumed}, on evidence a served slot alone cannot give: an open playlist in the
   * slot after the finished one.
   *
   * ⭐ A run of playback stalls is kept for the opposite reason: serving a slot does not disprove it.
   * Through the whole of the fourteen-minute collapse the gateway kept serving, 384 slots against 34
   * empty ones after the onset, while the picture stopped every couple of seconds. Clearing the
   * stalls here would make the state that run exists to add unreachable on the run itself.
   */
  recordGatewayResponse(topicId: string): void {
    this.update(topicId, (health) => ({ ...HEALTHY, hasEnded: health.hasEnded, stallsAtMs: health.stallsAtMs }));
  }

  /** The picture stopped, after having started. See {@link PLAYBACK_STALL_BURST}. */
  recordPlaybackStall(topicId: string): void {
    const stalledAtMs = this.now();
    this.update(topicId, (health) => ({
      ...health,
      stallsAtMs: recentStalls([...health.stallsAtMs, stalledAtMs], stalledAtMs),
    }));
  }

  /**
   * The broadcaster published a manifest that ends the playlist. Not a fault, and it outlasts
   * everything a gateway can do. Only the broadcaster coming back ends it: see {@link recordFeedResumed}.
   */
  recordFeedEnded(topicId: string): void {
    this.update(topicId, (health) => ({ ...health, hasEnded: true }));
  }

  /**
   * The broadcaster is publishing to a feed that had finished: the slot after its finished playlist
   * was served one that is still open.
   *
   * ⭐ The one thing that takes a topic back out of {@link FEED_STATE_ENDED}. A declared stream's
   * broadcaster who stops and comes back continues the same feed at the next index, so a finished
   * playlist is the end of a session rather than of the feed. Measured live 2026-09-24: finalized at
   * 18:41:57 UTC, back at 18:43:18, and a viewer who had watched it end was still told it had ended
   * fifteen minutes later, because nothing on this side ever looked past the finished playlist.
   *
   * A slot was served to learn this, so it forgets what {@link recordGatewayResponse} forgets and keeps
   * the stalls for the reason given there. The unserved run matters most. A ladder rung sits on
   * unserved slots for the whole reconnect window before the uploader finishes it, the finished slot
   * ends its walk before anything records it as served, and the end hides the run from then on.
   * Without this a ladder that came back would be announced as still waiting to continue.
   *
   * ⛔ **For a ladder's group, every followed rung's run ends with it, not only the rung that was found
   * back.** One rung is watched, and the rung a viewer is on decides the unserved half of the group's
   * state. Those runs were waiting on the broadcast that has just come back, so they are over whichever
   * rung showed it. Failures are left alone: they describe the gateway, not the broadcaster.
   *
   * Announced to {@link onFeedResumed} whether or not this topic was recorded as ended. A viewer who
   * opened a recording never had the end recorded on the single-rendition path, and a ladder rung never
   * has it at all, since a ladder's end is recorded once against its group.
   */
  recordFeedResumed(topicId: string): void {
    this.clearEnd(topicId);

    for (const listener of [...this.feedResumedListeners]) {
      try {
        listener(topicId);
      } catch (error) {
        console.error('Feed resumed listener threw:', error);
      }
    }
  }

  /**
   * A fresh session's first read found this feed's playlist open, while an end is still recorded
   * against it. That end was left by an earlier session, and the broadcaster has come back since.
   *
   * ⛔ The tracker outlives every player on the page, so an end recorded while one viewer watched is
   * still recorded after they leave. A viewer who came back through the app after the broadcaster had
   * returned was told the broadcast had ended over a live picture, because only a watch cleared an end
   * and the watch went with the session that ran it.
   *
   * Cleared the way {@link recordFeedResumed} clears it, and announced to nobody. This is not a return
   * any watch saw: the viewer has only just arrived and watched nothing yet, so there is nothing to
   * rejoin, and a rejoin armed here would fire at the end of the live broadcast they go on to watch and
   * restart them into its recording.
   *
   * Nothing at all happens to a feed that has not ended. A restart into a stall reads the same open
   * playlist a fresh session does, and the stall it already reported has to survive that read. See
   * `ManifestFetcher.handleInitialFetch`.
   */
  forgetStaleEnd(topicId: string): void {
    if (!this.topics.get(topicId)?.hasEnded) {
      return;
    }
    this.clearEnd(topicId);
  }

  /**
   * Out of {@link FEED_STATE_ENDED}, with the waits that came before the end forgotten along with it.
   * What both {@link recordFeedResumed} and {@link forgetStaleEnd} do, and says why.
   */
  private clearEnd(topicId: string): void {
    for (const rung of this.rungsOfGroup.get(topicId) ?? []) {
      this.endUnservedRun(rung);
    }
    this.update(topicId, (health) => ({ ...HEALTHY, stallsAtMs: health.stallsAtMs }));
  }

  /**
   * The gateway answered, for a slot it had nothing in. The ordinary case for a viewer who has
   * caught up with the publisher, and the reason this does not set a backoff.
   *
   * It does clear one. An answer is an answer whatever it carries, so this ends a run of failures
   * exactly as {@link recordGatewayReachable} does. Carrying the failure count through instead left
   * a single earlier flake pinning the topic to `reconnecting` for as long as the publisher stayed
   * quiet, which is precisely when `stalled` is the thing worth saying.
   *
   * @returns The length of the run this poll extends.
   */
  recordUnservedSlot(topicId: string): number {
    let polls = 0;
    const at = this.now();
    this.update(topicId, (health) => {
      polls = health.unservedSlotPolls + 1;
      return {
        ...health,
        gatewayFailures: 0,
        retryAtMs: 0,
        unservedSlotPolls: polls,
        // Stamped once per run, not per poll. The run's age is the whole point, and rewriting it on
        // every poll would hold a permanently stalled feed at zero seconds old for ever.
        unservedSinceMs: health.unservedSinceMs ?? at,
      };
    });
    return polls;
  }

  /** Forget a topic, or all of them. */
  clear(topicId?: string): void {
    if (topicId === undefined) {
      const forgotten = [...this.topics.keys()];
      this.topics.clear();
      this.publishAll(forgotten);
      return;
    }
    this.update(topicId, () => null);
  }

  private update(topicId: string, change: (health: TopicHealth) => TopicHealth | null): void {
    const changed = change(this.topics.get(topicId) ?? HEALTHY);
    // Aged out here as well as when a stall is recorded, so that the entry stops being worth
    // tracking on the first poll after its window empties. Nothing schedules a re-read, and nothing
    // needs to: the fetcher records against this on every poll, so a topic whose only remaining
    // reason to be held is a burst that has expired is dropped within a poll of expiring.
    const next = changed === null ? null : { ...changed, stallsAtMs: recentStalls(changed.stallsAtMs, this.now()) };

    // Deleted before every write as well as instead of one, so that a re-insert moves the topic to
    // the end of the map and eviction below takes the least recently updated rather than the oldest.
    this.topics.delete(topicId);
    if (next !== null && isWorthTracking(next)) {
      this.topics.set(topicId, next);
      this.evictOverflow();
    }

    this.publish(topicId, this.state(topicId));
    this.publishGroupOf(topicId);
  }

  /** A rung's change is its group's change too, because the overlay watches only the group. */
  private publishGroupOf(topicId: string): void {
    const group = this.groupOfRung.get(topicId);
    if (group !== undefined) {
      this.publish(group, this.state(group));
    }
  }

  private evictOverflow(): void {
    const evicted: string[] = [];
    while (this.topics.size > TRACKED_TOPIC_LIMIT) {
      const oldest = this.topics.keys().next();
      if (oldest.done) {
        break;
      }
      this.topics.delete(oldest.value);
      evicted.push(oldest.value);
    }
    this.publishAll(evicted);
  }

  /**
   * Say that these topics are back to live, because forgetting one is a state change like any other.
   *
   * Published after the map has finished changing rather than inside the loop, so that a listener
   * which records against this tracker cannot resize the map halfway through a scan of it.
   */
  private publishAll(topicIds: string[]): void {
    for (const topicId of topicIds) {
      this.publish(topicId, FEED_STATE_LIVE);
      this.publishGroupOf(topicId);
    }
  }

  /** Says a state once. A subscriber hearing the same thing twice reads as a second fault. */
  private publish(topicId: string, state: FeedState): void {
    if ((this.lastPublished.get(topicId) ?? FEED_STATE_LIVE) === state) {
      return;
    }
    if (state === FEED_STATE_LIVE) {
      this.lastPublished.delete(topicId);
    } else {
      this.lastPublished.set(topicId, state);
    }

    for (const listener of this.listeners.get(topicId) ?? []) {
      this.notify(listener, state);
    }
  }

  /**
   * One listener's throw is its own. Without this the throw travels back up the promise chain that
   * reported the gateway answering, is caught by the handler for the gateway not answering, and is
   * recorded as the failure it is the opposite of.
   */
  private notify(listener: FeedStateListener, state: FeedState): void {
    try {
      listener(state);
    } catch (error) {
      console.error('Feed state listener threw:', error);
    }
  }
}
