import {
  ARCHIVE_PURCHASE_SETTLE_MS,
  type ArchivePurchaseSettleContext,
  archivePurchaseNodeLabel,
  formatTtl,
  getErrorMessage,
  isPurchasedArchiveBatch,
  plurToBzzExact,
} from '@streaming-infra-manager/common';
import {
  archiveBatchCostPlur,
  type FundingInventory,
  type FundingNode,
  type FundingStampPurchaseAnswer,
  type FundingStampPurchaseRequest,
  type FundingStampPurchaseStatus,
  type FundingTransferState,
} from '@streaming-monorepo/contracts';

import type { Profile } from '../../types/index.js';
import type { BeeStamp, BuyStampInput } from '../BeeClient.js';
import { BeeHttpError } from '../errors/BeeHttpError.js';
import { Logger } from '../Logger.js';
import type { ArchiveBatchDesignator, ArchiveBatchReader } from '../stages/archiveBatchPorts.js';
import { type CatalogueDesignationRow, isDesignated, isMoving } from '../stages/CatalogueDesignationRepository.js';
import { FundingApiError } from './FundingApiError.js';
import { FUNDING_STATUS_READ_MS } from './FundingChainService.js';
import type {
  FundingStampPurchaseJournal,
  FundingStampPurchasePatch,
  FundingStampPurchaseRow,
} from './FundingStampPurchaseJournal.js';
import { beeWords, neverReached, sentNothing } from './FundingStampService.js';

const logger = Logger.getInstance();

/** What a purchase asks the catalogue node's Bee API, `BeeClient` in production, on its on-chain budget. */
export interface FundingStampPurchaseNode {
  /** `POST /stamps/{amount}/{depth}?label=` with the `immutable` header. Bee answers once the purchase is mined. */
  buyStamp(input: BuyStampInput): Promise<{ batchID: string }>;
}

/** What a status call reads from the node, `BeeClient` with the funding API's short read timeout in production. */
export interface FundingStampPurchaseReads {
  /** `GET /stamps`: the batches the node holds, each with the label it keeps for it. */
  listStamps(): Promise<BeeStamp[]>;
  /** `GET /stamps/{id}`, for a batch id without `0x`. */
  getStamp(batchId: string): Promise<BeeStamp>;
}

export interface FundingStampPurchaseDeps {
  journal: FundingStampPurchaseJournal;
  /** The nodes, their wallets and the price of postage, read now, `FundingInventoryService`. */
  inventory: { inventory(): Promise<FundingInventory> };
  /** The deployment whose own Bee node a node id names, or null when this manager runs none now. */
  deployment(nodeId: string): Promise<Profile | null>;
  /** The Bee API of a deployment's own Bee node, as the manager reaches it, `beeApiUrlFor`. */
  uploaderApiUrl(profile: Profile): string;
  /** The node at this Bee API, asked for a purchase. */
  node(apiUrl: string): FundingStampPurchaseNode;
  /** The node at this Bee API, read by a status call. */
  reads(apiUrl: string): FundingStampPurchaseReads;
  /** The archive batches, none of which a settle takes for a purchase's batch. */
  archiveBatches: ArchiveBatchReader;
  /** The catalogue designation, whose pinned batch, and the one a pending move left, a settle never takes. */
  catalogue: { read(): Promise<CatalogueDesignationRow> };
  /** What makes a bought batch an archive batch, and pushes the catalogue stamp record. */
  designator: ArchiveBatchDesignator;
  now?: () => number;
}

/** What the node's answer came to, before it is written onto the row. */
interface Outcome {
  state: Exclude<FundingTransferState, 'submitted'>;
  batchId: string | null;
  txHash: string | null;
  error: string | null;
  /** The connection to the node was never made, so it was asked nothing: answered as `node_unreachable`. */
  unreachable: boolean;
}

/** A batch id as Bee spells one, with or without `0x`, in either case. */
const BATCH_ID = /^(0[xX])?[0-9a-fA-F]{64}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

const UNKNOWN_NODE = 'No node of this manager has this id.';
const ONLY_CATALOGUE =
  'An archive stamp is bought on the catalogue node alone, and this node is not the catalogue node.';
