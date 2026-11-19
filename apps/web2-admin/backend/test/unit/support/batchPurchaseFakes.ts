/**
 * Fakes of what the batch purchase service works with: its table in memory, the manager's funding API as far as a
 * purchase uses it, and the catalogue move's port.
 */
import type {
  FundingBatchPurchaseAnswer,
  FundingBatchPurchaseRequest,
  FundingBatchPurchaseStatus,
  FundingInventory,
} from '@streaming-monorepo/contracts';
import { batchBuyAmountPerChunkPlur, batchBuyCostPlur } from '@streaming-monorepo/web2-admin-common';

import type { PurchasedCatalogueMove, PurchasedMoveReading } from '../../../src/domain/funding/batchPurchasePorts.js';
import type {
  BatchPurchaseChange,
  BatchPurchaseRow,
  BatchPurchaseStore,
  NewBatchPurchase,
} from '../../../src/domain/funding/BatchPurchaseRepository.js';
import type { BatchPurchaseManager } from '../../../src/domain/funding/BatchPurchaseService.js';
import { ManagerFundingError } from '../../../src/domain/funding/ManagerFundingClient.js';

import { BATCH_CATALOGUE, BATCH_RUNG, fundingBatch, NODE_RUNG, POSTAGE, stampInventory } from './fundingFakes.js';

/** The batch a purchase buys, in the manager's form. */
export const BOUGHT = `0x${'e4'.repeat(32)}`;

/** A stage that follows the rung bought for. */
export const FOLLOWING_STAGE = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';

const OPEN = ['buying', 'waiting_usable', 'restarting', 'moving'];

/** The cost of a batch of `depth` for `days` at the tests' price, as the dialog shows it. */
export function costOf(depth: number, days: number): string {
  return batchBuyCostPlur(depth, batchBuyAmountPerChunkPlur(days, POSTAGE));
}

/**
 * The stamp inventory with the rung's and the catalogue's batches run out, each with the manager's recommendation of a
 * replacement: the rung's expired, at depth 22 and mutable, the catalogue's gone, at depth 18 and immutable.
 */
export function purchaseInventory(): FundingInventory {
  const inventory = stampInventory();
  const nodes = inventory.stages[0]!.nodes.map((node) =>
    node.nodeId === NODE_RUNG
      ? {
          ...node,
          batch: fundingBatch({ batchId: BATCH_RUNG, depth: 22, ttlSeconds: 0, usable: false, state: 'expired' }),
          replacement: { depth: 22, immutable: false },
        }
      : { ...node, replacement: node.role === 'gateway' ? null : { depth: 20, immutable: false } },
  );
  return {
    ...inventory,
    stages: [{ ...inventory.stages[0]!, nodes }],
    catalogue: {
      ...inventory.catalogue!,
      batch: fundingBatch({ batchId: BATCH_CATALOGUE, depth: 18, immutable: true, ttlSeconds: 0, state: 'gone' }),
      replacement: { depth: 18, immutable: true },
    },
  };
}

/** The manager's status of a purchase, with what `over` says beside: by default bought and waiting to be usable. */
export function purchaseStatus(
  request: Pick<FundingBatchPurchaseRequest, 'requestId' | 'purpose' | 'nodeId'>,
  over: Partial<FundingBatchPurchaseStatus> = {},
): FundingBatchPurchaseStatus {
  return {
    requestId: request.requestId,
    purpose: request.purpose,
    nodeId: request.nodeId,
    state: 'confirmed',
    batchId: BOUGHT,
    txHash: `0x${'f5'.repeat(32)}`,
    usable: false,
    step: 'waiting_usable',
    error: null,
    stages: [],
    catalogue: null,
    ...over,
  };
}

/** `batch_purchases` in memory, with migration 030's one purchase under way per node. */
export class InMemoryBatchPurchaseStore implements BatchPurchaseStore {
  readonly rows = new Map<string, BatchPurchaseRow>();
  private clock = 1_700_000_000_000;

  private tick(): Date {
    this.clock += 1_000;
    return new Date(this.clock);
  }

  private openOn(nodeId: string, except: string | null): boolean {
    return [...this.rows.values()].some(
      (row) => row.nodeId === nodeId && row.id !== except && OPEN.includes(row.state),
    );
  }

  async create(purchase: NewBatchPurchase): Promise<BatchPurchaseRow | null> {
    if (this.openOn(purchase.nodeId, null)) return null;
    const at = this.tick();
    const row: BatchPurchaseRow = {
      ...purchase,
      state: 'buying',
      batchId: null,
      txHash: null,
      error: null,
      stages: [],
      releasedAt: null,
      relayedAt: null,
      startedAt: at,
      updatedAt: at,
      finishedAt: null,
    };
    this.rows.set(row.id, row);
    return { ...row };
  }

