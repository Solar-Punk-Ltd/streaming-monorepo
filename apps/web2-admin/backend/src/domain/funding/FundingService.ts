import { randomUUID } from 'node:crypto';

import type {
  FundingAccountAnswer,
  FundingErrorCode,
  FundingInventory,
  FundingNode,
  FundingTransferAnswer,
  FundingTransferStatus,
} from '@streaming-monorepo/contracts';
import {
  type AdminFundingNode,
  type FundingBulkAnswer,
  type FundingPinsAnswer,
  type FundingPinState,
  type FundingTransferItem,
  type FundingTransferItemRequest,
  type FundingTransfersAnswer,
  type FundingView,
  formatBaseUnits,
  XBZZ_DECIMALS,
  XDAI_DECIMALS,
} from '@streaming-monorepo/web2-admin-common';
import { type Address, encodeFunctionData, erc20Abi, getAddress, type Hex, keccak256 } from 'viem';

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

import type { BrandWallet, BrandWalletTransaction } from './BrandWallet.js';
import type { FundingPinRow, FundingPinStore, NewFundingPin } from './FundingPinRepository.js';
import {
  holdsSend,
  isAsked,
  isOpen,
  type FundingTransferRow,
  type FundingTransferStore,
  type FundingTransferUpdate,
  type NewFundingTransfer,
} from './FundingTransferRepository.js';
import { ManagerFundingError, type ManagerFundingClient } from './ManagerFundingClient.js';

/**
 * The Funding page's service (docs/architecture/funding.md): the brand wallet and every node the manager funds, the
 * pins that confirm each node's wallet, and sends from the brand wallet to node wallets, which the admin signs and the
 * manager relays to the chain. The admin has no chain connection: the nodes, the wallet's balances, nonce and fees
 * and every transfer's state come from the manager's funding API (`packages/contracts/src/funding.ts`).
 *
 * A send is refused, in this order: a password that is wrong (the route checks it first); a node named twice for one
 * kind; funding not set up; a node not pinned, whose wallet is not the pinned one or could not be read; an earlier
 * send with an item that still holds it up (`queued`, `submitted`, or `unknown` within the manager's 30 minutes), once
 * refreshed; a fee or gas limit over the admin's own ceilings; a
 * wallet that cannot pay for it, fees counted. Then every item is signed with consecutive nonces and journalled
 * (`funding_transfers`) before any is relayed, one send at a time under the store's send lock. What the manager does
 * not take for a reason that passes stays journalled, and `bulk` relays it again, the same bytes under the same
 * request id. Nothing is ever signed twice, and a failed item is never sent again. An `unknown` item older than the
 * manager's 30 minutes, and a `failed` one the chain's node refused with no block, hold up no send but stay watched
 * for a late receipt; a younger `unknown` one holds it up, since the chain may hold it at its nonce.
 *
 * Neither the signed transaction nor the wallet's key reaches an answer, a log line or the audit log.
 */

const logger = Logger.getInstance();

/** The chain the admin signs for, fixed in the admin: Gnosis Chain. */
export const ADMIN_FUNDING_CHAIN_ID = 100;

/**
 * The admin's own ceilings on what the manager suggests, held before anything is signed. The manager holds a transfer
 * to three times its own suggestion, which guards it against a hostile admin; only these guard the brand wallet against
 * a hostile or broken manager.
 */
/** The most wei per gas the admin signs for, base fee and tip together: 100 gwei. */
export const FUNDING_MAX_FEE_PER_GAS_WEI = 100_000_000_000n;
/** The gas limit of an xDAI transfer, exactly: a plain transfer costs 21000 and no more. */
export const FUNDING_GAS_NATIVE = 21_000n;
/** The most gas an xBZZ transfer, the token's `transfer` call, is signed with. */
export const FUNDING_MAX_GAS_BZZ_TRANSFER = 100_000n;

/** How many sends a refresh of the Funding page, or of a send refused for an open one, goes through at most. */
export const FUNDING_REFRESH_LIMIT = 3;

/** Who settles an item when a refresh, rather than an operator's send, learns how it ended. */
export const FUNDING_SYSTEM: Actor = { kind: 'system', reason: 'funding' };

/** What the service uses of the brand wallet: its address, null while it has no key, and a signature. */
export type FundingWallet = Pick<BrandWallet, 'address' | 'signTransaction'>;

/** What the service uses of the client of the manager's funding API. */
export type FundingManager = Pick<ManagerFundingClient, 'inventory' | 'account' | 'relay' | 'status'>;

