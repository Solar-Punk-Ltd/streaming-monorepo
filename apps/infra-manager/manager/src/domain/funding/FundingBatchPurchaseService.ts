import {
  ARCHIVE_SLOTS_FULL_REFUSAL,
  formatTtl,
  plurToBzzExact,
  purchaseNodeLabel,
  purchaseReplaceProblem,
} from '@streaming-infra-manager/common';
import {
  archiveBatchCostPlur,
  CATALOGUE_ARCHIVE_BATCHES_MAX,
  type FundingBatchPurchaseAnswer,
  type FundingBatchPurchaseRequest,
  type FundingBatchPurchaseStatus,
  type FundingInventory,
  type FundingNode,
  type FundingStampPurchaseAnswer,
  type FundingStampPurchaseRequest,
  type FundingStampPurchaseStatus,
  type FundingTransferState,
} from '@streaming-monorepo/contracts';

import type { Profile } from '../../types/index.js';
import { AsyncLock } from '../AsyncLock.js';
import type { BuyStampInput } from '../BeeClient.js';
import { BeeHttpError } from '../errors/BeeHttpError.js';
import { Logger } from '../Logger.js';
import { FundingApiError } from './FundingApiError.js';
import { bareBatchId, batchIdFrom, type FundingPurchaseFollowUp, usableOf } from './FundingPurchaseFollowUp.js';
import type {
  FundingStampPurchaseJournal,
  FundingStampPurchasePatch,
  FundingStampPurchaseRow,
} from './FundingStampPurchaseJournal.js';
import { beeWords, neverReached, sentNothing } from './FundingStampService.js';
import type { PurchasedCatalogueBatches, PurchasedRungBatches } from './purchaseFollowUpPorts.js';

const logger = Logger.getInstance();

/** What a purchase asks the node's Bee API, `BeeClient` in production, on its on-chain budget. */
export interface FundingBatchPurchaseNode {
  /** `POST /stamps/{amount}/{depth}?label=` with the `immutable` header. Bee answers once the purchase is mined. */
  buyStamp(input: BuyStampInput): Promise<{ batchID: string }>;
}