const NO_GAS = 'The node’s wallet holds no xDAI to pay the gas with.';
const NO_PRICE =
  'No node answered the price of postage, so whether this amount buys the life the postage contract asks of a new batch is not known.';
const BUYING =
  'Another archive stamp purchase on this node is still being settled, and both would spend the same wallet. Try again once it is.';
const OTHER_PURCHASE = 'This request id names another stamp purchase.';
const LABEL_TAKEN =
  'Another purchase’s request id begins with the same twelve hex digits, which the batch’s label on its node is made of. Send this purchase under a new request id.';
const NOT_REACHED = 'The node’s Bee API could not be reached, so it was asked nothing.';
const ANSWER_LOST =
  'The node’s answer was lost, so the batch is looked for among the node’s batches by this purchase’s label until it shows.';
const NO_BATCH_ANSWERED =
  'The node answered with no batch id, so the batch is looked for among the node’s batches by this purchase’s label until it shows.';
const NOT_FOUND = 'The node lists no batch under this purchase’s label thirty minutes after it was asked.';

function refused(message: string): FundingApiError {
  return new FundingApiError('stamp_refused', message);
}

/** A node with another purchase still being settled on it, answered as the chequebook operations answer a busy node. */
function busy(): FundingApiError {
  return new FundingApiError('conflict', BUYING);
}

/** A batch id as the funding API prints one, `0x` and 64 hex digits in lower case, or null for anything else. */
function batchIdFrom(value: unknown): string | null {
  if (typeof value !== 'string' || !BATCH_ID.test(value)) return null;
  return `0x${value.slice(-64).toLowerCase()}`;
}

/** A batch id as the archive batches and the catalogue designation keep one: 64 hex digits without `0x`, lower case. */
function bareBatchId(id: string): string {
  return id.replace(/^0x/i, '').toLowerCase();
}

/** Life left as a sentence says it: "1d 0h of life", or "no life". */
function lifeOf(seconds: number): string {
  return seconds > 0 ? `${formatTtl(seconds)} of life` : 'no life';
}

/** What a failed purchase call comes to: Bee's refusal, a node never reached, or an answer that says nothing. */
function failureOutcome(err: unknown): Outcome {
  const nothing = { batchId: null, txHash: null };
  if (err instanceof BeeHttpError) {
    const words = beeWords(err);
    const said = words ? `${err.status}, “${words}”` : `${err.status}`;
    if (sentNothing(err.status)) {
      return { ...nothing, state: 'failed', error: `The node refused it (${said}).`, unreachable: false };
    }
    return {
      ...nothing,
      state: 'unknown',
      error: `The node answered ${said}, which does not say whether it bought the batch, so the batch is looked for among the node’s batches by this purchase’s label until it shows.`,
      unreachable: false,
    };
  }
  if (neverReached(err)) return { ...nothing, state: 'failed', error: NOT_REACHED, unreachable: true };
  return { ...nothing, state: 'unknown', error: ANSWER_LOST, unreachable: false };
}

/** Bee's word about a batch it answered for, or null when the answer is not about that batch or says nothing. */
function usableOf(stamp: BeeStamp | null, batchId: string): boolean | null {
  if (stamp === null || typeof stamp !== 'object' || batchIdFrom(stamp.batchID) !== batchId) return null;
  return typeof stamp.usable === 'boolean' ? stamp.usable : null;
}

function answerOf(row: FundingStampPurchaseRow): FundingStampPurchaseAnswer {
  return { requestId: row.requestId, state: row.state, batchId: row.batchId, txHash: row.txHash };
}

