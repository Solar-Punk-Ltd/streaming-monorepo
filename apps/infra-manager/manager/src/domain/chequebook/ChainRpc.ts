import { ChainEvidenceError } from '../errors/ChainEvidenceError.js';
import { ChainReadError } from '../errors/ChainReadError.js';
import {
  chainAddress,
  chainHash,
  chainIdFromQuantity,
  chainObject,
  chainQuantity,
  parseChainReceipt,
  parseChainTransaction,
  type ChainReceipt,
  type ChainTransaction,
} from './chainEvidence.js';

export interface ChainBlockHeader {
  readonly number: string;
  readonly hash: string;
  readonly parentHash: string;
}

export interface ChainBlock extends ChainBlockHeader {
  readonly transactions: readonly ChainTransaction[];
}

interface ChainRpcOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
}

type ReadMethod =
  | 'eth_chainId'
  | 'eth_getBalance'
  | 'eth_call'
  | 'eth_maxPriorityFeePerGas'
  | 'eth_getTransactionCount'
  | 'eth_getTransactionByHash'
  | 'eth_getTransactionReceipt'
  | 'eth_getBlockByNumber'
  | 'eth_getBlockTransactionCountByHash';

type BlockReference = bigint | 'latest' | 'finalized';

function blockTag(block: BlockReference): string {
  if (block === 'latest' || block === 'finalized') return block;
  const tag = `0x${block.toString(16)}`;
  chainQuantity(tag);
  return tag;
}

function blockHeader(value: unknown, expected: BlockReference): ChainBlockHeader {
  const block = chainObject(value);
  const number = chainQuantity(block.number).toString();
  if (typeof expected === 'bigint' && number !== expected.toString()) throw new ChainEvidenceError();
  return Object.freeze({ number, hash: chainHash(block.hash), parentHash: chainHash(block.parentHash) });
}

/** What `sendRawTransaction` came to: the hash the chain took it under, or the kind of refusal, never its words. */
export type SentTransaction =
  | { kind: 'sent'; hash: string }
  | { kind: 'refused'; reason: 'nonce' | 'funds' | 'known' | 'underpriced' | 'other' };

/** The fees a type 2 transaction is priced against: the latest block's base fee and the node's suggested tip. */
export interface ChainFeeSuggestion {
  baseFeePerGas: string;
  maxPriorityFeePerGas: string;
}

/** `balanceOf(address)` of an ERC-20 token, its selector and the address as one 32-byte word. */
function balanceOfData(holder: string): string {
  return `0x70a08231${chainAddress(holder).slice(2).padStart(64, '0')}`;
}

/**
 * The kind of a refusal by the words a node uses, so none of its words, which may carry anything, travels on. Both
 * geth's sentences ("already known", "nonce too low") and Nethermind's codes (`AlreadyKnown`, `OldNonce`,
 * `InsufficientFunds`, `FeeTooLow`), which most Gnosis Chain endpoints answer with, are read: the words are compared
 * with whitespace removed and case folded, in the message and in a `data` string beside it.
 */
function refusalReason(error: Record<string, unknown>): Extract<SentTransaction, { kind: 'refused' }>['reason'] {
  const words = [error.message, error.data].filter((part): part is string => typeof part === 'string').join(' ');
  const text = words.replace(/\s+/g, '').toLowerCase();
  if (text.includes('alreadyknown')) return 'known';
  if (text.includes('noncetoolow') || text.includes('oldnonce')) return 'nonce';
  if (text.includes('insufficientfunds')) return 'funds';
  if (text.includes('underpriced') || text.includes('feetoolow')) return 'underpriced';
  return 'other';
}

/** Whether a JSON-RPC answer carries an error: an error object, never a null one beside a result. */
function carriesError(
  body: Record<string, unknown>,
): body is Record<string, unknown> & { error: Record<string, unknown> } {
  const error = body.error;
  return error !== null && typeof error === 'object' && !Array.isArray(error);
}

/**
 * Bounded observations, and one write: `sendRawTransaction`, which the funding API sends a transfer the web2 admin
 * signed with. `call` is an observation too, a read-only contract call. The endpoint and upstream diagnostics never
 * enter returned errors or answers.
 */
