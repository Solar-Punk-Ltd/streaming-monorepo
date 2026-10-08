import { randomUUID } from 'node:crypto';

import type {
  FundingChequebookOperationAnswer,
  FundingChequebookOperationStatus,
  FundingErrorCode,
  FundingInventory,
  FundingNode,
} from '@streaming-monorepo/contracts';
import {
  CHEQUEBOOK_TARGET_MIN_PLUR,
  type ChequebookItemRequest,
  type ChequebookMove,
  chequebookMove,
  chequebookMoveNow,
  type FundingChequebookBulkAnswer,
  type FundingChequebookItem,
  type FundingChequebookOperationsAnswer,
  type FundingChequebookOperationsRequest,
  formatBaseUnits,
  movableChequebook,
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
  chequebookRequestOf,
  holdsChequebookBulk,
  isChequebookAsked,
  type FundingChequebookRow,
  type FundingChequebookStore,
  type NewFundingChequebookOperation,
} from './FundingChequebookRepository.js';
import {
  ADMIN_FUNDING_CHAIN_ID,
  FUNDING_REFRESH_LIMIT,
  FUNDING_SYSTEM,
  managerCode,
  managerProblem,
  nodeName,
} from './FundingService.js';
import { ManagerFundingError, type ManagerFundingClient } from './ManagerFundingClient.js';

/**
 * The chequebook operations of the Funding page (docs/architecture/funding.md, "Chequebooks tab"): the deposits into
 * and withdrawals from the chequebooks of the brand's nodes that bring each to a target the operator typed, which the
 * manager asks each node for. A deposit moves xBZZ from the node's wallet into its chequebook, a withdrawal from its
 * chequebook into its wallet, the one place Bee withdraws to, and the node pays the gas of either in xDAI. The admin
 * signs nothing for them and moves none of the brand wallet's funds; it checks a request against the manager's
 * inventory, read fresh, journals it, and relays it item by item through the manager's funding API
 * (`packages/contracts/src/funding.ts`).
 *
 * Each item's move is worked out again when the request comes in, and never moves more than the page's confirm dialog
 * showed: `chequebookMoveNow(target, availablePlur, available now)`, from the available balance the page read and the
 * one the manager's inventory reads now (`chequebookPlan.ts` of web2-admin-common, whose `chequebookMove` the page
 * shows). A deposit is the target less the larger of the two, so it keeps the amount shown into a chequebook its node
 * drew on since and lands a little under the target, and shrinks into one that grew, landing on it; a withdrawal is
 * the smaller of the two less the target, so it shrinks from a chequebook that drew down, landing on the target, and
 * keeps the amount shown from one that grew. The journal keeps the balance the move was worked out from, beside the
 * target. A busy node keeps paying its peers out of its chequebook, so its balance lands near the target, not on it.
 *
 * A request is refused, in this order, nothing journalled: a target that is not whole PLUR of 30 digits at most or is
 * under 1 xBZZ (`CHEQUEBOOK_TARGET_MIN_PLUR`), no item, an available balance that is not whole PLUR of 30 digits at
 * most, or a node named twice (`RequestShapeError`); funding not set up; a manager on another chain; an item whose node
 * no stage lists (the catalogue node alone is not listed) or whose chequebook the tab does not move
 * (`movableChequebook`: a gateway's, one the node has not got or that was not read, or one whose node's wallet was not
 * read), whose chequebook stands at the target as the page showed it, or is at the target or past it now; a node that
 * holds no xDAI for the gas, or less xBZZ than its deposit; an earlier chequebook bulk with an item that still holds up
 * a new one, once refreshed, or another request at the same moment (`FundingBusyError`). The manager checks again, and
 * its preflight on the chain once more.
 *
 * Every item is journalled (`funding_chequebook_operations`) before any is relayed, one request at a time under the
 * chequebook lock, and the request answers at once, every item `queued`. The items are then relayed in turn behind
 * it, in this process, as stamp operations are. A request names a node once, so no item waits on another. A read of
 * the bulk and the page's view refresh it, waiting on the refresh, or on the relays under way, for
 * {@link FUNDING_CHEQUEBOOK_WAIT_MS} at most. One run of relays or reads per bulk at a time in a process, which every
 * caller shares.
 *
 * An item the manager refuses (`chequebook_refused`, `unknown_node`, `conflict`, `bad_transaction`) fails with the
 * manager's sentence, nothing having been asked of the node, and the next item is relayed: each node moves its own.
 * Any other failure, an answer lost among them or the manager's journal out of reach (its 503), leaves the item
 * `queued`, and the ones after it, for a refresh, which asks the manager where each stands and relays again, the same
 * fields under the same request id, only one the manager never received (`unknown_request`). The manager journals a
 * move before it asks the node, so one that reached it is never `unknown_request`. An item the manager answered for is
 * never relayed again, since a second run of it would move the balance again: the manager journals it and runs it once.
 *
 * A `queued` item holds up the next chequebook bulk until the manager has it, and a `submitted` or `unknown` one for
 * the manager's 30-minute receipt budget ({@link holdsChequebookBulk}). Past it the manager may hold the move so until
 * an operator settles it in the manager's console, so the next bulk goes ahead while the item is still asked about:
 * the manager itself refuses a second move on a node while one is in flight there, `conflict`, and that item fails
 * with its sentence.
 */

