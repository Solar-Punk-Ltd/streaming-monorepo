/**
 * How the catalogue gateway confirms the feed's latest entry before a write that has no recorded write to go on:
 * the node's peers, its feed lookup, then a direct read of each of the slots after the head the lookup found. Against
 * the fake Bee of `support/fakeBee.ts`, which answers a lookup with whatever head a test sets, whatever its chunks
 * hold. `pnpm test`.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Bytes, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';

import { BeeFeedGateway, HEAD_CONFIRM_WINDOW } from '../../src/domain/BeeFeedGateway.js';
import { CatalogueHeadUnconfirmedError, type CatalogueHeadProblem } from '../../src/domain/errors/index.js';

import { FakeBee } from './support/fakeBee.js';

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TOPIC = 'catalogue-head-test';
const BATCH = 'a1'.repeat(32);

let bee: FakeBee;
const target = () => ({ beeApiUrl: bee.url, batchId: BATCH });
const gateway = (headConfirmReadTimeoutMs?: number) =>
  new BeeFeedGateway({ feedPrivateKey: KEY, feedTopic: TOPIC, headConfirmReadTimeoutMs });

/** The address of slot `index`'s chunk, as the feed key and topic give it. */
function slotAddress(index: number): string {
  const topic = Topic.fromString(TOPIC);
  const identifier = Bytes.keccak256(
    Bytes.concat(topic.toUint8Array(), FeedIndex.fromBigInt(BigInt(index)).toUint8Array()),
  );
  const owner = new PrivateKey(KEY).publicKey().address();
  return Bytes.keccak256(Bytes.concat(identifier.toUint8Array(), owner.toUint8Array())).toHex();
}

/** Writes slots 0 to `last` through the node, as the catalogue would have been written. */
async function written(last: number): Promise<void> {
  for (let index = 0; index <= last; index++) await gateway().write(`[{"slot":${index}}]`, index, target());
}

const refusedAs = (problem: CatalogueHeadProblem) => (err: unknown) =>
  err instanceof CatalogueHeadUnconfirmedError && err.problem === problem && !err.message.includes('127.0.0.1');

before(async () => {
  bee = await new FakeBee().start();
});
after(async () => {
  await bee.stop();
});
beforeEach(() => {
  bee.chunks.clear();
  bee.uploads.length = 0;
  bee.chunkReads.length = 0;
  bee.peers = 1;
  bee.feedHead = null;
  bee.holdChunkReads = false;
});

describe('confirming the latest catalogue entry', () => {
  it('refuses at once when the node has no peers, before its lookup and any read', async () => {
    bee.peers = 0;
    await assert.rejects(() => gateway().readConfirmedLatest(target()), refusedAs('no_peers'));
    assert.deepEqual(bee.chunkReads, []);
  });

  it('confirms an empty feed once none of the first slots is held', async () => {
    const latest = await gateway().readConfirmedLatest(target());

    assert.deepEqual(latest, { index: null, entries: [] });
    assert.equal(HEAD_CONFIRM_WINDOW, 8);
    assert.deepEqual(
      [...bee.chunkReads].sort(),
      Array.from({ length: 8 }, (_, index) => slotAddress(index)).sort(),
      'slots 0 to 7, each read directly',
    );
  });

  it('confirms the head the lookup answered once none of the slots after it is held', async () => {
    await written(3);
    bee.feedHead = { index: 3, payload: new TextEncoder().encode('[{"slot":3}]') };

    const latest = await gateway().readConfirmedLatest(target());

    assert.equal(latest.index, 3);
    assert.deepEqual(latest.entries, [{ slot: 3 }]);
    assert.deepEqual(
      [...bee.chunkReads].sort(),
      Array.from({ length: 8 }, (_, at) => slotAddress(4 + at)).sort(),
      'slots 4 to 11',
    );
  });

  it('refuses a head the lookup answered when a slot after it is held, as on a feed with a lost slot', async () => {
    await written(5);
    // The lookup stopped at 1, as it does when slot 2 cannot be fetched; slots up to 5 are held.
    bee.feedHead = { index: 1, payload: new TextEncoder().encode('[{"slot":1}]') };
    bee.chunks.delete(slotAddress(2));

    await assert.rejects(() => gateway().readConfirmedLatest(target()), refusedAs('gap'));
  });

  it('refuses an empty-looking feed whose first slot is lost but whose later ones are held', async () => {
    await written(2);
    bee.chunks.delete(slotAddress(0));

    await assert.rejects(() => gateway().readConfirmedLatest(target()), refusedAs('gap'));
  });

  it('refuses within its bound when the node does not answer whether a slot is held', async () => {
    bee.holdChunkReads = true;
    const started = Date.now();

    await assert.rejects(() => gateway(200).readConfirmedLatest(target()), refusedAs('unanswered'));
    assert.ok(Date.now() - started < 5_000, 'the reads are bounded, and run at once');
    assert.equal(bee.chunkReads.length, 8);
  });
});