/**
 * The codes a relay is refused with for good: the manager checked the transfer and will refuse the same bytes again.
 * The item fails. Any other failure (the manager or the chain out of reach, the funding API off, a token refused, an
 * answer that cannot be read) leaves it as journalled, for a refresh to relay again.
 */
const RELAY_REFUSALS: readonly FundingErrorCode[] = ['bad_transaction', 'unknown_node', 'conflict'];

/**
 * The error of an item the manager answered `failed` when it relayed it: the chain's node refused the broadcast. It
 * stays watched, since the manager reads it again for a late receipt.
 */
const REFUSED_AT_RELAY =
  "The chain's node refused it when the manager sent it. If it is mined anyway, this row will say so: check the node's balance before sending to it again.";

/**
 * The error of an item never relayed because one before it in the send failed or was lost: its nonce comes after one
 * that may never be used, so it would wait on the chain for good.
 */
const NOT_SENT_AFTER_FAILURE =
  'Not sent: a transfer before it in this send failed or was lost, so its nonce might never be reached. Send it again.';

/** The code of a failed manager call, or null for any other error. */
function managerCode(error: unknown): ManagerFundingError['code'] | null {
  return error instanceof ManagerFundingError ? error.code : null;
}

/**
 * Why the manager could not be read, in the admin's own sentence. Never the manager's address or token, nor its own
 * text, which names its routes.
 */
export function managerProblem(error: unknown): string {
  switch (managerCode(error)) {
    case 'unreachable':
    case 'timeout':
      return 'The manager could not be reached.';
    case 'funding_off':
      return "The manager's funding API is off: the manager has no FUNDING_API_TOKEN.";
    case 'unauthorized':
      return "The manager refused the admin's token: MANAGER_FUNDING_TOKEN is not the manager's FUNDING_API_TOKEN.";
    case 'chain_unreachable':
      return 'The manager could not reach the chain.';
    default:
      return "The manager's answer could not be read. Is MANAGER_FUNDING_URL the manager's address, and does it run the funding API?";
  }
}

/**
 * A node's pin state against the pin stored for it. A node whose wallet could not be read keeps the state its pin
 * gives it, `pinned` or `new`, and is never `changed` for it: its `readError` says why it was not read.
 */
export function pinStateOf(node: FundingNode, pin: FundingPinRow | undefined): FundingPinState {
  if (!pin) return 'new';
  if (node.walletAddress === null) return 'pinned';
  return pin.walletAddress === node.walletAddress ? 'pinned' : 'changed';
}

function withPin(node: FundingNode, pins: Map<string, FundingPinRow>): AdminFundingNode {
  const pin = pins.get(node.nodeId);
  return { ...node, pin: pinStateOf(node, pin), pinnedAddress: pin?.walletAddress ?? null };
}

/** Every node of the inventory, the catalogue node included, by its id. */
function nodesOf(inventory: FundingInventory): Map<string, FundingNode> {
  const nodes = [
    ...inventory.stages.flatMap((stage) => stage.nodes),
    ...(inventory.catalogue ? [inventory.catalogue] : []),
  ];
  return new Map(nodes.map((node) => [node.nodeId, node]));
}

/** How a sentence names a node: its label and its id. */
function nodeName(node: { label: string; nodeId: string }): string {
  return `${node.label} (${node.nodeId})`;
}

/**
 * An item as the console reads it at `now`, never with the signed transaction. The one place `settled` and `watched`
 * are worked out: `settled` is false while the item holds up a new send ({@link holdsSend}: open, or `unknown` within
 * the manager's 30 minutes), and `watched` is the journal's own column, true while an `unknown` item, or a `failed` one
 * the chain's node refused with no block, is still asked about for a late receipt.
 */
export function toFundingTransferItem(row: FundingTransferRow, now: number): FundingTransferItem {
  return {
    requestId: row.requestId,
    nodeId: row.nodeId,
    kind: row.kind,
    amount: row.amount,
    state: row.state,
    txHash: row.txHash,
    blockNumber: row.blockNumber,
    error: row.error,
    settled: !holdsSend(row, now),
    watched: row.watched,
  };
}

/** What an audit row says of an item: never the signed transaction. */
function itemDetails(row: FundingTransferRow): Record<string, unknown> {
  return {
    bulkId: row.bulkId,
    requestId: row.requestId,
    nodeId: row.nodeId,
    nodeLabel: row.nodeLabel,
    kind: row.kind,
    amount: row.amount,
    to: row.toAddress,
    nonce: row.nonce,
    txHash: row.txHash,
    state: row.state,
    error: row.error,
    blockNumber: row.blockNumber,
  };
}

