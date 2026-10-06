import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  WINDOW_CLOCK_JUMP_TOLERANCE_MS,
  WINDOW_CLOCK_LIMIT_MS,
  WINDOW_CLOCK_SAFETY_STEP_MS,
  WINDOW_CLOCK_SHRINK_AFTER_FOUND,
  WINDOW_CLOCK_WRITER_MISS_CAP_MS,
  WINDOW_WRITE_SLACK_MS,
  WindowClock,
} from '../src/windowClock.js';
import { WINDOW_READ_MARGIN_MS } from '../src/windows.js';

const STEP = WINDOW_CLOCK_SAFETY_STEP_MS;
const MARGIN = WINDOW_READ_MARGIN_MS;
const FIRST_END = 1_793_793_604_000;
const WINDOW_MS = 2000;

/** Each ask is for the next 2 s window, so the reader's clock moves on as it would. */
let windowsAsked = 0;
const nextEnd = (): number => FIRST_END + WINDOW_MS * windowsAsked++;

/**
 * A found ask made `correction` after its base due time, answered `ageAtAnswer` after its write by
 * the reader's clock, which is the offset plus the true age.
 */
function foundAt(clock: WindowClock, correction: number, ageAtAnswer = 400): void {
  const end = nextEnd();
  const askedAt = end + MARGIN + correction;
  clock.found({ askedAt, receivedAt: askedAt + 100, windowEnd: end, writtenAt: askedAt + 100 - ageAtAnswer });
}

function absentAt(clock: WindowClock, correction: number): ReturnType<WindowClock['absent']> {
  const end = nextEnd();
  return clock.absent({ askedAt: end + MARGIN + correction, windowEnd: end });
}

/**
 * Drives a clock against a reader clock running `aheadMs` ahead, with a chunk readable `readableMs`
 * after its window's end: each step asks at the current correction and reports what Bee would say.
 */
function converge(aheadMs: number, readableMs = 300, steps = 60): { early: number; clock: WindowClock } {
  const clock = new WindowClock();
  let early = 0;
  const ask = (correction: number): void => {
    // The ask happens `MARGIN + correction` after the end by the reader's clock, so `aheadMs` less in true time.
    const trueLateness = MARGIN + correction - aheadMs;
    if (trueLateness >= readableMs) {
      foundAt(clock, correction, aheadMs + trueLateness);
    } else {
      early += 1;
      absentAt(clock, correction);
    }
  };
  // The opening: the newest due window and the three before it, one window apart.
  for (let k = 0; k < 4; k++) {
    ask(k * 2000);
  }
  for (let step = 0; step < steps; step++) {
    ask(clock.correctionMs);
  }
  return { early, clock };
}

