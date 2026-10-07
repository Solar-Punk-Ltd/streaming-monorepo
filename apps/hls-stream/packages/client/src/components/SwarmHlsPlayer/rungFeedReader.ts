import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { feedSlotPath } from '@swarm-hls-stream/shared';
import { HLS_M3U } from '@swarm-hls-stream/shared';
import { programDateTimeMs, segmentDuration } from '@swarm-hls-stream/shared';

import type { FeedEntry, FeedRead, FeedReader } from './following/feedReader';
import { type PlayerReader, servedText, type ServedText } from './playerReads';
import { parseManifest } from './playlist';
import { isSlotNotWrittenYet } from './refusedSlot';

/**
 * A slot as the strategies in `following/` see it, worked out from the playlist it carries.
 *
 * The newest segment's end is its PROGRAM-DATE-TIME plus its duration. A playlist that carries no
 * stamp is placed at the moment it was read, on the viewer's clock, which keeps the follower's learned
 * lag meaningful because that lag is only ever a difference between the two.
 */
export function feedEntryOf(index: number, playlist: string, readAtMs: number): FeedEntry {
  const newest = parseManifest(playlist).segments.at(-1);
  const startMs = newest?.programDateTime ? programDateTimeMs(newest.programDateTime) : null;
  const durationS = newest ? segmentDuration(newest.extinf) : null;
  return {
    index,
    newestSegmentEndMs: startMs === null ? readAtMs : startMs + (durationS ?? 0) * 1000,
  };
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
    this.playlists.set(entry, response.text);
    return { found: true, entry };
  }

  /** The playlist an entry this reader returned was read from. */
  playlistOf(entry: FeedEntry): string | undefined {
    return this.playlists.get(entry);
  }
}
