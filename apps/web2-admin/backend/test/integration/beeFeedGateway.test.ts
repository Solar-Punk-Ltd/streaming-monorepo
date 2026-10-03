/**
 * The real BeeFeedGateway against a real Bee node. Skipped unless both
 * ITEST_BEE_URL and ITEST_BATCH_ID are in the environment:
 *
 *   ITEST_BEE_URL=http://localhost:1633 ITEST_BATCH_ID=<usable batch> \
 *     pnpm test:integration
 *
 * They are this suite's own. The backend reads neither: it writes through the
 * catalogue stamp the manager pushes, which the suite stands in for by
 * handing the gateway the same target on every call.
 *
 * Everything the unit tests assert about publishing is against the in-memory
 * gateway, so this is the one place the bee-js calls themselves are exercised:
 * that a never-written feed reads as "no index" rather than throwing, that a
 * payload survives the JSON round trip, that the head advances, and that a
 * thumbnail comes back byte-identical.
 *
 * It signs a FRESH random key and a random topic every run, so it can never
 * write to the catalog this backend publishes — the feed it makes is garbage
 * that decays with the postage batch.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { Bee } from '@ethersphere/bee-js';

import { BeeFeedGateway } from '../../src/domain/BeeFeedGateway.js';

const beeUrl = process.env.ITEST_BEE_URL;
const batchId = process.env.ITEST_BATCH_ID;
const configured = Boolean(beeUrl && batchId);
const target = configured ? { beeApiUrl: beeUrl!, batchId: batchId! } : null;

const gateway = configured
  ? new BeeFeedGateway({
      feedPrivateKey: `0x${randomBytes(32).toString('hex')}`,
      feedTopic: `web2-admin-itest-${randomUUID()}`,
    })
  : null;

const foreign = { owner: 'f'.repeat(40), topic: randomUUID(), state: 'live' };
const entry = {
  owner: '0'.repeat(40),
  topic: randomUUID(),
  title: 'bee gateway integration test',
  state: 'scheduled',
  mediatype: 'video',
  thumbnail: '',
  tags: ['itest'],
  description: 'written by web2-admin test:integration',
  scheduledStartTime: null,
  timestamp: Date.now(),
};

describe('BeeFeedGateway', { skip: configured ? false : 'ITEST_BEE_URL / ITEST_BATCH_ID not set' }, () => {
  it('reads a never-written feed as an empty list with no index', async () => {
    const snapshot = await gateway!.readLatest(target);
    assert.equal(snapshot.index, null);
    assert.deepEqual(snapshot.entries, []);
  });

  it('writes at index 0 and reads the same payload back, byte for byte', async () => {
    const payloadText = JSON.stringify([foreign, entry]);
    const reference = await gateway!.write(payloadText, 0, target);
    assert.match(reference, /^[0-9a-f]{64}$/);

    const snapshot = await gateway!.readLatest(target);
    assert.equal(snapshot.index, 0);
    assert.deepEqual(snapshot.entries, [foreign, entry]);
    assert.equal(snapshot.payloadText, payloadText);
  });

  it('advances the head on the next write', async () => {
    await gateway!.write(JSON.stringify([entry]), 1, target);

    const snapshot = await gateway!.readLatest(target);
    assert.equal(snapshot.index, 1);
    assert.deepEqual(snapshot.entries, [entry]);
  });

  it('uploads a thumbnail that downloads byte-identical', async () => {
    const bytes = randomBytes(64);
    const reference = await gateway!.uploadThumbnail(bytes, 'thumbnail.png', 'image/png', target);
    assert.match(reference, /^[0-9a-f]{64}$/);

    const downloaded = await new Bee(beeUrl!).file.download(reference);
    assert.deepEqual(Buffer.from(downloaded.data.toUint8Array()), Buffer.from(bytes));
  });
});