  async get(id: string): Promise<BatchPurchaseRow | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async listSince(since: Date): Promise<BatchPurchaseRow[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          OPEN.includes(row.state) || row.startedAt >= since || (row.finishedAt !== null && row.finishedAt >= since),
      )
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .map((row) => ({ ...row }));
  }

  async listOpen(): Promise<BatchPurchaseRow[]> {
    return [...this.rows.values()].filter((row) => OPEN.includes(row.state)).map((row) => ({ ...row }));
  }

  async update(id: string, change: BatchPurchaseChange): Promise<BatchPurchaseRow | 'busy' | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const state = change.state ?? row.state;
    if (OPEN.includes(state) && !OPEN.includes(row.state) && this.openOn(row.nodeId, id)) return 'busy';
    const at = this.tick();
    const next: BatchPurchaseRow = {
      ...row,
      state,
      batchId: change.batchId !== undefined ? change.batchId : row.batchId,
      txHash: change.txHash ?? row.txHash,
      error: change.error !== undefined ? change.error : row.error,
      stages: change.stages ? [...change.stages] : row.stages,
      releasedAt: change.released ? (row.releasedAt ?? at) : row.releasedAt,
      relayedAt: change.relayed === 'sent' ? at : change.relayed === 'unsent' ? null : row.relayedAt,
      finishedAt: state === 'done' || state === 'failed' ? (row.finishedAt ?? at) : null,
      updatedAt: at,
    };
    this.rows.set(id, next);
    return { ...next };
  }
}

/** The manager's funding API as a purchase uses it. */
export class FakePurchaseManager implements BatchPurchaseManager {
  inventoryValue: FundingInventory = purchaseInventory();
  readonly requests: FundingBatchPurchaseRequest[] = [];
  /** What the status route answers for each purchase; a purchase not named answers `buying`, nothing bought. */
  readonly statuses = new Map<string, FundingBatchPurchaseStatus | 'unknown_request'>();
  readonly restarts: { requestId: string; stageId: string }[] = [];
  readonly checks: string[] = [];
  readonly releases: string[] = [];
  /** What the next purchase is refused with, or the failure it meets, instead of an answer. */
  sendFailure: ManagerFundingError | null = null;
  /** The state a purchase is answered with. */
  answerState: FundingBatchPurchaseAnswer['state'] = 'unknown';
  /** What a restart, a check or a release is refused with instead. */
  callFailure: ManagerFundingError | null = null;
  /** Whether the store held the purchase when each request came: it is written before the manager is asked. */
  readonly writtenFirst: boolean[] = [];

  constructor(private readonly store: InMemoryBatchPurchaseStore | null = null) {}

  async inventory(): Promise<FundingInventory> {
    return this.inventoryValue;
  }

  async batchPurchase(request: FundingBatchPurchaseRequest): Promise<FundingBatchPurchaseAnswer> {
    this.requests.push(request);
    if (this.store) this.writtenFirst.push(this.store.rows.has(request.requestId));
    if (this.sendFailure) throw this.sendFailure;
    return {
      requestId: request.requestId,
      purpose: request.purpose,
      state: this.answerState,
      batchId: null,
      txHash: null,
    };
  }

  async batchPurchaseStatus(requestId: string): Promise<FundingBatchPurchaseStatus> {
    const status = this.statuses.get(requestId);
    if (status === 'unknown_request') throw new ManagerFundingError('unknown_request', 404, 'No such purchase.');
    const request = this.requests.find((each) => each.requestId === requestId);
    return (
      status ??
      purchaseStatus(
        { requestId, purpose: request?.purpose ?? 'rung', nodeId: request?.nodeId ?? NODE_RUNG },
        { state: 'unknown', batchId: null, txHash: null, usable: null, step: 'buying' },
      )
    );
  }

  async batchPurchaseRestart(requestId: string, stageId: string): Promise<FundingBatchPurchaseStatus> {
    this.restarts.push({ requestId, stageId });
    if (this.callFailure) throw this.callFailure;
    return this.batchPurchaseStatus(requestId);
  }

  async batchPurchaseCheck(requestId: string): Promise<FundingBatchPurchaseStatus> {
    this.checks.push(requestId);
    if (this.callFailure) throw this.callFailure;
    return this.batchPurchaseStatus(requestId);
  }

  async batchPurchaseRelease(requestId: string): Promise<FundingBatchPurchaseStatus> {
    this.releases.push(requestId);
    if (this.callFailure) throw this.callFailure;
    const status = await this.batchPurchaseStatus(requestId);
    const released: FundingBatchPurchaseStatus = {
      ...status,
      step: 'done',
      catalogue: { previousBatchId: status.catalogue?.previousBatchId ?? null, released: true },
    };
    this.statuses.set(requestId, released);
    return released;
  }
}

/** The catalogue move's port: switched on or off, and answering every target with the reading a test sets. */
export class FakeCatalogueMove implements PurchasedCatalogueMove {
  on = true;
  reading: PurchasedMoveReading = {
    state: 'running',
    slotsDone: 3,
    slotsTotal: 12,
    message: null,
    clearedThumbnails: [],
  };
  readonly calls: { targetBatchId: string; purchaseId: string; retryFailed: boolean }[] = [];

  enabled(): boolean {
    return this.on;
  }

  async ensure(input: {
    targetBatchId: string;
    purchaseId: string;
    retryFailed: boolean;
  }): Promise<PurchasedMoveReading> {
    this.calls.push(input);
    return { ...this.reading };
  }
}
