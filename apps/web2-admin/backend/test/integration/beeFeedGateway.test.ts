/**
 * The real BeeFeedGateway against a real Bee node. Skipped unless both
 * BEE_URL and POSTAGE_BATCH_ID are in the environment:
 *
 *   BEE_URL=http://localhost:1633 POSTAGE_BATCH_ID=<usable batch> \
 *     pnpm test:integration
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

const beeUrl = process.env.BEE_URL;
const postageBatchId = process.env.POSTAGE_BATCH_ID;
const configured = Boolean(beeUrl && postageBatchId);

const gateway = configured
  ? new BeeFeedGateway({
      beeUrl: beeUrl!,
      postageBatchId: postageBatchId!,
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

describe('BeeFeedGateway', { skip: configured ? false : 'BEE_URL / POSTAGE_BATCH_ID not set' }, () => {
  it('reads a never-written feed as an empty list with no index', async () => {
    const snapshot = await gateway!.readLatest();
    assert.equal(snapshot.index, null);
    assert.deepEqual(snapshot.entries, []);
  });

  it('writes at index 0 and reads the same payload back', async () => {
    const reference = await gateway!.write([foreign, entry], 0);
    assert.match(reference, /^[0-9a-f]{64}$/);

    const snapshot = await gateway!.readLatest();
    assert.equal(snapshot.index, 0);
    assert.deepEqual(snapshot.entries, [foreign, entry]);
  });

  it('advances the head on the next write', async () => {
    await gateway!.write([entry], 1);

    const snapshot = await gateway!.readLatest();
    assert.equal(snapshot.index, 1);
    assert.deepEqual(snapshot.entries, [entry]);
  });

  it('uploads a thumbnail that downloads byte-identical', async () => {
    const bytes = randomBytes(64);
    const reference = await gateway!.uploadThumbnail(
      bytes,
      'thumbnail.png',
      'image/png',
    );
    assert.match(reference, /^[0-9a-f]{64}$/);

    const downloaded = await new Bee(beeUrl!).downloadFile(reference);
    assert.deepEqual(
      Buffer.from(downloaded.data.toUint8Array()),
      Buffer.from(bytes),
    );
  });
});
