import {
  CLOCK_PENDING,
  CLOCK_TRUSTED,
  CLOCK_UNCHECKED,
  CLOCK_UNTRUSTED,
  ClockCheckReport,
  ClockVerdict,
} from '../types.js';
import { describeFailure } from '../utils/transportFailure.js';

import { Clock, systemClock, Timer } from './Clock.js';
import { ClockSample, ClockServer, querySntp } from './sntp.js';

/**
 * How far off the host's clock may be before the uploader refuses to publish windows.
 *
 * A window's address comes from the writer's clock, and a reader asks for it 1 s after the window's end
 * by its own. A quarter of that margin is the plan's ceiling for the writer's share. Phase 0 measured the
 * stage hosts within 2.5 ms of three time servers, so on a host that keeps time this never fires.
 */
export const CLOCK_MAX_ERROR_MS = 250;

/** How long after a round that found the clock trusted, or a first round, the next one starts. */
export const CLOCK_CHECK_INTERVAL_MS = 600_000;

/**
 * How long after a round that did not find the clock trusted the next one starts. Short, so publishing
 * resumes soon after the clock is fixed, and so an unanswered round leaves `/health` soon after the
 * servers answer again.
 */
export const CLOCK_RETRY_INTERVAL_MS = 30_000;

/** How long one server has to answer one query. Every server of a round is asked at once. */
const DEFAULT_QUERY_TIMEOUT_MS = 2_000;

/** What one round found: the verdict, and the answer it was reached on when any server answered. */
interface ClockRound {
  readonly verdict: ClockVerdict;
  readonly estimate?: ClockSample;
  readonly errorBoundMs?: number;
}

/** A round as the check keeps it, with why each server that did not answer did not. */
interface MeasuredRound {
  readonly round: ClockRound;
  readonly failures: readonly string[];
}

interface ClockCheckLogger {
  info(message: string): void;
  warn(message: string): void;
}

interface ClockCheckOptions {
  readonly servers: readonly ClockServer[];
  readonly logger: ClockCheckLogger;
  /** Schedules the rounds. Injected so a test steps ten minutes rather than waiting for them. */
  readonly clock?: Clock;
  /** The wall clock a round's finishing time is reported by. */
  readonly now?: () => number;
  /** One query of one server. Injected so the schedule is tested without a network. */
  readonly query?: (server: ClockServer) => Promise<ClockSample>;
  readonly queryTimeoutMs?: number;
}

/**
 * The verdict of one round. The answer with the shortest round trip is the estimate, and the host's
 * clock is somewhere between `|offset| - delay / 2` and `|offset| + delay / 2` off, because the server
 * read its clock at an unknown point of that round trip.
 *
 * Trusted when even the far end of that range is inside the limit, which is how phase 0's clock tool
 * judged a host. Untrusted only when even the near end is outside it, so a measurement shows the clock
 * off whatever the path. Anything between is unchecked: the answer came too slowly to tell, and a
 * perfect clock behind a congested uplink must not be refused for it.
 *
 * The shortest round trip rather than the smallest offset, because a long round trip is the one whose
 * offset can be wrong by the most, and an estimate chosen by its offset would pick whichever server
 * happened to agree with a clock that is off.
 */
export function judgeClock(samples: readonly ClockSample[]): ClockRound {
  const estimate = [...samples].sort((a, b) => a.delayMs - b.delayMs)[0];
  if (!estimate) {
    return { verdict: CLOCK_UNCHECKED };
  }
  const halfPathMs = Math.max(0, estimate.delayMs) / 2;
  const errorBoundMs = Math.abs(estimate.offsetMs) + halfPathMs;
  if (errorBoundMs <= CLOCK_MAX_ERROR_MS) {
    return { verdict: CLOCK_TRUSTED, estimate, errorBoundMs };
  }
  if (Math.abs(estimate.offsetMs) - halfPathMs > CLOCK_MAX_ERROR_MS) {
    return { verdict: CLOCK_UNTRUSTED, estimate, errorBoundMs };
  }
  return { verdict: CLOCK_UNCHECKED, estimate, errorBoundMs };
}

/**
 * Checks the host's clock against time servers at start and on a schedule, and answers whether windows
 * may be published by it.
 *
 * Only a measured offset refuses. A round no server answered is unchecked: it reports degraded on
 * `/health` with its own reason and does not refuse, because a firewall dropping UDP 123 says nothing
 * about the clock and refusing on it would stop every broadcast on a host whose time is fine. That holds
 * after an untrusted round too: the refusal lasts while a measurement says the clock is off. Before the first round has finished the verdict is pending, which refuses nothing either.
 *
 * Rounds never overlap: the next is scheduled when one has finished, every 10 minutes while the clock
 * is trusted and every 30 s while it is not, or while nothing answers.
 */