const logger = Logger.getInstance();

/**
 * How long a read of a chequebook bulk, and the page's view, wait on the bulk's refresh or on its relays under way
 * before they answer the journal as it stands; the relays and reads go on behind them. A relay waits on the manager's
 * preparation of the move through the node, and on the node.
 */
export const FUNDING_CHEQUEBOOK_WAIT_MS = 2_000;

/** What the chequebook service uses of the client of the manager's funding API. */
export type FundingChequebookManager = Pick<
  ManagerFundingClient,
  'inventory' | 'chequebookOperation' | 'chequebookOperationStatus'
>;

/**
 * The codes a relay is refused with for good: the manager checked the move, or could not prepare it, and asked the
 * node for nothing (`chequebook_refused`); it does not hold the node (`unknown_node`); another move on the node is
 * still under way, or the request id is another move's (`conflict`); or it could not take the request
 * (`bad_transaction`), and would refuse the same fields again. The item fails. Any other failure (the manager or the
 * chain out of reach, the funding API off, a token refused, an answer lost or one that cannot be read) leaves it as
 * journalled, for a refresh to ask about.
 */
const CHEQUEBOOK_REFUSALS: readonly FundingErrorCode[] = [
  'chequebook_refused',
  'unknown_node',
  'conflict',
  'bad_transaction',
];

/** Why a relay failed its item for good, in a sentence, or null when it leaves the item as journalled. */
function relayFailure(error: unknown): string | null {
  if (!(error instanceof ManagerFundingError)) return null;
  return (CHEQUEBOOK_REFUSALS as readonly string[]).includes(error.code)
    ? `The manager refused it: ${error.message}`
    : null;
}

/** The error of an item the manager calls failed with no sentence the admin could read. */
const FAILED_WITHOUT_REASON = 'The manager reports that it failed, without a reason the admin could read.';

/** How one relay ended: the manager took it, it failed, or it is held as journalled; and the item as it now stands. */
interface Relayed {
  outcome: 'taken' | 'failed' | 'held';
  row: FundingChequebookRow;
}

/**
 * Whole PLUR as a chequebook request carries it: decimal digits, with no sign, prefix or leading zero, and 30 at
 * most, so the move worked out from two of them is never longer than the manager's chequebook journal holds.
 */
const REQUEST_PLUR = /^(0|[1-9]\d{0,29})$/;

