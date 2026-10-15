import { BeeResponseError, FeedIndex, PrivateKey } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BeePublisherPool, FEED_LOOKUP_TIMEOUT_MS } from '../src/libs/BeePublisherPool.js';
import { MasterFeedWriter } from '../src/libs/MasterFeedWriter.js';
import { buildMasterPlaylist } from '../src/libs/MasterPlaylist.js';
import { Rendition } from '../src/types.js';

const TEST_KEY = '0'.repeat(63) + '1';

const rung = (name: string): Rendition => ({
  name,
  width: 640,
  height: 360,
  topic: `topic-${name}`,
  bandwidth: 800_000,
  avgBandwidth: 700_000,
});

interface WriterOptions {
  /** The group's master feed already holds a head at this index, as a restart mid-ladder leaves it. */
  headIndex?: bigint;
  /** The playlist that head holds. */
  headPlaylist?: string;
  /** The feed reader answers 404, the shape of a group whose master was never written. */
  headMissing?: boolean;
  /** The timeout each reader was made with, in order, when a test wants to see it. */
  readerTimeouts?: (number | undefined)[];
  /** The first write is refused with a status worth retrying. */
  firstWriteFails?: boolean;
  /** How many writers were made, when a test wants to see it. */
  writersMade?: { count: number };
}

function makeWriter(writes: bigint[], opts: WriterOptions = {}): MasterFeedWriter {
  let failedOnce = false;
  const bee = {
    feed: {
      makeReader: (_topic: unknown, _owner: unknown, requestOptions?: { timeout?: number }) => {
        opts.readerTimeouts?.push(requestOptions?.timeout);
        return {
          downloadPayload: async () => {
            if (opts.headMissing) {
              throw new BeeResponseError('GET', '/feeds', 'Not Found.', undefined, 404, 'Not Found');
            }
            return {
              feedIndex: FeedIndex.fromBigInt(opts.headIndex ?? 0n),
              payload: { toUtf8: () => opts.headPlaylist ?? '#EXTM3U\n' },
            };
          },
        };
      },
      makeWriter: () => {
        if (opts.writersMade) {
          opts.writersMade.count += 1;
        }
        return {
          uploadPayload: async (_stamp: string, _payload: unknown, writeOpts: { index: FeedIndex }) => {
            if (opts.firstWriteFails && writes.length === 0 && !failedOnce) {
              failedOnce = true;
              throw new BeeResponseError('POST', '/soc', 'Service Unavailable', undefined, 503, 'Service Unavailable');
            }
            writes.push(writeOpts.index.toBigInt());
            return { reference: { toHex: () => 'ref' } };
          },
        };
      },
    },
  };
  const publisher = { rung: 'coordinator', url: '', stamp: 'stamp', bee };
  const publishers = { coordinator: () => publisher } as unknown as BeePublisherPool;
  return new MasterFeedWriter(publishers, new PrivateKey(TEST_KEY));
}

describe('MasterFeedWriter next index', () => {
  /** A writer carries one deadline counted from when it is made. See DeadlineBee in BeePublisherPool.ts. */
  it('makes a writer for each attempt, so a retry is not handed a deadline already spent', async () => {
    const writersMade = { count: 0 };
    const writes: bigint[] = [];
    const writer = makeWriter(writes, { headIndex: 5n, firstWriteFails: true, writersMade });

    await writer.publish('group-1', [rung('360p')]);

    assert.deepEqual(writes, [6n]);
    assert.equal(writersMade.count, 2);
  });

  /** The first write's probe is a feed lookup, longer than the pool's 4 s. See FEED_LOOKUP_TIMEOUT_MS. */
  it('probes the feed with a feed lookup’s deadline rather than the pool’s', async () => {
    const readerTimeouts: (number | undefined)[] = [];
    const writer = makeWriter([], { headIndex: 5n, readerTimeouts });

    await writer.publish('group-1', [rung('360p')]);

    assert.deepEqual(readerTimeouts, [FEED_LOOKUP_TIMEOUT_MS]);
  });

  it('probes the feed on the first write, so a recovering ladder does not rewind its master', async () => {
    // The group id is the feed topic and it survives a restart. An uploader that recovers a ladder
    // mid-stream must continue past the master a viewer is already reading, not overwrite it at 0.
    const writes: bigint[] = [];
    const writer = makeWriter(writes, { headIndex: 5n });

    const published = await writer.publish('group-1', [rung('360p')]);

    assert.equal(published?.index, 6, 'a probed head at 5 must write the next master at 6, not 0');
    assert.deepEqual(writes, [6n]);
  });

  it('starts at 0 when the group has never had a master', async () => {
    const writes: bigint[] = [];
    const writer = makeWriter(writes, { headMissing: true });

    const published = await writer.publish('group-1', [rung('360p')]);

    assert.equal(published?.index, 0);
    assert.deepEqual(writes, [0n]);
  });

  it('continues from its cached index without probing again after the first write', async () => {
    const writes: bigint[] = [];
    const writer = makeWriter(writes, { headIndex: 5n });

    await writer.publish('group-1', [rung('360p')]);
    await writer.publish('group-1', [rung('360p'), rung('720p')]);

    assert.deepEqual(writes, [6n, 7n], 'the second write continues from the cached index rather than re-probing');
  });

  it('publishes nothing for an empty rung list', async () => {
    const writes: bigint[] = [];
    const writer = makeWriter(writes);

    const published = await writer.publish('group-1', []);

    assert.equal(published, null);
    assert.deepEqual(writes, []);
  });
});

describe('MasterFeedWriter and a master that would say nothing new', () => {
  it('writes nothing when asked to keep an unchanged master, and names the slot already holding it', async () => {
    const writes: bigint[] = [];
    const writer = makeWriter(writes, { headMissing: true });

    await writer.publish('group-1', [rung('360p'), rung('720p')]);
    const kept = await writer.publish('group-1', [rung('360p'), rung('720p')], { skipIfUnchanged: true });

    assert.deepEqual(writes, [0n], 'an identical master was written into the next slot');
    assert.equal(kept?.index, 0);
  });

  it('compares against the head a fresh process reads, so a resumed finalize adds no slot', async () => {
    const writes: bigint[] = [];
    const headPlaylist = buildMasterPlaylist(new PrivateKey(TEST_KEY).publicKey().address().toHex(), [rung('360p')]);
    const writer = makeWriter(writes, { headIndex: 5n, headPlaylist });

    const kept = await writer.publish('group-1', [rung('360p')], { skipIfUnchanged: true });

    assert.deepEqual(writes, []);
    assert.equal(kept?.index, 5);
  });

  it('writes a master that differs from the head even when asked to keep an unchanged one', async () => {
    const writes: bigint[] = [];
    const writer = makeWriter(writes, { headMissing: true });

    await writer.publish('group-1', [rung('360p')]);
    const written = await writer.publish('group-1', [rung('360p'), rung('720p')], { skipIfUnchanged: true });

    assert.deepEqual(writes, [0n, 1n]);
    assert.equal(written?.index, 1);
  });

  /**
   * A new broadcast of the same declared stream opens with a live master that can be byte for byte the
   * recording's. It still has to land above the recording, because a slot above is what tells anyone the
   * broadcaster came back.
   */
  it('still writes an identical master when not asked to keep it', async () => {
    const writes: bigint[] = [];
    const writer = makeWriter(writes, { headMissing: true });

    await writer.publish('group-1', [rung('360p')]);
    await writer.publish('group-1', [rung('360p')]);

    assert.deepEqual(writes, [0n, 1n]);
  });
});
