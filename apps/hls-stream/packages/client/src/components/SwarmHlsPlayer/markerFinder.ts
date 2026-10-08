import { FeedIndex, Topic } from '@ethersphere/bee-js';

import { type LadderMarker, markerPeriodAt } from '@swarm-hls-stream/shared';

import type { FollowClock } from './following/feedReader';
import { findNewestFromHint, type SwitchHint } from './following/findNewestFromHint';
import { FeedRung, IndexSearchFinder, NewestIndex, NewestIndexFinder } from './newestIndexFinder';
import { LadderMarkerReads } from './ladderMarkerReads';
import type { PlayerReader } from './playerReads';
import { RungFeedReader } from './rungFeedReader';

/**
 * How long a marker just read serves every rung of its ladder. A switch right after the start, or the
 * end check right after a switch, then costs no second marker read. Short, because a marker only says
 * where a rung stood, and the further that is in the past the wider the round from it has to reach.
 */
export const MARKER_REUSE_MS = 5_000;

/**
 * Finds a rung's newest index from the ladder's time marker (decision 35), and searches as before
 * when there is none.
 *
 * The uploader writes one marker per ladder every ten seconds naming every rung's newest index (see
 * `packages/shared/src/ladderMarker.ts`). The marker of the previous period, `period - 1`, is read once, and
 * `period - 2` once more when that is missing, since the current period's may not be written yet.
 * With an index for the rung, the search from a hint starts there, moved on by the time since the
 * marker was written, which lands in one round. A ladder with no marker, a marker that does not
 * parse, or one that does not name the rung goes to the {@link IndexSearchFinder} unchanged.
 *
 * ⛔ **A marker address is read at most once**, through {@link LadderMarkerReads}, which says why.
 */
export class MarkerFinder implements NewestIndexFinder {
  private last: {
    readonly ladder: string;
    readonly period: number;
    readonly marker: LadderMarker;
    readonly readAtMs: number;
  } | null = null;

  constructor(
    private readonly reader: PlayerReader,
    private readonly clock: FollowClock,
    /** What to add to the viewer's clock to read the gateway's. See `GatewayClock`. */
    private readonly clockOffsetMs: () => number = () => 0,
    private readonly fallback: NewestIndexFinder = new IndexSearchFinder(reader, clock),
    /** Shared with the player's other marker readers, so an address is asked once between them. */
    private readonly reads: LadderMarkerReads = new LadderMarkerReads(reader),
  ) {}

  async findNewest(
    rung: FeedRung,
    hint: SwitchHint | null,
    isStopped: () => boolean = () => false,
  ): Promise<NewestIndex | null> {
    const marker = rung.group && !isStopped() ? await this.markerFor(rung.owner, rung.group) : null;
    if (isStopped()) {
      return null;
    }
    const index = marker?.rungs[rung.topic.toHex()];
    if (marker === null || index === undefined) {
      return this.fallback.findNewest(rung, hint, isStopped);
    }

    const reader = new RungFeedReader(this.reader, rung.owner, rung.topic, this.clock.now, isStopped);
    const { newest } = await findNewestFromHint(reader, this.clock, {
      index,
      // The newest segment of that index ended a little before the marker was written, by the upload's
      // own lag. Close enough to steer a second round, which the first one rarely leaves.
      newestSegmentEndMs: marker.writtenAt,
      seenAtMs: marker.writtenAt - this.clockOffsetMs(),
    });
    const playlist = newest === null ? undefined : reader.playlistOf(newest);
    if (newest === null || playlist === undefined) {
      return null;
    }
    return { index: FeedIndex.fromBigInt(BigInt(newest.index)), playlist };
  }

  /**
   * The newest marker of this ladder there is to read, or null when neither recent period has one.
   *
   * Shared with the player's check that the stream list named every rung, so that check and the start
   * rung's search ask the marker's address once between them.
   */
  async markerFor(owner: string, groupHex: string): Promise<LadderMarker | null> {
    const ladder = `${owner}/${groupHex}`;
    const period = markerPeriodAt(this.clock.now() + this.clockOffsetMs());
    const last = this.last;
    if (
      last !== null &&
      last.ladder === ladder &&
      (last.period === period - 1 || this.clock.now() - last.readAtMs < MARKER_REUSE_MS)
    ) {
      return last.marker;
    }

    const group = new Topic(groupHex);
    for (const wanted of [period - 1, period - 2]) {
      if (wanted < 0) {
        continue;
      }
      let marker: LadderMarker | null;
      try {
        marker = await this.reads.read(owner, group, wanted);
      } catch {
        // A fault, which says nothing about the period before it either.
        return null;
      }
      if (marker !== null) {
        this.last = { ladder, period: wanted, marker, readAtMs: this.clock.now() };
        return marker;
      }
    }
    return null;
  }
}
