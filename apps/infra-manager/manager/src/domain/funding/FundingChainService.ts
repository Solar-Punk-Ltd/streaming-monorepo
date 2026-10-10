import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerializable,
} from 'viem';

import type {
  FundingAccountAnswer,
  FundingInventory,
  FundingTransferAnswer,
  FundingTransferRequest,
  FundingTransferState,
  FundingTransferStatus,
} from '@streaming-monorepo/contracts';

import type { ChainFeeSuggestion, SentTransaction } from '../chequebook/ChainRpc.js';
import type { ChainReceipt, ChainTransaction } from '../chequebook/chainEvidence.js';
import { ChainEvidenceError } from '../errors/ChainEvidenceError.js';
import { ChainReadError } from '../errors/ChainReadError.js';
import { Logger } from '../Logger.js';
import { FundingApiError } from './FundingApiError.js';
import { FUNDING_BZZ_TOKEN, FUNDING_CHAIN_ID } from './FundingInventoryService.js';
import type { FundingTransferJournal, FundingTransferRow } from './FundingTransferJournal.js';

const logger = Logger.getInstance();

/** The gas limit the manager suggests for an xDAI transfer: a plain transfer's exact cost. */
export const FUNDING_GAS_NATIVE = 21_000n;

/** The gas limit the manager suggests for an xBZZ `transfer`, with room above its usual cost on Gnosis Chain. */
export const FUNDING_GAS_BZZ_TRANSFER = 65_000n;

/**
 * How far above the manager's own suggestion a transfer's gas limit and fee cap may go: three times. Enough for a
 * fee that rose between the admin's account read and its transfer, and a bound on what a wrong or hostile signature
 * could make the brand wallet pay.
 */
export const FUNDING_SANE_BOUND = 3n;

/**
 * How long a transfer may go without a receipt while the chain no longer holds it before it reads as `unknown`: half
 * an hour. One the chain still holds stays `submitted` however long it waits.
 */
export const FUNDING_UNKNOWN_AFTER_MS = 30 * 60 * 1000;

/**
 * How often the status route reads the chain for one request id: at most once every five seconds. The web2 admin
 * polls each unsettled transfer every three, and the journalled state is answered in between.
 */
export const FUNDING_STATUS_READ_MS = 5_000;

/** The largest amount a transfer can carry, 2^256 - 1. */
const MAX_UINT256 = 2n ** 256n - 1n;

/**
 * Whether the chain failed to answer, or answered something that is not what a chain answers: either way the
 * manager does not know, and says so as `chain_unreachable` or by keeping what it journalled.
 */
function chainSilent(err: unknown): boolean {
  return err instanceof ChainReadError || err instanceof ChainEvidenceError;
}

/** What the funding API reads and sends on the chain, `ChainRpc` in production. */
export interface FundingChain {
  balance(address: string): Promise<string>;
  tokenBalance(token: string, holder: string): Promise<string>;
  pendingNonce(address: string): Promise<number>;
  feeSuggestion(): Promise<ChainFeeSuggestion>;
  sendRawTransaction(raw: string): Promise<SentTransaction>;
  receipt(hash: string): Promise<ChainReceipt | null>;
  transaction(hash: string): Promise<ChainTransaction | null>;
}

export interface FundingChainDeps {
  /** Null when the manager has no chain endpoint for funding, FUNDING_RPC_URL or BEE_RPC_ENDPOINT. */
  chain: FundingChain | null;
  journal: FundingTransferJournal;
  /** The nodes and their wallets, read now, `FundingInventoryService`. */
  inventory: { inventory(): Promise<FundingInventory> };
  now?: () => number;
}

function noChain(): FundingApiError {
  return new FundingApiError(
    'chain_unreachable',
    'This manager has no chain endpoint for funding: set FUNDING_RPC_URL, or BEE_RPC_ENDPOINT.',
  );
}

function unreachable(): FundingApiError {
  return new FundingApiError('chain_unreachable', 'The chain did not answer the manager.');
}

function bad(message: string): FundingApiError {
  return new FundingApiError('bad_transaction', message);
}

/** The fee cap the manager suggests: twice the latest base fee, which covers it doubling, and the suggested tip. */
function suggestedMaxFee(fees: ChainFeeSuggestion): bigint {
  return 2n * BigInt(fees.baseFeePerGas) + BigInt(fees.maxPriorityFeePerGas);
}