/** `3 chequebooks` or `1 chequebook`. */
function plural(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? '' : 's'}`;
}

/** An amount of PLUR as an amount of xBZZ a person reads, every digit of it. */
function xbzz(plur: bigint | string): string {
  return formatBaseUnits(plur.toString(), XBZZ_DECIMALS);
}

/**
 * Refuses a request the schema cannot, or a caller of the service that skipped it: a target that is not whole PLUR of
 * 30 digits at most, or is under the owner's floor of 1 xBZZ; no item; an available balance that is not whole PLUR of
 * 30 digits at most; and a node named twice. Each before the manager is asked anything.
 */
export function checkChequebookShape(request: FundingChequebookOperationsRequest): void {
  if (!REQUEST_PLUR.test(request.targetPlur)) {
    throw new RequestShapeError(['The target must be a whole number of PLUR, 30 digits at most.']);
  }
  if (BigInt(request.targetPlur) < BigInt(CHEQUEBOOK_TARGET_MIN_PLUR)) {
    throw new RequestShapeError([`The target must be at least ${xbzz(CHEQUEBOOK_TARGET_MIN_PLUR)} xBZZ.`]);
  }
  if (request.items.length === 0) throw new RequestShapeError(['A request names one chequebook or more.']);
  const seen = new Set<string>();
  for (const item of request.items) {
    if (!REQUEST_PLUR.test(item.availablePlur)) {
      throw new RequestShapeError([
        `The available balance of ${item.nodeId} must be a whole number of PLUR, 30 digits at most.`,
      ]);
    }
    if (seen.has(item.nodeId)) {
      throw new RequestShapeError([`${item.nodeId} is named twice: a request brings a chequebook to the target once.`]);
    }
    seen.add(item.nodeId);
  }
}

/**
 * One item of a request, checked against the inventory: the stage's node whose chequebook moves, its wallet and its
 * chequebook read, and the move that brings its chequebook to the target, worked out again from the balance read now
 * and never more than the page showed.
 */
export interface ChequebookTarget {
  item: ChequebookItemRequest;
  node: FundingNode;
  move: ChequebookMove;
  /**
   * The available balance the move was worked out from, PLUR: the larger of the page's and the one read now for a
   * deposit, the smaller for a withdrawal, so the move is the one that brings it to the target. The journal keeps it.
   */
  fromPlur: string;
}

/** The available balance `move` brings to `targetPlur`: the target less a deposit, or the target plus a withdrawal. */
function balanceMovedFrom(targetPlur: string, move: ChequebookMove): string {
  const target = BigInt(targetPlur);
  const amount = BigInt(move.amountPlur);
  return (move.direction === 'deposit' ? target - amount : target + amount).toString();
}

/** Why a stage's node's chequebook is not moved from the tab, in a sentence that names it. Only for one refused. */
function immovable(node: FundingNode): FundingRefusedError {
  if (node.role === 'gateway') {
    return new FundingRefusedError(
      'node',
      `${nodeName(node)} is a gateway: the manager moves only the chequebook of a stage's own Bee node or of a rung. Nothing was sent.`,
    );
  }
  const chequebook = node.chequebook;
  if (chequebook === undefined) {
    return new FundingRefusedError(
      'chequebook',
      `The manager did not say how the chequebook of ${nodeName(node)} stands: it reads no chequebooks. Nothing was sent.`,
    );
  }
  if (chequebook === null) {
    return new FundingRefusedError(
      'chequebook',
      `${nodeName(node)} has no chequebook, so there is none to bring to the target. Nothing was sent.`,
    );
  }
  if (chequebook.readError !== null || chequebook.availablePlur === null) {
    return new FundingRefusedError(
      'chequebook',
      `The chequebook of ${nodeName(node)} could not be read, so nothing was sent.${chequebook.readError ? ` ${chequebook.readError}` : ''}`,
    );
  }
  return new FundingRefusedError(
    'node',
    `The wallet of ${nodeName(node)} could not be read, so there is no telling whether it can pay. Nothing was sent.${node.readError ? ` ${node.readError}` : ''}`,
  );
}

