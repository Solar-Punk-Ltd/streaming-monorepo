import { randomUUID } from 'node:crypto';

import type {
  FundingBatch,
  FundingErrorCode,
  FundingInventory,
  FundingNode,
  FundingStampOperationAnswer,
  FundingStampOperationStatus,
} from '@streaming-monorepo/contracts';
import {
  type FundingStampBulkAnswer,
  type FundingStampItem,
  type FundingStampOperationsAnswer,
  formatBaseUnits,
  type OperableBatch,
  operableBatch,
  type StampOperationItemRequest,
  stampDiluteQuote,
  stampTopUpQuote,
  XBZZ_DECIMALS,
} from '@streaming-monorepo/web2-admin-common';

import { getErrorMessage } from '../../utils/errorUtils.js';
import { quoteForLog } from '../../utils/logText.js';
import { describeActor, type Actor, type OperatorActor } from '../actor.js';
import { recordAudit, type AuditAction, type AuditLog } from '../AuditLog.js';
import {
  FundingBulkNotFoundError,
  FundingBusyError,
  FundingManagerUnavailableError,
  FundingRefusedError,
  RequestShapeError,
} from '../errors/index.js';
import { Logger } from '../Logger.js';

import {
  ADMIN_FUNDING_CHAIN_ID,
  FUNDING_REFRESH_LIMIT,
  FUNDING_SYSTEM,
  managerCode,
  managerProblem,
  nodeName,
} from './FundingService.js';
import {
  holdsStampBulk,
  isStampAsked,
  stampRequestOf,
  type FundingStampRow,
  type FundingStampStore,
  type NewFundingStampOperation,
} from './FundingStampRepository.js';
import { ManagerFundingError, type ManagerFundingClient } from './ManagerFundingClient.js';

/**
 * The stamp operations of the Funding page (docs/architecture/funding.md, "Stamps tab"): top-ups and dilutions of the
 * batches the brand's nodes upload with, which the manager asks each node for, and which each node pays for from its
 * own wallet. The admin signs nothing for them and moves none of the brand wallet's funds; it checks a request against
 * the manager's inventory, read fresh, journals it, and relays it item by item through the manager's funding API
 * (`packages/contracts/src/funding.ts`).
 *
 * A request is refused, in this order, nothing journalled: a request of both kinds, or one that names a batch twice;
 * funding not set up; a manager on another chain; an item whose node or batch the manager does not hold, whose batch
 * could not be read, is not usable, has expired or is no longer at the depth the page showed, whose dilution would
 * leave the batch under 7 days, or whose top-up has no price of postage to go by, or one higher than the page quoted
 * it at; a node whose wallet could not be read, holds no xDAI for the gas, or cannot pay for its top-ups in xBZZ; an
 * earlier stamp bulk with an item that still holds up a new one, once refreshed, or another request at the same moment
 * (`FundingBusyError`). The arithmetic is the console's own, `stampQuote.ts` of web2-admin-common, which the page
 * shows. The manager checks all of it again.
 *
 * Every item is journalled (`funding_stamp_operations`) before any is relayed, one request at a time under the stamp
 * lock, and the request answers at once, every item `queued`. The items are then relayed in turn behind it, in this
 * process: the manager answers an operation only once the node has, and the node once the chain has mined it, which
 * makes minutes of a bulk of several. A node is asked for one operation at a time: an item waits, `queued`, while an
 * item before it in its bulk for the same node still holds up a bulk ({@link holdsStampBulk}: under way, or `unknown`
 * for less than the manager's 30 minutes), and a later refresh relays it. A read of the bulk and the page's view
 * refresh it, waiting on the refresh, or on the relays under way, for {@link FUNDING_STAMP_WAIT_MS} at most. One run of
 * relays or reads per bulk at a time in a process, which every caller shares.
 *
 * An item the manager refuses (`stamp_refused`, `unknown_node`, `bad_transaction`, `conflict`), or whose node it could
 * not reach (`node_unreachable`, which the manager journals failed), fails with the manager's sentence, and the next
 * item is relayed: each node pays for its own. Any other failure leaves the item `queued`, and the ones after it, for a
 * refresh, which asks the manager where each stands and relays again, the same fields under the same request id, only
 * one the manager never received (`unknown_request`). An item the manager answered for is never relayed again, since a
 * second run of it would pay again: the manager journals it and runs it once.
 */