function unit(kind: 'xdai' | 'xbzz'): string {
  return kind === 'xdai' ? 'xDAI' : 'xBZZ';
}

/** One item of a send, checked against the inventory and the pins: the node, and the pinned wallet it goes to. */
interface SendTarget {
  item: FundingTransferItemRequest;
  node: FundingNode;
  to: string;
}

/** How one relay ended: the manager took it, it failed for good, or it is held as journalled. */
type RelayOutcome = 'taken' | 'failed' | 'held';

export interface FundingServiceDeps {
  /** The brand wallet, or null where none is wired. Its `address()` is null while it has no key. */
  wallet: FundingWallet | null;
  /** The client of the manager's funding API, or null while the admin has no manager funding settings. */
  manager: FundingManager | null;
  transfers: FundingTransferStore;
  pins: FundingPinStore;
  audit: AuditLog;
  /** A new request id or bulk id: `randomUUID` by default. */
  newId?: () => string;
  /**
   * The admin's clock, in ms: `Date.now` by default, a fake in the unit tests. It stamps when the manager's answer to
   * a relay came back (`relayed_at`), and an `unknown` item's 30 minutes are read against it.
   */
  now?: () => number;
}

export class FundingService {
  private readonly wallet: FundingWallet | null;
  private readonly manager: FundingManager | null;
  private readonly transfers: FundingTransferStore;
  private readonly pins: FundingPinStore;
  private readonly audit: AuditLog;
  private readonly newId: () => string;
  private readonly now: () => number;
  /** The refresh of each send running now, so overlapping reads of one send share it rather than relay twice. */
  private readonly refreshing = new Map<string, Promise<void>>();

  constructor(deps: FundingServiceDeps) {
    this.wallet = deps.wallet;
    this.manager = deps.manager;
    this.transfers = deps.transfers;
    this.pins = deps.pins;
    this.audit = deps.audit;
    this.newId = deps.newId ?? randomUUID;
    this.now = deps.now ?? Date.now;
  }

  /** The items of a send as the console reads them now. */
  private async itemsOf(bulkId: string): Promise<FundingTransferItem[]> {
    const now = this.now();
    return (await this.transfers.listBulk(bulkId)).map((row) => toFundingTransferItem(row, now));
  }

  /**
   * `GET /api/funding`. Not configured, it asks the manager nothing. Otherwise it first refreshes the latest sends with
   * an item still asked about, {@link FUNDING_REFRESH_LIMIT} at most, then reads the inventory and the wallet's account
   * together; when either cannot be read, `managerError` says why and every reading of the manager is empty.
   * `openBulkId` names the send that still holds up a new one, so the page resumes it after a reload.
   */
  async view(): Promise<FundingView> {
    const address = this.wallet?.address() ?? null;
    const manager = this.manager;
    if (manager) {
      for (const bulkId of await this.transfers.askedBulkIds(FUNDING_REFRESH_LIMIT)) {
        await this.refreshBulk(manager, bulkId);
      }
    }
    const [openBulkId = null] = await this.transfers.openBulkIds(1, new Date(this.now()));
    const view: FundingView = {
      configured: this.manager !== null,
      wallet: address ? { address, xdaiWei: null, xbzzPlur: null } : null,
      chainId: ADMIN_FUNDING_CHAIN_ID,
      stages: [],
      catalogue: null,
      observedAt: null,
      managerError: null,
      openBulkId,
    };
    if (!manager) return view;

    const pins = await this.pins.all();
    let inventory: FundingInventory;
    let account: FundingAccountAnswer | null;
    try {
      [inventory, account] = await Promise.all([
        manager.inventory(),
        address ? manager.account(address) : Promise.resolve(null),
      ]);
    } catch (error) {
      logger.warn(`[Funding] could not read the manager for the Funding page: ${getErrorMessage(error)}`);
      return { ...view, managerError: managerProblem(error) };
    }
    if (inventory.chain.chainId !== ADMIN_FUNDING_CHAIN_ID) {
      return { ...view, managerError: this.otherChain(inventory.chain.chainId) };
    }
    return {
      ...view,
      wallet: address && account ? { address, xdaiWei: account.xdaiWei, xbzzPlur: account.xbzzPlur } : view.wallet,
      stages: inventory.stages.map((stage) => ({
        stageId: stage.stageId,
        name: stage.name,
        nodes: stage.nodes.map((node) => withPin(node, pins)),
      })),
      catalogue: inventory.catalogue ? withPin(inventory.catalogue, pins) : null,
      observedAt: inventory.observedAt,
    };
  }

