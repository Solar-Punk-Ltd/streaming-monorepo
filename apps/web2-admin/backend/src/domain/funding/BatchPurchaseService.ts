import { randomUUID } from 'node:crypto';

import {
  type FundingBatchPurchaseRequest,
  type FundingBatchPurchaseStatus,
  type FundingInventory,
  type FundingNode,
  type FundingPostage,
  fundingPurchaseRestartable,
  type StageStampState,
} from '@streaming-monorepo/contracts';
import {
  BATCH_PURCHASE_MOVE_OFF,
  BATCH_PURCHASE_OPEN_STATES,
  BATCH_PURCHASES_NOT_OFFERED,
  type BatchPurchase,
  type BatchPurchaseMove,
  type BatchPurchaseRequest,
  type BatchPurchaseStage,
  type BatchPurchaseState,
  type BatchPurchasesResponse,
  batchBuyAmountPerChunkPlur,
  batchBuyProblem,
  batchOffersPurchase,
  batchPurchaseHoldsNode,
} from '@streaming-monorepo/web2-admin-common';

import { getErrorMessage } from '../../utils/errorUtils.js';
import { describeActor, type Actor, type OperatorActor } from '../actor.js';
import { recordAudit, type AuditAction, type AuditLog } from '../AuditLog.js';
import { FundingManagerUnavailableError, FundingRefusedError } from '../errors/index.js';
import type { FundingRefusalProblem } from '../errors/FundingRefusedError.js';
import { Logger } from '../Logger.js';

import type { PurchasedCatalogueMove, PurchasedMoveReading } from './batchPurchasePorts.js';
import type { BatchPurchaseChange, BatchPurchaseRow, BatchPurchaseStore } from './BatchPurchaseRepository.js';
import { ADMIN_FUNDING_CHAIN_ID, FUNDING_SYSTEM, managerCode, managerProblem, nodeName } from './FundingService.js';
import { ManagerFundingError, type ManagerFundingClient } from './ManagerFundingClient.js';

/**
 * Buying a new batch from the Stamps tab (docs/architecture/funding.md, "Buying a new batch"): a rung's batch, or a
 * single-node stage's own, and the catalogue batch, in place of one that expired, that its node holds no more, or that
 * was never set. The node pays from its own wallet, through the manager's funding API, and the admin signs nothing.
 *
 * A purchase is checked against the manager's inventory, read fresh: the node is one the purpose names, the batch the
 * page showed is the one set now and it no longer pays, the cost is the one today's price gives (`batchBuyProblem`
 * of web2-admin-common), and the wallet holds it. It is then written, `buying` and not sent, under the id the
 * manager knows it by, before the manager is asked, so it is never asked for twice; one runs on a node at a time.
 *
 * The manager follows a purchase up by itself, and the admin reads it, on a request and every
 * {@link BATCH_PURCHASE_POLL_MS} in the background, one look at a time per purchase:
 * - A purchase not sent yet is sent, marked sent first. One the manager refuses fails with its sentence; one the
 *   manager never received (`unknown_request`) is sent again under the same id.
 * - `buying` and `waiting_usable` follow the manager's step. A failed step fails the purchase with the manager's
 *   sentence, with its batch when one was bought, and Check again takes it up from there.
 * - A rung's batch once set is `restarting`, with the manager's stages, until the manager calls the purchase done.
 * - A catalogue batch once designated is `moving`: the admin's catalogue move runs onto it through
 *   {@link PurchasedCatalogueMove}, and once it is done the admin asks the manager to release the batch moved from,
 *   and the purchase is done.
 *
 * Restart now and Check again go to the manager under the purchase. Every purchase, restart, check and release is
 * audited.
 */

const logger = Logger.getInstance();

/** How often the open purchases are read in the background. */
export const BATCH_PURCHASE_POLL_MS = 10_000;

/** How long a start, and a read, wait on the manager's answer before they answer the purchase as it stands. */
export const BATCH_PURCHASE_WAIT_MS = 2_000;

/** How far back the list goes for the purchases that ended: a day. */
export const BATCH_PURCHASE_RECENT_MS = 24 * 60 * 60 * 1000;

/** What the service uses of the client of the manager's funding API. */
export type BatchPurchaseManager = Pick<
  ManagerFundingClient,
  | 'inventory'
  | 'batchPurchase'
  | 'batchPurchaseStatus'
  | 'batchPurchaseRestart'
  | 'batchPurchaseCheck'
  | 'batchPurchaseRelease'
