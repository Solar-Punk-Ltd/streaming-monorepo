import {
  type BeeStampTransaction,
  dilutionPreview,
  formatTtl,
  MAX_STAMP_DEPTH,
  plurToBzzExact,
  topUpPreview,
} from '@streaming-infra-manager/common';
import type {
  FundingInventory,
  FundingNode,
  FundingStampOperationAnswer,
  FundingStampOperationRequest,
  FundingStampOperationStatus,
  FundingTransferState,
} from '@streaming-monorepo/contracts';

import { BeeHttpError } from '../errors/BeeHttpError.js';
import { ChainEvidenceError } from '../errors/ChainEvidenceError.js';
import { ChainReadError } from '../errors/ChainReadError.js';
import { Logger } from '../Logger.js';
import { FundingApiError } from './FundingApiError.js';
import { FUNDING_STATUS_READ_MS, FUNDING_UNKNOWN_AFTER_MS } from './FundingChainService.js';
import type {
  FundingStampOperationJournal,
  FundingStampOperationPatch,
  FundingStampOperationRow,
} from './FundingStampOperationJournal.js';
import { type PostageBatchRecord, type PostageContractReader, readPostageBatch } from './postageStamp.js';

const logger = Logger.getInstance();

/**
 * The least life a dilution may leave a batch with: seven days at today's price, the batch's time left halved for
 * every step. The owner's rule (`docs/architecture/funding.md`), well above the day the postage contract itself
 * refuses a dilution under.
 */
export const FUNDING_DILUTE_MIN_SECONDS = 7 * 24 * 60 * 60;

/** The most steps a dilution takes: two, each doubling what the batch holds and halving its life. */
export const FUNDING_DILUTE_MAX_STEPS = 2;

/** What a stamp operation asks a node's Bee API, `BeeClient` in production, on its on-chain budget. */
export interface FundingStampNode {
  /** `PATCH /stamps/topup/{id}/{amount}`, for a batch id without `0x`. */
  topUpStamp(batchId: string, amountPerChunkPlur: string): Promise<BeeStampTransaction>;
  /** `PATCH /stamps/dilute/{id}/{depth}`, for a batch id without `0x`. */
  diluteStamp(batchId: string, depth: number): Promise<BeeStampTransaction>;
}

export interface FundingStampDeps {
  journal: FundingStampOperationJournal;
  /** The nodes, their wallets and their batches, read now, `FundingInventoryService`. */
  inventory: { inventory(): Promise<FundingInventory> };
  /** The Bee API of a node of the inventory, by its id, or null when this manager runs no such node now. */
  nodeApiUrl(nodeId: string): Promise<string | null>;
  /** The node at this Bee API. */
  node(apiUrl: string): FundingStampNode;
  /** The postage contract, read through FUNDING_RPC_URL or BEE_RPC_ENDPOINT; null when the manager has neither. */
  chain: PostageContractReader | null;
  now?: () => number;
}

/** What the node's answer came to, before it is written onto the row. */
interface Outcome {
  state: Exclude<FundingTransferState, 'submitted'>;
  txHash: string | null;
  error: string | null;
  /** The connection to the node was never made, so it was asked nothing: answered as `node_unreachable`. */
  unreachable: boolean;
}

