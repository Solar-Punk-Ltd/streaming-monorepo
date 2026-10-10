import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { makeFeedIdentifier } from '@swarm-hls-stream/shared';
import { ladderMarkerIdentifier } from '@swarm-hls-stream/shared';

import type { PlayerReader } from '../../src/components/SwarmHlsPlayer/playerReads.js';
import { ManifestFetchError } from '../../src/components/SwarmHlsPlayer/refusedSlot.js';
import type { PathResponse } from './playerReader';

import { readerOverPaths } from './playerReader.js';

/** The instant every fake ladder's first segment is stamped with. */
export const LADDER_EPOCH_MS = Date.UTC(2026, 9, 7, 12, 0, 0);

/** Every fake segment is this long, the event's own cut. */
export const SEGMENT_S = 2;

/** How many segments one published playlist names, a short stand-in for the uploader's minute. */
export const WINDOW_SEGMENTS = 5;

interface PlaylistShape {
  name: string;
  firstSequence: number;
  count: number;
  /** When the first segment was presented. */
  startMs: number;
  finalized?: boolean;
}

/** A media playlist in the shape the uploader publishes, every segment stamped with its instant. */
export function ladderPlaylist({ name, firstSequence, count, startMs, finalized = false }: PlaylistShape): string {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${SEGMENT_S}`,
    `#EXT-X-MEDIA-SEQUENCE:${firstSequence}`,
  ];
  for (let i = 0; i < count; i++) {
    lines.push(
      `#EXT-X-PROGRAM-DATE-TIME:${new Date(startMs + i * SEGMENT_S * 1000).toISOString()}`,
      `#EXTINF:${SEGMENT_S}.0,`,
      `${name}-seg-${firstSequence + i}`,
    );
  }
  if (finalized) {
    lines.push('#EXT-X-ENDLIST');
  }
  return lines.join('\n');
}

interface FeedShape {
  /** Added to every index to give the sequence of its newest segment, so two rungs can disagree on indexes. */
  sequenceOffset?: number;
  /** Shifts every stamp, for a rung whose clock runs behind its siblings'. */
  stampShiftMs?: number;
}

interface FakeFeed {
  head: number;
  slots: Map<number, string>;
  shape: Required<FeedShape>;
  name: string;
}

/**
 * A gateway holding several feeds, serving each feed's head and slots and refusing the rest with a
 * 404, the way a live feed looks: the next index does not exist yet, and then it does.
 *
 * Every request is logged with the rung it was for, so a test can count reads per rung rather than
 * per path, since a slot's path is a hash that names no topic.
 */
export class FakeLadderGateway {
  readonly requests: { path: string; rung: string | null; kind: 'head' | 'slot' | 'other' }[] = [];
  private readonly feeds = new Map<string, FakeFeed>();
  private readonly slotOwners = new Map<string, { hex: string; index: number }>();
  private readonly faulted = new Set<string>();
  private readonly markers = new Map<string, string>();
  private skipList: { peers: number; skipMs: number; now: () => number } | null = null;
  /** Per path, until when each skipped peer stays skipped. */
  private readonly skippedUntil = new Map<string, number[]>();

  constructor(readonly owner: string) {}

  /** Reads of this slot fail in transport, as a gateway that drops the connection does. */
  faultSlot(topic: Topic, index: number): void {
    this.faulted.add(this.slotPath(topic, index));
  }

  /**
   * Answer from now on as a Bee node answers an address asked before it exists (Bee 2.8.2,
   * `pkg/retrieval/retrieval.go`): each such ask puts one of `peers` peers on a skip list for that
   * address for `skipMs` of `now`, and with every peer skipped the address answers not found at once,
   * written or not.
   */
  modelSkipList(peers: number, skipMs: number, now: () => number): void {
    this.skipList = { peers, skipMs, now };
  }

  /** Writes a ladder's time marker for `period`, at the address a reader computes. */
  publishMarker(group: Topic, period: number, marker: string): void {
    this.markers.set(`soc/${this.owner}/${ladderMarkerIdentifier(group, period).toHex()}`, marker);
  }

  /** Reads of the ladder's time markers, by path. */
  markerRequests(): string[] {
    return this.requests.filter((request) => this.markers.has(request.path)).map((request) => request.path);
  }

  /** The rung name a hex topic was published under. */
  nameOf(hex: string): string | null {
    return this.feeds.get(hex)?.name ?? null;
  }

  /**
   * Publishes indexes `0..head` of a live feed, each one a window ending at the segment its index
   * names. Calling again publishes up to a new head and keeps what was there.
   */
  publishLive(topic: Topic, name: string, head: number, shape: FeedShape = {}): void {
    const hex = topic.toString();
    const feed = this.feeds.get(hex) ?? {
      head: -1,
      slots: new Map<number, string>(),
      shape: { sequenceOffset: shape.sequenceOffset ?? 0, stampShiftMs: shape.stampShiftMs ?? 0 },
      name,
    };
    this.feeds.set(hex, feed);
    for (let index = feed.head + 1; index <= head; index++) {
      this.publishSlot(topic, index, this.windowAt(feed, index));
    }
  }