/**
 * Each item of a request checked against the manager's inventory, read fresh, in the request's order; the first that
 * fails refuses the request. An item names a node a stage lists, its own Bee node or a rung: the catalogue node alone
 * is not, whose chequebook the tab leaves alone. A node two stages list, as a stage's own and as another's rung, is
 * read once, so only its role differs between its listings. Its chequebook must be one the tab moves
 * ({@link movableChequebook}). Its move is {@link chequebookMoveNow}, worked out again from the available balance the
 * page showed and the one read now, never more than the page showed: an item the page showed at the target is not
 * one, and nor is one whose chequebook is at the target or past it now, which the page should read again.
 */
export function chequebookTargetsOf(
  request: FundingChequebookOperationsRequest,
  inventory: FundingInventory,
): ChequebookTarget[] {
  const staged = inventory.stages.flatMap((stage) => stage.nodes);
  return request.items.map((item) => {
    const named = staged.filter((node) => node.nodeId === item.nodeId);
    const [first] = named;
    if (!first) {
      const catalogue = inventory.catalogue;
      if (catalogue?.nodeId === item.nodeId) {
        throw new FundingRefusedError(
          'node',
          `${nodeName(catalogue)} is the catalogue node, which no stage lists: the Chequebooks tab leaves its chequebook alone. Nothing was sent.`,
        );
      }
      throw new FundingRefusedError('node', `The manager has no node ${item.nodeId}, so nothing was sent.`);
    }
    const node = named.find(movableChequebook) ?? named.find((candidate) => candidate.role !== 'gateway') ?? first;
    const availableNow = node.chequebook?.availablePlur ?? null;
    if (!movableChequebook(node) || availableNow === null) throw immovable(node);

    if (!chequebookMove(request.targetPlur, item.availablePlur)) {
      throw new FundingRefusedError(
        'chequebook',
        `The chequebook of ${nodeName(node)} is at the target as the page showed it, so there is nothing to move. Nothing was sent.`,
      );
    }
    const move = chequebookMoveNow(request.targetPlur, item.availablePlur, availableNow);
    if (!move) {
      throw new FundingRefusedError(
        'chequebook',
        `The chequebook of ${nodeName(node)} holds ${xbzz(availableNow)} xBZZ available now, at the target or past it, so there is nothing to move. Read the page again. Nothing was sent.`,
      );
    }
    return { item, node, move, fromPlur: balanceMovedFrom(request.targetPlur, move) };
  });
}

/**
 * Refuses a request a node cannot pay for. A node pays from its own wallet: its deposit in xBZZ, and the gas of either
 * way in xDAI. So every wallet must have been read, hold some xDAI, and hold its deposit in xBZZ. Nodes are counted by
 * their wallet, as the stamp operations count them. The sentence names each shortfall.
 */
