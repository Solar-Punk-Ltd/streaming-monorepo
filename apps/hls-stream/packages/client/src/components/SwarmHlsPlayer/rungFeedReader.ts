import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { feedSlotPath } from '@swarm-hls-stream/shared';
import { HLS_M3U, HLS_TARGET_DURATION } from '@swarm-hls-stream/shared';
import { programDateTimeMs, segmentDuration } from '@swarm-hls-stream/shared';

import type { FeedEntry, FeedRead, FeedReader } from './following/feedReader';
import { type PlayerReader, servedText, type ServedText } from './playerReads';
import { parseManifest } from './playlist';
import { isSlotNotWrittenYet } from './refusedSlot';

/**
 * A slot as the strategies in `following/` see it, worked out from the playlist it carries, or null for
 * a playlist that names no segment length, which nothing could follow.
 *
 * The newest segment's end is its PROGRAM-DATE-TIME plus its duration. A playlist that carries no
 * stamp is placed at the moment it was read, on the viewer's clock, which keeps the follower's learned
 * lag meaningful because that lag is only ever a difference between the two.
 */
export function feedEntryOf(index: number, playlist: string, readAtMs: number): FeedEntry | null {
  const { headers, segments } = parseManifest(playlist);
  const segmentMs = segmentLengthMs(
    segments.map((segment) => segmentDuration(segment.extinf)),
    headers,
  );
  if (segmentMs === null) {
    return null;
  }
  const newest = segments.at(-1);
  const startMs = newest?.programDateTime ? programDateTimeMs(newest.programDateTime) : null;
  const durationS = newest ? segmentDuration(newest.extinf) : null;
  return {
    index,
    newestSegmentEndMs: startMs === null ? readAtMs : startMs + (durationS ?? 0) * 1000,
    segmentMs,
  };
}

/**
 * The median of the segments' own durations, so one segment cut short by a reconnect does not move
 * it. The target duration only answers when no segment names a usable length: the uploader writes the
 * longest segment so far rounded up, and never lowers it, so it is a ceiling rather than the cadence.
 */
function segmentLengthMs(durationsS: readonly (number | null)[], headers: readonly string[]): number | null {
  const usable = durationsS.filter((duration): duration is number => duration !== null && duration > 0);
  if (usable.length > 0) {
    const sorted = [...usable].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const medianS = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    return Math.round(medianS * 1000);
  }
  const target = headers.find((line) => line.startsWith(`${HLS_TARGET_DURATION}:`));
  const targetS = target === undefined ? Number.NaN : Number(target.slice(HLS_TARGET_DURATION.length + 1));
  return Number.isFinite(targetS) && targetS > 0 ? targetS * 1000 : null;
}

/**
 * Reads one rung's feed slot by slot for the strategies in `following/`.
 *
 * A slot not written yet is `found: false`, as those strategies expect, and so is an answer that is
 * not a playlist. Anything else that fails, a transport error or a 5xx, is a fault of the gateway and
 * is thrown, for the caller to back off.
 * The playlist each found entry came from is kept beside it, so whoever is handed the entry can fold
 * the playlist in without reading the slot again.
 */
export class RungFeedReader implements FeedReader {
  private readonly playlists = new WeakMap<FeedEntry, string>();

  constructor(
    private readonly reader: PlayerReader,
    private readonly owner: string,
    private readonly topic: Topic,
    private readonly now: () => number,
    /** Once true, every read answers as a slot not written yet without asking, so a search ends quietly. */
    private readonly isStopped: () => boolean = () => false,
  ) {}

  async read(index: number): Promise<FeedRead> {
    if (this.isStopped()) {
      return { found: false };
    }
    let response: ServedText;
    try {
      response = await servedText(
        this.reader.readFeedEntry(this.owner, this.topic, index),
        feedSlotPath(this.owner, this.topic, FeedIndex.fromBigInt(BigInt(index))),
      );
    } catch (error) {
      if (isSlotNotWrittenYet(error)) {
        return { found: false };
      }
      throw error;
    }
    // A 200 that is not a playlist, a captive portal's page or a chunk that is not this feed's, would
    // otherwise be taken as an empty slot and handed to hls.js.
    if (!response.text.trimStart().startsWith(HLS_M3U)) {
      return { found: false };
    }
    const entry = feedEntryOf(index, response.text, this.now());
    if (entry === null) {
      return { found: false };
    }
    this.playlists.set(entry, response.text);
    return { found: true, entry };
  }

  /** The playlist an entry this reader returned was read from. */
  playlistOf(entry: FeedEntry): string | undefined {
    return this.playlists.get(entry);
  }
}