>;

const NODE_BUSY = 'A purchase is under way on this node. One runs on a node at a time.';
const FAILED_WITHOUT_REASON = 'The manager reports that the purchase failed, without a reason the admin could read.';

/** The codes the manager refuses a purchase or a follow-up call with, having asked the node for nothing. */
const MANAGER_REFUSALS: readonly string[] = ['stamp_refused', 'unknown_node', 'conflict', 'bad_transaction'];

/** A batch id as the admin keeps it: 64 hex digits in lower case, without `0x`. */
function bare(batchId: string): string {
  return batchId.toLowerCase().replace(/^0x/, '');
}

/** A batch id as the API and the manager carry it: `0x` and 64 hex digits in lower case. */
function prefixed(batchId: string): string {
  return `0x${bare(batchId)}`;
}

function shortBatch(batchId: string): string {
  return `${bare(batchId).slice(0, 8)}…`;
}

/** Whether a purchase is under way. */
export function isPurchaseOpen(state: BatchPurchaseState): boolean {
  return BATCH_PURCHASE_OPEN_STATES.includes(state);
}

/**
 * Whether Check again is offered: the purchase failed with its batch bought, a stage's restart failed, or the move of
 * the catalogue onto it failed.
 */
export function purchaseCanCheckAgain(
  row: Pick<BatchPurchaseRow, 'state' | 'batchId' | 'stages'>,
  move: Pick<PurchasedMoveReading, 'state'> | null,
): boolean {
  if (row.state === 'failed') return row.batchId !== null;
  if (row.stages.some((stage) => stage.apply === 'failed')) return true;
  return row.state === 'moving' && move?.state === 'failed';
}

/** A move reading for a purchase whose move was not read in this process. */
function unreadMove(state: BatchPurchaseState): PurchasedMoveReading {
  return {
    state: state === 'done' ? 'done' : 'waiting',
    slotsDone: 0,
    slotsTotal: null,
    message: null,
    clearedThumbnails: [],
  };
}

/**
 * A purchase as the Stamps tab shows it, with its move as last read and the state of its bought batch as the manager
 * last answered it, `batchState`, absent while the manager has not said.
 */
export function toBatchPurchase(
  row: BatchPurchaseRow,
  move: PurchasedMoveReading | null,
  batchState?: StageStampState,
): BatchPurchase {
  const movesCatalogue = row.purpose === 'catalogue' && (row.state === 'moving' || row.state === 'done');
  const reading = movesCatalogue ? (move ?? unreadMove(row.state)) : null;
  const shown: BatchPurchaseMove | null = reading ? { ...reading, released: row.releasedAt !== null } : null;
  return {
    id: row.id,
    purpose: row.purpose,
    nodeId: row.nodeId,
    nodeLabel: row.nodeLabel,
    depth: row.depth,
    immutable: row.immutable,
    days: row.days,
    amountPerChunkPlur: row.amountPerChunkPlur,
    costPlur: row.costPlur,
    replacesBatchId: row.replacesBatchId === null ? null : prefixed(row.replacesBatchId),
    state: row.state,
    batchId: row.batchId === null ? null : prefixed(row.batchId),
    error: row.error,
    stages: row.stages,
    move: shown,
    canCheckAgain: purchaseCanCheckAgain(row, reading),
    startedBy: row.startedBy,
    startedAt: row.startedAt.toISOString(),
    ...(batchState === undefined ? {} : { batchState }),
  };
}

/** The manager's request of a purchase, built from its row alone, so every send of it carries the same fields. */
export function purchaseRequestOf(row: BatchPurchaseRow): FundingBatchPurchaseRequest {
  return {
    requestId: row.id,
    purpose: row.purpose,
    nodeId: row.nodeId,
    depth: row.depth,
    amountPerChunkPlur: row.amountPerChunkPlur,
    immutable: row.immutable,
    label: null,
    replacesBatchId: row.replacesBatchId === null ? null : prefixed(row.replacesBatchId),
  };
}

/** A stage of the manager's status as the Stamps tab shows it. */
function stageOf(stage: FundingBatchPurchaseStatus['stages'][number]): BatchPurchaseStage {
  return { stageId: stage.stageId, name: stage.name, apply: stage.apply, message: stage.message };
}