export class ChainRpc {
  #endpoint: string;
  #timeoutMs: number;
  #maxResponseBytes: number;
  #nextId = 1;

  constructor(endpoint: string, options: ChainRpcOptions = {}) {
    try {
      const url = new URL(endpoint);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ChainReadError();
    } catch {
      throw new ChainReadError();
    }
    this.#endpoint = endpoint;
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.#maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
    if (
      !Number.isInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1 ||
      this.#timeoutMs > 60_000 ||
      !Number.isInteger(this.#maxResponseBytes) ||
      this.#maxResponseBytes < 1 ||
      this.#maxResponseBytes > 16 * 1024 * 1024
    )
      throw new ChainReadError();
  }

  async chainId(signal?: AbortSignal): Promise<number> {
    return chainIdFromQuantity(await this.#call('eth_chainId', [], signal));
  }

  async transactionCount(address: string, block: bigint, signal?: AbortSignal): Promise<string> {
    return chainQuantity(
      await this.#call('eth_getTransactionCount', [chainAddress(address), blockTag(block)], signal),
    ).toString();
  }

  /** The xDAI of an address, in wei, at the latest block. */
  async balance(address: string, signal?: AbortSignal): Promise<string> {
    return chainQuantity(await this.#call('eth_getBalance', [chainAddress(address), 'latest'], signal)).toString();
  }

  /** An ERC-20 token's balance of an address, in its base units, at the latest block. */
  async tokenBalance(token: string, holder: string, signal?: AbortSignal): Promise<string> {
    const result = await this.#call(
      'eth_call',
      [{ to: chainAddress(token), data: balanceOfData(holder) }, 'latest'],
      signal,
    );
    if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result)) throw new ChainReadError();
    return BigInt(result).toString();
  }

