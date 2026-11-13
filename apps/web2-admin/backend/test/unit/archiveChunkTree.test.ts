/**
 * The shapes of the chunks an archive copies: the erasure level a span carries, which references are parity, the
 * address of a feed slot and of a wrapped playlist's root, and the chunks a tree holds, against the 96 segments step 0
 * measured on a real node. `pnpm test`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bee, Bytes, EthAddress, FeedIndex, Identifier, Reference, Span, Topic } from '@ethersphere/bee-js';

import {
  chunkAddress,
  feedSlotAddress,
  levelOf,
  maxShards,
  parityCount,
  spanOf,
  splitReferences,
  treeChunks,
  treeShape,
  wrappedPayload,
  type RedundancyLevel,
} from '../../src/domain/archive/chunkTree.js';
import { buildFile, buildSlot, cac } from './support/archiveFakes.js';

const OWNER = '1234567890abcdef1234567890abcdef12345678';
const TOPIC = '0b7c3a1e-2f44-5d66-8a77-99aabbccddee';

/**
 * Each segment step 0 read through the catalogue node, at erasure level 1: its bytes, and the data, intermediate and
 * parity chunks its tree held. 360p, 480p and 720p of one 64-second recording, 32 segments each.
 */
const MEASURED: ReadonlyArray<readonly [number, number, number, number]> = [
  [227856, 56, 1, 7],
  [234248, 58, 1, 7],
  [223720, 55, 1, 7],
  [188188, 46, 1, 6],
  [248348, 61, 1, 7],
  [233872, 58, 1, 7],
  [236128, 58, 1, 7],
  [235376, 58, 1, 7],
  [233496, 58, 1, 7],
  [235564, 58, 1, 7],
  [228044, 56, 1, 7],
  [235188, 58, 1, 7],
  [241204, 59, 1, 7],
  [238196, 59, 1, 7],
  [232368, 57, 1, 7],
  [231992, 57, 1, 7],
  [244588, 60, 1, 7],
  [238196, 59, 1, 7],
  [238008, 59, 1, 7],
  [246092, 61, 1, 7],
  [242708, 60, 1, 7],
  [238948, 59, 1, 7],
  [234060, 58, 1, 7],
  [237068, 58, 1, 7],
  [239324, 59, 1, 7],
  [233684, 58, 1, 7],
  [233308, 57, 1, 7],
  [235564, 58, 1, 7],
  [220524, 54, 1, 7],
  [237068, 58, 1, 7],
  [183112, 45, 1, 6],
  [258312, 64, 1, 7],
  [345356, 85, 1, 8],
  [367916, 90, 1, 8],
  [359080, 88, 1, 8],
  [352124, 86, 1, 8],
  [376564, 92, 1, 8],
  [357952, 88, 1, 8],
  [358140, 88, 1, 8],
  [358140, 88, 1, 8],
  [268276, 66, 1, 7],
  [356448, 88, 1, 8],
  [357388, 88, 1, 8],
  [355508, 87, 1, 8],
  [355884, 87, 1, 8],
  [359456, 88, 1, 8],
  [356448, 87, 1, 8],
  [373744, 92, 1, 8],
  [354568, 87, 1, 8],
  [340092, 84, 1, 8],
  [362276, 89, 1, 8],
  [262824, 65, 1, 7],
  [360208, 88, 1, 8],
  [354192, 87, 1, 8],
  [363968, 89, 1, 8],
  [355132, 87, 1, 8],
  [363028, 89, 1, 8],
  [362276, 89, 1, 8],
  [357388, 88, 1, 8],
  [358328, 88, 1, 8],
  [396868, 97, 1, 9],
  [358516, 88, 1, 8],
  [328060, 81, 1, 8],
  [361524, 89, 1, 8],
  [776252, 190, 3, 20],
  [755384, 185, 3, 19],
  [646908, 158, 3, 18],
  [745232, 182, 3, 19],
  [792420, 194, 3, 20],
  [766288, 188, 3, 20],
  [712144, 174, 3, 19],
  [755384, 185, 3, 19],
  [758768, 186, 3, 19],
  [774372, 190, 3, 20],
  [768544, 188, 3, 20],
  [755008, 185, 3, 19],
  [801444, 196, 3, 20],
  [798812, 196, 3, 20],
  [852204, 209, 3, 20],
  [772680, 189, 3, 20],
  [754256, 185, 3, 19],
  [760648, 186, 3, 19],
  [778696, 191, 3, 20],
  [757640, 185, 3, 19],
  [741472, 182, 3, 19],
  [755948, 185, 3, 19],
  [763656, 187, 3, 19],
  [755760, 185, 3, 19],
  [754820, 185, 3, 19],
  [783960, 192, 3, 20],
  [567948, 139, 3, 17],
  [740532, 181, 3, 19],
  [785464, 192, 3, 20],
  [713272, 175, 3, 19],
  [758580, 186, 3, 19],
  [727560, 178, 3, 19],
];