/** The node as the inventory read it now, once every check of it and its batch has passed. */
interface Held {
  node: FundingNode;
  /** A top-up's cost in PLUR, `amountPerChunkPlur × 2^depth`; null for a dilution. */
  costPlur: string | null;
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

const NO_GAS = 'The node’s wallet holds no xDAI to pay the gas with.';
const NOT_REACHED = 'The node’s Bee API could not be reached, so it was asked nothing.';
const ANSWER_LOST =
  'The node’s answer was lost, so whether it went through is read from the postage contract until it shows.';

function refused(message: string): FundingApiError {
  return new FundingApiError('stamp_refused', message);
}

function noChain(): FundingApiError {
  return new FundingApiError(
    'chain_unreachable',
    'This manager has no chain endpoint for funding: set FUNDING_RPC_URL, or BEE_RPC_ENDPOINT.',
  );
}

/**
 * Whether the chain failed to answer, or answered something that is not what a chain answers: either way the
 * manager does not know, and says so as `chain_unreachable` or by keeping what it journalled.
 */
function chainSilent(err: unknown): boolean {
  return err instanceof ChainReadError || err instanceof ChainEvidenceError;
}

/** A node of the inventory everywhere it is listed: a pool's rung shared by two stages is listed under both. */
function appearancesOf(inventory: FundingInventory, nodeId: string): FundingNode[] {
  const nodes = [
    ...inventory.stages.flatMap((stage) => stage.nodes),
    ...(inventory.catalogue ? [inventory.catalogue] : []),
  ];
  return nodes.filter((node) => node.nodeId === nodeId);
}

/** Life left as a sentence says it: "6d 23h of life", or "no life". */
function lifeOf(seconds: number): string {
  return seconds > 0 ? `${formatTtl(seconds)} of life` : 'no life';
}

/** What the request asks, for a log line. */
function described(row: FundingStampOperationRow): string {
  return row.kind === 'topup'
    ? `top-up of ${row.batchId} by ${row.amountPerChunkPlur} PLUR a chunk`
    : `dilution of ${row.batchId} from depth ${row.expectedDepth} to ${row.newDepth}`;
}

/**
 * Bee's own words for a refusal, the `message` of the JSON body it answered with, which `BeeClient` keeps in its
 * error's text after the status. Null when the body was not Bee's JSON. Control characters are dropped and the words
 * cut at 200 characters, since they travel on to the web2 admin's operator.
 */
function beeWords(err: BeeHttpError): string | null {
  const marker = `→ ${err.status}: `;
  const at = err.message.indexOf(marker);
  if (at < 0) return null;
  let body: unknown;
  try {
    body = JSON.parse(err.message.slice(at + marker.length));
  } catch {
    return null;
  }
  const message = (body as { message?: unknown } | null)?.message;
  if (typeof message !== 'string') return null;
  const words = message
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return words || null;
}

/**
 * Whether a status Bee answered a stamp operation with means it sent nothing: every 4xx (402 for a wallet that cannot
 * pay, 429 while another on-chain operation of the node's runs), 501 on a node with no postage contract and 503 while
 * it syncs. Bee checks all of those before it sends a transaction. A 500 is not one of them: Bee answers 500 as well
 * when it sent the transaction and then lost sight of it, waiting for its receipt (bee `pkg/api/postage.go`).
 */
function sentNothing(status: number): boolean {
  return (status >= 400 && status < 500) || status === 501 || status === 503;
}

/**
 * One failure of a connection to the node that means it was never made, so nothing reached the node: refused, no route
 * to it, no such name, or a connect that timed out. An `AggregateError`, which fetch answers when it tried every
 * address of a name, is one only when every one of its errors is.
 */
function connectionNeverMade(failure: object): boolean {
  const { code, syscall, errors } = failure as { code?: unknown; syscall?: unknown; errors?: unknown };
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.every((each) => typeof each === 'object' && each !== null && connectionNeverMade(each));
  }
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return true;
  if (syscall === 'connect') return code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH';
  if (syscall === 'getaddrinfo') return code === 'ENOTFOUND' || code === 'EAI_AGAIN';
  return false;
}

/** Whether a failed call never reached the node. `BeeClient` wraps fetch's error, and fetch the socket's. */
function neverReached(err: unknown): boolean {
  let failure: unknown = err;
  for (let depth = 0; depth < 4 && typeof failure === 'object' && failure !== null; depth += 1) {
    if (connectionNeverMade(failure)) return true;
    failure = (failure as { cause?: unknown }).cause;
  }
  return false;
}