/**
 * The node a purchase of `purpose` buys on, from the inventory: the catalogue node for the catalogue, and a stage's
 * node that is not the catalogue node for a rung. Refused with a sentence otherwise.
 */
export function purchaseNodeOf(inventory: FundingInventory, request: BatchPurchaseRequest): FundingNode {
  if (request.purpose === 'catalogue') {
    const node = inventory.catalogue;
    if (!node || node.nodeId !== request.nodeId) {
      throw new FundingRefusedError(
        'node',
        `${request.nodeId} is not the catalogue node the manager names now, so no catalogue batch is bought on it. Nothing was bought.`,
      );
    }
    return node;
  }
  if (inventory.catalogue?.nodeId === request.nodeId) {
    throw new FundingRefusedError(
      'node',
      "The catalogue node's batch is bought as the catalogue batch, not as a rung's. Nothing was bought.",
    );
  }
  const node = inventory.stages.flatMap((stage) => stage.nodes).find((each) => each.nodeId === request.nodeId);
  if (!node) {
    throw new FundingRefusedError(
      'node',
      `The manager runs no stage node ${request.nodeId} now. Read the page again. Nothing was bought.`,
    );
  }
  return node;
}

/**
 * Why `node` takes no purchase now, with the refusal's kind, or null: a manager that offers none, a node that stamps
 * nothing, a batch other than the one the page showed, and a batch that still pays.
 */
export function purchaseReplaceProblem(
  node: FundingNode,
  replacesBatchId: string | null,
): { kind: FundingRefusalProblem; message: string } | null {
  if (node.replacement === undefined) return { kind: 'node', message: BATCH_PURCHASES_NOT_OFFERED };
  if (node.replacement === null) {
    return { kind: 'node', message: `${nodeName(node)} stamps nothing, so no batch is bought for it.` };
  }
  const shown = replacesBatchId === null ? null : bare(replacesBatchId);
  const now = node.batch ? bare(node.batch.batchId) : null;
  if (shown !== now) {
    return {
      kind: 'batch',
      message: `The batch of ${nodeName(node)} changed since the page showed it. Read the page again. Nothing was bought.`,
    };
  }
  if (!batchOffersPurchase(node)) {
    return {
      kind: 'batch',
      message: `The batch of ${nodeName(node)} still pays, so it is topped up or diluted rather than replaced. Nothing was bought.`,
    };
  }
  return null;
}

/** The kind of a refusal `batchBuyProblem` answered, by what it is about. */
function buyRefusalKind(problem: string, postage: FundingPostage | null): FundingRefusalProblem {
  if (postage === null || problem.startsWith('The price of postage')) return 'price';
  if (problem.startsWith("The node's wallet")) return 'insufficient_funds';
  return 'batch';
}

/**
 * Why the manager refused a purchase it was sent, in a sentence, or null when the failure leaves it to be read again:
 * a refusal with one of the contract's codes carries the manager's sentence, and a 404 without one is a manager that
 * offers no purchases of this kind.
 */
function sendRefusal(error: unknown): string | null {
  if (!(error instanceof ManagerFundingError) || error.status === null || error.status < 400 || error.status >= 500) {
    return null;
  }
  if (error.code === 'unknown_request') return null;
  if (MANAGER_REFUSALS.includes(error.code)) return error.message.trim() || NODE_BUSY;
  if (error.code === 'funding_off' || error.code === 'unauthorized') return managerProblem(error);
  if (error.status === 404) return BATCH_PURCHASES_NOT_OFFERED;
  return managerProblem(error);
}

/** A follow-up call the manager refused, as the admin's refusal; any other failure as the manager out of reach. */
function callRefusal(error: unknown): Error {
  if (error instanceof ManagerFundingError && MANAGER_REFUSALS.includes(error.code)) {
    return new FundingRefusedError('batch', `The manager refused it: ${error.message}`);
  }
  return new FundingManagerUnavailableError(managerProblem(error));
}