describe('WindowClock', () => {
  it('starts by trusting the reader clock, with nothing known', () => {
    const clock = new WindowClock();
    assert.equal(clock.correctionMs, 0);
    assert.equal(clock.aheadAtMost, Infinity);
    assert.equal(clock.aheadMoreThan, -Infinity);
    assert.equal(clock.settled, false);
  });

  it('takes the smallest received minus written as how far ahead the reader can be at most', () => {
    const clock = new WindowClock();
    foundAt(clock, 0, 900);
    foundAt(clock, 0, 600);
    foundAt(clock, 0, 1200);
    assert.equal(clock.aheadAtMost, 600);
  });

  it('takes an absent window as a lower bound, its ask less the write slack', () => {
    const clock = new WindowClock();
    assert.equal(absentAt(clock, 0), 'clock');
    assert.equal(clock.aheadMoreThan, MARGIN - WINDOW_WRITE_SLACK_MS);
  });

  it('never lets the correction sit below the lower bound plus a safety step', () => {
    const clock = new WindowClock();
    absentAt(clock, 4000);
    // In the reader clock's own terms the correction is at least the lower bound plus a step.
    assert.ok(clock.correctionMs >= clock.aheadMoreThan + STEP);
  });

  it('bisects between the bounds and settles above a clock 3 s ahead in a handful of asks', () => {
    const { early, clock } = converge(3000, 300, 20);
    assert.ok(clock.settled, 'settled');
    assert.ok(early <= 3, `early asks ${early}`);
    // Safe: the ask lands after the chunk is readable. Close: no more than about a second late.
    assert.ok(MARGIN + clock.correctionMs - 3000 >= 300, `correction ${clock.correctionMs}`);
    assert.ok(MARGIN + clock.correctionMs - 3000 <= 1500, `correction ${clock.correctionMs}`);
  });

  it('settles above a clock 5 minutes ahead from a found window far back, with few early asks', () => {
    const clock = new WindowClock();
    absentAt(clock, 250_000);
    foundAt(clock, 500_000, 300_000 + 201_000);
    let early = 0;
    for (let step = 0; step < 120; step++) {
      const correction = clock.correctionMs;
      const trueLateness = MARGIN + correction - 300_000;
      if (trueLateness >= 300) {
        foundAt(clock, correction, 300_000 + trueLateness);
      } else {
        if (trueLateness > -60_000) {
          early += 1;
        }
        absentAt(clock, correction);
      }
    }
    assert.ok(clock.settled);
    assert.ok(early <= 4, `harmful early asks ${early}`);
    assert.ok(MARGIN + clock.correctionMs - 300_000 >= 300);
    assert.ok(MARGIN + clock.correctionMs - 300_000 <= 1500, `correction ${clock.correctionMs}`);
  });

  it('shrinks with evidence, one step per run of found windows, never below the last early ask', () => {
    const clock = new WindowClock();
    absentAt(clock, 2000);
    foundAt(clock, 3000);
    const settledAt = clock.correctionMs;
    assert.ok(clock.settled);
    for (let i = 0; i < WINDOW_CLOCK_SHRINK_AFTER_FOUND; i++) {
      foundAt(clock, clock.correctionMs);
    }
    assert.ok(
      clock.correctionMs <= settledAt - STEP || clock.correctionMs === 2000 + MARGIN - WINDOW_WRITE_SLACK_MS + STEP,
    );
    for (let i = 0; i < 20 * WINDOW_CLOCK_SHRINK_AFTER_FOUND; i++) {
      foundAt(clock, clock.correctionMs);
    }
    assert.equal(clock.correctionMs, 2000 + MARGIN - WINDOW_WRITE_SLACK_MS + STEP);
  });

  it('drifts an accurate clock back to zero and no further', () => {
    const clock = new WindowClock();
    foundAt(clock, 0);
    for (let i = 0; i < 5 * WINDOW_CLOCK_SHRINK_AFTER_FOUND; i++) {
      foundAt(clock, clock.correctionMs);
    }
    assert.equal(clock.correctionMs, 0);
  });

  it('moves one safety step for each absent window the clock cannot explain, up to a cap', () => {
    const clock = new WindowClock();
    for (let i = 0; i < 5; i++) {
      foundAt(clock, 0);
    }
    assert.equal(absentAt(clock, 0), 'writer');
    assert.equal(clock.correctionMs, STEP);
    for (let i = 0; i < 20; i++) {
      foundAt(clock, clock.correctionMs);
    }
    assert.equal(clock.correctionMs, STEP, 'it does not shrink back under the miss');
    assert.equal(absentAt(clock, STEP), 'writer');
    assert.equal(absentAt(clock, 2 * STEP), 'writer');
    assert.equal(absentAt(clock, 2 * STEP), 'writer');
    assert.equal(clock.correctionMs, WINDOW_CLOCK_WRITER_MISS_CAP_MS, 'a run of misses stops at the cap');
  });

  it('caps how far writer misses can raise the correction above the best found ask', () => {
    const clock = new WindowClock();
    foundAt(clock, 0);
    for (let i = 0; i < 10; i++) {
      absentAt(clock, clock.correctionMs);
      foundAt(clock, clock.correctionMs);
    }
    assert.ok(clock.correctionMs <= WINDOW_CLOCK_WRITER_MISS_CAP_MS, `correction ${clock.correctionMs}`);
  });

  it('keeps the correction within its limit', () => {
    const clock = new WindowClock();
    absentAt(clock, 20 * 60_000);
    assert.equal(clock.correctionMs, WINDOW_CLOCK_LIMIT_MS);
    const behind = new WindowClock();
    behind.checkTimer({ epoch: behind.epoch, expectedMs: 2000, elapsedMs: 2000 - 20 * 60_000 });
    assert.equal(behind.correctionMs, -WINDOW_CLOCK_LIMIT_MS);
  });

  it('ignores timer slack within the tolerance', () => {
    const clock = new WindowClock();
    const jump = clock.checkTimer({
      epoch: clock.epoch,
      expectedMs: 2000,
      elapsedMs: 2000 + WINDOW_CLOCK_JUMP_TOLERANCE_MS,
    });
    assert.deepEqual(jump, { kind: 'none' });
    assert.equal(clock.correctionMs, 0);
  });

  it('shifts everything by a backward jump, once, however many readers see it', () => {
    const clock = new WindowClock();
    foundAt(clock, 0);
    const epoch = clock.epoch;
    const first = clock.checkTimer({ epoch, expectedMs: 2000, elapsedMs: 2000 - 10_000 });
    assert.deepEqual(first, { kind: 'backward', ms: -10_000 });
    assert.equal(clock.correctionMs, -10_000);
    const second = clock.checkTimer({ epoch, expectedMs: 10_000, elapsedMs: 10_000 - 10_000 });
    assert.deepEqual(second, { kind: 'backward', ms: -10_000 });
    assert.equal(clock.correctionMs, -10_000, 'the second reader does not shift it again');
  });

  it('keeps the correction on a forward gap, which a sleep and a jump both cause, and opens the bracket upward', () => {
    const clock = new WindowClock();
    foundAt(clock, 0, 400);
    const jump = clock.checkTimer({ epoch: clock.epoch, expectedMs: 2000, elapsedMs: 12_000 });
    assert.deepEqual(jump, { kind: 'forward', ms: 10_000 });
    assert.equal(clock.correctionMs, 0);
    assert.equal(clock.aheadAtMost, 10_400);
    // Absent at the old correction now reads as the clock having stepped forward, not as a writer miss.
    assert.equal(absentAt(clock, 0), 'clock');
    assert.ok(clock.correctionMs > STEP);
  });
});