/** What a failed call of the node comes to. */
function failureOutcome(err: unknown): Outcome {
  if (err instanceof BeeHttpError) {
    const words = beeWords(err);
    const said = words ? `${err.status}, “${words}”` : `${err.status}`;
    if (sentNothing(err.status)) {
      return { state: 'failed', txHash: null, error: `The node refused it (${said}).`, unreachable: false };
    }
    return {
      state: 'unknown',
      txHash: null,
      error: `The node answered ${said}, which does not say whether it sent the transaction, so that is read from the postage contract until it shows.`,
      unreachable: false,
    };
  }
  if (neverReached(err)) return { state: 'failed', txHash: null, error: NOT_REACHED, unreachable: true };
  return { state: 'unknown', txHash: null, error: ANSWER_LOST, unreachable: false };
}

/** Whether the postage contract shows the change a row asked for, since the balance before was read. */
function landed(row: FundingStampOperationRow, record: PostageBatchRecord): boolean {
  if (record.owner === null) return false;
  if (row.kind === 'dilute') return row.newDepth !== null && record.depth >= row.newDepth;
  return (
    row.amountPerChunkPlur !== null &&
    record.normalisedBalance - BigInt(row.normalisedBalanceBefore) >= BigInt(row.amountPerChunkPlur)
  );
}

/** Why a row the postage contract never showed the change of failed, in a sentence. */
function notLanded(row: FundingStampOperationRow): string {
  const change = row.kind === 'topup' ? 'top-up' : `dilution to depth ${row.newDepth}`;
  return `The postage contract shows no ${change} of the batch thirty minutes after the node was asked.`;
}

function answerOf(row: FundingStampOperationRow): FundingStampOperationAnswer {
  return { requestId: row.requestId, kind: row.kind, state: row.state, txHash: row.txHash };
}

/**
 * The funding API's stamp operations: a top-up or a dilution of the batch one of the manager's nodes uploads with,
 * which that node carries out through its Bee API and pays for from its own wallet.
 *
 * An operation is checked before anything is written, against the inventory read now and the postage contract read
 * now: the node is one of the manager's and the batch is the one it uploads with, wherever the node is listed; the
 * batch was read, has not expired, is usable and is at the depth the admin saw; a top-up's cost in xBZZ is in the
 * node's wallet, and a dilution takes one or two steps and leaves seven days. The node needs some xDAI for the gas
 * either way, checked here because Bee's own refusal of an empty gas wallet is no clear sentence. The postage
 * contract must hold the batch at that depth, and only the wallet that bought a batch may dilute it.
 *
 * Then the operation is journalled, with the batch's balance in the postage contract, and the node asked once. Bee
 * answers once the transaction is mined, so its answer with a hash is `confirmed`. A refusal is `failed` with its
 * sentence, and a node never reached `failed` as well, answered as `node_unreachable`. An answer that was lost, or a
 * 500, which Bee answers for a transaction it sent and then lost sight of too, is `unknown`, and the status route
 * reads the postage contract for it. The same request id answers what the journal holds and never asks the node
 * again; another body under it is a conflict.
 */
export class FundingStampService {
  private readonly now: () => number;
  /** When the chain was last read for each request id, for {@link FUNDING_STATUS_READ_MS}. */
  private readonly lastChainRead = new Map<string, number>();