describe('the chunks an archive copies', () => {
  it('reads the bytes a chunk spans and the erasure level its span carries', () => {
    assert.equal(spanOf(cac(new Uint8Array(10), 10)), 10);
    assert.equal(levelOf(cac(new Uint8Array(10), 10)), 0);
    const intermediate = cac(new Uint8Array(32 * 3), 9000, 1);
    assert.equal(spanOf(intermediate), 9000, 'the level byte is not part of the span');
    assert.equal(levelOf(intermediate), 1);
    for (const level of [2, 3, 4] as const) assert.equal(levelOf(cac(new Uint8Array(32), 5000, level)), level);
  });

  it('splits an intermediate into data and parity by its level, for every group size at levels 0 to 4', () => {
    for (const level of [0, 1, 2, 3, 4] as RedundancyLevel[]) {
      for (let shards = 1; shards <= maxShards(level); shards++) {
        const parities = parityCount(level, shards);
        if (shards + parities > 128) continue;
        const refs = Array.from({ length: shards + parities }, (_, at) => (at + 1).toString(16).padStart(64, '0'));
        const payload = new Uint8Array(Buffer.concat(refs.map((ref) => Buffer.from(ref, 'hex'))));
        const split = splitReferences(cac(payload, shards * 4096 + 1, level));
        assert.deepEqual(split.data, refs.slice(0, shards), `level ${level}, ${shards} shards`);
        assert.deepEqual(split.parity, refs.slice(shards), `level ${level}, ${shards} shards`);
      }
    }
  });

  it("holds the parity tables to Bee's: a full group of each level fills 128 references", () => {
    assert.equal(maxShards(0), 128);
    assert.equal(maxShards(1), 119);
    for (const level of [1, 2, 3, 4] as const)
      assert.equal(maxShards(level) + parityCount(level, maxShards(level)), 128);
    assert.equal(parityCount(1, 1), 2);
    assert.equal(parityCount(4, 1), 19);
  });

  it('opens no references in a data chunk', () => {
    assert.deepEqual(splitReferences(cac(new Uint8Array(4096), 4096, 1)), { data: [], parity: [] });
  });

  it('finds a feed slot where bee-js and the export find it', () => {
    const topic = Topic.fromString(TOPIC);
    const index = FeedIndex.fromBigInt(33n);
    const identifier = new Identifier(Bytes.keccak256(Bytes.concat(topic.toUint8Array(), index.toUint8Array())));
    const expected = new Reference(
      Bytes.keccak256(Bytes.concat(identifier.toUint8Array(), new EthAddress(OWNER).toUint8Array())),
    ).toHex();
    assert.equal(feedSlotAddress(OWNER, TOPIC, 33), expected);
    assert.equal(feedSlotAddress(`0x${OWNER.toUpperCase()}`, TOPIC, 33), expected, 'whatever the case and prefix');
  });

  it("computes a chunk's address as bee-js does", () => {
    const payload = new Uint8Array(Buffer.from('a playlist line'));
    const bee = new Bee('http://127.0.0.1:1633');
    const expected = bee.makeContentAddressedChunk(payload, Span.fromBigInt(BigInt(payload.length))).address.toHex();
    assert.equal(chunkAddress(cac(payload, payload.length)), expected);
  });

  it("gives a slot's inline payload, and a wrapped payload's root by the address its tree has", () => {
    const short = buildSlot(OWNER, TOPIC, 1, cac(new Uint8Array(Buffer.from('#EXTM3U')), 7));
    const inline = wrappedPayload(short.soc);
    assert.equal(inline.kind, 'inline');
    assert.equal(Buffer.from((inline as { payload: Uint8Array }).payload).toString(), '#EXTM3U');

    const file = buildFile(new Uint8Array(Buffer.alloc(4150, 'x')));
    const long = buildSlot(OWNER, TOPIC, 2, file.chunks.get(file.root)!);
    const wrapped = wrappedPayload(long.soc);
    assert.equal(wrapped.kind, 'root');
    assert.equal((wrapped as { address: string }).address, file.root, 'the root the export reads the playlist through');
  });

  it('counts the chunks of every segment step 0 measured, exactly but for one whose two data chunks were the same', () => {
    let exact = 0;
    for (const [bytes, data, intermediate, parity] of MEASURED) {
      const shape = treeShape(bytes, 1);
      assert.equal(shape.intermediate, intermediate, `${bytes} bytes`);
      assert.equal(shape.parity, parity, `${bytes} bytes`);
      assert.ok(shape.data >= data, `${bytes} bytes: an upper bound`);
      if (shape.data === data) exact += 1;
    }
    assert.equal(MEASURED.length, 96);
    assert.equal(exact, 95);
  });

  it('sizes a 1.25 MB segment as 306 data, 4 tree and 28 parity chunks', () => {
    assert.deepEqual(treeShape(1_250_000, 1), { data: 306, intermediate: 4, parity: 28 });
    assert.equal(treeChunks(1_250_000, 1), 338);
  });

  it('builds a test tree the counts and the split agree on', () => {
    const file = buildFile(new Uint8Array(Buffer.alloc(300 * 4096, 'y')), 1);
    const shape = treeShape(300 * 4096, 1);
    assert.equal(file.data.length, shape.data);
    assert.equal(file.intermediate.length, shape.intermediate);
    assert.equal(file.parity.length, shape.parity);
  });
});
