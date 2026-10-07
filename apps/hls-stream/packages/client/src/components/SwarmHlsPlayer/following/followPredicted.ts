import { FeedEntry, FollowContext, SEGMENT_MS } from './feedReader';
import { pollsTriggerFires, probeAhead, RefusedSlotTrigger } from './probeAhead';

interface FollowPredictedOptions {
  /**
   * How often the first ask for a slot may come too early, as a target the follower steers to. Lower
   * asks later and wastes less, higher finds a little sooner and wastes more.
   */
  readonly earlyRate: number;
  /** The same for the second ask, the one made after the first came too early. */
  readonly secondEarlyRate: number;
  /** Unanswered asks a slot may take before the follower backs off it, since Bee skips peers for an address asked too early too often. */
  readonly earlyAskBudget: number;
  /** The wait after the last ask the budget allows, doubled after every further miss up to `maxBackoffMs`. */
  readonly firstBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly trigger: RefusedSlotTrigger;
}

export const PREDICTED_DEFAULTS: FollowPredictedOptions = {
  earlyRate: 0.25,
  secondEarlyRate: 0.1,
  earlyAskBudget: 3,
  firstBackoffMs: SEGMENT_MS,
  maxBackoffMs: 4_000,
  trigger: { kind: 'time', lateMs: 2 * SEGMENT_MS },
};

/** The step a tracked lag moves on its first update, and the floor it settles to. */
const FIRST_STEP_MS = 400;
const SETTLED_STEP_MS = 40;
const STEP_DECAY = 0.9;
/** An ask made later than this past its planned moment says nothing about whether the plan was early. */
const ON_TIME_MS = 60;
/** The least gap between the two asks planned for one segment step. */
const MIN_RETRY_GAP_MS = 250;
/** Looking past a late slot reads the one slot after it: of 74 refused slots with something behind them, 73 had it at +1. */
const LOOK_PAST: readonly number[] = [1];

/**
 * A quantile of "when a slot becomes readable, minus its newest segment's end", tracked online.
 *
 * Both times are taken as the follower sees them: the segment end on the publisher's clock, the ask
 * on the viewer's. So whatever the two clocks disagree by is inside the lag, and nothing needs the
 * clocks to agree. Each ask made on plan nudges the estimate: a miss moves it later by
 * `(1 - rate) * step`, a hit earlier by `rate * step`, which settles where a fraction `rate` of asks
 * miss. That is the Robbins-Monro quantile estimate, and it needs no window or sort.
 */
class TrackedLag {
  private stepMs = FIRST_STEP_MS;

  constructor(
    public valueMs: number,
    private readonly rate: number,
  ) {}

  record(missed: boolean): void {
    this.valueMs += missed ? (1 - this.rate) * this.stepMs : -this.rate * this.stepMs;
    this.stepMs = Math.max(SETTLED_STEP_MS, this.stepMs * STEP_DECAY);
  }
}

type AskKind = 'first' | 'second' | 'backoff';

interface Ask {
  readonly kind: AskKind;
  /** Which segment after the current entry this ask was planned for: 1 is the next one. */
  readonly step: number;
  readonly onTime: boolean;
  readonly missed: boolean;
}

/**
 * Ask for the next slot when it is predicted to appear, rather than as often as possible.
 *
 * The next playlist follows the next segment's end, so it is predicted as the current entry's newest
 * segment end, plus a segment, plus a learned lag. The first ask goes at a lag that comes too early a
 * quarter of the time, a second at one that rarely does. A slot still missing after both is asked once
 * per segment after that, at the later lag, which is what a coalesced publish looks like: one playlist
 * covering two segments. After a small budget of unanswered asks the follower backs off, so a paused
 * or stalled publisher cannot pile early asks onto one address. A slot that is late is looked past by
 * one, once when it is `lateMs` late and again on every backoff turn, in case the node is refusing it
 * while the publisher has moved on.
 */