export interface BatchPurchaseServiceDeps {
  /** The client of the manager's funding API, or null while the admin has no manager funding settings. */
  manager: BatchPurchaseManager | null;
  store: BatchPurchaseStore;
  /** The catalogue move, which a catalogue purchase moves the catalogue through. */
  move: PurchasedCatalogueMove;
  audit: AuditLog;
  /** A new purchase id: `randomUUID` by default. */
  newId?: () => string;
  /** The admin's clock, in ms: `Date.now` by default. */
  now?: () => number;
  /** How often the open purchases are read: {@link BATCH_PURCHASE_POLL_MS} by default. */
  pollMs?: number;
  /** How long a start and a read wait on the manager: {@link BATCH_PURCHASE_WAIT_MS} by default. */
  waitMs?: number;
}

export class BatchPurchaseService {
  private readonly manager: BatchPurchaseManager | null;
  private readonly store: BatchPurchaseStore;
  private readonly move: PurchasedCatalogueMove;
  private readonly audit: AuditLog;
  private readonly newId: () => string;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly waitMs: number;
  /** The work on each purchase, one at a time: a look, a restart or a check waits for the one before it. */
  private readonly work = new Map<string, Promise<unknown>>();
  /** The look running on each purchase, which every caller shares rather than look twice. */
  private readonly looks = new Map<string, Promise<void>>();
  /** The move of each catalogue purchase as last read in this process. */
  private readonly moves = new Map<string, PurchasedMoveReading>();
  /** The state of each purchase's bought batch as the manager last answered it in this process. */
  private readonly batchStates = new Map<string, StageStampState>();
  /** The read of a held purchase's status running on each purchase, which every caller shares. */
  private readonly stateReads = new Map<string, Promise<void>>();
  private poller: ReturnType<typeof setInterval> | null = null;

  constructor(deps: BatchPurchaseServiceDeps) {
    this.manager = deps.manager;
    this.store = deps.store;
    this.move = deps.move;
    this.audit = deps.audit;
    this.newId = deps.newId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.pollMs = deps.pollMs ?? BATCH_PURCHASE_POLL_MS;
    this.waitMs = deps.waitMs ?? BATCH_PURCHASE_WAIT_MS;
  }

  /** Reads the purchases under way now, and every {@link BATCH_PURCHASE_POLL_MS} after, until {@link shutdown}. */
  boot(): void {
    if (this.poller || !this.manager) return;
    void this.lookAtOpen();
    this.poller = setInterval(() => void this.lookAtOpen(), this.pollMs);
    this.poller.unref();
  }

  /** Stops the background reads, and waits for the work under way. */
  async shutdown(): Promise<void> {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    await this.idle();
  }