const logger = Logger.getInstance();

/**
 * How long a read of a stamp bulk, and the page's view, wait on the bulk's refresh or on its relays under way before
 * they answer the journal as it stands; the relays and reads go on behind them. A relay can take minutes, since the
 * manager answers it only once the node has, and a node answers once the chain has mined what it asked for.
 */
export const FUNDING_STAMP_WAIT_MS = 2_000;

/** The deepest a batch goes: the postage contract keeps its depth in a byte. */
const MAX_DEPTH = 255;

/** What the stamp service uses of the client of the manager's funding API. */
export type FundingStampManager = Pick<ManagerFundingClient, 'inventory' | 'stampOperation' | 'stampOperationStatus'>;

/**
 * The codes a relay is refused with for good: the manager checked the operation and asked the node for nothing. The
 * item fails. So does one whose node the manager could not reach (`node_unreachable`), which it journals failed. Any
 * other failure (the manager or the chain out of reach, the funding API off, a token refused, an answer that cannot be
 * read) leaves it as journalled, for a refresh to ask about.
 */
const STAMP_REFUSALS: readonly FundingErrorCode[] = ['stamp_refused', 'unknown_node', 'bad_transaction', 'conflict'];

/** Why a relay failed its item for good, in a sentence, or null when it leaves the item as journalled. */
function relayFailure(error: unknown): string | null {
  if (!(error instanceof ManagerFundingError)) return null;
  if (error.code === 'node_unreachable') return `The manager could not reach the node: ${error.message}`;
  return (STAMP_REFUSALS as readonly string[]).includes(error.code) ? `The manager refused it: ${error.message}` : null;
}

/** The error of an item the manager calls failed with no sentence the admin could read. */
const FAILED_WITHOUT_REASON = 'The manager reports that it failed, without a reason the admin could read.';

/** How one relay ended: the manager took it, it failed, or it is held as journalled; and the item as it now stands. */
interface Relayed {
  outcome: 'taken' | 'failed' | 'held';
  row: FundingStampRow;
}

/**
 * Whether an item waits on its node: an item before it in its bulk, for the same node, still holds up a bulk
 * ({@link holdsStampBulk}), so the node may still be working on it. A node is asked for one operation at a time.
 */
export function waitsOnItsNode(row: FundingStampRow, rows: readonly FundingStampRow[], now: number): boolean {
  return rows.some(
    (other) => other.position < row.position && other.nodeId === row.nodeId && holdsStampBulk(other, now),
  );
}

/**
 * One item of a request, checked against the inventory: the node entry that holds its batch, the batch as the node
 * reported it, and what the operation does: a dilution's new depth, or a top-up's amount per chunk and cost.
 */
export interface StampTarget {
  item: StampOperationItemRequest;
  node: FundingNode;
  batch: OperableBatch;
  newDepth: number | null;
  amountPerChunkPlur: string | null;
  costPlur: string | null;
}

/** A batch id as a sentence names it: its first four bytes. */
function shortBatch(batchId: string): string {
  return `${batchId.slice(0, 10)}…`;
}