export async function followPredicted(
  context: FollowContext,
  options: FollowPredictedOptions = PREDICTED_DEFAULTS,
): Promise<void> {
  const { reader, clock, onEntry, isStopped } = context;
  let current: FeedEntry = context.from;

  // Before any evidence: the entry we start from is readable now and is the newest, so its successor's
  // lag lies within one segment below what this one's lag is at most.
  const sinceStart = clock.now() - current.newestSegmentEndMs;
  const firstLag = new TrackedLag(sinceStart - SEGMENT_MS, options.earlyRate);
  const secondLag = new TrackedLag(sinceStart, options.secondEarlyRate);

  while (!isStopped()) {
    const next = current.index + 1;
    const baseMs = current.newestSegmentEndMs;
    const asks: Ask[] = [];
    let step = 1;
    let kind: AskKind = 'first';
    let backoffMs = options.firstBackoffMs;
    let lastAskMs = -Infinity;
    let lookedPastLate = false;
    let found: FeedEntry | null = null;

    const planFor = (): number => {
      const stepMs = baseMs + step * SEGMENT_MS;
      if (kind === 'backoff') {
        return lastAskMs + backoffMs;
      }
      if (kind === 'first') {
        return stepMs + firstLag.valueMs;
      }
      return Math.max(stepMs + secondLag.valueMs, stepMs + firstLag.valueMs + MIN_RETRY_GAP_MS);
    };

    while (found === null && !isStopped()) {
      const plannedMs = Math.max(planFor(), lastAskMs + MIN_RETRY_GAP_MS);

      const lateLookMs = baseMs + SEGMENT_MS + secondLag.valueMs + lateMsOf(options.trigger);
      if (!lookedPastLate && lateLookMs <= plannedMs) {
        await sleepUntil(context, lateLookMs);
        lookedPastLate = true;
        if (isStopped()) {
          return;
        }
        found = await probeAhead(reader, next, LOOK_PAST);
        continue;
      }

      await sleepUntil(context, plannedMs);
      if (isStopped()) {
        return;
      }
      const askedMs = clock.now();
      lastAskMs = askedMs;
      const read = await reader.read(next);
      if (isStopped()) {
        return;
      }
      asks.push({ kind, step, onTime: askedMs - plannedMs <= ON_TIME_MS, missed: !read.found });
      if (read.found) {
        found = read.entry;
        break;
      }

      const pollsFired: boolean = pollsTriggerFires(options.trigger, asks.length) && !lookedPastLate;
      if (kind === 'backoff' || pollsFired) {
        lookedPastLate = lookedPastLate || pollsFired;
        found = await probeAhead(reader, next, LOOK_PAST);
        if (found !== null) {
          break;
        }
      }

      if (asks.length >= options.earlyAskBudget) {
        if (kind === 'backoff') {
          backoffMs = Math.min(options.maxBackoffMs, backoffMs * 2);
        }
        kind = 'backoff';
      } else if (kind === 'first') {
        kind = 'second';
      } else {
        step += 1;
      }
    }

    if (found === null || isStopped()) {
      return;
    }
    if (found.index === next) {
      learn(asks, Math.round((found.newestSegmentEndMs - baseMs) / SEGMENT_MS), firstLag, secondLag);
    }
    current = found;
    onEntry(found);
  }
}

/**
 * Only asks planned for the segment the found entry actually ended with say anything about the lag.
 * An ask for an earlier step came before that segment existed, which is coalescing, not a wrong lag.
 * A miss says the plan was too early however late the ask went out, but a hit says the plan was late
 * enough only when the ask went out on plan.
 */
function learn(asks: readonly Ask[], foundStep: number, firstLag: TrackedLag, secondLag: TrackedLag): void {
  for (const ask of asks) {
    if (ask.step !== foundStep || (!ask.onTime && !ask.missed)) {
      continue;
    }
    if (ask.kind === 'first') {
      firstLag.record(ask.missed);
    } else if (ask.kind === 'second') {
      secondLag.record(ask.missed);
    }
  }
  if (secondLag.valueMs < firstLag.valueMs + MIN_RETRY_GAP_MS) {
    secondLag.valueMs = firstLag.valueMs + MIN_RETRY_GAP_MS;
  }
}

function lateMsOf(trigger: RefusedSlotTrigger): number {
  return trigger.kind === 'time' ? trigger.lateMs : Infinity;
}

async function sleepUntil(context: FollowContext, atMs: number): Promise<void> {
  const waitMs = atMs - context.clock.now();
  if (waitMs > 0) {
    await context.clock.sleep(waitMs);
  }
}
