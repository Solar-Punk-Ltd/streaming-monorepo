import type { FollowClock } from '../../src/components/SwarmHlsPlayer/following/feedReader';

interface Timer {
  readonly atMs: number;
  readonly order: number;
  readonly fire: () => void;
}

/**
 * Simulated time for strategies written as ordinary async code.
 *
 * Every wait a strategy makes, a sleep or a read, is a timer here. Running pops the earliest timer,
 * moves the clock to it, fires it, and then lets the promise chains it released settle before the
 * next timer, so an async strategy runs in simulated time exactly as it would against real timers,
 * only without waiting. Time is held on the true clock. A viewer whose clock is off sees `now()`
 * shifted by that offset, which is the only thing a wrong clock changes for code that reads one.
 */
export class VirtualTime {
  private nowMs = 0;
  private order = 0;
  private readonly heap: Timer[] = [];

  /** The true time, which only the simulator itself reads. */
  get trueNowMs(): number {
    return this.nowMs;
  }

  /** A clock as a strategy sees it, off from true time by `offsetMs`. */
  clock(offsetMs = 0): FollowClock {
    return {
      now: () => this.nowMs + offsetMs,
      sleep: (ms) => this.delay(ms),
    };
  }

  delay(ms: number): Promise<void> {
    return new Promise((resolve) => this.at(this.nowMs + Math.max(0, ms), resolve));
  }

  /** Fire `fire` at true time `atMs`, or at once if that is already past. */
  at(atMs: number, fire: () => void): void {
    this.push({ atMs: Math.max(atMs, this.nowMs), order: this.order++, fire });
  }

  /** Run every timer due up to `untilMs`, then leave the clock there. */
  async runUntil(untilMs: number): Promise<void> {
    await settle();
    while (this.heap.length > 0 && this.heap[0].atMs <= untilMs) {
      const timer = this.pop();
      this.nowMs = timer.atMs;
      timer.fire();
      await settle();
    }
    this.nowMs = Math.max(this.nowMs, untilMs);
  }

  /** Run until `done` settles, failing rather than spinning if nothing is left to fire within `forMs`. */
  async runToCompletion<T>(done: Promise<T>, forMs = 24 * 3_600_000): Promise<T> {
    const limitMs = this.nowMs + forMs;
    let settled = false;
    let value: T | undefined;
    let failure: unknown = null;
    done.then(
      (result) => {
        settled = true;
        value = result;
      },
      (error: unknown) => {
        settled = true;
        failure = error ?? new Error('rejected');
      },
    );
    await settle();
    while (!settled) {
      if (this.heap.length === 0 || this.heap[0].atMs > limitMs) {
        throw new Error(`nothing left to run at ${this.nowMs} ms and the promise has not settled`);
      }
      const timer = this.pop();
      this.nowMs = timer.atMs;
      timer.fire();
      await settle();
    }
    if (failure !== null) {
      throw failure;
    }
    return value as T;
  }

  private push(timer: Timer): void {
    const heap = this.heap;
    heap.push(timer);
    let child = heap.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (!earlier(heap[child], heap[parent])) {
        break;
      }
      [heap[child], heap[parent]] = [heap[parent], heap[child]];
      child = parent;
    }
  }

  private pop(): Timer {
    const heap = this.heap;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let parent = 0;
      for (;;) {
        const left = parent * 2 + 1;
        const right = left + 1;
        let first = parent;
        if (left < heap.length && earlier(heap[left], heap[first])) {
          first = left;
        }
        if (right < heap.length && earlier(heap[right], heap[first])) {
          first = right;
        }
        if (first === parent) {
          break;
        }
        [heap[first], heap[parent]] = [heap[parent], heap[first]];
        parent = first;
      }
    }
    return top;
  }
}

function earlier(a: Timer, b: Timer): boolean {
  return a.atMs < b.atMs || (a.atMs === b.atMs && a.order < b.order);
}

/** A macrotask turn, which runs every microtask queued before it, however deep the await chain. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