/**
 * The funding API's stamp purchases: a new immutable batch on the catalogue node, an archive stamp, which that node
 * buys through its Bee API and pays for from its own wallet.
 *
 * A purchase is checked before anything is written, against the inventory read now: the node is the catalogue node
 * (404 `unknown_node` for one this manager does not run, and 422 `stamp_refused` for any other of its nodes), the cost
 * in xBZZ, `amountPerChunkPlur × 2^depth`, is in its wallet with some xDAI for the gas, and the amount buys the postage
 * contract's floor of life or more at the price read now. Each of those refusals is `stamp_refused` with a sentence. A
 * node with another purchase still being settled on it answers 409 `conflict`, as a chequebook operation answers a
 * busy node. Nothing is asked of the node either way.
 *
 * Then the purchase is journalled, with the label the batch will carry on its node, `archive-` and the first twelve
 * hex digits of the request id, and the node is asked once, with that label and `immutable`. Bee answers once the
 * transaction is mined, so its answer with a batch is `confirmed`. A refusal, a 429 for another on-chain operation of
 * the node's among them, is `failed` with Bee's words, and a node never reached `failed` as well, answered as
 * `node_unreachable`. A 500, and an answer that was lost, are `unknown`. The same request id answers what the journal
 * holds and never asks the node again; another body under it is a conflict.
 *
 * A `confirmed` purchase's batch is made an archive batch through `designateArchiveBatch`, and the journal marks the
 * purchase `recorded_at` once it is. One the designation failed for is designated again by the next status call; a
 * marked one never again, so a batch taken off the list stays off it.
 */
export class FundingStampPurchaseService {
  private readonly now: () => number;
  /** When each request id's node was last read for its batch, for {@link FUNDING_STATUS_READ_MS}. */
  private readonly lastSettleRead = new Map<string, number>();