type Refusal = Exclude<Extract<SentTransaction, { kind: 'refused' }>['reason'], 'known'>;

/** What a refusal by the chain means for the brand's operator, one sentence per kind. */
const REFUSED: Readonly<Record<Refusal, string>> = {
  nonce: 'The chain refused it: its nonce was used already.',
  funds: 'The chain refused it: the brand wallet cannot pay for it.',
  underpriced: 'The chain refused it: another transaction with its nonce pays more.',
  other: 'The chain refused it.',
};

/**
 * The chain side of the funding API: the account the web2 admin signs from, the transfers it signs, and their state.
 *
 * A transfer is checked before anything is written, journalled before it is broadcast, and broadcast at most once:
 * the same request id answers what the journal holds, and another body under it is a conflict. The manager never
 * signs; it decodes what the admin signed and holds it to exactly the transfer the request names.
 */
export class FundingChainService {
  private readonly now: () => number;
  /** When the chain was last read for each request id, for {@link FUNDING_STATUS_READ_MS}. */
  private readonly lastChainRead = new Map<string, number>();

  constructor(private readonly deps: FundingChainDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  async account(address: string): Promise<FundingAccountAnswer> {
    const chain = this.chainOrRefuse();
    try {
      const [xdaiWei, xbzzPlur, nonce, fees] = await Promise.all([
        chain.balance(address),
        chain.tokenBalance(FUNDING_BZZ_TOKEN, address),
        chain.pendingNonce(address),
        chain.feeSuggestion(),
      ]);
      return {
        address: address.toLowerCase(),
        chainId: FUNDING_CHAIN_ID,
        xdaiWei,
        xbzzPlur,
        nonce,
        maxFeePerGasWei: suggestedMaxFee(fees).toString(),
        maxPriorityFeePerGasWei: fees.maxPriorityFeePerGas,
        gasNative: FUNDING_GAS_NATIVE.toString(),
        gasBzzTransfer: FUNDING_GAS_BZZ_TRANSFER.toString(),
      };
    } catch (err) {
      if (chainSilent(err)) throw unreachable();
      throw err;
    }
  }

  async transfer(request: FundingTransferRequest): Promise<FundingTransferAnswer> {
    const raw = request.rawTransaction as Hex;
    const txHash = keccak256(raw);
    const known = await this.deps.journal.find(request.requestId);
    if (known) return this.repeat(known, request, txHash);

    // Everything that costs nothing first, so a body that is not a signed transfer reads no inventory and no chain.
    const tx = this.decoded(raw);
    let sender: string;
    try {
      sender = (await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase();
    } catch {
      throw bad('The signer of the transaction could not be recovered.');
    }
    this.holdToRequest(tx, request);
    await this.holdToNode(request);
    const chain = this.chainOrRefuse();
    let fees: ChainFeeSuggestion;
    try {
      fees = await chain.feeSuggestion();
    } catch (err) {
      if (chainSilent(err)) throw unreachable();
      throw err;
    }
    this.holdToBounds(tx, request, fees);

    const at = new Date(this.now());
    const row: FundingTransferRow = {
      requestId: request.requestId,
      nodeId: request.nodeId,
      kind: request.kind,
      toAddress: request.to,
      amount: request.amount,
      sender,
      txHash,
      state: 'unknown',
      error: null,
      blockNumber: null,
      createdAt: at,
      updatedAt: at,
    };
    if (!(await this.deps.journal.insert(row))) {
      // Another call journalled this request id between the read above and this write.
      const raced = await this.deps.journal.find(request.requestId);
      if (raced) return this.repeat(raced, request, txHash);
      throw new Error(`Transfer ${request.requestId} could not be journalled, so it was not sent.`);
    }
    logger.info(`[Funding] journalled transfer ${request.requestId}: ${request.kind} to ${request.nodeId}, ${txHash}`);

    let state: FundingTransferState = 'unknown';
    let error: string | null = null;
    try {
      const sent = await chain.sendRawTransaction(raw);
      if (sent.kind === 'sent' && sent.hash !== txHash) {
        // The journal keeps the hash of the bytes the admin signed, which is what the chain mines them under.
        logger.warn(
          `[Funding] the chain answered transfer ${request.requestId} as ${sent.hash}, not ${txHash}; keeping ${txHash}`,
        );
      }
      if (sent.kind === 'sent' || sent.reason === 'known') {
        state = 'submitted';
      } else {
        state = 'failed';
        error = REFUSED[sent.reason];
      }
    } catch (err) {
      if (!chainSilent(err)) throw err;
      error = 'The chain did not confirm it took the transaction; its state is read from its hash.';
    }
    await this.deps.journal.update(request.requestId, {
      state,
      error,
      blockNumber: null,
      updatedAt: new Date(this.now()),
    });
    logger.info(`[Funding] transfer ${request.requestId} is ${state}`);
    return { requestId: request.requestId, state, txHash };
  }

  /**
   * Where a transfer stands, refreshed from the chain while it is `submitted` or `unknown`: its receipt settles it,
   * `confirmed` on status 1 and `failed` on 0. Without a receipt, one the chain still holds is `submitted`, and one it
   * no longer knows {@link FUNDING_UNKNOWN_AFTER_MS} after it was journalled is `unknown`. A transfer a node refused
   * at the broadcast, `failed` with no block, is read for its receipt and for the pool: a node's refusal may not be
   * the chain's last word, since a node can answer with an error and keep the transaction all the same. A receipt
   * settles it, one the chain holds is `submitted` again, and one it neither mined nor holds stays as recorded, never
   * drifting to `unknown`. The chain is read at most once every {@link FUNDING_STATUS_READ_MS} for a request id; in
   * between, and when the chain does not answer or answers something it cannot read, the journalled state is
   * answered as it is.
   */
  async status(requestId: string): Promise<FundingTransferStatus> {
    const row = await this.deps.journal.find(requestId);
    if (!row) {
      throw new FundingApiError(
        'unknown_request',
        'No transfer was journalled under this request id, so sending it again under the same id is safe.',
      );
    }
    const fresh = await this.refreshed(row);
    return {
      requestId: fresh.requestId,
      state: fresh.state,
      txHash: fresh.txHash,
      blockNumber: fresh.blockNumber,
      error: fresh.error,
    };
  }

  private async refreshed(row: FundingTransferRow): Promise<FundingTransferRow> {
    const chain = this.deps.chain;
    const refusedAtBroadcast = row.state === 'failed' && row.blockNumber === null;
    if (!chain || (row.state !== 'submitted' && row.state !== 'unknown' && !refusedAtBroadcast)) return row;
    const now = this.now();
    const last = this.lastChainRead.get(row.requestId);
    if (last !== undefined && now - last < FUNDING_STATUS_READ_MS) return row;
    this.lastChainRead.set(row.requestId, now);
    let next: Pick<FundingTransferRow, 'state' | 'error' | 'blockNumber'>;
    try {
      const receipt = await chain.receipt(row.txHash);
      if (receipt) {
        next =
          receipt.status === 'success'
            ? { state: 'confirmed', error: null, blockNumber: Number(receipt.blockNumber) }
            : {
                state: 'failed',
                error: 'The transaction reverted on chain.',
                blockNumber: Number(receipt.blockNumber),
              };
      } else if (await chain.transaction(row.txHash)) {
        // A node may answer a broadcast with an error and keep the transaction in its pool all the same.
        next = { state: 'submitted', error: null, blockNumber: null };
      } else if (refusedAtBroadcast) {
        return row;
      } else if (this.now() - row.createdAt.getTime() > FUNDING_UNKNOWN_AFTER_MS) {
        next = {
          state: 'unknown',
          error: 'The chain has no receipt for it and no longer holds it.',
          blockNumber: null,
        };
      } else {
        return row;
      }
    } catch (err) {
      if (!chainSilent(err)) throw err;
      logger.debug(`[Funding] could not read transfer ${row.requestId} on the chain; answering it as journalled`);
      return row;
    }
    if (next.state === row.state && next.error === row.error && next.blockNumber === row.blockNumber) return row;
    const updated = { ...row, ...next, updatedAt: new Date(this.now()) };
    await this.deps.journal.update(row.requestId, updated);
    return updated;
  }

  /** A request id journalled already: its state for the same body, a conflict for another. */
  private repeat(row: FundingTransferRow, request: FundingTransferRequest, txHash: string): FundingTransferAnswer {
    const same =
      row.nodeId === request.nodeId &&
      row.kind === request.kind &&
      row.toAddress === request.to &&
      row.amount === request.amount &&
      row.txHash === txHash;
    if (!same) throw new FundingApiError('conflict', 'This request id names another transfer.');
    return { requestId: row.requestId, state: row.state, txHash: row.txHash };
  }

  private chainOrRefuse(): FundingChain {
    if (!this.deps.chain) throw noChain();
    return this.deps.chain;
  }

  /** The signed transaction, decoded: EIP-1559 on Gnosis Chain with no access list, or a refusal saying which not. */
  private decoded(raw: Hex): TransactionSerializable {
    let tx: TransactionSerializable;
    try {
      tx = parseTransaction(raw);
    } catch {
      throw bad('The signed transaction could not be decoded.');
    }
    if (tx.type !== 'eip1559') throw bad('Only EIP-1559 (type 2) transactions are sent.');
    if (tx.chainId !== FUNDING_CHAIN_ID) {
      throw bad(`The transaction is signed for chain ${tx.chainId ?? 'none'}, not Gnosis Chain.`);
    }
    if (tx.accessList && tx.accessList.length > 0) throw bad('The transaction carries an access list.');
    return tx;
  }

  /** The transaction is exactly the transfer the request names. */
  private holdToRequest(tx: TransactionSerializable, request: FundingTransferRequest): void {
    const amount = BigInt(request.amount);
    if (amount > MAX_UINT256) throw bad('The amount is more than a transfer can carry, 2^256 - 1.');
    const to = tx.to?.toLowerCase() ?? null;
    const value = tx.value ?? 0n;
    const data = (tx.data ?? '0x').toLowerCase();
    if (request.kind === 'xdai') {
      if (to !== request.to) throw bad('The transaction does not send to the address the request names.');
      if (value !== amount) throw bad('The transaction does not send the amount the request names.');
      if (data !== '0x') throw bad('An xDAI transfer carries no data.');
      return;
    }
    if (to !== FUNDING_BZZ_TOKEN) throw bad('An xBZZ transfer is a call of the BZZ token.');
    if (value !== 0n) throw bad('An xBZZ transfer sends no value.');
    const expected = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [getAddress(request.to), amount],
    }).toLowerCase();
    if (data !== expected) throw bad('The call is not transfer(to, amount) of what the request names.');
  }