  /**
   * `POST /api/funding/pins`, once the operator's password passed: pins the address each node answers now, read from
   * the manager's inventory. A node the inventory does not hold, or whose wallet could not be read, refuses the whole
   * request, and nothing is pinned. A node named twice is pinned once.
   */
  async pin(actor: OperatorActor, nodeIds: readonly string[]): Promise<FundingPinsAnswer> {
    const manager = this.requireManager();
    const wanted = [...new Set(nodeIds)];
    const nodes = nodesOf(await this.readInventory(manager));
    const pins: NewFundingPin[] = [];
    const named: FundingNode[] = [];
    for (const nodeId of wanted) {
      const node = nodes.get(nodeId);
      if (!node) {
        throw new FundingRefusedError('node', `The manager has no node ${nodeId}, so nothing was pinned.`);
      }
      if (node.walletAddress === null) {
        throw new RequestShapeError([
          `The wallet of ${nodeName(node)} could not be read, so there is no address to pin. Nothing was pinned.`,
        ]);
      }
      pins.push({ nodeId, walletAddress: node.walletAddress });
      named.push(node);
    }

    const before = await this.pins.all();
    await this.pins.pin(pins, actor.username);
    logger.info(
      `[Funding] ${describeActor(actor)} pinned the wallets of ${named
        .map((node) => `${quoteForLog(node.label)} (${node.nodeId}) at ${node.walletAddress}`)
        .join(', ')}`,
    );
    await recordAudit(this.audit, {
      actor,
      action: 'funding.pin',
      details: {
        pins: named.map((node) => ({
          nodeId: node.nodeId,
          nodeLabel: node.label,
          walletAddress: node.walletAddress,
          previousAddress: before.get(node.nodeId)?.walletAddress ?? null,
        })),
      },
    });
    return { pinned: wanted };
  }

