import { ChainReadError } from '../errors/ChainReadError.js';
import { ChequebookConfigurationError } from '../errors/ChequebookConfigurationError.js';
import { ChainRpc } from './ChainRpc.js';
import { tokenAddressForChain } from './transactionIdentity.js';

export type ChequebookChainReader = Pick<
  ChainRpc,
  'chainId' | 'transactionCount' | 'transaction' | 'receipt' | 'blockHeader' | 'blockTransactions'
>;
/**
 * Reads, again, the endpoint a saved transfer's node was started with. Null when it names none. Only the Docker route
 * can answer one, and the registry no longer calls it; the parameter goes with that route's cleanup.
 */
export type ReadNodeChainEndpoint = (signal?: AbortSignal) => Promise<string | null>;

/** An endpoint a transfer may read the chain through: http or https, a host, and no user information or fragment. */
function usableChainEndpoint(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

/**
 * Where a transfer reads the chain: its preparation, its receipts and their
 * finality, and recovery. CHEQUEBOOK_RPC_ENDPOINTS wins for every chain it
 * names. Then the manager's own default endpoint, `defaultEndpoint`
 * (FUNDING_RPC_URL, or else BEE_RPC_ENDPOINT), for whichever chain it answers
 * for. With neither, a transfer is refused as `chain_endpoint_missing`. The
 * manager reads the chain through its own settings alone, never through a node
 * or its container, so a node it reaches only through its Bee API is read the
 * same as any other.
 *
 * Every endpoint is held to the same shape rules and must answer the chain it
 * is asked for before use: one that does not answer is `chain_unreachable`, and
 * one on another chain is `wrong_chain`. No endpoint is ever logged, answered
 * or put in an error, and a money request, an operation record or a Bee answer
 * never chooses one.
 */
export class ChequebookChainRegistry {
  #endpoints = new Map<number, string>();
  #createReader: (endpoint: string) => ChequebookChainReader;
  #defaultEndpoint: string | undefined;

  constructor(
    configuration: string | undefined,
    createReader: (endpoint: string) => ChequebookChainReader = (endpoint) => new ChainRpc(endpoint),
    options: { defaultEndpoint?: string | undefined } = {},
  ) {
    this.#createReader = createReader;
    if (options.defaultEndpoint !== undefined && !usableChainEndpoint(options.defaultEndpoint))
      throw new ChequebookConfigurationError('chain_setting_invalid');
    this.#defaultEndpoint = options.defaultEndpoint;
    try {
      const configured: unknown = configuration ? JSON.parse(configuration) : {};
      if (!configured || typeof configured !== 'object' || Array.isArray(configured))
        throw new ChequebookConfigurationError();
      for (const [key, value] of Object.entries(configured)) {
        const chainId = Number(key);
        if (
          !/^[1-9][0-9]*$/.test(key) ||
          !Number.isSafeInteger(chainId) ||
          !tokenAddressForChain(chainId) ||
          !usableChainEndpoint(value)
        ) {
          throw new ChequebookConfigurationError();
        }
        this.#endpoints.set(chainId, value);
      }
    } catch {
      throw new ChequebookConfigurationError('chain_setting_invalid');
    }
  }

  /** The configured endpoint for a chain, or else the manager's default one, and nothing else. */
  async forChain(chainId: number, signal?: AbortSignal): Promise<ChequebookChainReader> {
    try {
      if (!tokenAddressForChain(chainId)) throw new ChainReadError('unsupported_chain');
      const endpoint = this.#endpoints.get(chainId) ?? this.#defaultEndpoint;
      if (!endpoint) throw new ChainReadError('chain_endpoint_missing');
      return await this.verified(endpoint, chainId, signal);
    } catch (error) {
      throw ChainReadError.keeping(error);
    }
  }

  /**
   * A transfer being prepared, read as `forChain`. The endpoint the node was started with, which only the Docker route
   * can name, is taken and never used: the signature stays for that route until it is removed.
   */
  async forPreparedNode(
    chainId: number,
    _nodeAddress: string,
    _nodeEndpoint: string | null,
    signal?: AbortSignal,
  ): Promise<ChequebookChainReader> {
    return this.forChain(chainId, signal);
  }

  /**
   * A saved transfer's receipts, finality and recovery, read as `forChain`. The node is never read for an endpoint:
   * the reader passed for it is never called, and the signature stays for the Docker route until it is removed.
   */
  async forSavedNode(
    chainId: number,
    _nodeAddress: string,
    _readNodeEndpoint: ReadNodeChainEndpoint,
    signal?: AbortSignal,
  ): Promise<ChequebookChainReader> {
    return this.forChain(chainId, signal);
  }

  /** A reader for the endpoint, once it answered the chain it is meant to read. */
  private async verified(endpoint: string, chainId: number, signal?: AbortSignal): Promise<ChequebookChainReader> {
    signal?.throwIfAborted();
    const reader = this.#createReader(endpoint);
    let answered: number;
    try {
      answered = await reader.chainId(signal);
    } catch {
      throw new ChainReadError('chain_unreachable');
    }
    if (answered !== chainId) throw new ChainReadError('wrong_chain');
    signal?.throwIfAborted();
    return reader;
  }
}