  /** The node is in the inventory now, and the request's address is its wallet. */
  private async holdToNode(request: FundingTransferRequest): Promise<void> {
    const inventory = await this.deps.inventory.inventory();
    const nodes = [
      ...inventory.stages.flatMap((stage) => stage.nodes),
      ...(inventory.catalogue ? [inventory.catalogue] : []),
    ];
    const node = nodes.find((candidate) => candidate.nodeId === request.nodeId);
    if (!node) throw new FundingApiError('unknown_node', 'No node of this manager has this id.');
    if (node.walletAddress === null) {
      throw new FundingApiError('unknown_node', 'The node’s wallet could not be read, so nothing is sent to it.');
    }
    if (node.walletAddress !== request.to) {
      throw new FundingApiError('unknown_node', 'The address is not the wallet of this node.');
    }
  }

  /** The gas limit and the fee cap are within {@link FUNDING_SANE_BOUND} times the manager's suggestion. */
  private holdToBounds(tx: TransactionSerializable, request: FundingTransferRequest, fees: ChainFeeSuggestion): void {
    const suggestedGas = request.kind === 'xdai' ? FUNDING_GAS_NATIVE : FUNDING_GAS_BZZ_TRANSFER;
    const gas = tx.gas ?? 0n;
    if (gas < FUNDING_GAS_NATIVE) throw bad('The gas limit is below what any transfer costs.');
    if (gas > suggestedGas * FUNDING_SANE_BOUND) {
      throw bad('The gas limit is over three times the manager’s suggestion.');
    }
    const maxFee = (tx as { maxFeePerGas?: bigint }).maxFeePerGas ?? 0n;
    const tip = (tx as { maxPriorityFeePerGas?: bigint }).maxPriorityFeePerGas ?? 0n;
    if (maxFee > suggestedMaxFee(fees) * FUNDING_SANE_BOUND) {
      throw bad('The fee cap is over three times the manager’s suggestion.');
    }
    if (tip > maxFee) throw bad('The priority fee is over the fee cap.');
  }
}