  /**
   * `POST /api/funding/transfers`, once the operator's password passed: signs every item, journals them all, then
   * relays them in nonce order. Refused, nothing signed, for a node named twice for one kind (`RequestShapeError`),
   * funding not set up, a node not pinned, changed or unreadable (`FundingRefusedError`), an earlier send still open
   * once refreshed or another send at the same moment (`FundingBusyError`), a fee or gas limit over the admin's
   * ceilings, and a wallet that cannot pay (`FundingRefusedError`).
   *
   * A relay the manager refuses for good fails its item, and the items after it are not relayed and fail too, since
   * their nonces would wait behind one never used. A relay that fails for any other reason leaves its item and the
   * ones after it `queued`, for `bulk` to relay again.
   */
  async send(actor: OperatorActor, items: readonly FundingTransferItemRequest[]): Promise<FundingTransfersAnswer> {
    const seen = new Set<string>();
    for (const item of items) {
      const key = `${item.kind}:${item.nodeId}`;
      if (seen.has(key)) {
        throw new RequestShapeError([
          `${item.nodeId} is named twice for ${unit(item.kind)}: a send takes one transfer of each kind to a node.`,
        ]);
      }
      seen.add(key);
    }

    const manager = this.requireManager();
    const wallet = this.wallet;
    const from = wallet?.address() ?? null;
    if (!wallet || !from) {
      throw new FundingRefusedError(
        'not_set_up',
        'There is no brand wallet to send from: BRAND_WALLET_SECRET is unset.',
      );
    }

    const inventory = await this.readInventory(manager);
    if (inventory.chain.chainId !== ADMIN_FUNDING_CHAIN_ID) {
      throw new FundingRefusedError('chain', this.otherChain(inventory.chain.chainId));
    }
    const targets = this.targetsOf(items, nodesOf(inventory), await this.pins.all());

    const locked = await this.transfers.withSendLock(async () => {
      // Asked first, whatever the clock says: an `unknown` item past its 30 minutes may sit in the pool after all, and
      // the manager then answers it `submitted`; a client that never reads the page would otherwise sign over its
      // nonce. The page that sent an open one may be gone as well: refreshed here, it never holds the wallet for good.
      const asked = new Set([
        ...(await this.transfers.askedBulkIds(FUNDING_REFRESH_LIMIT)),
        ...(await this.transfers.openBulkIds(FUNDING_REFRESH_LIMIT, new Date(this.now()))),
      ]);
      for (const bulkId of asked) await this.refreshBulk(manager, bulkId);
      if (await this.transfers.hasUnsettled(new Date(this.now()))) throw new FundingBusyError();
      const account = await this.readAccount(manager, from);
      checkCeilings(account, targets);
      checkBalance(account, targets);
      const bulkId = this.newId();
      const journal: NewFundingTransfer[] = [];
      for (const [index, target] of targets.entries()) {
        const nonce = account.nonce + index;
        const rawTransaction = (
          await wallet.signTransaction(transactionFor(target, account, inventory.chain.bzzToken, nonce))
        ).toLowerCase() as Hex;
        journal.push({
          requestId: this.newId(),
          bulkId,
          nodeId: target.node.nodeId,
          nodeLabel: target.node.label,
          toAddress: target.to,
          kind: target.item.kind,
          amount: target.item.amount,
          nonce,
          rawTransaction,
          txHash: keccak256(rawTransaction),
          requestedByUserId: actor.userId,
          requestedBy: actor.username,
        });
      }
      await this.transfers.insertAll(journal);
      return bulkId;
    });
    if (!locked.locked) throw new FundingBusyError();
    const bulkId = locked.result;

    const journalled = await this.transfers.listBulk(bulkId);
    logger.info(
      `[Funding] ${describeActor(actor)} signed ${journalled.length} transfer(s) from the brand wallet ${from} (send ${bulkId}): ${journalled
        .map(
          (row) =>
            `${formatBaseUnits(row.amount, row.kind === 'xdai' ? XDAI_DECIMALS : XBZZ_DECIMALS)} ${unit(row.kind)} to ${quoteForLog(row.nodeLabel)} (${row.nodeId}), nonce ${row.nonce}`,
        )
        .join('; ')}`,
    );
    await recordAudit(this.audit, {
      actor,
      action: 'funding.transfer.request',
      details: {
        bulkId,
        from,
        items: journalled.map((row) => ({
          requestId: row.requestId,
          nodeId: row.nodeId,
          nodeLabel: row.nodeLabel,
          kind: row.kind,
          amount: row.amount,
          to: row.toAddress,
          nonce: row.nonce,
          txHash: row.txHash,
        })),
      },
    });

    let stopped: 'failed' | 'held' | null = null;
    for (const row of journalled) {
      if (stopped === 'held') break;
      if (stopped === 'failed') {
        await this.settle(row, { state: 'failed', error: NOT_SENT_AFTER_FAILURE, watched: false }, actor);
        continue;
      }
      const outcome = await this.relay(manager, row, actor);
      if (outcome !== 'taken') stopped = outcome;
    }

    return { bulkId, items: await this.itemsOf(bulkId) };
  }

  /**
   * `GET /api/funding/transfers?bulkId=`: the items of a send, refreshed from the manager first. Without manager
   * settings, the items are answered as stored.
   */
  async bulk(bulkId: string): Promise<FundingBulkAnswer> {
    const rows = await this.transfers.listBulk(bulkId);
    if (rows.length === 0) throw new FundingBulkNotFoundError(bulkId);
    if (this.manager && rows.some(isAsked)) await this.refreshBulk(this.manager, bulkId);
    return { items: await this.itemsOf(bulkId) };
  }

  /**
   * Refreshes one send, sharing the refresh already running for it in this process, so overlapping reads of a send
   * relay nothing twice and audit nothing twice.
   */
  private refreshBulk(manager: FundingManager, bulkId: string): Promise<void> {
    const running = this.refreshing.get(bulkId);
    if (running) return running;
    const refresh = (async () => {
      const rows = await this.transfers.listBulk(bulkId);
      if (rows.some(isAsked)) await this.refresh(manager, rows);
    })().finally(() => this.refreshing.delete(bulkId));
    this.refreshing.set(bulkId, refresh);
    return refresh;
  }