export function checkChequebookFunds(targets: readonly ChequebookTarget[]): void {
  interface Wallet {
    names: string[];
    xdaiWei: bigint;
    xbzzPlur: bigint;
    depositPlur: bigint;
  }
  const wallets = new Map<string, Wallet>();
  for (const { node, move } of targets) {
    if (node.walletAddress === null || node.xdaiWei === null || node.xbzzPlur === null) {
      throw new FundingRefusedError(
        'node',
        `The wallet of ${nodeName(node)} could not be read, so there is no telling whether it can pay. Nothing was sent.`,
      );
    }
    const deposit = move.direction === 'deposit' ? BigInt(move.amountPlur) : 0n;
    const xdaiWei = BigInt(node.xdaiWei);
    const xbzzPlur = BigInt(node.xbzzPlur);
    const wallet = wallets.get(node.walletAddress);
    if (!wallet) {
      wallets.set(node.walletAddress, { names: [nodeName(node)], xdaiWei, xbzzPlur, depositPlur: deposit });
      continue;
    }
    // One wallet read more than once: the smaller reading is the one to count on.
    if (!wallet.names.includes(nodeName(node))) wallet.names.push(nodeName(node));
    wallet.xdaiWei = xdaiWei < wallet.xdaiWei ? xdaiWei : wallet.xdaiWei;
    wallet.xbzzPlur = xbzzPlur < wallet.xbzzPlur ? xbzzPlur : wallet.xbzzPlur;
    wallet.depositPlur += deposit;
  }
  const shortfalls: string[] = [];
  for (const wallet of wallets.values()) {
    const who = wallet.names.join(' and ');
    if (wallet.xdaiWei === 0n) shortfalls.push(`${who} holds no xDAI to pay the gas`);
    if (wallet.depositPlur > wallet.xbzzPlur) {
      shortfalls.push(
        `${who} is ${xbzz(wallet.depositPlur - wallet.xbzzPlur)} xBZZ short: it deposits ${xbzz(wallet.depositPlur)} xBZZ, and its wallet holds ${xbzz(wallet.xbzzPlur)}`,
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
 * An item as the console reads it at `now`. `settled` is false while it holds up a new chequebook bulk
 * ({@link holdsChequebookBulk}): while it is `queued`, and while it is `submitted` or `unknown` for at most the
 * manager's 30-minute receipt budget. `watched` is true while it is `unknown`, and while it is `submitted` past that
 * budget: the manager may still settle such a move from the chain, or an operator in the manager's console. A
 * chequebook item `confirmed` or `failed` is settled for good.
 */
export function toFundingChequebookItem(row: FundingChequebookRow, now: number): FundingChequebookItem {
  const settled = !holdsChequebookBulk(row, now);
  return {
    requestId: row.requestId,
    nodeId: row.nodeId,
    nodeLabel: row.nodeLabel,
    direction: row.direction,
    amountPlur: row.amountPlur,
    targetPlur: row.targetPlur,
    state: row.state,
    txHash: row.txHash,
    error: row.error,
    settled,
    watched: row.state === 'unknown' || (row.state === 'submitted' && settled),
  };
}

/** What an audit row says of an item. */
function itemDetails(row: FundingChequebookRow): Record<string, unknown> {
  return {
    bulkId: row.bulkId,
    requestId: row.requestId,
    nodeId: row.nodeId,
    nodeLabel: row.nodeLabel,
    direction: row.direction,
    amountPlur: row.amountPlur,
    targetPlur: row.targetPlur,
    availablePlur: row.availablePlur,
    txHash: row.txHash,
    state: row.state,
    error: row.error,
  };
}

/** How a log line names an item: which way it moves how much, and on which node. */
function describeItem(row: FundingChequebookRow): string {
  const where = `the chequebook of ${quoteForLog(row.nodeLabel)} (${row.nodeId})`;
  return row.direction === 'deposit'
    ? `deposit of ${xbzz(row.amountPlur)} xBZZ into ${where}`
    : `withdrawal of ${xbzz(row.amountPlur)} xBZZ from ${where}`;
}

export interface FundingChequebookServiceDeps {
  /** The client of the manager's funding API, or null while the admin has no manager funding settings. */
  manager: FundingChequebookManager | null;
  journal: FundingChequebookStore;
  audit: AuditLog;
  /** A new request id or bulk id: `randomUUID` by default. */
  newId?: () => string;
  /** The admin's clock, in ms: `Date.now` by default, a fake in the unit tests. */
  now?: () => number;
  /**
   * How long a read of a bulk, the view, and a request's look at the earlier bulks wait on a bulk's relays and reads:
   * {@link FUNDING_CHEQUEBOOK_WAIT_MS} by default. A request never waits on its own relays.
   */
  waitMs?: number;
}

export class FundingChequebookService {
  private readonly manager: FundingChequebookManager | null;
  private readonly journal: FundingChequebookStore;
  private readonly audit: AuditLog;
  private readonly newId: () => string;
  private readonly now: () => number;
  private readonly waitMs: number;
  /** The relays or the refresh of each chequebook bulk running now, which every caller shares rather than run twice. */
  private readonly runs = new Map<string, Promise<void>>();

  constructor(deps: FundingChequebookServiceDeps) {
    this.manager = deps.manager;
    this.journal = deps.journal;
    this.audit = deps.audit;
    this.newId = deps.newId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.waitMs = deps.waitMs ?? FUNDING_CHEQUEBOOK_WAIT_MS;
  }

  /**
   * `POST /api/funding/chequebook-operations`: checks the request against the manager's inventory, read fresh,
   * journals every item under the chequebook lock, each with the move worked out again from that reading, and answers
   * at once with the bulk id and every item `queued`, as journalled. The items are relayed in turn behind the answer,
   * in this process; a read of the bulk follows them. The refusals, nothing journalled, are the module's.
   */
  async request(
    actor: OperatorActor,
    request: FundingChequebookOperationsRequest,
  ): Promise<FundingChequebookOperationsAnswer> {
    checkChequebookShape(request);
    const manager = this.requireManager();
    const inventory = await this.readInventory(manager);
    if (inventory.chain.chainId !== ADMIN_FUNDING_CHAIN_ID) {
      throw new FundingRefusedError(
        'chain',
        `The manager's nodes are on chain ${inventory.chain.chainId}, not Gnosis Chain (${ADMIN_FUNDING_CHAIN_ID}), which the admin works with. Nothing was sent.`,
      );
    }
    const targets = chequebookTargetsOf(request, inventory);
    checkChequebookFunds(targets);

    const locked = await this.journal.withChequebookLock(async () => {
      // Asked first, as a stamp request asks about the earlier stamp bulks: a bulk whose page was closed never holds
      // the next one for good, and one the manager settled meanwhile lets it through.
      const earlier = new Set([
        ...(await this.journal.askedBulkIds(FUNDING_REFRESH_LIMIT)),
        ...(await this.journal.openBulkIds(FUNDING_REFRESH_LIMIT, new Date(this.now()))),
      ]);
      await this.within(Promise.all([...earlier].map((bulkId) => this.refreshBulk(manager, bulkId))));
      if (await this.journal.hasUnsettled(new Date(this.now()))) throw new FundingBusyError('chequebook bulk');
      const bulkId = this.newId();
      const journal: NewFundingChequebookOperation[] = targets.map((target, position) => ({
        requestId: this.newId(),
        bulkId,
        position,
        nodeId: target.node.nodeId,
        nodeLabel: target.node.label,
        direction: target.move.direction,
        amountPlur: target.move.amountPlur,
        targetPlur: request.targetPlur,
        availablePlur: target.fromPlur,
        requestedByUserId: actor.userId,
        requestedBy: actor.username,
      }));
      await this.journal.insertAll(journal);
      return bulkId;
    });
    if (!locked.locked) throw new FundingBusyError('chequebook bulk');
    const bulkId = locked.result;

    const journalled = await this.journal.listBulk(bulkId);
    logger.info(
      `[Funding] ${describeActor(actor)} asked to bring ${plural(journalled.length, 'chequebook')} to ${xbzz(
        request.targetPlur,
      )} xBZZ (chequebook bulk ${bulkId}): ${journalled.map(describeItem).join('; ')}`,
    );
    await recordAudit(this.audit, {
      actor,
      action: 'funding.chequebook.request',
      details: {
        bulkId,
        targetPlur: request.targetPlur,
        items: journalled.map((row) => ({
          requestId: row.requestId,
          nodeId: row.nodeId,
          nodeLabel: row.nodeLabel,
          direction: row.direction,
          amountPlur: row.amountPlur,
          availablePlur: row.availablePlur,
        })),
      },
    });

    const now = this.now();
    const answer: FundingChequebookOperationsAnswer = {
      bulkId,
      items: journalled.map((row) => toFundingChequebookItem(row, now)),
    };
    // Not waited on: the run never rejects, and a read of the bulk shares it while it goes on.
    void this.run(bulkId, () => this.relayAll(manager, journalled, actor));
    return answer;
  }

  /**
   * `GET /api/funding/chequebook-operations?bulkId=`: the items of a chequebook bulk, refreshed from the manager
   * first, waiting on the refresh, or on the relays still running for it, for {@link FUNDING_CHEQUEBOOK_WAIT_MS} at
   * most. Without manager settings, the items are answered as stored.
   */
  async bulk(bulkId: string): Promise<FundingChequebookBulkAnswer> {
    const rows = await this.journal.listBulk(bulkId);
    if (rows.length === 0) throw new FundingBulkNotFoundError(bulkId, 'chequebook bulk');
    if (this.manager && rows.some(isChequebookAsked)) await this.within(this.refreshBulk(this.manager, bulkId));
    return { items: await this.itemsOf(bulkId) };
  }

  /**
   * For the Funding page's view: refreshes the latest chequebook bulks with an item still asked about,
   * {@link FUNDING_REFRESH_LIMIT} at most, waiting on them for {@link FUNDING_CHEQUEBOOK_WAIT_MS} at most. Asks
   * nothing without manager settings.
   */
  async refreshAsked(): Promise<void> {
    const manager = this.manager;
    if (!manager) return;
    const bulkIds = await this.journal.askedBulkIds(FUNDING_REFRESH_LIMIT);
    await this.within(Promise.all(bulkIds.map((bulkId) => this.refreshBulk(manager, bulkId))));
  }

  /** The latest chequebook bulk with an item that holds up a new one, or null: the page follows it after a reload. */
  async openBulkId(): Promise<string | null> {
    const [bulkId = null] = await this.journal.openBulkIds(1, new Date(this.now()));
    return bulkId;
  }

  /** Resolves once no relay or refresh of any chequebook bulk runs in this process. */
  async idle(): Promise<void> {
    while (this.runs.size > 0) await Promise.all(this.runs.values());
  }

  /** The items of a bulk as the console reads them now. */
  private async itemsOf(bulkId: string): Promise<FundingChequebookItem[]> {
    const now = this.now();
    return (await this.journal.listBulk(bulkId)).map((row) => toFundingChequebookItem(row, now));
  }

  /** Waits on `work` for {@link FUNDING_CHEQUEBOOK_WAIT_MS} at most; it goes on behind whoever waited. */
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
        logger.error(`[Funding] the relays and reads of chequebook bulk ${bulkId} stopped: ${getErrorMessage(error)}`);
      })
      .finally(() => this.runs.delete(bulkId));
    this.runs.set(bulkId, run);
    return run;
  }

  /** A refresh of one bulk, run as {@link run} runs it: shared with the run under way, if any. */
  private refreshBulk(manager: FundingChequebookManager, bulkId: string): Promise<void> {
    return this.run(bulkId, async () => {
      const rows = await this.journal.listBulk(bulkId);
      if (rows.some(isChequebookAsked)) await this.refresh(manager, rows);
    });
  }

  /**
   * The relays of a bulk just journalled, in its order. A refusal fails its item, and the next is relayed; a relay
   * the manager could not answer leaves its item and the ones after it `queued`, for a refresh.
   */
  private async relayAll(
    manager: FundingChequebookManager,
    journalled: readonly FundingChequebookRow[],
    actor: Actor,
  ): Promise<void> {
    for (const row of journalled) {
      if (row.state !== 'queued') continue;
      const relayed = await this.relay(manager, row, actor);
      if (relayed.outcome === 'held') return;
    }
  }

  /**
   * In the bulk's order, reads where each item still asked about stands on the manager, and records it. A `queued`
   * item the manager never received (`unknown_request`) is relayed again, the journalled fields under the same request
   * id. One the manager answered for before and no longer knows is left as it is, never relayed again, since a second
   * run would move the balance again. The refresh stops at the first item the manager cannot answer for, and leaves it
   * and those after it as they are.
   */
  private async refresh(manager: FundingChequebookManager, journalled: readonly FundingChequebookRow[]): Promise<void> {
    for (const row of journalled) {
      if (!isChequebookAsked(row)) continue;
      let status: FundingChequebookOperationStatus;
      try {
        status = await manager.chequebookOperationStatus(row.requestId);
      } catch (error) {
        if (managerCode(error) !== 'unknown_request') {
          logger.warn(
            `[Funding] could not read chequebook operation ${row.requestId} on the manager, it stays ${row.state}: ${getErrorMessage(error)}`,
          );
          return;
        }
        if (row.state !== 'queued') {
          logger.warn(
            `[Funding] the manager has no chequebook operation ${row.requestId}, which it answered for before: it stays ${row.state}, and is never relayed again`,
          );
          continue;
        }
        // The manager never received it: relayed again as journalled.
        const relayed = await this.relay(manager, row, FUNDING_SYSTEM);
        if (relayed.outcome === 'held') return;
        continue;
      }
      await this.record(row, status, FUNDING_SYSTEM);
    }
  }

  /** Records where the manager says an item stands, when anything of it moved, and answers the item as it now stands. */
  private async record(
    row: FundingChequebookRow,
    status: FundingChequebookOperationStatus,
    actor: Actor,
  ): Promise<FundingChequebookRow> {
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
   * Relays one journalled item and records what the manager answered. One the manager refuses for good fails with the
   * manager's sentence; one it answers `failed`, whose move its preflight refused, takes the manager's sentence from a
   * status read, since the answer carries none.
   */
  private async relay(manager: FundingChequebookManager, row: FundingChequebookRow, actor: Actor): Promise<Relayed> {
    let answer: FundingChequebookOperationAnswer;
    try {
      answer = await manager.chequebookOperation(chequebookRequestOf(row));
    } catch (error) {
      const failure = relayFailure(error);
      if (failure) {
        const updated = await this.journal.update(row.requestId, { state: 'failed', error: failure });
        if (updated) await this.auditMove(row, updated, actor);
        return { outcome: 'failed', row: updated ?? row };
      }
      logger.warn(
        `[Funding] chequebook operation ${row.requestId} on ${row.nodeId} was not relayed, it stays ${row.state}: ${getErrorMessage(error)}`,
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
  private async failureReason(manager: FundingChequebookManager, requestId: string): Promise<string> {
    try {
      const status = await manager.chequebookOperationStatus(requestId);
      if (status.error) return status.error;
    } catch (error) {
      logger.warn(`[Funding] could not read why chequebook operation ${requestId} failed: ${getErrorMessage(error)}`);
    }
    return FAILED_WITHOUT_REASON;
  }

  /**
   * The audit row of an item that came to an outcome: `funding.chequebook.confirmed` or `funding.chequebook.failed`,
   * with its hash, once, when it first comes to that state. Each with a log line.
   */
  private async auditMove(before: FundingChequebookRow, after: FundingChequebookRow, actor: Actor): Promise<void> {
    if (after.state === before.state) return;
    let action: AuditAction;
    if (after.state === 'confirmed') action = 'funding.chequebook.confirmed';
    else if (after.state === 'failed') action = 'funding.chequebook.failed';
    else return;
    logger.info(
      `[Funding] ${describeActor(actor)}: ${describeItem(after)} (${after.requestId}) is ${after.state}${
        after.txHash ? `, transaction ${after.txHash}` : ''
      }${after.error ? `: ${after.error}` : ''} [${action}]`,
    );
    await recordAudit(this.audit, { actor, action, details: itemDetails(after) });
  }

  private requireManager(): FundingChequebookManager {
    if (!this.manager) {
      throw new FundingRefusedError(
        'not_set_up',
        'Funding is not set up: the admin has no MANAGER_FUNDING_URL and MANAGER_FUNDING_TOKEN.',
      );
    }
    return this.manager;
  }

  private async readInventory(manager: FundingChequebookManager): Promise<FundingInventory> {
    try {
      return await manager.inventory();
    } catch (error) {
      logger.warn(
        `[Funding] could not read the manager's inventory for a chequebook request: ${getErrorMessage(error)}`,
      );
      throw new FundingManagerUnavailableError(`${managerProblem(error)} Nothing was sent.`);
    }
  }
}