  constructor(private readonly deps: FundingStampPurchaseDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  async purchase(request: FundingStampPurchaseRequest): Promise<FundingStampPurchaseAnswer> {
    const known = await this.deps.journal.find(request.requestId);
    if (known) return this.repeat(known, request);

    const inventory = await this.deps.inventory.inventory();
    const node = this.buyer(inventory, request);
    const costPlur = archiveBatchCostPlur(request.depth, request.amountPerChunkPlur);
    this.checkWallet(node, costPlur);
    this.checkLife(inventory, request);
    const deployment = await this.deps.deployment(request.nodeId);
    if (!deployment) throw new FundingApiError('unknown_node', UNKNOWN_NODE);
    const apiUrl = this.deps.uploaderApiUrl(deployment);
    await this.refuseWhileOpen(request.nodeId, apiUrl, deployment);

    const at = new Date(this.now());
    const row: FundingStampPurchaseRow = {
      requestId: request.requestId,
      nodeId: request.nodeId,
      depth: request.depth,
      amountPerChunkPlur: request.amountPerChunkPlur,
      costPlur,
      label: request.label,
      nodeLabel: archivePurchaseNodeLabel(request.requestId),
      batchId: null,
      txHash: null,
      state: 'unknown',
      error: null,
      createdAt: at,
      updatedAt: at,
      recordedAt: null,
    };
    const inserted = await this.deps.journal.insert(row);
    if (inserted === 'node_busy') throw busy();
    if (inserted === 'label_taken') throw new FundingApiError('conflict', LABEL_TAKEN);
    if (inserted === 'request_taken') {
      // Another call journalled this request id between the read above and this write.
      const raced = await this.deps.journal.find(request.requestId);
      if (raced) return this.repeat(raced, request);
      throw new Error(`Stamp purchase ${request.requestId} could not be journalled, so the node was not asked.`);
    }
    logger.info(
      `[Funding] journalled stamp purchase ${row.requestId}: an immutable batch of depth ${row.depth} at ${row.amountPerChunkPlur} PLUR a chunk on ${row.nodeId}, labelled ${row.nodeLabel} there`,
    );

    const outcome = await this.ask(apiUrl, row);
    const { row: settled, applied } = await this.record(row, outcome);
    logger.info(
      `[Funding] stamp purchase ${row.requestId} is ${settled.state}${settled.batchId ? `, batch ${settled.batchId}` : ''}${
        settled.txHash ? `, ${settled.txHash}` : ''
      }${settled.error ? `: ${settled.error}` : ''}`,
    );
    if (settled.state === 'confirmed') await this.designate(settled, deployment.name);
    if (outcome.unreachable && applied) throw new FundingApiError('node_unreachable', NOT_REACHED);
    return answerOf(settled);
  }

  /**
   * Where a purchase stands. An `unknown` one is settled from the node's own list of batches ({@link settled}), and a
   * `confirmed` one is answered with the node's word now about whether its batch is usable, read on every call, and
   * null when the node could not be read about it. A `confirmed` purchase whose batch is not marked as made an archive
   * batch yet is designated now.
   */
  async status(requestId: string): Promise<FundingStampPurchaseStatus> {
    const row = await this.deps.journal.find(requestId);
    if (!row) {
      throw new FundingApiError(
        'unknown_request',
        'No stamp purchase was journalled under this request id, so sending it again under the same id is safe.',
      );
    }
    const deployment = await this.deps.deployment(row.nodeId);
    const apiUrl = deployment ? this.deps.uploaderApiUrl(deployment) : null;
    const { row: current, stamp } = row.state === 'unknown' ? await this.settled(row, apiUrl) : { row, stamp: null };
    let usable: boolean | null = null;
    if (current.state === 'confirmed' && current.batchId !== null) {
      if (deployment) await this.designate(current, deployment.name);
      usable = stamp ? usableOf(stamp, current.batchId) : await this.usable(current.batchId, apiUrl);
    }
    return {
      requestId: current.requestId,
      state: current.state,
      batchId: current.batchId,
      txHash: current.txHash,
      usable,
      error: current.error,
    };
  }

  /** A request id journalled already: its state for the same body, a conflict for another. */
  private repeat(row: FundingStampPurchaseRow, request: FundingStampPurchaseRequest): FundingStampPurchaseAnswer {
    const same =
      row.nodeId === request.nodeId &&
      row.depth === request.depth &&
      row.amountPerChunkPlur === request.amountPerChunkPlur &&
      row.label === request.label;
    if (!same) throw new FundingApiError('conflict', OTHER_PURCHASE);
    return answerOf(row);
  }

  /** The catalogue node, as the inventory read it now, when the request names it. */
  private buyer(inventory: FundingInventory, request: FundingStampPurchaseRequest): FundingNode {
    const catalogue = inventory.catalogue;
    if (catalogue?.nodeId === request.nodeId) return catalogue;
    const listed = inventory.stages.some((stage) => stage.nodes.some((node) => node.nodeId === request.nodeId));
    throw listed ? refused(ONLY_CATALOGUE) : new FundingApiError('unknown_node', UNKNOWN_NODE);
  }

  /** The cost in the node's wallet, with some xDAI for the gas, as the inventory read it now. */
  private checkWallet(node: FundingNode, costPlur: string): void {
    if (node.xbzzPlur === null || node.xdaiWei === null) {
      throw refused(
        `The node’s wallet could not be read, so whether it can pay is not known. ${node.readError ?? ''}`.trim(),
      );
    }
    const holds = BigInt(node.xbzzPlur);
    const cost = BigInt(costPlur);
    if (holds < cost) {
      throw refused(
        `The node’s wallet holds ${plurToBzzExact(holds)} xBZZ, ${plurToBzzExact(cost - holds)} xBZZ short of the ${plurToBzzExact(cost)} xBZZ this archive stamp costs.`,
      );
    }
    if (BigInt(node.xdaiWei) === 0n) throw refused(NO_GAS);
  }

  /** The amount buys the postage contract's floor of life or more, at the price the inventory read now. */
  private checkLife(inventory: FundingInventory, request: FundingStampPurchaseRequest): void {
    const postage = inventory.chain.postage;
    if (!postage) throw refused(NO_PRICE);
    const price = BigInt(postage.pricePerChunkPerBlockPlur);
    const amount = BigInt(request.amountPerChunkPlur);
    if (amount >= price * BigInt(postage.minimumValidityBlocks)) return;
    const seconds = Number(amount / price) * postage.blockSeconds;
    const floor = formatTtl(postage.minimumValidityBlocks * postage.blockSeconds);
    throw refused(
      `At today’s price this amount buys ${lifeOf(seconds)}, under the ${floor} the postage contract asks of a new batch.`,
    );
  }

  /**
   * Refuses a purchase while another on the node is still being settled, since both would spend the same wallet. The
   * open one is settled from the node's batches first, as a status call would, so one whose answer was lost holds the
   * node back no longer than it takes to settle.
   */
  private async refuseWhileOpen(nodeId: string, apiUrl: string, deployment: Profile): Promise<void> {
    const open = await this.deps.journal.openOn(nodeId);
    if (!open) return;
    const { row } = open.state === 'unknown' ? await this.settled(open, apiUrl) : { row: open };
    if (row.state === 'confirmed') await this.designate(row, deployment.name);
    if (row.state === 'unknown' || row.state === 'submitted') throw busy();
  }

  /** Asks the node once for the batch, and reads what its answer, or its silence, means. Never throws. */
  private async ask(apiUrl: string, row: FundingStampPurchaseRow): Promise<Outcome> {
    let answer: unknown;
    try {
      answer = await this.deps.node(apiUrl).buyStamp({
        amount: row.amountPerChunkPlur,
        depth: row.depth,
        label: row.nodeLabel,
        immutable: true,
      });
    } catch (err) {
      return failureOutcome(err);
    }
    const answered = (typeof answer === 'object' && answer !== null ? answer : {}) as {
      batchID?: unknown;
      txHash?: unknown;
    };
    const batchId = batchIdFrom(answered.batchID);
    if (batchId === null) {
      return { state: 'unknown', batchId: null, txHash: null, error: NO_BATCH_ANSWERED, unreachable: false };
    }
    const txHash =
      typeof answered.txHash === 'string' && TX_HASH.test(answered.txHash) ? answered.txHash.toLowerCase() : null;
    return { state: 'confirmed', batchId, txHash, error: null, unreachable: false };
  }

  /**
   * Writes the node's answer onto the row while it is still `unknown`, and answers the row as it stands after and
   * whether the answer was written. A status call may have settled the row from the node's batches while the node was
   * asked: a row it confirmed with the same batch takes the hash the node answered with, and anything else it settled
   * stands.
   */
  private async record(
    row: FundingStampPurchaseRow,
    outcome: Outcome,
  ): Promise<{ row: FundingStampPurchaseRow; applied: boolean }> {
    const patch: FundingStampPurchasePatch = {
      state: outcome.state,
      batchId: outcome.batchId,
      txHash: outcome.txHash,
      error: outcome.error,
      updatedAt: new Date(this.now()),
    };
    if (await this.deps.journal.update(row.requestId, 'unknown', patch)) {
      return { row: { ...row, ...patch }, applied: true };
    }
    const current = (await this.deps.journal.find(row.requestId)) ?? row;
    if (
      current.state === 'confirmed' &&
      current.txHash === null &&
      outcome.txHash !== null &&
      current.batchId === outcome.batchId
    ) {
      const withHash: FundingStampPurchasePatch = { ...patch, state: 'confirmed', error: null };
      if (await this.deps.journal.update(row.requestId, 'confirmed', withHash)) {
        return { row: { ...current, ...withHash }, applied: true };
      }
    }
    return { row: current, applied: false };
  }

  /**
   * An `unknown` purchase settled from the node's own list of batches: `confirmed` with the batch that carries exactly
   * the purchase's label, at its depth and immutable, and is neither the catalogue's own batch nor an archive batch
   * already (`isPurchasedArchiveBatch`); `failed` once {@link ARCHIVE_PURCHASE_SETTLE_MS} have passed since it was
   * journalled with no such batch. The node is read at most once every {@link FUNDING_STATUS_READ_MS} for a request
   * id; in between, and when the node is gone or does not answer, the row is answered as journalled. Answers the batch
   * as the node listed it, when the row was confirmed by it.
   */
  private async settled(
    row: FundingStampPurchaseRow,
    apiUrl: string | null,
  ): Promise<{ row: FundingStampPurchaseRow; stamp: BeeStamp | null }> {
    const unchanged = { row, stamp: null };
    if (apiUrl === null) return unchanged;
    const now = this.now();
    const last = this.lastSettleRead.get(row.requestId);
    if (last !== undefined && now - last < FUNDING_STATUS_READ_MS) return unchanged;
    this.lastSettleRead.set(row.requestId, now);
    let stamps: unknown;
    try {
      stamps = await this.deps.reads(apiUrl).listStamps();
    } catch (err) {
      logger.debug(
        `[Funding] could not read the batches of the node of stamp purchase ${row.requestId} (${err instanceof Error ? err.name : 'no error'}); answering it as journalled`,
      );
      return unchanged;
    }
    const labelled = (Array.isArray(stamps) ? (stamps as BeeStamp[]) : []).filter(
      (stamp) =>
        typeof stamp === 'object' &&
        stamp !== null &&
        stamp.label === row.nodeLabel &&
        batchIdFrom(stamp.batchID) !== null,
    );
    // The batches it can never be are read only once the node lists one under the purchase's label.
    const context = labelled.length > 0 ? await this.settleContext(row) : null;
    const found =
      (context &&
        labelled.find((stamp) =>
          isPurchasedArchiveBatch(stamp, { ...context, batchId: batchIdFrom(stamp.batchID)!.slice(2) }),
        )) ??
      null;

    let patch: FundingStampPurchasePatch;
    if (found) {
      const batchId = batchIdFrom(found.batchID);
      patch = { state: 'confirmed', batchId, txHash: row.txHash, error: null, updatedAt: new Date(now) };
    } else if (now - row.createdAt.getTime() > ARCHIVE_PURCHASE_SETTLE_MS) {
      patch = { state: 'failed', batchId: null, txHash: row.txHash, error: NOT_FOUND, updatedAt: new Date(now) };
    } else {
      return unchanged;
    }
    if (!(await this.deps.journal.update(row.requestId, 'unknown', patch))) {
      // The node's answer was written meanwhile, and it stands.
      return { row: (await this.deps.journal.find(row.requestId)) ?? row, stamp: null };
    }
    this.lastSettleRead.delete(row.requestId);
    logger.info(
      `[Funding] stamp purchase ${row.requestId} is ${patch.state}${patch.batchId ? `, batch ${patch.batchId}` : ''}, read from the node’s batches`,
    );
    return { row: { ...row, ...patch }, stamp: found };
  }

  /**
   * What a settle knows of a purchase and of the batches that cannot be its own, each id 64 hex digits without `0x` in
   * lower case: every archive batch, and the catalogue's own, the pinned one and the one a pending move left.
   */
  private async settleContext(row: FundingStampPurchaseRow): Promise<Omit<ArchivePurchaseSettleContext, 'batchId'>> {
    const [archived, designation] = await Promise.all([this.deps.archiveBatches.list(), this.deps.catalogue.read()]);
    const catalogueBatchIds: string[] = [];
    if (isDesignated(designation)) catalogueBatchIds.push(bareBatchId(designation.batchId));
    if (isMoving(designation)) catalogueBatchIds.push(bareBatchId(designation.movingFromBatchId));
    return {
      nodeLabel: row.nodeLabel,
      depth: row.depth,
      catalogueBatchIds,
      archiveBatchIds: archived.map((batch) => bareBatchId(batch.batchId)),
    };
  }

  /** The node's word now about whether a bought batch is usable, or null when it could not be read. Never throws. */
  private async usable(batchId: string, apiUrl: string | null): Promise<boolean | null> {
    if (apiUrl === null) return null;
    try {
      return usableOf(await this.deps.reads(apiUrl).getStamp(batchId.slice(2)), batchId);
    } catch (err) {
      logger.debug(
        `[Funding] could not read batch ${batchId} on its node (${err instanceof Error ? err.name : 'no error'}); answering whether it is usable as not known`,
      );
      return null;
    }
  }

  /**
   * Makes the batch a confirmed purchase bought an archive batch through `designateArchiveBatch`, which writes its row,
   * raises the revision and pushes the catalogue stamp record, and marks the purchase `recorded_at` once it did. A
   * purchase marked already is never designated again, so a batch taken off the list stays off it. A designation that
   * fails leaves the purchase `confirmed` and unmarked, and the next status call designates it again. Never throws.
   */
  private async designate(row: FundingStampPurchaseRow, profileName: string): Promise<void> {
    if (row.batchId === null || row.recordedAt !== null) return;
    try {
      await this.deps.designator.designateArchiveBatch({
        batchId: row.batchId.slice(2),
        profileName,
        depth: row.depth,
        label: row.label,
        designatedBy: null,
        purchaseRequestId: row.requestId,
      });
    } catch (err) {
      logger.warn(
        `[Funding] stamp purchase ${row.requestId} bought ${row.batchId}, which could not be made an archive batch yet: ${getErrorMessage(err)}`,
      );
      return;
    }
    try {
      await this.deps.journal.markRecorded(row.requestId, new Date(this.now()));
    } catch (err) {
      // The designation stands; it changes nothing when the next status call makes it again.
      logger.warn(`[Funding] stamp purchase ${row.requestId} could not be marked recorded: ${getErrorMessage(err)}`);
    }
  }
}