  /**
   * In nonce order, reads where each item still asked about stands on the manager, and records it. An open item the
   * manager never received is relayed again, the journalled bytes under the same request id, unless an item before it
   * failed or was lost, and then it fails as never sent. A watched item is only read, never relayed: the manager may
   * still find its receipt. An item settled for good is never asked about again, and a failed one is never sent again.
   * The refresh stops at the first item the manager cannot answer for, and leaves it and those after it as they are.
   */
  private async refresh(manager: FundingManager, rows: readonly FundingTransferRow[]): Promise<void> {
    let earlierFailed = false;
    for (const row of rows) {
      if (!isAsked(row)) {
        if (row.state === 'failed') earlierFailed = true;
        continue;
      }

      let status: FundingTransferStatus;
      try {
        status = await manager.status(row.requestId);
      } catch (error) {
        // `unknown_request`, not `unknown_node`: the manager journalled nothing under this id, so a relay is safe.
        if (managerCode(error) !== 'unknown_request') {
          logger.warn(
            `[Funding] could not read transfer ${row.requestId} on the manager, it stays ${row.state}: ${getErrorMessage(error)}`,
          );
          return;
        }
        if (!isOpen(row.state)) {
          // Watched, and the manager no longer knows it: it is never sent again, and stays as it is.
          logger.warn(`[Funding] the manager has no transfer ${row.requestId}, which stays ${row.state}`);
          earlierFailed = true;
          continue;
        }
        // The manager never received it: relayed again as journalled, unless a nonce before it may never be used.
        if (earlierFailed) {
          await this.settle(row, { state: 'failed', error: NOT_SENT_AFTER_FAILURE, watched: false }, FUNDING_SYSTEM);
          continue;
        }
        const outcome = await this.relay(manager, row, FUNDING_SYSTEM);
        if (outcome === 'held') return;
        if (outcome === 'failed') earlierFailed = true;
        continue;
      }

      const refusedByNode = status.state === 'failed' && status.blockNumber === null;
      const watched = status.state === 'unknown' || refusedByNode;
      // A refusal by the chain's node is told in the admin's sentence, which says what to do about it.
      const error = refusedByNode ? REFUSED_AT_RELAY : status.error;
      const moved =
        status.state !== row.state ||
        error !== row.error ||
        status.blockNumber !== row.blockNumber ||
        watched !== row.watched;
      if (moved) {
        const updated = await this.transfers.update(row.requestId, {
          state: status.state,
          error,
          blockNumber: status.blockNumber,
          watched,
          // A queued row the manager answers for was relayed after all, its answer lost: the manager journalled it no
          // later than now, so an `unknown` item's window starts here, as after an answered relay.
          ...(row.state === 'queued' ? { relayedAt: new Date(this.now()) } : {}),
        });
        if (updated) await this.auditMove(row, updated, FUNDING_SYSTEM, true);
      }
      if (status.state === 'failed' || status.state === 'unknown') earlierFailed = true;
    }
  }

  /**
   * Relays one journalled item, byte for byte, and records what the manager answered. One the chain's node refused is
   * `failed` with no block, and watched; one the manager refused for good is `failed`, and settled for good.
   */
  private async relay(manager: FundingManager, row: FundingTransferRow, actor: Actor): Promise<RelayOutcome> {
    let answer: FundingTransferAnswer;
    try {
      answer = await manager.relay({
        requestId: row.requestId,
        nodeId: row.nodeId,
        kind: row.kind,
        to: row.toAddress,
        amount: row.amount,
        rawTransaction: row.rawTransaction,
      });
    } catch (error) {
      const failure = error instanceof ManagerFundingError ? error : null;
      if (failure && (RELAY_REFUSALS as readonly string[]).includes(failure.code)) {
        await this.settle(
          row,
          { state: 'failed', error: `The manager refused it: ${failure.message}`, watched: false },
          actor,
        );
        return 'failed';
      }
      logger.warn(
        `[Funding] transfer ${row.requestId} to ${row.nodeId} was not relayed, it stays ${row.state}: ${getErrorMessage(error)}`,
      );
      return 'held';
    }
    const updated = await this.transfers.update(row.requestId, {
      state: answer.state,
      error: answer.state === 'failed' ? REFUSED_AT_RELAY : null,
      watched: answer.state === 'failed' || answer.state === 'unknown',
      // Once the answer is back, so at or after the manager's own journal moment: an unknown item's window starts here.
      relayedAt: new Date(this.now()),
    });
    if (updated) await this.auditMove(row, updated, actor, true);
    return answer.state === 'failed' ? 'failed' : 'taken';
  }

  /** Fails an item for a reason of the admin's own, or a refusal of the manager's, and audits it. */
  private async settle(row: FundingTransferRow, update: FundingTransferUpdate, actor: Actor): Promise<void> {
    const updated = await this.transfers.update(row.requestId, update);
    if (updated) await this.auditMove(row, updated, actor, false);
  }