  /** The playlist a live feed of this shape carries at `index`. */
  windowAt(feed: FakeFeed, index: number, finalized = false): string {
    const newest = index + feed.shape.sequenceOffset;
    const firstSequence = Math.max(0, newest - WINDOW_SEGMENTS + 1);
    return ladderPlaylist({
      name: feed.name,
      firstSequence,
      count: newest - firstSequence + 1,
      startMs: LADDER_EPOCH_MS + firstSequence * SEGMENT_S * 1000 + feed.shape.stampShiftMs,
      finalized,
    });
  }

  /** Publishes the next index of a live feed, finished when `finalized`. */
  publishNext(topic: Topic, finalized = false): number {
    const feed = this.feedOf(topic);
    const index = feed.head + 1;
    this.publishSlot(topic, index, this.windowAt(feed, index, finalized));
    return index;
  }

  /** Rewrites the newest index of a live feed as finished, as the uploader's last write does. */
  finishHead(topic: Topic): void {
    const feed = this.feedOf(topic);
    this.publishSlot(topic, feed.head, this.windowAt(feed, feed.head, true));
  }

  publishSlot(topic: Topic, index: number, body: string): void {
    const hex = topic.toString();
    const feed = this.feeds.get(hex) ?? {
      head: -1,
      slots: new Map<number, string>(),
      shape: { sequenceOffset: 0, stampShiftMs: 0 },
      name: hex,
    };
    this.feeds.set(hex, feed);
    feed.slots.set(index, body);
    feed.head = Math.max(feed.head, index);
    // Indexes well past the head are mapped too, so an ask for one not written yet is still counted
    // against its rung.
    for (let ahead = index; ahead <= index + 64; ahead++) {
      this.slotOwners.set(this.slotPath(topic, ahead), { hex, index: ahead });
    }
  }

  head(topic: Topic): number {
    return this.feedOf(topic).head;
  }

  slotPath(topic: Topic, index: number): string {
    return `soc/${this.owner}/${makeFeedIdentifier(topic, FeedIndex.fromBigInt(BigInt(index))).toString()}`;
  }

  /** Reads made for one rung, by hex topic. */
  requestsFor(hex: string): { path: string; kind: 'head' | 'slot' | 'other' }[] {
    return this.requests.filter((request) => request.rung === hex);
  }

  /** The index a slot read asked for, or null for any other read. */
  slotIndexOf(path: string): number | null {
    return this.slotOwners.get(path)?.index ?? null;
  }

  /** The player's reads, answered by {@link answerPath}. */
  readonly reader: PlayerReader = readerOverPaths((path) => this.answerPath(path));

  answerPath = async (path: string): Promise<PathResponse> => {
    const head = /^feeds\/[^/]+\/([0-9a-f]+)$/.exec(path);
    if (head) {
      const hex = head[1];
      this.requests.push({ path, rung: hex, kind: 'head' });
      const feed = this.feeds.get(hex);
      if (!feed || feed.head < 0) {
        throw new ManifestFetchError(path, 404);
      }
      const headers = new Headers({ 'Swarm-Feed-Index': feed.head.toString(16).padStart(16, '0') });
      return { ok: true, status: 200, headers, text: feed.slots.get(feed.head)! };
    }

    const owner = this.slotOwners.get(path);
    this.requests.push({ path, rung: owner?.hex ?? null, kind: owner ? 'slot' : 'other' });
    if (this.faulted.has(path)) {
      throw new TypeError('Failed to fetch');
    }
    const body = owner ? this.feeds.get(owner.hex)?.slots.get(owner.index) : this.markers.get(path);
    if (!this.peerLeftFor(path, body !== undefined) || body === undefined) {
      throw new ManifestFetchError(path, 404);
    }
    return { ok: true, status: 200, headers: new Headers(), text: body };
  };

  private peerLeftFor(path: string, written: boolean): boolean {
    if (this.skipList === null) {
      return true;
    }
    const now = this.skipList.now();
    const skipped = (this.skippedUntil.get(path) ?? []).filter((until) => until > now);
    const peerLeft = skipped.length < this.skipList.peers;
    if (peerLeft && !written) {
      skipped.push(now + this.skipList.skipMs);
    }
    this.skippedUntil.set(path, skipped);
    return peerLeft;
  }

  private feedOf(topic: Topic): FakeFeed {
    const feed = this.feeds.get(topic.toString());
    if (!feed) {
      throw new Error(`no feed published for ${topic.toString()}`);
    }
    return feed;
  }
}