export interface FundingBatchPurchaseDeps {
  journal: FundingStampPurchaseJournal;
  /** The nodes, their wallets and the price of postage, read now, `FundingInventoryService`. */
  inventory: { inventory(): Promise<FundingInventory> };
  /** The deployment whose own Bee node a node id names, or null when this manager runs none now. */
  deployment(nodeId: string): Promise<Profile | null>;
  /** The Bee API of a deployment's own Bee node, as the manager reaches it, `beeApiUrlFor`. */
  uploaderApiUrl(profile: Profile): string;
  /** The node at this Bee API, asked for a purchase. */
  node(apiUrl: string): FundingBatchPurchaseNode;
  /** The follow-up, which settles, reads and puts to use what a purchase bought, and takes the three calls. */
  followUp: Pick<
    FundingPurchaseFollowUp,
    'settle' | 'usable' | 'designateArchive' | 'advance' | 'restart' | 'check' | 'release'
  >;
  /** The batch set on a rung's node or a single-node stage now, and its verdict (`purchaseFollowUpPorts.ts`). */
  rungs: Pick<PurchasedRungBatches, 'current'>;
  /** The designated catalogue batch now, and its verdict (`purchaseFollowUpPorts.ts`). */
  catalogueBatches: Pick<PurchasedCatalogueBatches, 'current'>;
  /**
   * Whether another operation of the funding API is under way on the node, a stamp operation or a chequebook move,
   * either of which spends the same wallet. Without it none is.
   */
  otherOperationOpen?(nodeId: string, profileName: string): Promise<boolean>;
  /**
   * How many places on the catalogue stamp record's list of archive batches are held, `ArchiveBatchService.slotsTaken`:
   * an archive stamp's purchase is refused once it reaches the record's maximum. Without it none is refused for it.
   */
  archiveSlotsTaken?(): Promise<number>;
  /**
   * The lock the archive batches and the catalogue designation take, under which the places are counted again and an
   * archive stamp's purchase journalled, so two purchases or a purchase and an adopt never both take the last place.
   * Without it the service holds one of its own.
   */
  lock?: AsyncLock;
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

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

const UNKNOWN_NODE = 'No node of this manager has this id.';
const ONLY_CATALOGUE =
  'An archive stamp is bought on the catalogue node alone, and this node is not the catalogue node.';
const ONLY_CATALOGUE_BATCH =
  'A catalogue batch is bought on the catalogue node alone, and this node is not the catalogue node.';
const ONLY_RUNG =
  'A rung’s batch is bought on a rung’s node or on a single-node stage’s own node, and this node is neither.';
const NO_GAS = 'The node’s wallet holds no xDAI to pay the gas with.';
const NO_PRICE =
  'No node answered the price of postage, so whether this amount buys the life the postage contract asks of a new batch is not known.';
const BUYING =
  'Another batch purchase on this node is still being bought or waits for its batch to become usable, and both would spend the same wallet. Try again once it is done.';
const OTHER_OPERATION =
  'Another operation of the funding API is under way on this node, a top-up, a dilution or a chequebook move, and both would spend the same wallet. Try again once it is done.';
const OTHER_PURCHASE = 'This request id names another batch purchase.';
const NOT_AN_ARCHIVE_PURCHASE =
  'No archive stamp purchase was journalled under this request id. A batch purchase of another purpose is read on the batch purchase route.';
const LABEL_TAKEN =
  'Another purchase’s request id begins with the same twelve hex digits, which the batch’s label on its node is made of. Send this purchase under a new request id.';
const NOT_REACHED = 'The node’s Bee API could not be reached, so it was asked nothing.';
const ANSWER_LOST =
  'The node’s answer was lost, so the batch is looked for among the node’s batches by this purchase’s label until it shows.';
const NO_BATCH_ANSWERED =
  'The node answered with no batch id, so the batch is looked for among the node’s batches by this purchase’s label until it shows.';

function refused(message: string): FundingApiError {
  return new FundingApiError('stamp_refused', message);
}

/** A node with another purchase still under way on it, answered as the chequebook operations answer a busy node. */
function busy(): FundingApiError {
  return new FundingApiError('conflict', BUYING);
}

/** Why the batch a purchase names as replaced is refused: another one, or none, is set there now. */
function replacesAnother(now: string | null): string {
  return now === null
    ? 'No batch is set here now, and the purchase names one it replaces. Read the inventory again.'
    : `The batch set here now is 0x${now}, another than the one the purchase names as replaced. Read the inventory again.`;
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

/** The step a purchase is at once the node's answer, or a reading of its batches, comes to this state. */
function stepOf(state: FundingTransferState): Pick<FundingStampPurchasePatch, 'step'> {
  if (state === 'confirmed') return { step: 'waiting_usable' };
  if (state === 'failed') return { step: 'failed' };
  return { step: 'buying' };
}

function answerOf(row: FundingStampPurchaseRow): FundingBatchPurchaseAnswer {
  return {
    requestId: row.requestId,
    purpose: row.purpose,
    state: row.state,
    batchId: row.batchId,
    txHash: row.txHash,
  };
}

/**
 * The funding API's batch purchases: a new batch that a node buys through its Bee API and pays for from its own
 * wallet, for a rung, for the catalogue or as an archive stamp. One route takes the three purposes, and only the
 * parameters differ (`fundingBatchPurchaseRequestSchema`); the archive-only route of an older admin is a purchase of
 * purpose `archive` ({@link purchaseArchive}).
 *
 * A purchase is checked before anything is written, against the inventory read now, each refusal `stamp_refused` with
 * a sentence:
 * - the node is one the purpose names: a stage's node the inventory offers a replacement for, for a rung (a rung's
 *   node or a single-node stage's own node), and the catalogue node for the catalogue and an archive stamp; 404
 *   `unknown_node` for a node this manager does not run;
 * - for a rung or the catalogue, `replacesBatchId` is the batch set there now, as the port's `current` reads it, and
 *   that batch no longer pays (`purchaseReplaceProblem`);
 * - the cost in xBZZ, `amountPerChunkPlur × 2^depth`, is in the node's wallet, with some xDAI for the gas, and the
 *   amount buys the postage contract's floor of life or more at the price read now;
 * - an archive stamp keeps its check of the catalogue stamp record's places, made again under the archive batches'
 *   lock as it is journalled.
 *
 * A node with another purchase being bought or waiting for its batch to become usable, or with another operation of
 * the funding API under way, answers 409 `conflict`. Nothing is asked of the node either way.
 *
 * Then the purchase is journalled, with the label the batch will carry on its node (`purchaseNodeLabel`), and the
 * node is asked once, with that label and the kind asked for. Bee answers once the transaction is mined, so its answer
 * with a batch is `confirmed`. A refusal, a 429 for another on-chain operation of the node's among them, is `failed`
 * with Bee's words, and a node never reached `failed` as well, answered as `node_unreachable`. A 500, and an answer that
 * was lost, are `unknown`. The same request id answers what the journal holds and never asks the node again; another
 * body under it is a conflict. What follows a purchase is {@link FundingPurchaseFollowUp}'s.
 */
export class FundingBatchPurchaseService {
  private readonly now: () => number;
  private readonly lock: AsyncLock;

  constructor(private readonly deps: FundingBatchPurchaseDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.lock = deps.lock ?? new AsyncLock();
  }

  async purchase(request: FundingBatchPurchaseRequest): Promise<FundingBatchPurchaseAnswer> {
    const known = await this.deps.journal.find(request.requestId);
    if (known) return this.repeat(known, request);
    if (request.purpose === 'archive') await this.refuseFull();

    const inventory = await this.deps.inventory.inventory();
    const node = this.buyer(inventory, request);
    const costPlur = archiveBatchCostPlur(request.depth, request.amountPerChunkPlur);
    this.checkWallet(node, costPlur, request);
    this.checkLife(inventory, request);
    const deployment = await this.deps.deployment(request.nodeId);
    if (!deployment) throw new FundingApiError('unknown_node', UNKNOWN_NODE);
    await this.checkReplaced(request, deployment);
    const apiUrl = this.deps.uploaderApiUrl(deployment);
    await this.refuseWhileBusy(request.nodeId, apiUrl, deployment);

    const at = new Date(this.now());
    const row: FundingStampPurchaseRow = {
      requestId: request.requestId,
      purpose: request.purpose,
      nodeId: request.nodeId,
      depth: request.depth,
      amountPerChunkPlur: request.amountPerChunkPlur,
      costPlur,
      immutable: request.immutable,
      label: request.label,
      nodeLabel: purchaseNodeLabel(request.purpose, request.requestId),
      replacesBatchId: request.replacesBatchId,
      batchId: null,
      txHash: null,
      state: 'unknown',
      step: 'buying',
      error: null,
      createdAt: at,
      updatedAt: at,
      boughtAt: null,
      setAt: null,
      previousBatchId: null,
      releasedAt: null,
      recordedAt: null,
    };
    const inserted =
      request.purpose === 'archive'
        ? await this.lock.run(async () => {
            // Another purchase or an adopt may have taken the last place while the node was asked.
            await this.refuseFull();
            return this.deps.journal.insert(row);
          })
        : await this.deps.journal.insert(row);
    if (inserted === 'node_busy') throw busy();
    if (inserted === 'label_taken') throw new FundingApiError('conflict', LABEL_TAKEN);
    if (inserted === 'request_taken') {
      // Another call journalled this request id between the read above and this write.
      const raced = await this.deps.journal.find(request.requestId);
      if (raced) return this.repeat(raced, request);
      throw new Error(`Batch purchase ${request.requestId} could not be journalled, so the node was not asked.`);
    }
    logger.info(
      `[Funding] journalled batch purchase ${row.requestId} for ${row.purpose}: ${row.immutable ? 'an immutable' : 'a mutable'} batch of depth ${row.depth} at ${row.amountPerChunkPlur} PLUR a chunk on ${row.nodeId}, labelled ${row.nodeLabel} there${
        row.replacesBatchId ? `, in place of ${row.replacesBatchId}` : ''
      }`,
    );

    const outcome = await this.ask(apiUrl, row);
    const { row: settled, applied } = await this.record(row, outcome);
    logger.info(
      `[Funding] batch purchase ${row.requestId} is ${settled.state}${settled.batchId ? `, batch ${settled.batchId}` : ''}${
        settled.txHash ? `, ${settled.txHash}` : ''
      }${settled.error ? `: ${settled.error}` : ''}`,
    );
    if (settled.state === 'confirmed') {
      if (settled.purpose === 'archive') await this.deps.followUp.designateArchive(settled, deployment.name);
      void this.deps.followUp.advance(settled.requestId);
    }
    if (outcome.unreachable && applied) throw new FundingApiError('node_unreachable', NOT_REACHED);
    return answerOf(settled);
  }

  /**
   * Where a purchase stands. An `unknown` one is settled from the node's own list of batches, and a `confirmed` one is
   * answered with the node's word now about whether its batch is usable, read on every call, and null when the node
   * could not be read about it. A `confirmed` archive stamp not marked as made an archive batch yet is designated now.
   */
  async status(requestId: string): Promise<FundingBatchPurchaseStatus> {
    const row = await this.deps.journal.find(requestId);
    if (!row) {
      throw new FundingApiError(
        'unknown_request',
        'No batch purchase was journalled under this request id, so sending it again under the same id is safe.',
      );
    }
    const deployment = await this.deps.deployment(row.nodeId);
    const apiUrl = deployment ? this.deps.uploaderApiUrl(deployment) : null;
    const settled = row.state === 'unknown' ? await this.deps.followUp.settle(row, apiUrl) : { row, stamp: null };
    let current = settled.row;
    if (row.state === 'unknown' && current.state === 'confirmed') void this.deps.followUp.advance(requestId);
    let usable: boolean | null = null;
    const bought = current.state === 'confirmed' ? current.batchId : null;
    if (bought !== null) {
      if (deployment) current = (await this.deps.followUp.designateArchive(current, deployment.name)).row;
      usable = settled.stamp ? usableOf(settled.stamp, bought) : await this.deps.followUp.usable(bought, apiUrl);
    }
    const stages = current.purpose === 'rung' ? await this.deps.journal.stagesOf(requestId) : [];
    return {
      requestId: current.requestId,
      purpose: current.purpose,
      nodeId: current.nodeId,
      state: current.state,
      batchId: current.batchId,
      txHash: current.txHash,
      usable,
      step: current.step,
      error: current.error,
      stages: stages.map(({ stageId, name, apply, message }) => ({ stageId, name, apply, message })),
      catalogue:
        current.purpose === 'catalogue' && current.setAt !== null
          ? { previousBatchId: current.previousBatchId, released: current.releasedAt !== null }
          : null,
    };
  }

  /** Restart now: the Apply of one stage that waits for a broadcast, and the purchase's status after. */
  async restart(requestId: string, stageId: string): Promise<FundingBatchPurchaseStatus> {
    await this.deps.followUp.restart(requestId, stageId);
    return this.status(requestId);
  }

  /** Check again: the follow-up of a purchase that stopped, taken up again, and the purchase's status after. */
  async check(requestId: string): Promise<FundingBatchPurchaseStatus> {
    await this.deps.followUp.check(requestId);
    return this.status(requestId);
  }

  /** The release of the batch a catalogue purchase moved the catalogue from, and the purchase's status after. */
  async release(requestId: string): Promise<FundingBatchPurchaseStatus> {
    await this.deps.followUp.release(requestId);
    return this.status(requestId);
  }

  /**
   * The purchase of an archive stamp as an admin older than the batch purchase route asks for it: a batch purchase of
   * purpose `archive`, immutable and replacing none, answered in the older route's shape.
   */
  async purchaseArchive(request: FundingStampPurchaseRequest): Promise<FundingStampPurchaseAnswer> {
    const answer = await this.purchase({
      requestId: request.requestId,
      purpose: 'archive',
      nodeId: request.nodeId,
      depth: request.depth,
      amountPerChunkPlur: request.amountPerChunkPlur,
      immutable: true,
      label: request.label,
      replacesBatchId: null,
    });
    return { requestId: answer.requestId, state: answer.state, batchId: answer.batchId, txHash: answer.txHash };
  }

  /**
   * Where a purchase stands in the older route's shape, which carries no step: its `error` is the sentence of a
   * purchase that is `failed` or `unknown`, and null for one that is `confirmed`, as that route always answered it.
   */
  async archiveStatus(requestId: string): Promise<FundingStampPurchaseStatus> {
    // The older route read archive stamps alone, so a purchase of another purpose is none of its.
    const row = await this.deps.journal.find(requestId);
    if (row !== null && row.purpose !== 'archive') {
      throw new FundingApiError('unknown_request', NOT_AN_ARCHIVE_PURCHASE);
    }
    const status = await this.status(requestId);
    return {
      requestId: status.requestId,
      state: status.state,
      batchId: status.batchId,
      txHash: status.txHash,
      usable: status.usable,
      error: status.state === 'confirmed' ? null : status.error,
    };
  }

  /**
   * Refuses an archive stamp's purchase once the archive batches not spent and the purchases neither recorded nor
   * failed hold every place on the catalogue stamp record's list: the record would leave out a batch with life left.
   */
  private async refuseFull(): Promise<void> {
    if (!this.deps.archiveSlotsTaken) return;
    if ((await this.deps.archiveSlotsTaken()) >= CATALOGUE_ARCHIVE_BATCHES_MAX) {
      throw refused(ARCHIVE_SLOTS_FULL_REFUSAL);
    }
  }

  /** A request id journalled already: its state for the same body, a conflict for another. */
  private repeat(row: FundingStampPurchaseRow, request: FundingBatchPurchaseRequest): FundingBatchPurchaseAnswer {
    const same =
      row.purpose === request.purpose &&
      row.nodeId === request.nodeId &&
      row.depth === request.depth &&
      row.amountPerChunkPlur === request.amountPerChunkPlur &&
      row.immutable === request.immutable &&
      row.label === request.label &&
      row.replacesBatchId === request.replacesBatchId;
    if (!same) throw new FundingApiError('conflict', OTHER_PURCHASE);
    return answerOf(row);
  }

  /**
   * The node the purchase names, as the inventory read it now, when it is one the purpose names: a stage's node the
   * inventory offers a replacement for, for a rung, and the catalogue node otherwise.
   */
  private buyer(inventory: FundingInventory, request: FundingBatchPurchaseRequest): FundingNode {
    const staged = inventory.stages.flatMap((stage) => stage.nodes).filter((node) => node.nodeId === request.nodeId);
    const catalogue = inventory.catalogue?.nodeId === request.nodeId ? inventory.catalogue : null;
    if (request.purpose === 'rung') {
      const offered = staged.find((node) => node.replacement !== null && node.replacement !== undefined);
      if (offered) return offered;
      if (staged.length > 0 || catalogue) throw refused(ONLY_RUNG);
    } else {
      if (catalogue) return catalogue;
      if (staged.length > 0) throw refused(request.purpose === 'catalogue' ? ONLY_CATALOGUE_BATCH : ONLY_CATALOGUE);
    }
    throw new FundingApiError('unknown_node', UNKNOWN_NODE);
  }

  /** The cost in the node's wallet, with some xDAI for the gas, as the inventory read it now. */
  private checkWallet(node: FundingNode, costPlur: string, request: FundingBatchPurchaseRequest): void {
    if (node.xbzzPlur === null || node.xdaiWei === null) {
      throw refused(
        `The node’s wallet could not be read, so whether it can pay is not known. ${node.readError ?? ''}`.trim(),
      );
    }
    const holds = BigInt(node.xbzzPlur);
    const cost = BigInt(costPlur);
    if (holds < cost) {
      const what = request.purpose === 'archive' ? 'archive stamp' : 'batch';
      throw refused(
        `The node’s wallet holds ${plurToBzzExact(holds)} xBZZ, ${plurToBzzExact(cost - holds)} xBZZ short of the ${plurToBzzExact(cost)} xBZZ this ${what} costs.`,
      );
    }
    if (BigInt(node.xdaiWei) === 0n) throw refused(NO_GAS);
  }

  /** The amount buys the postage contract's floor of life or more, at the price the inventory read now. */
  private checkLife(inventory: FundingInventory, request: FundingBatchPurchaseRequest): void {
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
   * For a rung or the catalogue, the batch the purchase names as replaced is the one set there now, as the port reads
   * it, and that batch no longer pays (`purchaseReplaceProblem`): it expired, its node holds it no more, or none is
   * set. An archive stamp replaces none.
   */
  private async checkReplaced(request: FundingBatchPurchaseRequest, deployment: Profile): Promise<void> {
    if (request.purpose === 'archive') return;
    const current =
      request.purpose === 'rung'
        ? await this.deps.rungs.current(deployment.name)
        : await this.deps.catalogueBatches.current(deployment.name);
    const named = request.replacesBatchId === null ? null : bareBatchId(request.replacesBatchId);
    const now = current.batchId === null ? null : bareBatchId(current.batchId);
    if (named !== now) throw refused(replacesAnother(now));
    const problem = purchaseReplaceProblem(request.purpose, current.state);
    if (problem !== null) throw refused(problem);
  }

  /**
   * Refuses a purchase while another one on the node is being bought or waits for its batch to become usable, or
   * while another operation of the funding API is under way there, since each spends the same wallet. An open purchase
   * whose answer was lost is settled from the node's batches first, so it holds the node back no longer than it takes
   * to settle.
   */
  private async refuseWhileBusy(nodeId: string, apiUrl: string, deployment: Profile): Promise<void> {
    const open = await this.deps.journal.openOn(nodeId);
    if (open) {
      const { row } = open.state === 'unknown' ? await this.deps.followUp.settle(open, apiUrl) : { row: open };
      if (row.state === 'confirmed') await this.deps.followUp.designateArchive(row, deployment.name);
      if (row.state === 'unknown' || row.state === 'submitted' || row.step === 'waiting_usable') throw busy();
    }
    if (await this.deps.otherOperationOpen?.(nodeId, deployment.name)) {
      throw new FundingApiError('conflict', OTHER_OPERATION);
    }
  }

  /** Asks the node once for the batch, and reads what its answer, or its silence, means. Never throws. */
  private async ask(apiUrl: string, row: FundingStampPurchaseRow): Promise<Outcome> {
    let answer: unknown;
    try {
      answer = await this.deps.node(apiUrl).buyStamp({
        amount: row.amountPerChunkPlur,
        depth: row.depth,
        label: row.nodeLabel,
        immutable: row.immutable,
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
   * Writes the node's answer onto the row while it is still `unknown`, with the step it comes to, and answers the row
   * as it stands after and whether the answer was written. The follow-up may have settled the row from the node's
   * batches while the node was asked: a row it confirmed with the same batch takes the hash the node answered with,
   * keeping the step it reached, and anything else it settled stands.
   */
  private async record(
    row: FundingStampPurchaseRow,
    outcome: Outcome,
  ): Promise<{ row: FundingStampPurchaseRow; applied: boolean }> {
    const at = new Date(this.now());
    const patch: FundingStampPurchasePatch = {
      state: outcome.state,
      batchId: outcome.batchId,
      txHash: outcome.txHash,
      error: outcome.error,
      updatedAt: at,
      ...stepOf(outcome.state),
      boughtAt: outcome.state === 'confirmed' ? at : null,
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
      const withHash: FundingStampPurchasePatch = {
        ...patch,
        state: 'confirmed',
        error: null,
        step: current.step,
        boughtAt: current.boughtAt,
      };
      if (await this.deps.journal.update(row.requestId, 'confirmed', withHash)) {
        return { row: { ...current, ...withHash }, applied: true };
      }
    }
    return { row: current, applied: false };
  }
}
