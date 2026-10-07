import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { makeFeedIdentifier } from '@swarm-hls-stream/shared';

import type { NewestIndexFinder } from '../../src/components/SwarmHlsPlayer/newestIndexFinder.js';
import { ManifestFetchError } from '../../src/components/SwarmHlsPlayer/refusedSlot.js';
import { TimedResponse } from '../../src/utils/fetchWithTimeout.js';

import type { VirtualTime } from '../feedModel/virtualTime.js';

const SEGMENT_MS = 2_000;
const WINDOW_SEGMENTS = 5;
/** Slot addresses worked out ahead for each feed, far more than a test reaches. */
const SLOTS_PER_FEED = 2_000;

interface TimedFeedShape {
  /** True time after a segment's end at which its playlist becomes readable. */
  readonly lagMs: number;
  /** The publisher writes nothing past this index. */
  readonly stopsAfter?: number;
  /** True time before which this feed holds nothing, for a feed that starts late or is behind its siblings. */
  readonly startsAtMs?: number;
}

interface TimedFeed {
  readonly topic: Topic;
  readonly name: string;
  shape: TimedFeedShape;
}

export interface TimedRead {
  readonly rung: string;
  readonly index: number;
  readonly atMs: number;
  readonly found: boolean;
}

/**
 * A gateway on simulated time serving live feeds that gain one index every two seconds, each readable
 * `lagMs` after its newest segment ends, every read answered after `roundTripMs`. Whether a slot is
 * there is decided when the read arrives. The publisher's clock is the simulated one, so a playlist's
 * PROGRAM-DATE-TIME stamps sit exactly where the slot's timing puts them.
 */
export class TimedGateway {
  readonly reads: TimedRead[] = [];
  private readonly feeds = new Map<string, TimedFeed>();
  private readonly slots = new Map<string, { hex: string; index: number }>();

  constructor(
    private readonly time: VirtualTime,
    readonly owner: string,
    private readonly roundTripMs: number,
  ) {}

  addFeed(topic: Topic, name: string, shape: TimedFeedShape): void {
    const hex = topic.toString();
    this.feeds.set(hex, { topic, name, shape });
    for (let index = 0; index < SLOTS_PER_FEED; index++) {
      this.slots.set(this.slotPath(topic, index), { hex, index });
    }
  }

  /** Stops a feed after the index it holds now. */
  stop(topic: Topic): number {
    const feed = this.feedOf(topic.toString());
    const last = this.newestAt(topic, this.time.trueNowMs);
    feed.shape = { ...feed.shape, stopsAfter: last };
    return last;
  }

  slotPath(topic: Topic, index: number): string {
    return `soc/${this.owner}/${makeFeedIdentifier(topic, FeedIndex.fromBigInt(BigInt(index))).toString()}`;
  }

  /** When an index becomes readable, on true time. */
  readableAtMs(topic: Topic, index: number): number {
    const { shape } = this.feedOf(topic.toString());
    if (index < 0 || index > (shape.stopsAfter ?? Infinity)) {
      return Infinity;
    }
    return Math.max(index * SEGMENT_MS + shape.lagMs, shape.startsAtMs ?? -Infinity);
  }

  newestAt(topic: Topic, atMs: number): number {
    let newest = -1;
    while (this.readableAtMs(topic, newest + 1) <= atMs) {
      newest += 1;
    }
    return newest;
  }

  readsOf(topic: Topic): TimedRead[] {
    return this.reads.filter((read) => read.rung === topic.toString());
  }

  /** Asks for an index before it was readable, per index. */
  earlyAsks(topic: Topic): Map<number, number> {
    const early = new Map<number, number>();
    for (const read of this.readsOf(topic)) {
      if (!read.found && Number.isFinite(this.readableAtMs(topic, read.index))) {
        early.set(read.index, (early.get(read.index) ?? 0) + 1);
      }
    }
    return early;
  }

  /** The playlist at `index`: the window of segments ending with segment `index`, stamped on simulated time. */
  playlistAt(index: number, name: string): string {
    const first = Math.max(0, index - WINDOW_SEGMENTS + 1);
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${first}`];
    for (let sequence = first; sequence <= index; sequence++) {
      // Segment `sequence` ends at `sequence * SEGMENT_MS`, so slot `index` is due once segment `index` has ended.
      const startMs = (sequence - 1) * SEGMENT_MS;
      lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(startMs).toISOString()}`, '#EXTINF:2.0,', `${name}-${sequence}`);
    }
    return lines.join('\n');
  }

  fetchResource = (path: string): Promise<TimedResponse> => {
    const slot = this.slots.get(path);
    if (!slot) {
      return Promise.reject(new ManifestFetchError(path, 404));
    }
    const feed = this.feedOf(slot.hex);
    const askedAtMs = this.time.trueNowMs;
    const found = this.readableAtMs(feed.topic, slot.index) <= askedAtMs;
    this.reads.push({ rung: slot.hex, index: slot.index, atMs: askedAtMs, found });
    return new Promise((resolve, reject) => {
      this.time.at(askedAtMs + this.roundTripMs, () => {
        if (found) {
          resolve({ ok: true, status: 200, headers: new Headers(), text: this.playlistAt(slot.index, feed.name) });
        } else {
          reject(new ManifestFetchError(path, 404));
        }
      });
    });
  };

  /**
   * A finder that knows the head without searching, reading only the newest slot. For a case about
   * following, so the search's own reads do not blur what the follower asked.
   */
  knownHeadFinder(): NewestIndexFinder {
    return {
      findNewest: async (rung) => {
        const head = this.newestAt(rung.topic, this.time.trueNowMs);
        if (head < 0) {
          return null;
        }
        const response = await this.fetchResource(this.slotPath(rung.topic, head));
        return { index: FeedIndex.fromBigInt(BigInt(head)), playlist: response.text };
      },
    };
  }

  private feedOf(hex: string): TimedFeed {
    const feed = this.feeds.get(hex);
    if (!feed) {
      throw new Error(`no feed for ${hex}`);
    }
    return feed;
  }
}
