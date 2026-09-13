import { createHash } from 'node:crypto';

import type { FeedGateway, FeedSnapshot } from './FeedGateway.js';

interface FakeWrite {
  index: number;
  entries: unknown[];
}

/**
 * In-memory FeedGateway. Selected by FEED_GATEWAY=fake so the API can be run
 * and integration-tested without a Bee node or postage, and used directly by
 * the PublishService unit tests.
 *
 * It behaves like a feed in the ways publishing depends on: an unwritten feed
 * reads as `index: null`, a write is refused unless it lands on the next
 * index, and references look like references (sha256 of the bytes).
 *
 * Those references are fabricated, so `hasReference` knows only the ones this
 * process handed out. A restart forgets them, which is the honest answer: the
 * bytes were never anywhere, and a reference persisted by an earlier run
 * (or by a run with FEED_GATEWAY=fake, read back under `bee`) is not one
 * anybody can resolve.
 */
export class FakeFeedGateway implements FeedGateway {
  private snapshot: FeedSnapshot = { index: null, entries: [] };
  /** Every write, in order: what the tests assert on. */
  readonly writes: FakeWrite[] = [];
  readonly thumbnails: { filename: string; contentType: string; size: number }[] = [];
  /** The references uploadThumbnail handed out, for the life of the process. */
  private readonly references = new Set<string>();
  /** Set to make the next call fail, as a network or postage error would. */
  failNextWrite: Error | null = null;
  failNextRead: Error | null = null;
  failNextThumbnail: Error | null = null;
  failNextHasReference: Error | null = null;

  constructor(initial?: FeedSnapshot) {
    if (initial) this.snapshot = initial;
  }

  async readLatest(): Promise<FeedSnapshot> {
    const failure = this.take('failNextRead');
    if (failure) throw failure;
    return { index: this.snapshot.index, entries: [...this.snapshot.entries] };
  }

  async write(entries: unknown[], index: number): Promise<string> {
    const failure = this.take('failNextWrite');
    if (failure) throw failure;

    const expected = this.snapshot.index === null ? 0 : this.snapshot.index + 1;
    if (index !== expected) {
      throw new Error(`Fake feed write at index ${index}, expected ${expected}`);
    }
    this.snapshot = { index, entries: [...entries] };
    this.writes.push({ index, entries: [...entries] });
    return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  }

  async uploadThumbnail(
    bytes: Uint8Array,
    filename: string,
    contentType: string,
  ): Promise<string> {
    const failure = this.take('failNextThumbnail');
    if (failure) throw failure;

    this.thumbnails.push({ filename, contentType, size: bytes.length });
    const reference = createHash('sha256').update(bytes).digest('hex');
    this.references.add(reference);
    return reference;
  }

  async hasReference(reference: string): Promise<boolean> {
    const failure = this.take('failNextHasReference');
    if (failure) throw failure;
    return this.references.has(reference);
  }

  private take(
    field:
      | 'failNextRead'
      | 'failNextWrite'
      | 'failNextThumbnail'
      | 'failNextHasReference',
  ): Error | null {
    const failure = this[field];
    this[field] = null;
    return failure;
  }
}
