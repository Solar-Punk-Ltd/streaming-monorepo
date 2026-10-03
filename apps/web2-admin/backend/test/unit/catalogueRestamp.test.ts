/**
 * Uploading a catalogue slot again under another batch, byte for byte. Unit test: the real BeeFeedGateway and bee-js
 * against the fake Bee of `support/fakeBee.ts`, which records every chunk's address, bytes and batch. `pnpm test`.
 *
 * Pinned here, for the move of the catalogue (docs/architecture/stages.md): signing the same identifier and payload
 * with the same key gives the same signature, so a slot built again from the payload `feed_writes` recorded is the
 * chunk `write` first uploaded, at the same address with the same bytes; a slot with no recorded payload is read
 * from the network and uploaded with its own signature; a payload over 4096 bytes has its data uploaded again too,
 * chunk for chunk; and a thumbnail comes out at the reference it had.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Bee, Bytes, ChunkSplitter, Identifier, PrivateKey } from '@ethersphere/bee-js';

import { BeeFeedGateway } from '../../src/domain/BeeFeedGateway.js';
import { encodeFeedPayload } from '../../src/domain/FeedGateway.js';

import { FakeBee } from './support/fakeBee.js';

/** Hardhat's first test account: public, and it signs nothing that matters. */
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const OLD = 'a1'.repeat(32);
const NEW = 'b2'.repeat(32);

let bee: FakeBee;
let gateway: BeeFeedGateway;
const old = () => ({ beeApiUrl: bee.url, batchId: OLD });
const moved = () => ({ beeApiUrl: bee.url, batchId: NEW });

before(async () => {
  bee = await new FakeBee().start();
});

after(async () => {
  await bee.stop();
});

beforeEach(() => {
  bee.uploads.length = 0;
  bee.chunks.clear();
  bee.files.clear();
  bee.failNext = null;
  bee.beforeAnswer = null;
  gateway = new BeeFeedGateway({ feedPrivateKey: KEY, feedTopic: 'swarm-stream' });
});

/** A catalogue payload of about `bytes` bytes, with a title that is not ASCII, as a brand's can be. */
function payloadOf(bytes: number): string {
  const entries: unknown[] = [];
  let index = 0;
  while (encodeFeedPayload(entries).length < bytes) {
    entries.push({
      owner: '19e7e376e7c213b7e7e7e46cc70a5dd086daff2a',
      topic: `t-${index}`,
      title: `Élő adás ${index}`,
    });
    index += 1;
  }
  return encodeFeedPayload(entries);
}

/** The address and bytes of every upload under a batch, of one kind, as hex, for a comparison. */
function held(batch: string, kind?: 'soc' | 'chunk' | 'file'): [string, string][] {
  return bee.under(batch, kind).map((upload) => [upload.address, Buffer.from(upload.bytes).toString('hex')]);
}

describe('the signature a slot carries', () => {
  it('is the same every time the same key signs the same identifier and payload (RFC 6979)', () => {
    const helpers = new Bee('http://127.0.0.1:1633');
    const identifier = new Identifier(Bytes.keccak256(Bytes.fromUtf8('slot 7')));
    const signer = new PrivateKey(KEY);
    const once = helpers.makeContentAddressedChunk('[{"topic":"a"}]').toSingleOwnerChunk(identifier, signer);
    const again = helpers.makeContentAddressedChunk('[{"topic":"a"}]').toSingleOwnerChunk(identifier, signer);

    assert.equal(once.signature.toHex(), again.signature.toHex());
    assert.equal(Buffer.from(once.data).toString('hex'), Buffer.from(again.data).toString('hex'));
    assert.equal(once.address.toHex(), again.address.toHex());
  });

  it('differs for another payload, so the check above is not of a constant', () => {
    const helpers = new Bee('http://127.0.0.1:1633');
    const identifier = new Identifier(Bytes.keccak256(Bytes.fromUtf8('slot 7')));
    const signer = new PrivateKey(KEY);
    const one = helpers.makeContentAddressedChunk('[{"topic":"a"}]').toSingleOwnerChunk(identifier, signer);
    const other = helpers.makeContentAddressedChunk('[{"topic":"b"}]').toSingleOwnerChunk(identifier, signer);
    assert.notEqual(one.signature.toHex(), other.signature.toHex());
    assert.equal(one.address.toHex(), other.address.toHex(), 'the address is the identifier and owner alone');
  });
});

