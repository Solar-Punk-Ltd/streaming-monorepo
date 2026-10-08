/**
 * How the funding API reads a batch from the postage contract: `batches(id)` on Swarm's PostageStamp on Gnosis Chain,
 * through `eth_call`, decoded into the owner, the depth and the normalised balance a stamp operation is checked and
 * settled by.
 *
 * Unit test, no chain: a fake reader answers what a contract would. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { encodeAbiParameters, getAddress, toFunctionSelector } from 'viem';

import { ChainEvidenceError } from '../../src/domain/errors/ChainEvidenceError.js';
import { ChainReadError } from '../../src/domain/errors/ChainReadError.js';
import {
  FUNDING_POSTAGE_STAMP,
  type PostageContractReader,
  readPostageBatch,
} from '../../src/domain/funding/postageStamp.js';

const BATCH = `0x${'ab'.repeat(32)}`;
const OWNER = '0x1111111111111111111111111111111111111111';

const OUTPUTS = [
  { name: 'owner', type: 'address' },
  { name: 'depth', type: 'uint8' },
  { name: 'bucketDepth', type: 'uint8' },
  { name: 'immutableFlag', type: 'bool' },
  { name: 'normalisedBalance', type: 'uint256' },
  { name: 'lastUpdatedBlockNumber', type: 'uint256' },
] as const;

function answering(answer: string | (() => never)) {
  const calls: Array<{ to: string; data: string }> = [];
  const reader: PostageContractReader = {
    call: async (to, data) => {
      calls.push({ to, data });
      return typeof answer === 'string' ? answer : answer();
    },
  };
  return { reader, calls };
}

function record(owner: string, depth: number, normalisedBalance: bigint, immutable = true): string {
  return encodeAbiParameters(OUTPUTS, [owner as `0x${string}`, depth, 16, immutable, normalisedBalance, 39_000_000n]);
}

describe('the postage contract’s record of a batch', () => {
  it('is read with batches(id) from Swarm’s PostageStamp on Gnosis Chain', async () => {
    const { reader, calls } = answering(record(OWNER, 22, 123n));
    await readPostageBatch(reader, BATCH);
    assert.equal(FUNDING_POSTAGE_STAMP, '0x45a1502382541cd610cc9068e88727426b696293');
    assert.deepEqual(calls, [
      { to: FUNDING_POSTAGE_STAMP, data: `${toFunctionSelector('batches(bytes32)')}${BATCH.slice(2)}` },
    ]);
  });

  it('answers the owner in lower case, the depth, the kind and the normalised balance', async () => {
    // A made-up owner, in the mixed case of its checksum, as the getter's decoding writes an address.
    const owner = '0x3f1a9c2b4d5e6f708192a3b4c5d6e7f809a1b2c3';
    const { reader } = answering(record(getAddress(owner), 23, 2n ** 200n + 7n, false));
    assert.notEqual(getAddress(owner), owner);
    assert.deepEqual(await readPostageBatch(reader, BATCH), {
      owner,
      depth: 23,
      immutable: false,
      normalisedBalance: 2n ** 200n + 7n,
    });
  });

  it('answers no owner for a batch the contract does not hold, which it answers as zeros', async () => {
    const { reader } = answering(record('0x0000000000000000000000000000000000000000', 0, 0n, false));
    assert.equal((await readPostageBatch(reader, BATCH)).owner, null);
  });

  it('refuses an answer that is not the getter’s: no code at the address, a word short, a depth over a byte', async () => {
    const whole = record(OWNER, 22, 1n);
    const depthWord = `${'0'.repeat(61)}100`;
    for (const answer of [
      '0x',
      whole.slice(0, -64),
      `${whole}00`,
      `${whole.slice(0, 66)}${depthWord}${whole.slice(130)}`,
    ]) {
      const { reader } = answering(answer);
      await assert.rejects(readPostageBatch(reader, BATCH), ChainEvidenceError, answer.length.toString());
    }
  });

  it('lets a chain that does not answer say so', async () => {
    const { reader } = answering(() => {
      throw new ChainReadError();
    });
    await assert.rejects(readPostageBatch(reader, BATCH), ChainReadError);
  });
});
