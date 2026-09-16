import { createHash } from 'node:crypto';

import type { FeedGateway, FeedSnapshot } from './FeedGateway.js';

interface FakeWrite {
  index: number;
  entries: unknown[];
  /** What `write` returned, so a test can check what was logged next to it. */
  reference: string;
}

export interface FakeFeedGatewayOptions {
  /** How many writes behind `readLatest` answers. 0 (the default) is honest. */
  readLagWrites?: number;
}

/**
 * In-memory FeedGateway. Selected by FEED_GATEWAY=fake so the API can be run
 * and integration-tested without a Bee node or postage, and used directly by
 * the PublishService unit tests.
 *
 * It behaves like a feed in the ways publishing depends on: an unwritten feed
 * reads as `index: null`, a write is refused unless it lands on the next index
 * of a feed this process has written, and references look like references
 * (sha256 of the bytes). A feed it has *not* written takes whatever index it
 * is given — `feed_writes` outlives this process and decides that now.
 *
 * Those references are fabricated, so `hasReference` knows only the ones this
 * process handed out. A restart forgets them, which is the honest answer: the
 * bytes were never anywhere, and a reference persisted by an earlier run
 * (or by a run with FEED_GATEWAY=fake, read back under `bee`) is not one
 * anybody can resolve.
 *
 * `readLagWrites` reproduces the one way the real node is *not* like this: its
 * feed lookup answers with the head as it was some seconds ago, not as it is.
 * With a lag of n, `readLatest` answers with the state as of n writes ago
 * while `write` still enforces the true next index — which is exactly the
 * shape of the bug: the network read was stale, the chunk address was not.
 */
export class FakeFeedGateway implements FeedGateway {
  private snapshot: FeedSnapshot = { index: null, entries: [] };
  /** Every state the feed has been in, oldest first: what the lag reads from. */
  private readonly history: FeedSnapshot[] = [];
  private readonly readLagWrites: number;
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

  constructor(initial?: FeedSnapshot, options: FakeFeedGatewayOptions = {}) {
    if (initial) this.snapshot = initial;
    this.readLagWrites = options.readLagWrites ?? 0;
    this.history.push(this.snapshot);
  }

  async readLatest(): Promise<FeedSnapshot> {
    const failure = this.take('failNextRead');
    if (failure) throw failure;
    const at = Math.max(0, this.history.length - 1 - this.readLagWrites);
    const seen = this.history[at]!;
    return { index: seen.index, entries: [...seen.entries] };
  }

  async write(entries: unknown[], index: number): Promise<string> {
    const failure = this.take('failNextWrite');
    if (failure) throw failure;

    // Within one process the index must be the next one, which is what pins
    // "indexes only ever go forward" in the tests. A feed this process has not
    // written yet takes whatever index it is given: the next index now comes
    // from `feed_writes`, which survives a restart, and this gateway — which
    // forgets everything, by design — must not refuse to continue it. That is
    // the normal `FEED_GATEWAY=fake` dev loop under `tsx watch`.
    if (this.snapshot.index !== null && index !== this.snapshot.index + 1) {
      throw new Error(
        `Fake feed write at index ${index}, expected ${this.snapshot.index + 1}`,
      );
    }
    this.snapshot = { index, entries: [...entries] };
    this.history.push(this.snapshot);
    const reference = createHash('sha256')
      .update(JSON.stringify(entries))
      .digest('hex');
    this.writes.push({ index, entries: [...entries], reference });
    return reference;
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