  /** Resolves once no work runs on any purchase in this process. */
  async idle(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work.values()]);
  }

  /**
   * `GET /api/funding/batch-purchases`: the purchases the store lists, the latest first, read from the manager
   * first, waiting {@link BATCH_PURCHASE_WAIT_MS} at most: each purchase under way is followed up, and for each
   * failed one that holds its node (`batchPurchaseHoldsNode`) the state of its bought batch is read.
   */
  async list(): Promise<BatchPurchasesResponse> {
    const since = new Date(this.now() - BATCH_PURCHASE_RECENT_MS);
    const held = (await this.store.listSince(since)).filter((row) => this.holdsAsFailed(row));
    const open = await this.store.listOpen();
    await this.within(
      Promise.all([...open.map((row) => this.look(row.id)), ...held.map((row) => this.readBatchState(row.id))]),
    );
    const rows = await this.store.listSince(since);
    return { purchases: rows.map((row) => this.toView(row)) };
  }

  /** `GET /api/funding/batch-purchases/:id`: one purchase, read from the manager first, or null for none. */
  async get(id: string): Promise<BatchPurchase | null> {
    const row = await this.store.get(id);
    if (!row) return null;
    if (isPurchaseOpen(row.state)) await this.within(this.look(id));
    return this.view(id);
  }

  /**
   * `POST /api/funding/batch-purchases`: checks the purchase against the manager's inventory, read fresh, writes it,
   * and sends it to the manager, answering it as it stands after {@link BATCH_PURCHASE_WAIT_MS} at most. The refusals,
   * nothing written, are the module's.
   */
  async start(actor: OperatorActor, request: BatchPurchaseRequest): Promise<BatchPurchase> {
    const manager = this.requireManager();
    if (request.purpose === 'catalogue' && !this.move.enabled()) {
      throw new FundingRefusedError('not_set_up', BATCH_PURCHASE_MOVE_OFF);
    }
    const inventory = await this.readInventory(manager);
    if (inventory.chain.chainId !== ADMIN_FUNDING_CHAIN_ID) {
      throw new FundingRefusedError(
        'chain',
        `The manager's nodes are on chain ${inventory.chain.chainId}, not Gnosis Chain (${ADMIN_FUNDING_CHAIN_ID}), which the admin works with. Nothing was bought.`,
      );
    }
    const node = purchaseNodeOf(inventory, request);
    const replace = purchaseReplaceProblem(node, request.replacesBatchId);
    if (replace) throw new FundingRefusedError(replace.kind, replace.message);
    const postage = inventory.chain.postage ?? null;
    const problem = batchBuyProblem(request.purpose, request, {
      postage,
      walletXbzzPlur: node.xbzzPlur,
      walletXdaiWei: node.xdaiWei,
    });
    if (problem) throw new FundingRefusedError(buyRefusalKind(problem, postage), problem);

    const row = await this.store.create({
      id: this.newId(),
      purpose: request.purpose,
      nodeId: node.nodeId,
      nodeLabel: node.label,
      depth: request.depth,
      immutable: request.immutable,
      days: request.days,
      amountPerChunkPlur: batchBuyAmountPerChunkPlur(request.days, postage!),
      costPlur: request.costPlur,
      replacesBatchId: request.replacesBatchId === null ? null : bare(request.replacesBatchId),
      startedByUserId: actor.userId,
      startedBy: describeActor(actor),
    });
    if (!row) throw new FundingRefusedError('node', NODE_BUSY);
    logger.info(
      `[Funding] ${describeActor(actor)} asked for a ${row.purpose} batch of depth ${row.depth} for ${row.days} days on ${nodeName(node)} (${row.id}), ${row.costPlur} PLUR`,
    );
    await recordAudit(this.audit, {
      actor,
      action: 'funding.purchase.request',
      details: {
        purchaseId: row.id,
        purpose: row.purpose,
        nodeId: row.nodeId,
        nodeLabel: row.nodeLabel,
        depth: row.depth,
        immutable: row.immutable,
        days: row.days,
        amountPerChunkPlur: row.amountPerChunkPlur,
        costPlur: row.costPlur,
        replacesBatchId: row.replacesBatchId,
        postage,
      },
    });
    await this.within(this.look(row.id));
    return (await this.view(row.id))!;
  }

  /**
   * `POST /api/funding/batch-purchases/:id/restart`: restarts now the uploader of a stage that waits for a broadcast
   * to end, through the manager, and answers the purchase. Null for no such purchase.
   */
  async restart(actor: OperatorActor, id: string, stageId: string): Promise<BatchPurchase | null> {
    const manager = this.requireManager();
    return this.exclusive(id, async () => {
      const row = await this.store.get(id);
      if (!row) return null;
      if (row.purpose !== 'rung' || row.state !== 'restarting') {
        throw new FundingRefusedError('batch', 'This purchase has no stage that waits to restart.');
      }
      const stage = row.stages.find((each) => each.stageId === stageId);
      if (!stage || !fundingPurchaseRestartable(stage.apply)) {
        throw new FundingRefusedError(
          'batch',
          'This stage does not wait for a broadcast to end, so there is nothing to restart now.',
        );
      }
      let status: FundingBatchPurchaseStatus;
      try {
        status = await manager.batchPurchaseRestart(id, stageId);
      } catch (error) {
        throw callRefusal(error);
      }
      logger.info(`[Funding] ${describeActor(actor)} restarted stage "${stage.name}" for purchase ${id}`);
      await recordAudit(this.audit, {
        actor,
        action: 'funding.purchase.restart',
        details: { purchaseId: id, nodeId: row.nodeId, stageId, stageName: stage.name },
      });
      await this.follow(manager, row, status, actor, false);
      return this.view(id);
    });
  }

  /**
   * `POST /api/funding/batch-purchases/:id/check`: takes up again what stopped after the batch was bought, the
   * manager's follow-up or the move of the catalogue, and answers the purchase. Nothing is bought a second time. A
   * failed purchase's bought batch is read first, and one that has run out, which no check can put to use, holds its
   * node no more and is refused. Null for no such purchase.
   */
  async check(actor: OperatorActor, id: string): Promise<BatchPurchase | null> {
    const manager = this.requireManager();
    return this.exclusive(id, async () => {
      const row = await this.store.get(id);
      if (!row) return null;
      const move = this.moves.get(id) ?? null;
      if (!purchaseCanCheckAgain(row, move)) {
        throw new FundingRefusedError('batch', 'Nothing of this purchase stopped, so there is nothing to check again.');
      }
      if (row.state === 'failed') {
        // A status that cannot be read leaves the state as last answered; the check then goes to the manager.
        await manager
          .batchPurchaseStatus(id)
          .then((status) => this.noteBatchState(id, status))
          .catch((error: unknown) =>
            logger.warn(
              `[Funding] could not read the batch of purchase ${id} before a check: ${getErrorMessage(error)}`,
            ),
          );
        if (!this.holdsAsFailed(row)) {
          throw new FundingRefusedError(
            'batch',
            'The batch this purchase bought has run out, so a check cannot put it to use. Buy a new batch instead.',
          );
        }
      }
      const movingAgain = row.state === 'moving' && move?.state === 'failed';
      let status: FundingBatchPurchaseStatus;
      try {
        status = movingAgain ? await manager.batchPurchaseStatus(id) : await manager.batchPurchaseCheck(id);
      } catch (error) {
        throw callRefusal(error);
      }
      logger.info(`[Funding] ${describeActor(actor)} checked purchase ${id} again`);
      await recordAudit(this.audit, {
        actor,
        action: 'funding.purchase.check',
        details: { purchaseId: id, nodeId: row.nodeId, state: row.state, move: movingAgain },
      });
      await this.follow(manager, row, status, actor, movingAgain);
      return this.view(id);
    });
  }

  /** The purchase as the Stamps tab shows it now, or null. */
  private async view(id: string): Promise<BatchPurchase | null> {
    const row = await this.store.get(id);
    return row ? this.toView(row) : null;
  }

  /** A row as the Stamps tab shows it, with what this process last read of its move and its bought batch. */
  private toView(row: BatchPurchaseRow): BatchPurchase {
    return toBatchPurchase(row, this.moves.get(row.id) ?? null, this.batchStates.get(row.id));
  }

  /** Whether a failed purchase holds its node, by `batchPurchaseHoldsNode` on what was last read of its batch. */
  private holdsAsFailed(row: BatchPurchaseRow): boolean {
    return row.state === 'failed' && batchPurchaseHoldsNode(this.toView(row));
  }

  /** Keeps the state of a purchase's bought batch the manager answered, and drops it when the manager said none. */
  private noteBatchState(id: string, status: Pick<FundingBatchPurchaseStatus, 'batchState'>): void {
    if (status.batchState === undefined) this.batchStates.delete(id);
    else this.batchStates.set(id, status.batchState);
  }

  /**
   * Reads the status of a failed purchase that holds its node, for the state of its bought batch, shared with the
   * read under way. Never rejects: a status that cannot be read leaves the state as last answered.
   */
  private readBatchState(id: string): Promise<void> {
    const manager = this.manager;
    if (!manager) return Promise.resolve();
    const running = this.stateReads.get(id);
    if (running) return running;
    const read = this.exclusive(id, async () => this.noteBatchState(id, await manager.batchPurchaseStatus(id)))
      .catch((error: unknown) => {
        logger.warn(`[Funding] could not read the batch of purchase ${id} on the manager: ${getErrorMessage(error)}`);
      })
      .finally(() => this.stateReads.delete(id));
    this.stateReads.set(id, read);
    return read;
  }

  /** One look at each purchase under way. Never rejects. */
  private async lookAtOpen(): Promise<void> {
    try {
      const open = await this.store.listOpen();
      await Promise.all(open.map((row) => this.look(row.id)));
    } catch (error) {
      logger.warn(`[Funding] could not read the purchases under way: ${getErrorMessage(error)}`);
    }
  }

  /** One look at a purchase, shared with the one under way. Never rejects: what stops it is logged. */
  private look(id: string): Promise<void> {
    const running = this.looks.get(id);
    if (running) return running;
    const look = this.exclusive(id, () => this.lookOnce(id))
      .catch((error: unknown) => {
        logger.warn(`[Funding] could not follow purchase ${id} on the manager: ${getErrorMessage(error)}`);
      })
      .finally(() => this.looks.delete(id));
    this.looks.set(id, look);
    return look;
  }

  private async lookOnce(id: string): Promise<void> {
    const manager = this.manager;
    const row = await this.store.get(id);
    if (!manager || !row || !isPurchaseOpen(row.state)) return;
    if (row.relayedAt === null) {
      await this.send(manager, row);
      return;
    }
    let status: FundingBatchPurchaseStatus;
    try {
      status = await manager.batchPurchaseStatus(id);
    } catch (error) {
      if (managerCode(error) === 'unknown_request') {
        // The manager never received it, so the next look sends it again, under the same id.
        await this.store.update(id, { relayed: 'unsent' });
        return;
      }
      throw error;
    }
    await this.follow(manager, row, status, FUNDING_SYSTEM, false);
  }

  /**
   * Sends a purchase to the manager, marked sent first: a process that stops after the manager took it reads where it
   * stands, rather than asking again. A refusal fails it with the manager's sentence; a lost answer leaves it to be read.
   */
  private async send(manager: BatchPurchaseManager, row: BatchPurchaseRow): Promise<void> {
    await this.store.update(row.id, { relayed: 'sent' });
    try {
      const answer = await manager.batchPurchase(purchaseRequestOf(row));
      if (answer.state === 'failed') {
        // The answer carries no reason; the status route carries the manager's.
        const words = await manager
          .batchPurchaseStatus(row.id)
          .then((status) => status.error?.trim() || null)
          .catch(() => null);
        await this.settle(row, { state: 'failed', error: words ?? FAILED_WITHOUT_REASON }, FUNDING_SYSTEM);
        return;
      }
      if (answer.batchId) {
        await this.record(
          row,
          { state: 'waiting_usable', batchId: bare(answer.batchId), txHash: answer.txHash },
          FUNDING_SYSTEM,
        );
      }
    } catch (error) {
      const refusal = sendRefusal(error);
      if (refusal === null) throw error;
      await this.settle(row, { state: 'failed', error: refusal }, FUNDING_SYSTEM);
    }
  }

  /**
   * Records where the manager says a purchase stands. A rung's set batch restarts the stages; a catalogue's
   * designated batch moves the catalogue, starting a failed move again when `retryMove` is set.
   */
  private async follow(
    manager: BatchPurchaseManager,
    before: BatchPurchaseRow,
    status: FundingBatchPurchaseStatus,
    actor: Actor,
    retryMove: boolean,
  ): Promise<void> {
    const batchId = status.batchId ? bare(status.batchId) : before.batchId;
    const stages = status.stages.map(stageOf);
    const known = { batchId, txHash: status.txHash ?? before.txHash, stages };
    this.noteBatchState(before.id, status);
    if (status.state === 'failed' || status.step === 'failed') {
      const error = status.error?.trim() || FAILED_WITHOUT_REASON;
      await this.settle(before, { ...known, state: 'failed', error }, actor);
      return;
    }
    if (status.step === 'buying' || status.step === 'waiting_usable') {
      const state: BatchPurchaseState = batchId === null ? 'buying' : 'waiting_usable';
      await this.record(before, { ...known, state, error: null }, actor);
      return;
    }
    if (before.purpose === 'rung') {
      if (status.step === 'done') await this.settle(before, { ...known, state: 'done', error: null }, actor);
      else await this.record(before, { ...known, state: 'restarting', error: null }, actor);
      return;
    }
    const moving = await this.record(before, { ...known, state: 'moving', error: null }, actor);
    if (moving) await this.moveOn(manager, moving, status, retryMove);
  }

  /**
   * Moves the catalogue onto a designated batch through the move, and once the move is done, releases the batch it
   * moved from through the manager, when there was one, and the purchase is done. A release the manager refuses
   * (`stamp_refused`) is not asked again: the purchase is done, unreleased, with the manager's sentence. Any other
   * failure of the release leaves the purchase moving, and the next look asks again.
   */
  private async moveOn(
    manager: BatchPurchaseManager,
    row: BatchPurchaseRow,
    status: FundingBatchPurchaseStatus,
    retryFailed: boolean,
  ): Promise<void> {
    const reading = await this.move.ensure({ targetBatchId: row.batchId!, purchaseId: row.id, retryFailed });
    this.moves.set(row.id, reading);
    if (reading.state !== 'done') return;
    const previous = status.catalogue?.previousBatchId ?? null;
    if (previous !== null && status.catalogue?.released !== true) {
      try {
        await manager.batchPurchaseRelease(row.id);
      } catch (error) {
        if (managerCode(error) === 'stamp_refused') {
          const sentence = `The catalogue moved onto the new batch, and the manager refused to release the previous one: ${(error as Error).message}`;
          logger.warn(`[Funding] purchase ${row.id}: ${sentence}`);
          await this.settle(row, { state: 'done', error: sentence }, FUNDING_SYSTEM);
          return;
        }
        logger.warn(
          `[Funding] could not release batch ${shortBatch(previous)} for purchase ${row.id}, it is asked again: ${getErrorMessage(error)}`,
        );
        return;
      }
      logger.info(
        `[Funding] the catalogue moved onto ${shortBatch(row.batchId!)}, and ${shortBatch(previous)} is released`,
      );
      await recordAudit(this.audit, {
        actor: FUNDING_SYSTEM,
        action: 'funding.purchase.release',
        details: { purchaseId: row.id, nodeId: row.nodeId, batchId: row.batchId, previousBatchId: bare(previous) },
      });
    }
    await this.settle(
      row,
      { state: 'done', error: null, ...(previous !== null ? { released: true } : {}) },
      FUNDING_SYSTEM,
    );
  }

  /** Records a change that keeps the purchase under way, auditing its batch once bought, and answers the row. */
  private async record(
    before: BatchPurchaseRow,
    change: BatchPurchaseChange,
    actor: Actor,
  ): Promise<BatchPurchaseRow | null> {
    const after = await this.write(before, change);
    if (after && before.batchId === null && after.batchId !== null) {
      logger.info(`[Funding] purchase ${after.id} bought batch ${shortBatch(after.batchId)} on ${after.nodeId}`);
      await recordAudit(this.audit, {
        actor,
        action: 'funding.purchase.bought',
        details: { purchaseId: after.id, nodeId: after.nodeId, batchId: after.batchId, txHash: after.txHash },
      });
    }
    return after;
  }

  /** Records that a purchase is done or failed, auditing it once, when it first comes to that state. */
  private async settle(before: BatchPurchaseRow, change: BatchPurchaseChange, actor: Actor): Promise<void> {
    const after = await this.record(before, change, actor);
    if (!after || after.state === before.state) return;
    const action: AuditAction = after.state === 'done' ? 'funding.purchase.done' : 'funding.purchase.failed';
    if (after.state === 'done') logger.info(`[Funding] purchase ${after.id} is done`);
    else logger.warn(`[Funding] purchase ${after.id} failed: ${after.error}`);
    await recordAudit(this.audit, {
      actor,
      action,
      details: {
        purchaseId: after.id,
        purpose: after.purpose,
        nodeId: after.nodeId,
        batchId: after.batchId,
        txHash: after.txHash,
        error: after.error,
      },
    });
  }

  /** Writes a change, refusing one that would put a purchase under way beside another on its node. */
  private async write(before: BatchPurchaseRow, change: BatchPurchaseChange): Promise<BatchPurchaseRow | null> {
    const after = await this.store.update(before.id, change);
    if (after === 'busy') throw new FundingRefusedError('node', NODE_BUSY);
    return after;
  }

  /** Runs `work` on a purchase once the work before it on the same purchase is over. */
  private exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    const before = this.work.get(id) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(work);
    const tail = run.catch(() => undefined);
    this.work.set(id, tail);
    void tail.then(() => {
      if (this.work.get(id) === tail) this.work.delete(id);
    });
    return run;
  }

  /** Waits on `work` for {@link BATCH_PURCHASE_WAIT_MS} at most; it goes on behind whoever waited. */
  private async within(work: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.waitMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private requireManager(): BatchPurchaseManager {
    if (!this.manager) {
      throw new FundingRefusedError(
        'not_set_up',
        'Funding is not set up: the admin has no MANAGER_FUNDING_URL and MANAGER_API_TOKEN.',
      );
    }
    return this.manager;
  }

  private async readInventory(manager: BatchPurchaseManager): Promise<FundingInventory> {
    try {
      return await manager.inventory();
    } catch (error) {
      logger.warn(`[Funding] could not read the manager's inventory for a purchase: ${getErrorMessage(error)}`);
      throw new FundingManagerUnavailableError(`${managerProblem(error)} Nothing was bought.`);
    }
  }
}
