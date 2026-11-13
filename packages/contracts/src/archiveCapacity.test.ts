import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ARCHIVE_CHUNK_BYTES,
  ARCHIVE_EFFECTIVE_BYTES_BY_DEPTH,
  ARCHIVE_MAX_DEPTH,
  ARCHIVE_MIN_DEPTH,
  ARCHIVE_SIZING_MARGIN,
  archiveAmountPerChunkPlur,
  archiveBatchCostPlur,
  archiveChunksWithMargin,
  archiveDepthChoices,
  archiveEffectiveBytes,
  archiveEffectiveChunks,
  smallestArchiveDepthFor,
} from './archiveCapacity.js';

describe('what an archive stamp holds', () => {
  it('names every depth from the shallowest to the deepest, each holding more than the one before', () => {
    const depths = Object.keys(ARCHIVE_EFFECTIVE_BYTES_BY_DEPTH).map(Number);
    assert.deepEqual(
      depths,
      Array.from({ length: ARCHIVE_MAX_DEPTH - ARCHIVE_MIN_DEPTH + 1 }, (_, step) => ARCHIVE_MIN_DEPTH + step),
    );
    for (let depth = ARCHIVE_MIN_DEPTH + 1; depth <= ARCHIVE_MAX_DEPTH; depth++) {
      assert.ok(archiveEffectiveBytes(depth) > archiveEffectiveBytes(depth - 1), `depth ${depth}`);
    }
  });

  it('holds less than the batch has stamps, since a full bucket refuses its chunk', () => {
    for (let depth = ARCHIVE_MIN_DEPTH; depth <= ARCHIVE_MAX_DEPTH; depth++) {
      assert.ok(archiveEffectiveChunks(depth) < 2 ** depth, `depth ${depth}`);
    }
  });

  it('counts whole chunks', () => {
    assert.equal(archiveEffectiveChunks(17), Math.floor(44_700 / ARCHIVE_CHUNK_BYTES));
    assert.equal(archiveEffectiveChunks(23), Math.floor(19_940_000_000 / ARCHIVE_CHUNK_BYTES));
  });

  it('holds nothing at a depth the table does not name', () => {
    for (const depth of [0, 16, ARCHIVE_MAX_DEPTH + 1, 20.5, Number.NaN]) {
      assert.equal(archiveEffectiveBytes(depth), 0);
      assert.equal(archiveEffectiveChunks(depth), 0);
    }
  });
});

describe('the depth a recording needs', () => {
  it('adds the margin and rounds up', () => {
    assert.equal(ARCHIVE_SIZING_MARGIN, 0.05);
    assert.equal(archiveChunksWithMargin(0), 0);
    assert.equal(archiveChunksWithMargin(100), 105);
    assert.equal(archiveChunksWithMargin(101), 107);
    assert.equal(archiveChunksWithMargin(100, 0), 100);
  });

  it('refuses a count or a margin that is no measure', () => {
    for (const chunks of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => archiveChunksWithMargin(chunks));
    }
    for (const margin of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => archiveChunksWithMargin(10, margin));
    }
  });

  it('is the shallowest depth that holds the count with its margin', () => {
    assert.equal(smallestArchiveDepthFor(0), ARCHIVE_MIN_DEPTH);
    assert.equal(smallestArchiveDepthFor(10, 0), 17);
    assert.equal(smallestArchiveDepthFor(11, 0), 18);
    // Step 0's copy of one 360p minute and its master slot: 2101 chunks.
    assert.equal(smallestArchiveDepthFor(2101), 19);
    // An hour of 1080p with its parity, about 650,000 chunks.
    assert.equal(smallestArchiveDepthFor(650_000), 22);
  });

  it('turns at the last chunk a depth holds', () => {
    for (let depth = ARCHIVE_MIN_DEPTH; depth < ARCHIVE_MAX_DEPTH; depth++) {
      const holds = archiveEffectiveChunks(depth);
      assert.equal(smallestArchiveDepthFor(holds, 0), depth, `depth ${depth} holds its own count`);
      assert.equal(smallestArchiveDepthFor(holds + 1, 0), depth + 1, `one more needs depth ${depth + 1}`);
    }
  });

  it('is null for a count no depth holds', () => {
    assert.equal(smallestArchiveDepthFor(archiveEffectiveChunks(ARCHIVE_MAX_DEPTH) + 1, 0), null);
  });
});

describe('the depths a buy dialog offers', () => {
  it('starts at the smallest that fits and goes on to the deepest', () => {
    const choices = archiveDepthChoices(650_000);
    assert.equal(choices[0], 22);
    assert.equal(choices.at(-1), ARCHIVE_MAX_DEPTH);
    assert.equal(choices.length, ARCHIVE_MAX_DEPTH - 22 + 1);
  });

  it('is every depth when no recording is being sized', () => {
    const choices = archiveDepthChoices();
    assert.equal(choices[0], ARCHIVE_MIN_DEPTH);
    assert.equal(choices.length, ARCHIVE_MAX_DEPTH - ARCHIVE_MIN_DEPTH + 1);
  });

  it('is empty when nothing fits', () => {
    assert.deepEqual(archiveDepthChoices(archiveEffectiveChunks(ARCHIVE_MAX_DEPTH) + 1, 0), []);
  });
});

describe('what an archive stamp costs', () => {
  it('is the amount for every stamp of the batch', () => {
    assert.equal(archiveBatchCostPlur(17, '1'), String(2 ** 17));
    assert.equal(archiveBatchCostPlur(22, '414720000'), (414720000n * 2n ** 22n).toString());
    assert.equal(archiveBatchCostPlur(41, '0'), '0');
  });

  it('keeps every digit of an amount beyond a float', () => {
    const amount = '123456789012345678901234567890';
    assert.equal(archiveBatchCostPlur(30, amount), (BigInt(amount) * 2n ** 30n).toString());
  });

  it('refuses a depth outside the table and an amount that is no whole number', () => {
    assert.throws(() => archiveBatchCostPlur(16, '1'));
    assert.throws(() => archiveBatchCostPlur(ARCHIVE_MAX_DEPTH + 1, '1'));
    for (const amount of ['', '-1', '1.5', '01', '1e3', ' 1']) {
      assert.throws(() => archiveBatchCostPlur(20, amount), `amount "${amount}"`);
    }
  });

  it('gives each chunk the price of every block of the life asked for, a started block counted whole', () => {
    // 30 days of 5 second blocks at 24000 PLUR a chunk a block.
    assert.equal(archiveAmountPerChunkPlur(30 * 86_400, '24000', 5), (24000n * 518400n).toString());
    assert.equal(archiveAmountPerChunkPlur(1, '24000', 5), '24000');
    assert.equal(archiveAmountPerChunkPlur(6, '24000', 5), '48000');
  });

  it('refuses a life, a block time or a price that is no measure', () => {
    assert.throws(() => archiveAmountPerChunkPlur(0, '24000', 5));
    assert.throws(() => archiveAmountPerChunkPlur(Number.NaN, '24000', 5));
    assert.throws(() => archiveAmountPerChunkPlur(60, '24000', 0));
    assert.throws(() => archiveAmountPerChunkPlur(60, '24000', 2.5));
    for (const price of ['0', '', '-1', '1.5', '01']) {
      assert.throws(() => archiveAmountPerChunkPlur(60, price, 5), `price "${price}"`);
    }
  });
});
