import { FeedIndex, Topic } from '@ethersphere/bee-js';

import { type LadderMarker, ladderMarkerIdentifier, markerPeriodAt, parseLadderMarker } from '@swarm-hls-stream/shared';

import type { FollowClock } from './following/feedReader';
import { findNewestFromHint, type SwitchHint } from './following/findNewestFromHint';
import { FeedRung, IndexSearchFinder, NewestIndex, NewestIndexFinder } from './newestIndexFinder';
import { type PlayerReader, servedText } from './playerReads';
import { isSlotNotWrittenYet } from './refusedSlot';
import { RungFeedReader } from './rungFeedReader';

/**
 * How long a marker just read serves every rung of its ladder. A switch right after the start, or the
 * end check right after a switch, then costs no second marker read. Short, because a marker only says
 * where a rung stood, and the further that is in the past the wider the round from it has to reach.
 */
export const MARKER_REUSE_MS = 5_000;

/** Marker addresses remembered as missing, far more than one session's start and switches visit. */
const MISSING_REMEMBERED = 64;

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
 * ⛔ **A marker address is read at most once.** A marker is never rewritten, so one found missing or
 * malformed stays so, and asking again would put early asks on one address, which Bee answers by
 * skipping peers for it. A gateway fault is not remembered, since the next ask may well be answered.
 */
export class MarkerFinder implements NewestIndexFinder {
  private readonly missing = new Set<string>();
  private readonly inFlight = new Map<string, Promise<LadderMarker | null>>();
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
      segmentMs: marker.segmentMs,
      seenAtMs: marker.writtenAt - this.clockOffsetMs(),
    });
    const playlist = newest === null ? undefined : reader.playlistOf(newest);
    if (newest === null || playlist === undefined) {
      return null;
    }
    return { index: FeedIndex.fromBigInt(BigInt(newest.index)), playlist };
  }

  /** The newest marker of this ladder there is to read, or null when neither recent period has one. */
  private async markerFor(owner: string, groupHex: string): Promise<LadderMarker | null> {
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
      const identifier = ladderMarkerIdentifier(group, wanted).toHex();
      const address = `${owner}/${identifier}`;
      if (this.missing.has(address)) {
        continue;
      }
      let read = this.inFlight.get(address);
      if (read === undefined) {
        read = this.readMarker(owner, identifier, wanted).finally(() => this.inFlight.delete(address));
        this.inFlight.set(address, read);
      }
      const marker = await read;
      if (marker !== null) {
        this.last = { ladder, period: wanted, marker, readAtMs: this.clock.now() };
        return marker;
      }
      if (!this.missing.has(address)) {
        // A fault, which says nothing about the period before it either.
        return null;
      }
    }
    return null;
  }

  /** One marker read. Null for a fault as well as for a marker missing or malformed, which alone are remembered. */
  private async readMarker(owner: string, identifier: string, period: number): Promise<LadderMarker | null> {
    const address = `${owner}/${identifier}`;
    let text: string;
    try {
      text = (await servedText(this.reader.readSoc(owner, identifier), `soc/${address}`)).text;
    } catch (error) {
      if (isSlotNotWrittenYet(error)) {
        this.rememberMissing(address);
      }
      return null;
    }
    const marker = parseLadderMarker(text, period);
    if (marker === null) {
      this.rememberMissing(address);
    }
    return marker;
  }

  private rememberMissing(address: string): void {
    this.missing.add(address);
    if (this.missing.size > MISSING_REMEMBERED) {
      const oldest = this.missing.values().next().value;
      if (oldest !== undefined) {
        this.missing.delete(oldest);
      }
    }
  }
}