describe('the fake Bee', () => {
  it('splits data the way the chunk splitter bee-js ships does', async () => {
    const data = new TextEncoder().encode(payloadOf(20_000));
    const root = bee.split(data, null);
    assert.equal(root, (await ChunkSplitter.root(data)).hash().toHex());
  });
});

describe('restampSlot', () => {
  it('uploads a slot again from its recorded payload, byte for byte what write uploaded', async () => {
    const payload = payloadOf(600);
    const reference = await gateway.write(payload, 3, old());

    const restamped = await gateway.restampSlot({ index: 3, payloadText: payload, reference }, moved());

    assert.deepEqual(restamped, { reference, source: 'recorded', wrapped: false });
    assert.equal(held(OLD).length, 1);
    assert.deepEqual(held(NEW), held(OLD), 'the same chunk, at the same address, under the new batch');
  });

  it('uploads a slot again from the network when it has no recorded payload', async () => {
    const payload = payloadOf(600);
    const reference = await gateway.write(payload, 0, old());

    const restamped = await gateway.restampSlot({ index: 0, payloadText: null, reference: null }, moved());

    assert.deepEqual(restamped, { reference, source: 'network', wrapped: false });
    assert.deepEqual(held(NEW), held(OLD));
  });

  for (const source of ['recorded', 'network'] as const) {
    it(`uploads a wrapped slot's data again, chunk for chunk, from the ${source === 'recorded' ? 'recorded payload' : 'network'}`, async () => {
      const payload = payloadOf(10_000);
      assert.ok(new TextEncoder().encode(payload).length > 4096);
      const reference = await gateway.write(payload, 5, old());
      assert.ok(held(OLD, 'chunk').length >= 4, 'three leaves and a root at least');

      const restamped = await gateway.restampSlot(
        { index: 5, payloadText: source === 'recorded' ? payload : null, reference },
        moved(),
      );

      assert.deepEqual(restamped, { reference, source, wrapped: true });
      assert.deepEqual(held(NEW, 'soc'), held(OLD, 'soc'));
      assert.deepEqual(
        new Map(held(NEW, 'chunk')),
        new Map(held(OLD, 'chunk')),
        'every chunk of the data, under the new batch',
      );
    });
  }

  it('refuses a slot recorded at another address than its key and topic give it, and uploads nothing', async () => {
    await assert.rejects(
      gateway.restampSlot({ index: 1, payloadText: '[]', reference: 'ff'.repeat(32) }, moved()),
      /not at the address this feed key and topic give it/,
    );
    assert.equal(bee.uploads.length, 0);
  });

  it('fails when the network no longer holds a slot with no recorded payload', async () => {
    await gateway.write(payloadOf(300), 2, old());
    bee.lapse(OLD);

    await assert.rejects(gateway.restampSlot({ index: 2, payloadText: null, reference: null }, moved()));
    assert.equal(held(NEW).length, 0);
  });

  it('still uploads a slot whose old batch lapsed, from its recorded payload', async () => {
    const payload = payloadOf(300);
    const reference = await gateway.write(payload, 2, old());
    const before = held(OLD);
    bee.lapse(OLD);

    await gateway.restampSlot({ index: 2, payloadText: payload, reference }, moved());
    assert.deepEqual(held(NEW), before);
  });

  it('says the status a refusing node answered, not its address', async () => {
    bee.failNext = { kind: 'soc', status: 402 };
    const error = await gateway.restampSlot({ index: 0, payloadText: '[]', reference: null }, moved()).then(
      () => null,
      (e: unknown) => e as Error,
    );
    assert.match(error?.message ?? '', /the node answered 402 to the upload of slot 0/);
    assert.equal(error?.message.includes(new URL(bee.url).hostname), false, 'the node’s address reached the error');
  });
});

describe('restampThumbnail', () => {
  it('uploads the stored bytes again at the reference they had', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const reference = await gateway.uploadThumbnail(bytes, 'topic.png', 'image/png', old());

    const again = await gateway.restampThumbnail(
      reference,
      { bytes, filename: 'topic.png', contentType: 'image/png' },
      moved(),
    );

    assert.equal(again, reference);
    assert.deepEqual(held(NEW, 'file'), held(OLD, 'file'));
  });

  it('reads a file the admin no longer holds from the network, with its name and type', async () => {
    const bytes = new Uint8Array([255, 216, 255, 1, 2]);
    const reference = await gateway.uploadThumbnail(bytes, 'topic.jpg', 'image/jpeg', old());

    assert.equal(await gateway.restampThumbnail(reference, null, moved()), reference);
    assert.deepEqual(held(NEW, 'file'), held(OLD, 'file'));
  });
});