  /**
   * A read-only call of a contract at the latest block, `eth_call` with no sender and no value, answered as the bytes
   * the call returned, in lower case. The funding API reads the postage contract's record of a batch with it. An answer
   * that is not whole bytes in hex throws `ChainReadError`, like any answer that is not one.
   */
  async call(to: string, data: string, signal?: AbortSignal): Promise<string> {
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) throw new ChainReadError();
    const result = await this.#call('eth_call', [{ to: chainAddress(to), data: data.toLowerCase() }, 'latest'], signal);
    if (typeof result !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(result)) throw new ChainReadError();
    return result.toLowerCase();
  }

  /** The nonce the next transaction from this address takes, counting the ones still pending. */
  async pendingNonce(address: string, signal?: AbortSignal): Promise<number> {
    const nonce = chainQuantity(
      await this.#call('eth_getTransactionCount', [chainAddress(address), 'pending'], signal),
    );
    if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new ChainReadError();
    return Number(nonce);
  }

  /** The latest block's base fee and the node's suggested priority fee, both in wei per gas. */
  async feeSuggestion(signal?: AbortSignal): Promise<ChainFeeSuggestion> {
    const block = await this.#call('eth_getBlockByNumber', ['latest', false], signal);
    let baseFeePerGas: bigint;
    try {
      baseFeePerGas = chainQuantity(chainObject(block).baseFeePerGas);
    } catch {
      throw new ChainReadError();
    }
    const tip = chainQuantity(await this.#call('eth_maxPriorityFeePerGas', [], signal));
    return { baseFeePerGas: baseFeePerGas.toString(), maxPriorityFeePerGas: tip.toString() };
  }

  /**
   * Sends a signed transaction. A node's refusal is answered by its kind alone, and anything else that stops the
   * call, a timeout, a lost connection or an answer that is not JSON-RPC, throws `ChainReadError`: then the
   * transaction may or may not have reached the chain, which only its hash can tell later.
   */
  async sendRawTransaction(raw: string, signal?: AbortSignal): Promise<SentTransaction> {
    if (!/^0x([0-9a-fA-F]{2})+$/.test(raw)) throw new ChainReadError();
    const body = await this.#post('eth_sendRawTransaction', [raw], signal);
    if (carriesError(body)) return { kind: 'refused', reason: refusalReason(body.error) };
    if (!Object.hasOwn(body, 'result')) throw new ChainReadError();
    let hash: string;
    try {
      hash = chainHash(body.result);
    } catch {
      throw new ChainReadError();
    }
    return { kind: 'sent', hash };
  }

  async transaction(hash: string, signal?: AbortSignal): Promise<ChainTransaction | null> {
    const expected = chainHash(hash);
    const value = await this.#call('eth_getTransactionByHash', [expected], signal);
    if (value === null) return null;
    const transaction = parseChainTransaction(value);
    if (transaction.hash !== expected) throw new ChainEvidenceError();
    return transaction;
  }

  async receipt(hash: string, signal?: AbortSignal): Promise<ChainReceipt | null> {
    const expected = chainHash(hash);
    const receipt = parseChainReceipt(await this.#call('eth_getTransactionReceipt', [expected], signal));
    if (receipt && receipt.transactionHash !== expected) throw new ChainEvidenceError();
    return receipt;
  }

  async blockHeader(block: BlockReference, signal?: AbortSignal): Promise<ChainBlockHeader | null> {
    const value = await this.#call('eth_getBlockByNumber', [blockTag(block), false], signal);
    return value === null ? null : blockHeader(value, block);
  }

  async blockTransactions(block: bigint, nodeAddress: string, signal?: AbortSignal): Promise<ChainBlock | null> {
    const sender = chainAddress(nodeAddress);
    const value = await this.#call('eth_getBlockByNumber', [blockTag(block), true], signal);
    if (value === null) return null;
    const header = blockHeader(value, block);
    const rawTransactions = chainObject(value).transactions;
    if (!Array.isArray(rawTransactions)) throw new ChainEvidenceError();
    const transactions: ChainTransaction[] = [];
    const seenHashes = new Set<string>();
    for (const [index, value] of rawTransactions.entries()) {
      const transaction = chainObject(value);
      const hash = chainHash(transaction.hash);
      if (seenHashes.has(hash) || chainQuantity(transaction.transactionIndex) !== BigInt(index))
        throw new ChainEvidenceError();
      seenHashes.add(hash);
      if (
        chainHash(transaction.blockHash) !== header.hash ||
        chainQuantity(transaction.blockNumber).toString() !== header.number
      )
        throw new ChainEvidenceError();
      if (chainAddress(transaction.from) === sender) transactions.push(parseChainTransaction(value));
    }
    const count = chainQuantity(await this.#call('eth_getBlockTransactionCountByHash', [header.hash], signal));
    if (count !== BigInt(rawTransactions.length)) throw new ChainEvidenceError();
    return Object.freeze({ ...header, transactions: Object.freeze(transactions) });
  }

  async #call(method: ReadMethod, params: unknown[], callerSignal?: AbortSignal): Promise<unknown> {
    const body = await this.#post(method, params, callerSignal);
    // A read keeps the strict envelope: any `error` member, a null one included, is refused.
    if (Object.hasOwn(body, 'error') || !Object.hasOwn(body, 'result')) throw new ChainReadError();
    return body.result;
  }

  /** One JSON-RPC call, answered as the response object, its `error` included; anything else throws. */
  async #post(
    method: ReadMethod | 'eth_sendRawTransaction',
    params: unknown[],
    callerSignal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const cleanup = new AbortController();
    const signal = AbortSignal.any([
      cleanup.signal,
      AbortSignal.timeout(this.#timeoutMs),
      ...(callerSignal ? [callerSignal] : []),
    ]);
    const id = this.#nextId++;
    try {
      signal.throwIfAborted();
      const response = await fetch(this.#endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        redirect: 'error',
        signal,
      });
      if (!response.ok || !response.body || Number(response.headers.get('content-length')) > this.#maxResponseBytes)
        throw new ChainReadError();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > this.#maxResponseBytes) throw new ChainReadError();
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      signal.throwIfAborted();
      const body = chainObject(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))),
      );
      if (body.jsonrpc !== '2.0' || body.id !== id) throw new ChainReadError();
      return body;
    } catch {
      throw new ChainReadError();
    } finally {
      cleanup.abort();
    }
  }
}
