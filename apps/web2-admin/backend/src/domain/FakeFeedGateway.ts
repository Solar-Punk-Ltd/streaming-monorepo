import { createHash } from 'node:crypto';

import type {
  CatalogueRestamper,
  CatalogueTarget,
  FeedGateway,
  FeedSnapshot,
  RestampedSlot,
  SlotToRestamp,
  ThumbnailFile,
} from './FeedGateway.js';

interface FakeWrite {
  index: number;
  entries: unknown[];
  /** The text as it was handed over, which is what `feed_writes` must record. */
  payloadText: string;
  /** Where the caller said the write goes: null for a write with no catalogue stamp. */
  target: CatalogueTarget | null;
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
 * It writes nowhere, so it needs no catalogue stamp: it takes a null target,
 * and records whatever target it was handed so a test can tell which batch a
 * write would have been stamped with.
 *
 * `readLagWrites` reproduces the one way the real node is *not* like this: its
 * feed lookup answers with the head as it was some seconds ago, not as it is.
 * With a lag of n, `readLatest` answers with the state as of n writes ago
 * while `write` still enforces the true next index — which is exactly the
 * shape of the bug: the network read was stale, the chunk address was not.
 */
export class FakeFeedGateway implements FeedGateway, CatalogueRestamper {
  private snapshot: FeedSnapshot = { index: null, entries: [] };
  /** Every state the feed has been in, oldest first: what the lag reads from. */
  private readonly history: FeedSnapshot[] = [];
  private readonly readLagWrites: number;
  /** Every write, in order: what the tests assert on. */
  readonly writes: FakeWrite[] = [];
  readonly thumbnails: { filename: string; contentType: string; size: number; target: CatalogueTarget | null }[] = [];
  /** The target of every read, in order, so a test can tell which node a check asked. */
  readonly reads: (CatalogueTarget | null)[] = [];
  /** The references uploadThumbnail handed out, for the life of the process. */
  private readonly references = new Set<string>();
  /** Set to make the next call fail, as a network or postage error would. */
  failNextWrite: Error | null = null;
  failNextRead: Error | null = null;
  failNextThumbnail: Error | null = null;
  failNextHasReference: Error | null = null;
  failNextRestamp: Error | null = null;
  /** Every slot and thumbnail uploaded again by a catalogue move, in order. */
  readonly restamps: { index: number; payloadText: string; target: CatalogueTarget }[] = [];
  readonly restampedThumbnails: { reference: string; fromAdmin: boolean; target: CatalogueTarget }[] = [];

  constructor(initial?: FeedSnapshot, options: FakeFeedGatewayOptions = {}) {
    if (initial) this.snapshot = initial;
    this.readLagWrites = options.readLagWrites ?? 0;
    this.history.push(this.snapshot);
  }

  async readLatest(target: CatalogueTarget | null = null): Promise<FeedSnapshot> {
    const failure = this.take('failNextRead');
    if (failure) throw failure;
    this.reads.push(target);
    const at = Math.max(0, this.history.length - 1 - this.readLagWrites);
    const seen = this.history[at]!;
    return {
      index: seen.index,
      entries: [...seen.entries],
      ...(seen.payloadText === undefined ? {} : { payloadText: seen.payloadText }),
    };
  }

  async write(payloadText: string, index: number, target: CatalogueTarget | null = null): Promise<string> {
    const failure = this.take('failNextWrite');
    if (failure) throw failure;

    // Within one process the index must be the next one, which is what pins
    // "indexes only ever go forward" in the tests. A feed this process has not
    // written yet takes whatever index it is given: the next index now comes
    // from `feed_writes`, which survives a restart, and this gateway — which
    // forgets everything, by design — must not refuse to continue it. That is
    // the normal `FEED_GATEWAY=fake` dev loop under `tsx watch`.
    if (this.snapshot.index !== null && index !== this.snapshot.index + 1) {
      throw new Error(`Fake feed write at index ${index}, expected ${this.snapshot.index + 1}`);
    }
    const entries = JSON.parse(payloadText) as unknown[];
    this.snapshot = { index, entries: [...entries], payloadText };
    this.history.push(this.snapshot);
    const reference = createHash('sha256').update(payloadText).digest('hex');
    this.writes.push({ index, entries: [...entries], payloadText, target, reference });
    return reference;
  }

  async uploadThumbnail(
    bytes: Uint8Array,
    filename: string,
    contentType: string,
    target: CatalogueTarget | null = null,
  ): Promise<string> {
    const failure = this.take('failNextThumbnail');
    if (failure) throw failure;

    this.thumbnails.push({ filename, contentType, size: bytes.length, target });
    const reference = createHash('sha256').update(bytes).digest('hex');
    this.references.add(reference);
    return reference;
  }

  async hasReference(reference: string): Promise<boolean> {
    const failure = this.take('failNextHasReference');
    if (failure) throw failure;
    return this.references.has(reference);
  }

  /**
   * Moving the catalogue, in memory: a slot with its payload is taken as it is, and one without is known only when
   * this process wrote it. Each is recorded with its target, so a test can tell which slots went under which batch.
   */
  async restampSlot(slot: SlotToRestamp, target: CatalogueTarget): Promise<RestampedSlot> {
    const failure = this.take('failNextRestamp');
    if (failure) throw failure;
    const payloadText =
      slot.payloadText ?? [...this.writes].reverse().find((write) => write.index === slot.index)?.payloadText;
    if (payloadText === undefined) throw new Error(`the fake gateway holds no chunk for slot ${slot.index}`);
    this.restamps.push({ index: slot.index, payloadText, target });
    return {
      reference: createHash('sha256').update(payloadText).digest('hex'),
      source: slot.payloadText !== null ? 'recorded' : 'network',
      wrapped: new TextEncoder().encode(payloadText).length > 4096,
    };
  }

  async restampThumbnail(reference: string, file: ThumbnailFile | null, target: CatalogueTarget): Promise<string> {
    const failure = this.take('failNextRestamp');
    if (failure) throw failure;
    this.restampedThumbnails.push({ reference, fromAdmin: file !== null, target });
    if (!file) {
      if (!this.references.has(reference)) throw new Error(`the fake gateway holds no file ${reference}`);
      return reference;
    }
    return createHash('sha256').update(file.bytes).digest('hex');
  }

  private take(
    field: 'failNextRead' | 'failNextWrite' | 'failNextThumbnail' | 'failNextHasReference' | 'failNextRestamp',
  ): Error | null {
    const failure = this[field];
    this[field] = null;
    return failure;
  }
}