export class ClockCheck {
  private readonly clock: Clock;
  private readonly now: () => number;
  private readonly query: (server: ClockServer) => Promise<ClockSample>;
  private timer: Timer | null = null;
  private isStarted = false;
  private isStopped = false;
  private verdict: ClockVerdict = CLOCK_PENDING;
  private lastRound: { readonly finishedAtMs: number; readonly round: ClockRound } | null = null;

  constructor(private readonly options: ClockCheckOptions) {
    this.clock = options.clock ?? systemClock;
    this.now = options.now ?? Date.now;
    const timeoutMs = options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
    this.query = options.query ?? ((server) => querySntp(server, timeoutMs));
  }

  /** Runs the first round now and schedules the rest. A second call does nothing. */
  public start(): void {
    if (this.isStarted || this.isStopped) {
      return;
    }
    this.isStarted = true;
    this.runRound();
  }

  /** Stops the schedule. A round in flight finishes and changes nothing. */
  public stop(): void {
    this.isStopped = true;
    this.timer?.cancel();
    this.timer = null;
  }

  /** What the window writer asks before each write: false only while the last round found the clock off. */
  public isTrusted(): boolean {
    return this.verdict !== CLOCK_UNTRUSTED;
  }

  public report(): ClockCheckReport {
    const estimate = this.lastRound?.round.estimate;
    return {
      verdict: this.verdict,
      checkedAt: this.lastRound ? new Date(this.lastRound.finishedAtMs).toISOString() : null,
      server: estimate?.server ?? null,
      offsetMs: estimate?.offsetMs ?? null,
      delayMs: estimate?.delayMs ?? null,
      errorBoundMs: this.lastRound?.round.errorBoundMs ?? null,
      maxErrorMs: CLOCK_MAX_ERROR_MS,
    };
  }

  private runRound(): void {
    this.timer = null;
    void this.measure().then(({ round, failures }) => {
      if (this.isStopped) {
        return;
      }
      this.record(round, failures);
      const nextInMs = round.verdict === CLOCK_TRUSTED ? CLOCK_CHECK_INTERVAL_MS : CLOCK_RETRY_INTERVAL_MS;
      // Unref'd, because a pending clock check is no reason to keep alive a process that is otherwise ending.
      this.timer = this.clock.setTimer(() => this.runRound(), nextInMs, { unref: true });
    });
  }

  private async measure(): Promise<MeasuredRound> {
    const answers = await Promise.allSettled(this.options.servers.map((server) => this.query(server)));
    return {
      round: judgeClock(answers.flatMap((answer) => (answer.status === 'fulfilled' ? [answer.value] : []))),
      failures: answers.flatMap((answer) => (answer.status === 'rejected' ? [describeFailure(answer.reason)] : [])),
    };
  }

  private record(round: ClockRound, failures: readonly string[]): void {
    const previous = this.verdict;
    this.verdict = round.verdict;
    this.lastRound = { finishedAtMs: this.now(), round };

    const { estimate, errorBoundMs } = round;
    if (!estimate || errorBoundMs === undefined) {
      this.options.logger.warn(
        `[ClockCheck] no time server answered, so the clock is unchecked and publishing goes on. The host must ` +
          `allow outbound UDP 123. Asking again in ${CLOCK_RETRY_INTERVAL_MS / 1_000} s. ${failures.join('. ')}`,
      );
      return;
    }
    // A positive offset is a server ahead of this host, so the host is behind it.
    const direction = estimate.offsetMs >= 0 ? 'behind' : 'ahead of';
    const reading =
      `${Math.abs(estimate.offsetMs).toFixed(1)} ms ${direction} ${estimate.server}, round trip ` +
      `${estimate.delayMs.toFixed(1)} ms, at most ${errorBoundMs.toFixed(1)} ms off against a limit of ${CLOCK_MAX_ERROR_MS} ms`;

    if (round.verdict === CLOCK_UNCHECKED) {
      this.options.logger.warn(
        `[ClockCheck] the round trip was too long to judge the clock: ${reading}. Publishing goes on, ` +
          `asking again in ${CLOCK_RETRY_INTERVAL_MS / 1_000} s`,
      );
    } else if (round.verdict === CLOCK_UNTRUSTED) {
      this.options.logger.warn(
        `[ClockCheck] the host's clock is ${reading}, so publishing windows is refused until it is fixed. ` +
          `Asking again in ${CLOCK_RETRY_INTERVAL_MS / 1_000} s`,
      );
    } else if (previous === CLOCK_UNTRUSTED) {
      this.options.logger.info(`[ClockCheck] the host's clock is ${reading}, so publishing windows resumes`);
    } else if (previous === CLOCK_PENDING) {
      this.options.logger.info(`[ClockCheck] the host's clock is ${reading}`);
    }
  }
}
