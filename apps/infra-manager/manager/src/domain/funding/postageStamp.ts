import { decodeFunctionResult, encodeFunctionData, type Hex } from 'viem';

import { ChainEvidenceError } from '../errors/ChainEvidenceError.js';

/**
 * Swarm's postage contract on Gnosis Chain, `PostageStamp` of storage-incentives, which keeps every batch's owner,
 * depth and balance. The address is the one Swarm's smart contract reference lists for Gnosis Chain
 * (docs.ethswarm.org, "Smart contracts", read 2026-10-08), which `scripts/public-leaks/allow.json` names as well.
 */
export const FUNDING_POSTAGE_STAMP = '0x45a1502382541cd610cc9068e88727426b696293';

/**
 * The contract's public getter of its `batches` mapping, which answers the members of a `Batch` in their order
 * (storage-incentives, `src/PostageStamp.sol`, read 2026-10-08).
 */
const POSTAGE_STAMP_ABI = [
  {
    type: 'function',
    name: 'batches',
    stateMutability: 'view',
    inputs: [{ name: 'batchId', type: 'bytes32' }],
    outputs: [
      { name: 'owner', type: 'address' },
      { name: 'depth', type: 'uint8' },
      { name: 'bucketDepth', type: 'uint8' },
      { name: 'immutableFlag', type: 'bool' },
      { name: 'normalisedBalance', type: 'uint256' },
      { name: 'lastUpdatedBlockNumber', type: 'uint256' },
    ],
  },
] as const;

/** The zero address, the owner the contract answers for a batch it does not hold. */
const NO_OWNER = '0x0000000000000000000000000000000000000000';

/** Six 32-byte words, the getter's whole answer. */
const BATCH_ANSWER = /^0x[0-9a-f]{384}$/;

/**
 * A batch as the postage contract holds it. `owner` is the wallet that bought it, or null when the contract holds no
 * such batch: one never bought, or one that expired and was removed. `normalisedBalance` is the balance each chunk
 * has paid in all, counted against the contract's running total of what a chunk has cost: a top-up adds its amount
 * per chunk to it, a dilution lowers it, since the balance left then pays for twice the chunks a step, and nothing
 * else raises it.
 */
export interface PostageBatchRecord {
  owner: string | null;
  depth: number;
  immutable: boolean;
  normalisedBalance: bigint;
}

/** What the funding API reads the postage contract through: `ChainRpc.call` in production. */
export interface PostageContractReader {
  call(to: string, data: string): Promise<string>;
}

/**
 * The postage contract's record of a batch, by its id, `0x` and 64 hex digits. Throws `ChainEvidenceError` for an
 * answer that is not the getter's, and whatever the reader throws when the chain does not answer.
 */
export async function readPostageBatch(chain: PostageContractReader, batchId: string): Promise<PostageBatchRecord> {
  const data = encodeFunctionData({ abi: POSTAGE_STAMP_ABI, functionName: 'batches', args: [batchId as Hex] });
  const answer = (await chain.call(FUNDING_POSTAGE_STAMP, data)).toLowerCase();
  if (!BATCH_ANSWER.test(answer)) throw new ChainEvidenceError();
  let owner: string;
  let depth: number;
  let immutable: boolean;
  let normalisedBalance: bigint;
  try {
    [owner, depth, , immutable, normalisedBalance] = decodeFunctionResult({
      abi: POSTAGE_STAMP_ABI,
      functionName: 'batches',
      data: answer as Hex,
    });
  } catch {
    throw new ChainEvidenceError();
  }
  // A byte in the contract, so a word above one is no answer of the getter's.
  if (!Number.isInteger(depth) || depth < 0 || depth > 255) throw new ChainEvidenceError();
  const holder = owner.toLowerCase();
  return { owner: holder === NO_OWNER ? null : holder, depth, immutable, normalisedBalance };
}