/** `30 days` or `1 day`. */
function plural(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? '' : 's'}`;
}

/** An amount of PLUR as an amount of xBZZ a person reads. */
function xbzz(plur: bigint | string): string {
  return formatBaseUnits(plur.toString(), XBZZ_DECIMALS);
}

/**
 * Refuses a request the schema cannot: one of both kinds, and one that names a batch twice. Batch ids are compared in
 * lower case, as the inventory keeps them.
 */
export function checkStampShape(items: readonly StampOperationItemRequest[]): void {
  if (new Set(items.map((item) => item.kind)).size > 1) {
    throw new RequestShapeError(['A request takes one kind of operation: top-ups or dilutions, not both.']);
  }
  const seen = new Set<string>();
  for (const item of items) {
    const batchId = item.batchId.toLowerCase();
    if (seen.has(batchId)) {
      throw new RequestShapeError([`Batch ${batchId} is named twice: a request takes one operation on a batch.`]);
    }
    seen.add(batchId);
  }
}

/** Why a batch takes no operation, in a sentence that names its node. Only for one {@link operableBatch} refuses. */
function inoperable(batch: FundingBatch, node: FundingNode): string {
  const unread = batch.readError !== null || batch.depth === null || batch.ttlSeconds === null || batch.usable === null;
  if (unread) {
    return `The batch of ${nodeName(node)} could not be read, so nothing was sent.${batch.readError ? ` ${batch.readError}` : ''}`;
  }
  if (batch.ttlSeconds === 0) {
    return `The batch of ${nodeName(node)} has expired, and an expired batch can be neither topped up nor diluted. Nothing was sent.`;
  }
  return `Bee does not call the batch of ${nodeName(node)} usable, so nothing was sent.`;
}

/**
 * Each item of a request checked against the manager's inventory, read fresh, in the request's order; the first that
 * fails refuses the request. An item names a node and a batch the node uploads with, which the inventory lists
 * together: a node is listed once for each batch it uploads with, as a stage's own node and as the catalogue node,
 * say. The batch must be read whole, usable and not expired ({@link operableBatch}), and at the depth the page showed.
 * A top-up is priced at the price of postage the manager read now ({@link stampTopUpQuote}), and refused when that is
 * higher than the price the page quoted it at, so it never costs more than the page showed; a dilution must leave the
 * batch 7 days or more ({@link stampDiluteQuote}).
 */
export function stampTargetsOf(
  items: readonly StampOperationItemRequest[],
  inventory: FundingInventory,
): StampTarget[] {
  const entries = [
    ...inventory.stages.flatMap((stage) => stage.nodes),
    ...(inventory.catalogue ? [inventory.catalogue] : []),
  ];
  const postage = inventory.chain.postage ?? null;
  return items.map((item) => {
    const named = entries.filter((node) => node.nodeId === item.nodeId);
    const [first] = named;
    if (!first) {
      throw new FundingRefusedError('node', `The manager has no node ${item.nodeId}, so nothing was sent.`);
    }
    const node = named.find((candidate) => candidate.batch?.batchId === item.batchId);
    const batch = node?.batch;
    if (!node || !batch) {
      throw new FundingRefusedError(
        'batch',
        `Batch ${shortBatch(item.batchId)} is not a batch ${nodeName(first)} uploads with, so nothing was sent.`,
      );
    }
    if (!operableBatch(batch)) throw new FundingRefusedError('batch', inoperable(batch, node));
    if (batch.depth !== item.expectedDepth) {
      throw new FundingRefusedError(
        'batch',
        `The batch of ${nodeName(node)} is at depth ${batch.depth} now, not the ${item.expectedDepth} the page showed: read the page again. Nothing was sent.`,
      );
    }
    if (item.kind === 'topup') {
      if (!postage) {
        throw new FundingRefusedError(
          'price',
          'The manager could not read the price of postage from any node, so no top-up can be priced. Nothing was sent.',
        );
      }
      // Priced at the price of now, which may be lower than the page's, never higher: the page showed what it costs.
      if (BigInt(postage.pricePerChunkPerBlockPlur) > BigInt(item.pricePerChunkPerBlockPlur)) {
        throw new FundingRefusedError(
          'price',
          'The price of postage has risen since the page read it. Read the page again. Nothing was sent.',
        );
      }
      const quote = stampTopUpQuote(item.days, batch.depth, batch.ttlSeconds, postage);
      return {
        item,
        node,
        batch,
        newDepth: null,
        amountPerChunkPlur: quote.amountPerChunkPlur,
        costPlur: quote.costPlur,
      };
    }
    const quote = stampDiluteQuote(item.steps, batch.depth, batch.ttlSeconds);
    if (quote.problem) {
      throw new FundingRefusedError(
        'batch',
        `The batch of ${nodeName(node)} cannot be diluted ${plural(item.steps, 'step')}: ${quote.problem} Nothing was sent.`,
      );
    }
    if (quote.newDepth > MAX_DEPTH) {
      throw new FundingRefusedError(
        'batch',
        `The batch of ${nodeName(node)} is at depth ${batch.depth}, and ${plural(item.steps, 'step')} more would take it past ${MAX_DEPTH}. Nothing was sent.`,
      );
    }
    return { item, node, batch, newDepth: quote.newDepth, amountPerChunkPlur: null, costPlur: null };
  });
}

/**
 * Refuses a request a node cannot pay for. A node pays from its own wallet: its top-ups in xBZZ, and the gas of every
 * operation, a top-up's approval and its top-up or a dilution, in xDAI. So every wallet must have been read, hold some
 * xDAI, and hold the sum of the top-ups it pays for in xBZZ. Nodes are counted by their wallet, since one node is
 * listed once for each batch it uploads with, each time with the same wallet. The sentence names each shortfall.
 */
export function checkStampFunds(targets: readonly StampTarget[]): void {
  interface Wallet {
    names: string[];
    xdaiWei: bigint;
    xbzzPlur: bigint;
    costPlur: bigint;
  }
  const wallets = new Map<string, Wallet>();
  for (const { node, costPlur } of targets) {
    if (node.walletAddress === null || node.xdaiWei === null || node.xbzzPlur === null) {
      throw new FundingRefusedError(
        'node',
        `The wallet of ${nodeName(node)} could not be read, so there is no telling whether it can pay. Nothing was sent.`,
      );
    }
    const cost = costPlur === null ? 0n : BigInt(costPlur);
    const xdaiWei = BigInt(node.xdaiWei);
    const xbzzPlur = BigInt(node.xbzzPlur);
    const wallet = wallets.get(node.walletAddress);
    if (!wallet) {
      wallets.set(node.walletAddress, { names: [nodeName(node)], xdaiWei, xbzzPlur, costPlur: cost });
      continue;
    }
    // One wallet read more than once: the smaller reading is the one to count on.
    if (!wallet.names.includes(nodeName(node))) wallet.names.push(nodeName(node));
    wallet.xdaiWei = xdaiWei < wallet.xdaiWei ? xdaiWei : wallet.xdaiWei;
    wallet.xbzzPlur = xbzzPlur < wallet.xbzzPlur ? xbzzPlur : wallet.xbzzPlur;
    wallet.costPlur += cost;
  }
  const shortfalls: string[] = [];
  for (const wallet of wallets.values()) {
    const who = wallet.names.join(' and ');
    if (wallet.xdaiWei === 0n) shortfalls.push(`${who} holds no xDAI to pay the gas`);
    if (wallet.costPlur > wallet.xbzzPlur) {
      shortfalls.push(
        `${who} is ${xbzz(wallet.costPlur - wallet.xbzzPlur)} xBZZ short: its top-ups cost ${xbzz(wallet.costPlur)} xBZZ, and its wallet holds ${xbzz(wallet.xbzzPlur)}`,
      );
    }
  }
  if (shortfalls.length > 0) {
    throw new FundingRefusedError(
      'insufficient_funds',
      `The nodes cannot pay for this: ${shortfalls.join('; ')}. Nothing was sent.`,
    );
  }
}

/**
 * An item as the console reads it at `now`. `settled` is false while it holds up a new stamp bulk
 * ({@link holdsStampBulk}), and `watched` is true while it is `unknown`: the manager still reads such an operation
 * from the chain, and may yet call it `confirmed`. A stamp item `failed` is settled for good.
 */
export function toFundingStampItem(row: FundingStampRow, now: number): FundingStampItem {
  return {
    requestId: row.requestId,
    kind: row.kind,
    nodeId: row.nodeId,
    nodeLabel: row.nodeLabel,
    batchId: row.batchId,
    days: row.days,
    steps: row.steps,
    costPlur: row.costPlur,
    state: row.state,
    txHash: row.txHash,
    error: row.error,
    settled: !holdsStampBulk(row, now),
    watched: row.state === 'unknown',
  };
}

/** What an audit row says of an item. */
function itemDetails(row: FundingStampRow): Record<string, unknown> {
  return {
    bulkId: row.bulkId,
    requestId: row.requestId,
    nodeId: row.nodeId,
    nodeLabel: row.nodeLabel,
    batchId: row.batchId,
    kind: row.kind,
    days: row.days,
    steps: row.steps,
    expectedDepth: row.expectedDepth,
    newDepth: row.newDepth,
    amountPerChunkPlur: row.amountPerChunkPlur,
    costPlur: row.costPlur,
    txHash: row.txHash,
    state: row.state,
    error: row.error,
  };
}

/** How a log line names an item: what it does, to which batch, on which node. */
function describeItem(row: FundingStampRow): string {
  const where = `batch ${shortBatch(row.batchId)} of ${quoteForLog(row.nodeLabel)} (${row.nodeId})`;
  return row.kind === 'topup'
    ? `top-up of ${plural(row.days ?? 0, 'day')} on ${where}, ${xbzz(row.costPlur ?? '0')} xBZZ`
    : `dilution of ${where} from depth ${row.expectedDepth} to ${row.newDepth}`;
}

export interface FundingStampServiceDeps {
  /** The client of the manager's funding API, or null while the admin has no manager funding settings. */
  manager: FundingStampManager | null;
  journal: FundingStampStore;
  audit: AuditLog;
  /** A new request id or bulk id: `randomUUID` by default. */
  newId?: () => string;
  /** The admin's clock, in ms: `Date.now` by default, a fake in the unit tests. */
  now?: () => number;
  /**
   * How long a read of a bulk, the view, and a request's look at the earlier bulks wait on a bulk's relays and reads:
   * {@link FUNDING_STAMP_WAIT_MS} by default. A request never waits on its own relays.
   */
  waitMs?: number;
}

export class FundingStampService {
  private readonly manager: FundingStampManager | null;
  private readonly journal: FundingStampStore;
  private readonly audit: AuditLog;
  private readonly newId: () => string;
  private readonly now: () => number;
  private readonly waitMs: number;
  /** The relays or the refresh of each stamp bulk running now, which every caller shares rather than run twice. */
  private readonly runs = new Map<string, Promise<void>>();

  constructor(deps: FundingStampServiceDeps) {
    this.manager = deps.manager;
    this.journal = deps.journal;
    this.audit = deps.audit;
    this.newId = deps.newId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.waitMs = deps.waitMs ?? FUNDING_STAMP_WAIT_MS;
  }

  /**
   * `POST /api/funding/stamp-operations`: checks the request against the manager's inventory, read fresh, journals
   * every item under the stamp lock, and answers at once with the bulk id and every item `queued`. The items are
   * relayed in turn behind the answer, in this process; a read of the bulk follows them. The refusals, nothing
   * journalled, are the module's.
   */
  async request(
    actor: OperatorActor,
    items: readonly StampOperationItemRequest[],
  ): Promise<FundingStampOperationsAnswer> {
    const wanted = items.map((item) => ({ ...item, batchId: item.batchId.toLowerCase() }));
    checkStampShape(wanted);
    const manager = this.requireManager();
    const inventory = await this.readInventory(manager);
    if (inventory.chain.chainId !== ADMIN_FUNDING_CHAIN_ID) {
      throw new FundingRefusedError(
        'chain',
        `The manager's nodes are on chain ${inventory.chain.chainId}, not Gnosis Chain (${ADMIN_FUNDING_CHAIN_ID}), which the admin works with. Nothing was sent.`,
      );
    }
    const targets = stampTargetsOf(wanted, inventory);
    checkStampFunds(targets);

    const locked = await this.journal.withStampLock(async () => {
      // Asked first, as a send asks about the open sends: a bulk whose page was closed never holds the next one for
      // good, and one the manager settled meanwhile lets it through.
      const earlier = new Set([
        ...(await this.journal.askedBulkIds(FUNDING_REFRESH_LIMIT)),
        ...(await this.journal.openBulkIds(FUNDING_REFRESH_LIMIT, new Date(this.now()))),
      ]);
      await this.within(Promise.all([...earlier].map((bulkId) => this.refreshBulk(manager, bulkId))));
      if (await this.journal.hasUnsettled(new Date(this.now()))) throw new FundingBusyError('stamp bulk');
      const bulkId = this.newId();
      const journal: NewFundingStampOperation[] = targets.map((target, position) => ({
        requestId: this.newId(),
        bulkId,
        position,
        nodeId: target.node.nodeId,
        nodeLabel: target.node.label,
        batchId: target.batch.batchId,
        kind: target.item.kind,
        days: target.item.kind === 'topup' ? target.item.days : null,
        steps: target.item.kind === 'dilute' ? target.item.steps : null,
        expectedDepth: target.batch.depth,
        newDepth: target.newDepth,
        amountPerChunkPlur: target.amountPerChunkPlur,
        costPlur: target.costPlur,
        requestedByUserId: actor.userId,
        requestedBy: actor.username,
      }));
      await this.journal.insertAll(journal);
      return bulkId;
    });
    if (!locked.locked) throw new FundingBusyError('stamp bulk');
    const bulkId = locked.result;

    const journalled = await this.journal.listBulk(bulkId);
    logger.info(
      `[Funding] ${describeActor(actor)} asked for ${plural(journalled.length, 'stamp operation')} (stamp bulk ${bulkId}): ${journalled
        .map(describeItem)
        .join('; ')}`,
    );
    const postage = inventory.chain.postage ?? null;
    await recordAudit(this.audit, {
      actor,
      action: 'funding.stamp.request',
      details: {
        bulkId,
        kind: journalled[0]?.kind ?? null,
        // The price a top-up was worked out at; a dilution needs none.
        postage: journalled.some((row) => row.kind === 'topup') ? postage : null,
        items: journalled.map((row) => ({
          requestId: row.requestId,
          nodeId: row.nodeId,
          nodeLabel: row.nodeLabel,
          batchId: row.batchId,
          days: row.days,
          steps: row.steps,
          expectedDepth: row.expectedDepth,
          newDepth: row.newDepth,
          amountPerChunkPlur: row.amountPerChunkPlur,
          costPlur: row.costPlur,
        })),
      },
    });

    const now = this.now();
    const answer: FundingStampOperationsAnswer = {
      bulkId,
      items: journalled.map((row) => toFundingStampItem(row, now)),
    };
    // Not waited on: the run never rejects, and a read of the bulk shares it while it goes on.
    void this.run(bulkId, () => this.relayAll(manager, journalled, actor));
    return answer;
  }

  /**
   * `GET /api/funding/stamp-operations?bulkId=`: the items of a stamp bulk, refreshed from the manager first, waiting
   * on the refresh, or on the relays still running for it, for {@link FUNDING_STAMP_WAIT_MS} at most. Without manager
   * settings, the items are answered as stored.
   */
  async bulk(bulkId: string): Promise<FundingStampBulkAnswer> {
    const rows = await this.journal.listBulk(bulkId);
    if (rows.length === 0) throw new FundingBulkNotFoundError(bulkId, 'stamp bulk');
    if (this.manager && rows.some(isStampAsked)) await this.within(this.refreshBulk(this.manager, bulkId));
    return { items: await this.itemsOf(bulkId) };
  }

  /**
   * For the Funding page's view: refreshes the latest stamp bulks with an item still asked about,
   * {@link FUNDING_REFRESH_LIMIT} at most, waiting on them for {@link FUNDING_STAMP_WAIT_MS} at most. Asks nothing
   * without manager settings.
   */
  async refreshAsked(): Promise<void> {
    const manager = this.manager;
    if (!manager) return;
    const bulkIds = await this.journal.askedBulkIds(FUNDING_REFRESH_LIMIT);
    await this.within(Promise.all(bulkIds.map((bulkId) => this.refreshBulk(manager, bulkId))));
  }

  /** The latest stamp bulk with an item that holds up a new one, or null: the page follows it after a reload. */
  async openBulkId(): Promise<string | null> {
    const [bulkId = null] = await this.journal.openBulkIds(1, new Date(this.now()));
    return bulkId;
  }

  /** Resolves once no relay or refresh of any stamp bulk runs in this process. */
  async idle(): Promise<void> {
    while (this.runs.size > 0) await Promise.all(this.runs.values());
  }

  /** The items of a bulk as the console reads them now. */
  private async itemsOf(bulkId: string): Promise<FundingStampItem[]> {
    const now = this.now();
    return (await this.journal.listBulk(bulkId)).map((row) => toFundingStampItem(row, now));
  }

  /** Waits on `work` for {@link FUNDING_STAMP_WAIT_MS} at most; it goes on behind whoever waited. */
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

  /**
   * Runs `work` for a bulk unless a run of it is under way, which the caller then shares: one run of relays or reads
   * per bulk at a time in this process, so overlapping reads relay nothing twice and audit nothing twice. The run
   * never rejects: what stops it is logged, and its items stay as recorded, for the next refresh.
   */
  private run(bulkId: string, work: () => Promise<void>): Promise<void> {
    const running = this.runs.get(bulkId);
    if (running) return running;
    const run = work()
      .catch((error: unknown) => {
        logger.error(`[Funding] the relays and reads of stamp bulk ${bulkId} stopped: ${getErrorMessage(error)}`);
      })
      .finally(() => this.runs.delete(bulkId));
    this.runs.set(bulkId, run);
    return run;
  }

  /** A refresh of one bulk, run as {@link run} runs it: shared with the run under way, if any. */
  private refreshBulk(manager: FundingStampManager, bulkId: string): Promise<void> {
    return this.run(bulkId, async () => {
      const rows = await this.journal.listBulk(bulkId);
      if (rows.some(isStampAsked)) await this.refresh(manager, rows);
    });
  }

  /**
   * The relays of a bulk just journalled, in its order. An item that waits on its node ({@link waitsOnItsNode}) stays
   * `queued` for a later refresh, and the next is relayed. A refusal fails its item, and the next is relayed; a relay
   * the manager could not answer leaves its item and the ones after it `queued`, for a refresh.
   */
  private async relayAll(
    manager: FundingStampManager,
    journalled: readonly FundingStampRow[],
    actor: Actor,
  ): Promise<void> {
    const rows = [...journalled];
    for (const [index, row] of rows.entries()) {
      if (row.state !== 'queued' || waitsOnItsNode(row, rows, this.now())) continue;
      const relayed = await this.relay(manager, row, actor);
      rows[index] = relayed.row;
      if (relayed.outcome === 'held') return;
    }
  }

  /**
   * In the bulk's order, reads where each item still asked about stands on the manager, and records it. A `queued`
   * item the manager never received (`unknown_request`) is relayed again, the journalled fields under the same request
   * id, unless it waits on its node ({@link waitsOnItsNode}): then it was never relayed, and it is neither read nor
   * relayed until the item before it settles. One the manager answered for before and no longer knows is left as it
   * is, never relayed again, since a second run would pay again. The refresh stops at the first item the manager cannot
   * answer for, and leaves it and those after it as they are.
   */
  private async refresh(manager: FundingStampManager, journalled: readonly FundingStampRow[]): Promise<void> {
    const rows = [...journalled];
    for (const [index, row] of rows.entries()) {
      if (!isStampAsked(row)) continue;
      if (row.state === 'queued' && waitsOnItsNode(row, rows, this.now())) continue;
      let status: FundingStampOperationStatus;
      try {
        status = await manager.stampOperationStatus(row.requestId);
      } catch (error) {
        if (managerCode(error) !== 'unknown_request') {
          logger.warn(
            `[Funding] could not read stamp operation ${row.requestId} on the manager, it stays ${row.state}: ${getErrorMessage(error)}`,
          );
          return;
        }
        if (row.state !== 'queued') {
          logger.warn(
            `[Funding] the manager has no stamp operation ${row.requestId}, which it answered for before: it stays ${row.state}, and is never relayed again`,
          );
          continue;
        }
        // The manager never received it: relayed again as journalled.
        const relayed = await this.relay(manager, row, FUNDING_SYSTEM);
        rows[index] = relayed.row;
        if (relayed.outcome === 'held') return;
        continue;
      }
      rows[index] = await this.record(row, status, FUNDING_SYSTEM);
    }
  }

  /** Records where the manager says an item stands, when anything of it moved, and answers the item as it now stands. */
  private async record(
    row: FundingStampRow,
    status: FundingStampOperationStatus,
    actor: Actor,
  ): Promise<FundingStampRow> {
    const error = status.error ?? (status.state === 'failed' ? FAILED_WITHOUT_REASON : null);
    const txHash = status.txHash ?? row.txHash;
    if (status.state === row.state && error === row.error && txHash === row.txHash) return row;
    const updated = await this.journal.update(row.requestId, {
      state: status.state,
      error,
      txHash,
      // A queued row the manager answers for was relayed after all, its answer lost: the manager journalled it no
      // later than now, so an `unknown` item's window starts here, as after an answered relay.
      ...(row.state === 'queued' ? { relayedAt: new Date(this.now()) } : {}),
    });
    if (updated) await this.auditMove(row, updated, actor);
    return updated ?? row;
  }

  /**
   * Relays one journalled item and records what the manager answered. One the manager refuses for good, or whose node
   * it could not reach, fails with the manager's sentence; one it answers `failed`, which the node refused, takes the
   * manager's sentence from a status read, since the answer carries none.
   */
  private async relay(manager: FundingStampManager, row: FundingStampRow, actor: Actor): Promise<Relayed> {
    let answer: FundingStampOperationAnswer;
    try {
      answer = await manager.stampOperation(stampRequestOf(row));
    } catch (error) {
      const failure = relayFailure(error);
      if (failure) {
        const updated = await this.journal.update(row.requestId, { state: 'failed', error: failure });
        if (updated) await this.auditMove(row, updated, actor);
        return { outcome: 'failed', row: updated ?? row };
      }
      logger.warn(
        `[Funding] stamp operation ${row.requestId} on ${row.nodeId} was not relayed, it stays ${row.state}: ${getErrorMessage(error)}`,
      );
      return { outcome: 'held', row };
    }
    // Once the answer is back, so at or after the manager's own journal moment: an unknown item's window starts here.
    const answeredAt = new Date(this.now());
    const error = answer.state === 'failed' ? await this.failureReason(manager, row.requestId) : null;
    const updated = await this.journal.update(row.requestId, {
      state: answer.state,
      error,
      txHash: answer.txHash ?? row.txHash,
      relayedAt: answeredAt,
    });
    if (updated) await this.auditMove(row, updated, actor);
    return { outcome: answer.state === 'failed' ? 'failed' : 'taken', row: updated ?? row };
  }

  /** The manager's sentence for an operation it answered failed, or the admin's own when it cannot be read. */
  private async failureReason(manager: FundingStampManager, requestId: string): Promise<string> {
    try {
      const status = await manager.stampOperationStatus(requestId);
      if (status.error) return status.error;
    } catch (error) {
      logger.warn(`[Funding] could not read why stamp operation ${requestId} failed: ${getErrorMessage(error)}`);
    }
    return FAILED_WITHOUT_REASON;
  }

  /**
   * The audit row of an item that came to an outcome: `funding.stamp.confirmed` or `funding.stamp.failed`, with its
   * hash, once, when it first comes to that state. Each with a log line.
   */
  private async auditMove(before: FundingStampRow, after: FundingStampRow, actor: Actor): Promise<void> {
    if (after.state === before.state) return;
    let action: AuditAction;
    if (after.state === 'confirmed') action = 'funding.stamp.confirmed';
    else if (after.state === 'failed') action = 'funding.stamp.failed';
    else return;
    logger.info(
      `[Funding] ${describeActor(actor)}: ${describeItem(after)} (${after.requestId}) is ${after.state}${
        after.txHash ? `, transaction ${after.txHash}` : ''
      }${after.error ? `: ${after.error}` : ''} [${action}]`,
    );
    await recordAudit(this.audit, { actor, action, details: itemDetails(after) });
  }

  private requireManager(): FundingStampManager {
    if (!this.manager) {
      throw new FundingRefusedError(
        'not_set_up',
        'Funding is not set up: the admin has no MANAGER_FUNDING_URL and MANAGER_FUNDING_TOKEN.',
      );
    }
    return this.manager;
  }

  private async readInventory(manager: FundingStampManager): Promise<FundingInventory> {
    try {
      return await manager.inventory();
    } catch (error) {
      logger.warn(`[Funding] could not read the manager's inventory for a stamp request: ${getErrorMessage(error)}`);
      throw new FundingManagerUnavailableError(`${managerProblem(error)} Nothing was sent.`);
    }
  }
}