  /**
   * The audit rows of an item that moved: `funding.transfer.sent` when the manager answered for a `queued` one, which
   * it has taken by then, and `funding.transfer.confirmed` or `funding.transfer.failed` when it came to that state,
   * once each: a watched item read again in the same state writes nothing. Each with a log line. `fromManager` is
   * false for the admin's own refusal, which the manager never saw.
   */
  private async auditMove(
    before: FundingTransferRow,
    after: FundingTransferRow,
    actor: Actor,
    fromManager: boolean,
  ): Promise<void> {
    const actions: AuditAction[] = [];
    if (fromManager && before.state === 'queued') actions.push('funding.transfer.sent');
    if (after.state !== before.state && after.state === 'confirmed') actions.push('funding.transfer.confirmed');
    if (after.state !== before.state && after.state === 'failed') actions.push('funding.transfer.failed');
    for (const action of actions) {
      logger.info(
        `[Funding] ${describeActor(actor)}: transfer ${after.requestId} of ${formatBaseUnits(
          after.amount,
          after.kind === 'xdai' ? XDAI_DECIMALS : XBZZ_DECIMALS,
        )} ${unit(after.kind)} to ${quoteForLog(after.nodeLabel)} (${after.nodeId}) is ${after.state}${
          after.error ? `: ${after.error}` : ''
        } [${action}]`,
      );
      await recordAudit(this.audit, { actor, action, details: itemDetails(after) });
    }
  }

  private requireManager(): FundingManager {
    if (!this.manager) {
      throw new FundingRefusedError(
        'not_set_up',
        'Funding is not set up: the admin has no MANAGER_FUNDING_URL and MANAGER_FUNDING_TOKEN.',
      );
    }
    return this.manager;
  }

  private async readInventory(manager: FundingManager): Promise<FundingInventory> {
    try {
      return await manager.inventory();
    } catch (error) {
      logger.warn(`[Funding] could not read the manager's inventory: ${getErrorMessage(error)}`);
      throw new FundingManagerUnavailableError(`${managerProblem(error)} Nothing was changed.`);
    }
  }

  private async readAccount(manager: FundingManager, address: string): Promise<FundingAccountAnswer> {
    let account: FundingAccountAnswer;
    try {
      account = await manager.account(address);
    } catch (error) {
      logger.warn(`[Funding] could not read the brand wallet's account on the manager: ${getErrorMessage(error)}`);
      throw new FundingManagerUnavailableError(`${managerProblem(error)} Nothing was sent.`);
    }
    if (account.chainId !== ADMIN_FUNDING_CHAIN_ID) {
      throw new FundingRefusedError('chain', this.otherChain(account.chainId));
    }
    return account;
  }

  private otherChain(chainId: number): string {
    return `The manager's nodes are on chain ${chainId}, not Gnosis Chain (${ADMIN_FUNDING_CHAIN_ID}), which the admin signs for. Nothing is sent.`;
  }

  /** Each item's node, which must be in the inventory with a wallet, pinned, and answering the pinned address. */
  private targetsOf(
    items: readonly FundingTransferItemRequest[],
    nodes: Map<string, FundingNode>,
    pins: Map<string, FundingPinRow>,
  ): SendTarget[] {
    return items.map((item) => {
      const node = nodes.get(item.nodeId);
      if (!node) {
        throw new FundingRefusedError('node', `The manager has no node ${item.nodeId}, so nothing was sent.`);
      }
      if (node.walletAddress === null) {
        throw new FundingRefusedError(
          'node',
          `${nodeName(node)}: its address could not be read, so it cannot be checked against the pin. Nothing was sent.`,
        );
      }
      const pin = pins.get(node.nodeId);
      if (!pin) {
        throw new FundingRefusedError(
          'node',
          `${nodeName(node)} is not pinned: confirm its wallet before sending to it. Nothing was sent.`,
        );
      }
      if (pin.walletAddress !== node.walletAddress) {
        throw new FundingRefusedError(
          'node',
          `${nodeName(node)} now answers another wallet than the pinned one: check it, and pin it again before sending to it. Nothing was sent.`,
        );
      }
      return { item, node, to: pin.walletAddress };
    });
  }
}

/**
 * Refuses to sign what the manager suggested over the admin's own ceilings: a fee cap over
 * {@link FUNDING_MAX_FEE_PER_GAS_WEI}, a tip over the fee cap, an xDAI transfer's gas limit other than
 * {@link FUNDING_GAS_NATIVE}, or an xBZZ transfer's of 0 or over {@link FUNDING_MAX_GAS_BZZ_TRANSFER}. Only the gas of
 * the kinds the send carries is held to its ceiling.
 */