  constructor(private readonly deps: FundingStampDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  async operate(request: FundingStampOperationRequest): Promise<FundingStampOperationAnswer> {
    const known = await this.deps.journal.find(request.requestId);
    if (known) return this.repeat(known, request);

    const { node, costPlur } = this.held(await this.deps.inventory.inventory(), request);
    const apiUrl = await this.deps.nodeApiUrl(request.nodeId);
    if (apiUrl === null) throw new FundingApiError('unknown_node', 'No node of this manager has this id.');
    const before = await this.onChain(request, node);

    const at = new Date(this.now());
    const row: FundingStampOperationRow = {
      requestId: request.requestId,
      kind: request.kind,
      nodeId: request.nodeId,
      batchId: request.batchId,
      expectedDepth: request.expectedDepth,
      newDepth: request.kind === 'dilute' ? request.newDepth : null,
      amountPerChunkPlur: request.kind === 'topup' ? request.amountPerChunkPlur : null,
      costPlur,
      normalisedBalanceBefore: before.normalisedBalance.toString(),
      txHash: null,
      state: 'unknown',
      error: null,
      createdAt: at,
      updatedAt: at,
    };
    if (!(await this.deps.journal.insert(row))) {
      // Another call journalled this request id between the read above and this write.
      const raced = await this.deps.journal.find(request.requestId);
      if (raced) return this.repeat(raced, request);
      throw new Error(`Stamp operation ${request.requestId} could not be journalled, so the node was not asked.`);
    }
    logger.info(`[Funding] journalled stamp operation ${row.requestId}: ${described(row)} on ${row.nodeId}`);

    const outcome = await this.ask(apiUrl, request);
    const { row: settled, applied } = await this.record(row, outcome);
    logger.info(
      `[Funding] stamp operation ${row.requestId} is ${settled.state}${settled.txHash ? `, ${settled.txHash}` : ''}${
        settled.error ? `: ${settled.error}` : ''
      }`,
    );
    if (outcome.unreachable && applied) throw new FundingApiError('node_unreachable', NOT_REACHED);
    return answerOf(settled);
  }

  /**
   * Where an operation stands. An `unknown` one is settled from the postage contract: a top-up landed once the batch's
   * balance there has grown by the amount, a dilution once the batch is at the new depth or deeper, and either is
   * `failed` once {@link FUNDING_UNKNOWN_AFTER_MS} have passed since it was journalled with no sign of it. The chain is
   * read at most once every {@link FUNDING_STATUS_READ_MS} for a request id; in between, and when the chain does not
   * answer or answers something it cannot read, the journalled state is answered as it is.
   */
  async status(requestId: string): Promise<FundingStampOperationStatus> {
    const row = await this.deps.journal.find(requestId);
    if (!row) {
      throw new FundingApiError(
        'unknown_request',
        'No stamp operation was journalled under this request id, so sending it again under the same id is safe.',
      );
    }
    const fresh = await this.refreshed(row);
    return {
      requestId: fresh.requestId,
      kind: fresh.kind,
      state: fresh.state,
      txHash: fresh.txHash,
      error: fresh.error,
    };
  }

  private async refreshed(row: FundingStampOperationRow): Promise<FundingStampOperationRow> {
    const chain = this.deps.chain;
    if (!chain || row.state !== 'unknown') return row;
    const now = this.now();
    const last = this.lastChainRead.get(row.requestId);
    if (last !== undefined && now - last < FUNDING_STATUS_READ_MS) return row;
    this.lastChainRead.set(row.requestId, now);
    let record: PostageBatchRecord;
    try {
      record = await readPostageBatch(chain, row.batchId);
    } catch (err) {
      if (!chainSilent(err)) throw err;
      logger.debug(
        `[Funding] could not read the batch of stamp operation ${row.requestId}; answering it as journalled`,
      );
      return row;
    }
    let next: Pick<FundingStampOperationRow, 'state' | 'error'>;
    if (landed(row, record)) {
      next = { state: 'confirmed', error: null };
    } else if (now - row.createdAt.getTime() > FUNDING_UNKNOWN_AFTER_MS) {
      next = { state: 'failed', error: notLanded(row) };
    } else {
      return row;
    }
    const patch: FundingStampOperationPatch = { ...next, txHash: row.txHash, updatedAt: new Date(now) };
    if (!(await this.deps.journal.update(row.requestId, 'unknown', patch))) {
      // The node's answer was written meanwhile, and it stands.
      return (await this.deps.journal.find(row.requestId)) ?? row;
    }
    this.lastChainRead.delete(row.requestId);
    logger.info(`[Funding] stamp operation ${row.requestId} is ${patch.state}, read from the postage contract`);
    return { ...row, ...patch };
  }

  /** A request id journalled already: its state for the same body, a conflict for another. */
  private repeat(row: FundingStampOperationRow, request: FundingStampOperationRequest): FundingStampOperationAnswer {
    const same =
      row.kind === request.kind &&
      row.nodeId === request.nodeId &&
      row.batchId === request.batchId &&
      row.expectedDepth === request.expectedDepth &&
      (request.kind === 'topup'
        ? row.amountPerChunkPlur === request.amountPerChunkPlur
        : row.newDepth === request.newDepth);
    if (!same) throw new FundingApiError('conflict', 'This request id names another stamp operation.');
    return answerOf(row);
  }

  /** The node and its batch, checked against the inventory read now, and what the operation costs. */
  private held(inventory: FundingInventory, request: FundingStampOperationRequest): Held {
    const appearances = appearancesOf(inventory, request.nodeId);
    if (appearances.length === 0) throw new FundingApiError('unknown_node', 'No node of this manager has this id.');
    const node = appearances.find((candidate) => candidate.batch?.batchId === request.batchId);
    const batch = node?.batch;
    if (!node || !batch) {
      throw refused(
        appearances.some((candidate) => candidate.batch)
          ? 'The batch is not the one this node uploads with, so the manager does not change it.'
          : 'This node uploads with no batch of the manager’s, so there is none to change.',
      );
    }
    if (batch.readError !== null) {
      throw refused(`The batch could not be read, so it is not changed now. ${batch.readError}`);
    }
    if (batch.depth === null || batch.ttlSeconds === null) {
      throw refused('The node did not say the batch’s depth or its time left, so it is not changed now.');
    }
    if (batch.ttlSeconds === 0) throw refused('The batch has expired, and nothing revives an expired batch.');
    if (batch.usable !== true) throw refused('The node does not call the batch usable, so it is not changed now.');
    if (batch.depth !== request.expectedDepth) {
      throw refused(
        `The batch is at depth ${batch.depth} now, not the depth ${request.expectedDepth} the request was made for.`,
      );
    }
    const reading = { depth: batch.depth, batchTTL: batch.ttlSeconds };

    if (request.kind === 'topup') {
      const costPlur = topUpPreview(reading, request.amountPerChunkPlur, null).costPlur;
      if (costPlur === null) throw refused('The cost of this top-up could not be worked out.');
      const wallet = this.walletOf(node);
      if (wallet.xbzzPlur < BigInt(costPlur)) {
        throw refused(
          `The node’s wallet holds ${plurToBzzExact(wallet.xbzzPlur)} xBZZ, less than the ${plurToBzzExact(BigInt(costPlur))} xBZZ this top-up costs.`,
        );
      }
      if (wallet.xdaiWei === 0n) throw refused(NO_GAS);
      return { node, costPlur };
    }

    const steps = request.newDepth - batch.depth;
    if (steps < 1 || steps > FUNDING_DILUTE_MAX_STEPS) {
      throw refused('A dilution takes a batch one step deeper, or two.');
    }
    const after = dilutionPreview(reading, request.newDepth);
    if (after === null || after.ttl === null) {
      throw refused(`The manager dilutes a batch to depth ${MAX_STAMP_DEPTH} at most.`);
    }
    if (after.ttl < FUNDING_DILUTE_MIN_SECONDS) {
      throw refused(
        `Diluting it ${steps === 1 ? 'one step' : 'two steps'} would leave it ${lifeOf(after.ttl)}, under the 7 days a dilution must leave. Top it up first.`,
      );
    }
    if (this.walletOf(node).xdaiWei === 0n) throw refused(NO_GAS);
    return { node, costPlur: null };
  }

  /** The node's wallet as the inventory read it, or a refusal when it could not be read. */
  private walletOf(node: FundingNode): { xbzzPlur: bigint; xdaiWei: bigint } {
    if (node.xbzzPlur === null || node.xdaiWei === null) {
      throw refused(
        `The node’s wallet could not be read, so whether it can pay is not known. ${node.readError ?? ''}`.trim(),
      );
    }
    return { xbzzPlur: BigInt(node.xbzzPlur), xdaiWei: BigInt(node.xdaiWei) };
  }

  /**
   * The postage contract's record of the batch, read before the node is asked, for the balance the status route
   * settles a lost answer by. It must hold the batch at the depth the request was made for, which the chain may show
   * moved before the node has read it back, and only the wallet that bought a batch may dilute it.
   */
  private async onChain(request: FundingStampOperationRequest, node: FundingNode): Promise<PostageBatchRecord> {
    const chain = this.deps.chain;
    if (!chain) throw noChain();
    let record: PostageBatchRecord;
    try {
      record = await readPostageBatch(chain, request.batchId);
    } catch (err) {
      if (chainSilent(err)) throw new FundingApiError('chain_unreachable', 'The chain did not answer the manager.');
      throw err;
    }
    if (record.owner === null) throw refused('The postage contract holds no such batch: it expired and was removed.');
    if (record.depth !== request.expectedDepth) {
      throw refused(
        `The postage contract has the batch at depth ${record.depth}, not the depth ${request.expectedDepth} the request was made for.`,
      );
    }
    if (request.kind === 'dilute' && record.owner !== node.walletAddress) {
      throw refused(
        'Another wallet than this node’s bought the batch, and only the wallet that bought it can dilute it.',
      );
    }
    return record;
  }

  /** Asks the node once, and reads what its answer, or its silence, means. Never throws. */
  private async ask(apiUrl: string, request: FundingStampOperationRequest): Promise<Outcome> {
    const node = this.deps.node(apiUrl);
    // Bee's spelling of a batch id in a path, without `0x`.
    const batchId = request.batchId.slice(2);
    let answer: BeeStampTransaction;
    try {
      answer =
        request.kind === 'topup'
          ? await node.topUpStamp(batchId, request.amountPerChunkPlur)
          : await node.diluteStamp(batchId, request.newDepth);
    } catch (err) {
      return failureOutcome(err);
    }
    const txHash: unknown = (answer as { txHash?: unknown } | null)?.txHash;
    if (typeof txHash !== 'string' || !TX_HASH.test(txHash)) {
      return {
        state: 'unknown',
        txHash: null,
        error:
          'The node answered with no transaction hash, so whether it went through is read from the postage contract until it shows.',
        unreachable: false,
      };
    }
    return { state: 'confirmed', txHash: txHash.toLowerCase(), error: null, unreachable: false };
  }

  /**
   * Writes the node's answer onto the row while it is still `unknown`, and answers the row as it stands after and
   * whether the answer was written. The status route may have settled the row from the postage contract while the node
   * was asked: a row it confirmed takes the hash the node answered with, and anything else it settled stands.
   */
  private async record(
    row: FundingStampOperationRow,
    outcome: Outcome,
  ): Promise<{ row: FundingStampOperationRow; applied: boolean }> {
    const patch: FundingStampOperationPatch = {
      state: outcome.state,
      txHash: outcome.txHash,
      error: outcome.error,
      updatedAt: new Date(this.now()),
    };
    if (await this.deps.journal.update(row.requestId, 'unknown', patch)) {
      return { row: { ...row, ...patch }, applied: true };
    }
    const current = (await this.deps.journal.find(row.requestId)) ?? row;
    if (current.state === 'confirmed' && current.txHash === null && outcome.txHash !== null) {
      const withHash: FundingStampOperationPatch = { ...patch, state: 'confirmed', error: null };
      if (await this.deps.journal.update(row.requestId, 'confirmed', withHash)) {
        return { row: { ...current, ...withHash }, applied: true };
      }
    }
    return { row: current, applied: false };
  }
}
