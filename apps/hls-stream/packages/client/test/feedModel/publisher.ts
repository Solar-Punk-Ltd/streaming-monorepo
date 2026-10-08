import type { FeedEntry } from '../../src/components/SwarmHlsPlayer/following/feedReader';

import type { Random } from './random';

export const SEGMENT_MS = 2_000;
/** Publishes are sequential, so a slot is never readable before the one before it. */
const SEQUENTIAL_GAP_MS = 20;
/** At most this many segments fold into one playlist, which bounds a run of coalesced publishes. */
const MAX_COALESCED = 5;

/** A break between two sessions of one broadcast, after which each feed continues from its own head. */
export interface Pause {
  readonly afterSlot: number;
  readonly lengthMs: number;
}

interface QualityFeedOptions {
  readonly random: Random;
  readonly slots: number;
  /** True time at which slot 0's newest segment ends. */
  readonly startMs: number;
  /** The chance that a segment's publish is folded into the next one's. */
  readonly coalescing: number;
  /** True time from a slot's newest segment end to it being readable, this quality's own. */
  readonly lagMs: number;
  /** The standard deviation of that lag from slot to slot. */
  readonly jitterMs: number;
  /** How far this quality's PROGRAM-DATE-TIME runs ahead of true time. */
  readonly pdtOffsetMs: number;
  readonly pauses: readonly Pause[];
}

/**
 * One quality feed, built in full up front: when each slot's newest segment ends, on the publisher's
 * clock, and when the slot becomes readable on a node, in true time.
 */
export class QualityFeed {
  readonly segmentEndMs: Float64Array;
  readonly readableAtMs: Float64Array;

  constructor(options: QualityFeedOptions) {
    const { random, slots } = options;
    this.segmentEndMs = new Float64Array(slots);
    this.readableAtMs = new Float64Array(slots);
    const pauses = new Map(options.pauses.map((pause) => [pause.afterSlot, pause.lengthMs]));

    let segmentEnd = options.startMs - SEGMENT_MS;
    let previousReadable = -Infinity;
    for (let slot = 0; slot < slots; slot += 1) {
      segmentEnd += SEGMENT_MS + (pauses.get(slot - 1) ?? 0);
      for (let folded = 0; folded < MAX_COALESCED && random.chance(options.coalescing); folded += 1) {
        segmentEnd += SEGMENT_MS;
      }
      const readable = Math.max(
        segmentEnd + options.lagMs + options.jitterMs * random.normal(),
        segmentEnd + 100,
        previousReadable + SEQUENTIAL_GAP_MS,
      );
      this.segmentEndMs[slot] = segmentEnd + options.pdtOffsetMs;
      this.readableAtMs[slot] = readable;
      previousReadable = readable;
    }
  }

  get length(): number {
    return this.readableAtMs.length;
  }

  readableAt(index: number): number {
    return index < 0 || index >= this.length ? Infinity : this.readableAtMs[index];
  }

  entry(index: number): FeedEntry {
    return { index, newestSegmentEndMs: this.segmentEndMs[index], segmentMs: SEGMENT_MS };
  }

  /** The newest slot readable at true time `atMs`, or -1. */
  newestAt(atMs: number): number {
    let low = -1;
    let high = this.length;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (this.readableAtMs[middle] <= atMs) {
        low = middle;
      } else {
        high = middle;
      }
    }
    return low;
  }
}

/**
 * Pauses for a feed `slots` long that has been running for days: sessions of one to three hours, with
 * breaks of ten minutes to twelve hours between them. None falls in the last `liveSlots`, so the feed
 * is live at its end.
 */
export function historyPauses(random: Random, slots: number, liveSlots: number): Pause[] {
  const pauses: Pause[] = [];
  let slot = Math.round(random.uniform(1_800, 5_400));
  while (slot < slots - liveSlots) {
    pauses.push({ afterSlot: slot, lengthMs: random.uniform(600_000, 43_200_000) });
    slot += Math.round(random.uniform(1_800, 5_400));
  }
  return pauses;
}