export function checkCeilings(
  account: FundingAccountAnswer,
  targets: readonly { item: FundingTransferItemRequest }[],
): void {
  const gwei = (wei: bigint) => formatBaseUnits(wei.toString(), 9);
  const refuse = (reason: string) =>
    new FundingRefusedError('fee', `The manager suggested ${reason}, so nothing was signed. Nothing was sent.`);
  const maxFee = BigInt(account.maxFeePerGasWei);
  const tip = BigInt(account.maxPriorityFeePerGasWei);
  if (maxFee > FUNDING_MAX_FEE_PER_GAS_WEI) {
    throw refuse(
      `a fee cap of ${gwei(maxFee)} gwei, over the admin's ceiling of ${gwei(FUNDING_MAX_FEE_PER_GAS_WEI)} gwei`,
    );
  }
  if (tip > maxFee) {
    throw refuse(`a priority fee of ${gwei(tip)} gwei, over its own fee cap of ${gwei(maxFee)} gwei`);
  }
  const kinds = new Set(targets.map(({ item }) => item.kind));
  const gasNative = BigInt(account.gasNative);
  if (kinds.has('xdai') && gasNative !== FUNDING_GAS_NATIVE) {
    throw refuse(`a gas limit of ${gasNative} for an xDAI transfer, which takes exactly ${FUNDING_GAS_NATIVE}`);
  }
  const gasBzz = BigInt(account.gasBzzTransfer);
  if (kinds.has('xbzz') && (gasBzz === 0n || gasBzz > FUNDING_MAX_GAS_BZZ_TRANSFER)) {
    throw refuse(
      `a gas limit of ${gasBzz} for an xBZZ transfer, outside the admin's ceiling of 1 to ${FUNDING_MAX_GAS_BZZ_TRANSFER}`,
    );
  }
}

/**
 * Refuses a send the wallet cannot pay for: the xDAI sent and, for every item, its gas limit at the fee cap must fit
 * the xDAI balance, and the xBZZ sent the xBZZ balance. The sentence names each shortfall.
 */
export function checkBalance(
  account: FundingAccountAnswer,
  targets: readonly { item: FundingTransferItemRequest }[],
): void {
  const maxFee = BigInt(account.maxFeePerGasWei);
  let xdai = 0n;
  let xbzz = 0n;
  for (const { item } of targets) {
    const amount = BigInt(item.amount);
    if (item.kind === 'xdai') {
      xdai += amount + BigInt(account.gasNative) * maxFee;
    } else {
      xbzz += amount;
      xdai += BigInt(account.gasBzzTransfer) * maxFee;
    }
  }
  const shortfalls: string[] = [];
  const xdaiHeld = BigInt(account.xdaiWei);
  const xbzzHeld = BigInt(account.xbzzPlur);
  const read = (value: bigint, decimals: number) => formatBaseUnits(value.toString(), decimals);
  if (xdai > xdaiHeld) {
    shortfalls.push(
      `${read(xdai - xdaiHeld, XDAI_DECIMALS)} xDAI short: it needs ${read(xdai, XDAI_DECIMALS)} xDAI with the fees, and the wallet holds ${read(xdaiHeld, XDAI_DECIMALS)}`,
    );
  }
  if (xbzz > xbzzHeld) {
    shortfalls.push(
      `${read(xbzz - xbzzHeld, XBZZ_DECIMALS)} xBZZ short: it needs ${read(xbzz, XBZZ_DECIMALS)} xBZZ, and the wallet holds ${read(xbzzHeld, XBZZ_DECIMALS)}`,
    );
  }
  if (shortfalls.length > 0) {
    throw new FundingRefusedError(
      'insufficient_funds',
      `The brand wallet cannot pay for this send: ${shortfalls.join('; ')}. Nothing was sent.`,
    );
  }
}

/** The transaction of one item: xDAI straight to the node's wallet, xBZZ as the token's `transfer` to it. */
function transactionFor(
  target: SendTarget,
  account: FundingAccountAnswer,
  bzzToken: string,
  nonce: number,
): BrandWalletTransaction {
  const fees = {
    chainId: ADMIN_FUNDING_CHAIN_ID,
    nonce,
    maxFeePerGas: BigInt(account.maxFeePerGasWei),
    maxPriorityFeePerGas: BigInt(account.maxPriorityFeePerGasWei),
  };
  const amount = BigInt(target.item.amount);
  if (target.item.kind === 'xdai') {
    return { ...fees, to: target.to as Address, value: amount, data: '0x', gas: BigInt(account.gasNative) };
  }
  return {
    ...fees,
    to: bzzToken as Address,
    value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [getAddress(target.to), amount] }),
    gas: BigInt(account.gasBzzTransfer),
  };
}
