import {
  batchOffersPurchase,
  operableBatch,
  stampDiluteQuote,
  stampTopUpQuote,
  sumBaseUnits,
  XBZZ_DECIMALS,
  type AdminFundingNode,
  type ArchiveStamp,
  type FundingBatch,
  type FundingDiluteSteps,
  type FundingPostage,
  type FundingStampOperationKind,
  type FundingView,
  type OperableBatch,
  type StampOperationItemRequest,
} from '@streaming-monorepo/web2-admin-common';

import { shortHex } from '../../format';
import { formatShort, roundUpUnits } from './amounts';
import { allNodes, nodeGroups, type NodeGroup } from './balance';

/**
 * The Stamps tab's arithmetic and checks: the batches the page lists, which of them can be ticked, and what the ticked
 * ones come to. Every quote is the common `stampQuote`, the one the backend checks a request with, and every amount
 * is BigInt in PLUR.
 */

/** The least days a top-up buys, on the slider and in the field beside it. */
export const DAYS_MIN = 1;

/** The most days the slider reaches. The field beside it takes any whole number of days from 1, with no cap. */
export const DAYS_SLIDER_MAX = 365;

/** The days a preset sets with one click. */
export const DAYS_PRESETS: readonly number[] = [7, 30, 90];

/** The days the tab starts with. */
export const DEFAULT_DAYS = 30;

/** Said in place of the tick box of a batch that has run out. */
export const EXPIRED_TEXT = 'Expired: it can no longer be topped up or diluted.';

/** Said in place of the tick box of a batch Bee does not call usable, such as one the chain has yet to confirm. */
export const NOT_USABLE_TEXT = 'Not usable yet, so it cannot be topped up or diluted.';

/** Said in place of the tick box of a batch the node did not say enough about, with no read error to say why. */
export const NOT_READ_IN_FULL_TEXT = 'The node did not say enough about it to top it up or dilute it.';

/**
 * Said in place of the tick box of a batch whose node's wallet could not be read: the wallet pays a top-up, and the
 * gas of either operation.
 */
export const WALLET_UNREAD_TEXT = "Its node's wallet could not be read, so it cannot be topped up or diluted.";

/**
 * Said in place of the tick box of an archive stamp on a node the Funding view lists nowhere, neither a stage's node nor
 * the catalogue node: one that is the catalogue node no longer. The admin sends that node no transfer, so its wallet is
 * funded outside the admin, and the API refuses to top the stamp up or dilute it.
 */
export const FORMER_CATALOGUE_NODE_TEXT =
  "Its node is the catalogue node no longer: that node's wallet is funded outside the admin, so the admin does not top it up or dilute it.";

/**
 * Said in place of the tick box of an archive stamp, on a dilution, that is not written any more, such as one left on a
 * node that is the catalogue node no longer: nothing is copied onto it again, so it is kept alive and never made bigger.
 */
export const TOP_UP_ONLY_TEXT = 'Not written any more, so it is topped up only.';

/** Why the days field cannot be read. */
export const DAYS_PROBLEM = 'The days are a whole number, 1 or more.';

/** Why no top-up can be priced: the manager answered no price of postage. */
export const NO_PRICE_PROBLEM =
  'The manager could not read what postage costs, so a top-up cannot be priced. Refresh to read it again.';

/**
 * What the tab lists: the Funding view's nodes and their batches, and the archive stamps as `GET /api/archive/stamps`
 * answers them, each naming the node that holds it. Absent or empty, there is no archive stamp to list.
 */
type Inventory = Pick<FundingView, 'stages' | 'catalogue'> & { archiveStamps?: readonly ArchiveStamp[] | null };

/**
 * One batch as a row lists it: the node that holds it and pays for it, and the batch as that node reported it. An
 * archive stamp's row has the stamp as the admin answers it, `archive`, with its label, room and whether it is still
 * written.
 */
export interface BatchRow {
  node: AdminFundingNode;
  batch: FundingBatch;
  archive?: ArchiveStamp;
  /**
   * True for an archive stamp on a node the Funding view lists nowhere, which is the catalogue node no longer and no
   * stage's: the admin does not top it up or dilute it, and its row says so in place of a tick box.
   */
  formerCatalogue?: boolean;
}

/** Said in an archive stamp's row when the manager did not read it, so it is not known what it is worth now. */
export const ARCHIVE_STAMP_UNREAD_TEXT = 'The manager could not read this stamp.';

/**
 * An archive stamp as a batch of the Funding view: its id with `0x`, as the stamp operations take it, and its
 * readings. `usable` is the manager's word for it: active or full. A stamp the manager could not read says so.
 */
function archiveBatchOf(stamp: ArchiveStamp): FundingBatch {
  return {
    batchId: `0x${stamp.batchId.replace(/^0x/i, '').toLowerCase()}`,
    depth: stamp.depth,
    immutable: stamp.immutable,
    usable: stamp.state === 'active' || stamp.state === 'full',
    ttlSeconds: stamp.ttlSeconds,
    fillRatio: stamp.fillRatio,
    readError: stamp.state === 'unknown' ? ARCHIVE_STAMP_UNREAD_TEXT : null,
  };
}

/**
 * The node an archive stamp names as its holder, as the Funding view lists it, or, for one the view lists nowhere, the
 * node with its name and no wallet read: its stamp then says why it has no tick box. `formerCatalogue` is true for a
 * node the stamp names and the view lists nowhere, since a node that holds an archive stamp and is neither a stage's
 * nor the catalogue node is the catalogue node no longer. A stamp that names no node, as when the manager's inventory
 * was not read, is not known to be on one.
 */
function holderOf(
  stamp: ArchiveStamp,
  nodes: readonly AdminFundingNode[],
): { node: AdminFundingNode; formerCatalogue: boolean } {
  const listed = stamp.nodeId === null ? undefined : nodes.find((node) => node.nodeId === stamp.nodeId);
  if (listed) return { node: listed, formerCatalogue: false };
  return {
    node: {
      nodeId: stamp.nodeId ?? `archive:${stamp.batchId}`,
      label: stamp.nodeLabel ?? 'Unknown node',
      role: 'uploader',
      walletAddress: null,
      xdaiWei: null,
      xbzzPlur: null,
      readError: null,
      pin: 'new',
      pinnedAddress: null,
    },
    formerCatalogue: stamp.nodeId !== null,
  };
}

/** A row that has a tick box: its batch can take an operation, and its node's wallet was read. */
export type TickableRow = BatchRow & { batch: OperableBatch };

/**
 * Whether a node's wallet was read, its address and both its balances, as the common `movableChequebook` has it for
 * the Chequebooks tab: the wallet pays a top-up's xBZZ, and the gas of either operation.
 */
function walletRead(node: AdminFundingNode): boolean {
  return node.walletAddress !== null && node.xdaiWei !== null && node.xbzzPlur !== null;
}

/** Whether a row takes this operation at all: an archive stamp that is not written any more takes top-ups only. */
function takesOperation(row: BatchRow, operation: FundingStampOperationKind): boolean {
  return operation === 'topup' || row.archive?.writable !== false;
}

/**
 * Whether a row has a tick box for `operation`: its batch read whole, usable and not expired, the common
 * `operableBatch` the backend checks too, not an archive stamp on a node that is the catalogue node no longer, its
 * node's wallet read, and, on a dilution, not an archive stamp that is written no more. Select all, the group's tick
 * box and the operation follow the same rule, so a tick left on a row that has lost its tick box since is neither
 * counted nor asked for.
 */
export function hasTickBox(row: BatchRow, operation: FundingStampOperationKind = 'topup'): row is TickableRow {
  return operableBatch(row.batch) && !row.formerCatalogue && walletRead(row.node) && takesOperation(row, operation);
}

/**
 * The catalogue batch, the archive stamps, or one stage's batches, with the node group they come from, which the node
 * cards need. `kind` tells the three apart.
 */
export interface BatchGroup {
  key: string;
  kind: 'catalogue' | 'archive' | 'stage';
  title: string;
  nodes: NodeGroup;
  rows: BatchRow[];
  /**
   * The group's nodes that have no batch at all and for which the manager recommends one, the common
   * `batchOffersPurchase`: each has a row of its own with Buy new. A gateway, which stamps nothing, has none.
   */
  missing: AdminFundingNode[];
}

/** The title of the group of archive stamps, under the catalogue batch. */
export const ARCHIVE_GROUP_TITLE = 'Archive stamps';

/**
 * The catalogue batch in a group of its own on top, then the archive stamps, then each stage's batches under its name,
 * in the admin's order. Each archive stamp is paid for by the node that holds it, the catalogue node for every stamp
 * bought here, so that node's one wallet pays for them and for the catalogue batch alike. The archive group is there
 * whenever the catalogue node or an archive stamp is, with no rows while there is no stamp. A node with no batch has no
 * batch row; one the manager recommends a batch for is in its group's `missing`, and a gateway is in neither.
 */
export function batchGroups(view: Inventory): BatchGroup[] {
  const stamps = view.archiveStamps ?? [];
  const nodes = allNodes(view);
  const archiveRows: BatchRow[] = stamps.map((stamp) => {
    const holder = holderOf(stamp, nodes);
    return { node: holder.node, batch: archiveBatchOf(stamp), archive: stamp, formerCatalogue: holder.formerCatalogue };
  });
  const archiveGroup: BatchGroup = {
    key: 'archive',
    kind: 'archive',
    title: ARCHIVE_GROUP_TITLE,
    nodes: { key: 'archive', title: ARCHIVE_GROUP_TITLE, catalogue: false, nodes: archiveRows.map((row) => row.node) },
    rows: archiveRows,
    missing: [],
  };
  const groups = nodeGroups(view).flatMap((group): BatchGroup[] => {
    const rows = group.nodes.flatMap((node) => (node.batch ? [{ node, batch: node.batch }] : []));
    const missing = group.nodes.filter((node) => !node.batch && batchOffersPurchase(node));
    if (!group.catalogue) return [{ key: group.key, kind: 'stage', title: group.title, nodes: group, rows, missing }];
    return [{ key: group.key, kind: 'catalogue', title: 'Catalogue batch', nodes: group, rows, missing }, archiveGroup];
  });
  // With no catalogue node designated, stamps left on other nodes still need their top-ups: their group comes first.
  return view.catalogue || stamps.length === 0 ? groups : [archiveGroup, ...groups];
}

/**
 * Every batch once, in the order the page lists them. A batch listed twice, by a node pool two stages share, is ticked
 * in both places and counted and asked for once, for the first listing that has a tick box, or the first of all while
 * none has: a listing whose node could not be read about the batch, or about its wallet, never hides one whose node
 * could.
 */
export function allBatchRows(view: Inventory, operation: FundingStampOperationKind = 'topup'): BatchRow[] {
  const byId = new Map<string, BatchRow>();
  for (const row of batchGroups(view).flatMap((group) => group.rows)) {
    const kept = byId.get(row.batch.batchId);
    // A batch keeps the place it is first listed in, whichever listing it is kept for.
    if (!kept || (!hasTickBox(kept, operation) && hasTickBox(row, operation))) byId.set(row.batch.batchId, row);
  }
  return [...byId.values()];
}

/**
 * The batches of a group that have a tick box, by id, each once: what the group's own tick box ticks and clears, and,
 * from every group, what Select all ticks.
 */
export function tickableBatches(group: BatchGroup, operation: FundingStampOperationKind = 'topup'): string[] {
  return [...new Set(group.rows.flatMap((row) => (hasTickBox(row, operation) ? [row.batch.batchId] : [])))];
}

/** Whether the manager names any node's batch: one older than the Stamps tab answers its nodes without them. */
export function reportsBatches(view: Inventory): boolean {
  return nodeGroups(view).some((group) => group.nodes.some((node) => node.batch !== undefined));
}

/**
 * Why a batch cannot take an operation, or null when it can. The rule is the common `operableBatch`, which the
 * backend checks too: a batch read whole, usable and not expired.
 */
export function whyNotOperable(batch: FundingBatch): string | null {
  if (operableBatch(batch)) return null;
  if (batch.readError) return batch.readError;
  if (batch.ttlSeconds === 0) return EXPIRED_TEXT;
  if (batch.usable === false) return NOT_USABLE_TEXT;
  return NOT_READ_IN_FULL_TEXT;
}

/**
 * Why a row has no tick box for `operation`, said in its row instead, or null when it has one: what is wrong with its
 * batch first, then that its node is the catalogue node no longer, or that its node's wallet was not read, then that an
 * archive stamp written no more takes top-ups only.
 */
export function whyNoTickBox(row: BatchRow, operation: FundingStampOperationKind = 'topup'): string | null {
  const why = whyNotOperable(row.batch);
  if (why !== null) return why;
  if (row.formerCatalogue) return FORMER_CATALOGUE_NODE_TEXT;
  if (!walletRead(row.node)) return WALLET_UNREAD_TEXT;
  return takesOperation(row, operation) ? null : TOP_UP_ONLY_TEXT;
}

export type ReadDays = { kind: 'ok'; days: number } | { kind: 'invalid'; problem: string };

const DIGITS = /^\d+$/;

/** The days typed for a top-up: a whole number, 1 or more, with no cap. */
export function readDays(typed: string): ReadDays {
  const text = typed.trim();
  const days = DIGITS.test(text) ? Number(text) : Number.NaN;
  return Number.isSafeInteger(days) && days >= DAYS_MIN
    ? { kind: 'ok', days }
    : { kind: 'invalid', problem: DAYS_PROBLEM };
}

/** Whether the days field may hold `typed`: digits only, so any other character never reaches it. */
export function acceptsDaysTyping(typed: string): boolean {
  return /^\d*$/.test(typed);
}

/** `1 day`, `30 days`. */
export function dayCount(days: number): string {
  return `${days} day${days === 1 ? '' : 's'}`;
}

/** `1 step`, `2 steps`. */
export function stepCount(steps: number): string {
  return `${steps} step${steps === 1 ? '' : 's'}`;
}

/** `1 batch`, `3 batches`. */
export function batchCount(count: number): string {
  return `${count} batch${count === 1 ? '' : 'es'}`;
}

/** What the operator chose: the operation, its days or steps, which apply to every ticked batch, and the ticks. */
export interface StampSelection {
  operation: FundingStampOperationKind;
  /** The days of a top-up, as typed. */
  days: string;
  /** The steps of a dilution. */
  steps: FundingDiluteSteps;
  /** The ticked batches, by id. */
  ticked: ReadonlySet<string>;
}

/** What the Stamps tab starts with: a top-up of {@link DEFAULT_DAYS} days, a dilution's 1 step, and nothing ticked. */
export const FIRST_STAMP_SELECTION: StampSelection = {
  operation: 'topup',
  days: String(DEFAULT_DAYS),
  steps: 1,
  ticked: new Set(),
};

/** One ticked batch: the item it asks for, and what the operation costs and leaves. */
export interface StampLine {
  node: AdminFundingNode;
  batch: OperableBatch;
  /** The item to send, or null while a top-up's days cannot be read or there is no price of postage to quote it at. */
  request: StampOperationItemRequest | null;
  /** A top-up's cost in PLUR, at today's price, or null for a dilution and while the days or the price are not known. */
  costPlur: string | null;
  /** The batch's time left after the operation, at today's price, or null while it cannot be worked out. */
  ttlAfterSeconds: number | null;
  /** A dilution's new depth, or null for a top-up. */
  newDepth: number | null;
  /** Why the dilution is refused, or null. */
  problem: string | null;
}

/**
 * What one node pays for its ticked batches, what its wallet holds after them, and whether it can pay the gas. The
 * amounts are its top-ups', while they are priced: a dilution costs no xBZZ.
 */
export interface NodeLedger {
  /** What its ticked top-ups cost in all, in PLUR, or null for a dilution and while a top-up is not priced. */
  costPlur: string | null;
  /** Its xBZZ after them, in PLUR, or null when it cannot pay for them, and for a dilution or an unpriced top-up. */
  afterPlur: string | null;
  /** What it lacks for them, exactly, in PLUR, or null when it lacks nothing or that is not known. */
  shortPlur: string | null;
  /**
   * What it lacks rounded up to three decimals of xBZZ, in PLUR, or null: the amount the row says, and the one Fund
   * all enters on the Balance tab, so a node funded with it is not short by a rounding.
   */
  fundPlur: string | null;
  /** Whether it holds no xDAI to pay the gas, which a top-up and a dilution both cost. */
  noGas: boolean;
}

export interface StampCheck {
  lines: StampLine[];
  /** The line of each ticked batch, by its id. */
  lineOf: ReadonlyMap<string, StampLine>;
  /**
   * The ledger of each node with a ticked batch whose wallet was read, by node id, in the order its first ticked batch
   * is listed: the nodes Fund all funds come from it.
   */
  ledgerOf: ReadonlyMap<string, NodeLedger>;
  /** What the ticked top-ups cost in all, in PLUR, or null for a dilution and while a cost is not known. */
  totalCostPlur: string | null;
  /** Why the operation cannot be asked for, in the order the page says them; empty when it can. */
  problems: string[];
}

/**
 * A ticked top-up, priced at `postage`, the view's price, which its request names: the API refuses it when postage
 * costs more by the time it asks, so it never costs more than the page shows.
 */
function topUpLine(
  node: AdminFundingNode,
  batch: OperableBatch,
  days: ReadDays,
  postage: FundingPostage | null,
): StampLine {
  const priced = days.kind === 'ok' && postage ? { days: days.days, postage } : null;
  const quote = priced ? stampTopUpQuote(priced.days, batch.depth, batch.ttlSeconds, priced.postage) : null;
  return {
    node,
    batch,
    request: priced
      ? {
          kind: 'topup',
          nodeId: node.nodeId,
          batchId: batch.batchId,
          expectedDepth: batch.depth,
          days: priced.days,
          pricePerChunkPerBlockPlur: priced.postage.pricePerChunkPerBlockPlur,
        }
      : null,
    costPlur: quote?.costPlur ?? null,
    ttlAfterSeconds: quote?.ttlAfterSeconds ?? null,
    newDepth: null,
    problem: null,
  };
}

function diluteLine(node: AdminFundingNode, batch: OperableBatch, steps: FundingDiluteSteps): StampLine {
  const quote = stampDiluteQuote(steps, batch.depth, batch.ttlSeconds);
  return {
    node,
    batch,
    request: { kind: 'dilute', nodeId: node.nodeId, batchId: batch.batchId, expectedDepth: batch.depth, steps },
    costPlur: null,
    ttlAfterSeconds: quote.ttlAfterSeconds,
    newDepth: quote.newDepth,
    problem: quote.problem,
  };
}

/** A balance as BigInt, or null when it was not read. */
function unitsOf(value: string | null): bigint | null {
  return value !== null && DIGITS.test(value) ? BigInt(value) : null;
}

/**
 * The ledger of a node whose wallet holds `balance` xBZZ and `xdai`, and whose ticked top-ups cost `cost`: null for a
 * dilution and while a top-up is not priced, which leaves the ledger's amounts null.
 */
function ledgerFor(cost: bigint | null, balance: bigint, xdai: bigint): NodeLedger {
  const noGas = xdai === 0n;
  if (cost === null) return { costPlur: null, afterPlur: null, shortPlur: null, fundPlur: null, noGas };
  if (cost <= balance) {
    return {
      costPlur: cost.toString(),
      afterPlur: (balance - cost).toString(),
      shortPlur: null,
      fundPlur: null,
      noGas,
    };
  }
  const short = cost - balance;
  return {
    costPlur: cost.toString(),
    afterPlur: null,
    shortPlur: short.toString(),
    fundPlur: roundUpUnits(short, XBZZ_DECIMALS).toString(),
    noGas,
  };
}

/**
 * The ticked batches the operation asks for, what each costs and leaves, what each node pays and holds after, and
 * every reason the operation cannot be asked for: nothing ticked; for a top-up, days it cannot read or no price; for a
 * dilution, one that would leave its batch under 7 days; a node short of xBZZ for its top-ups, and one with no xDAI for
 * the gas, which both operations pay. These are the backend's checks, made here first, so the operator learns them
 * before asking. A row that has no tick box, its batch unable to take an operation or its node's wallet not read, is
 * never counted, even when a tick from before a refresh is still on it.
 */
export function checkStamps(view: Inventory & Pick<FundingView, 'postage'>, selection: StampSelection): StampCheck {
  const topUp = selection.operation === 'topup';
  const days = readDays(selection.days);
  const lines: StampLine[] = [];
  for (const row of allBatchRows(view, selection.operation)) {
    if (!selection.ticked.has(row.batch.batchId) || !hasTickBox(row, selection.operation)) continue;
    const { node, batch } = row;
    lines.push(topUp ? topUpLine(node, batch, days, view.postage) : diluteLine(node, batch, selection.steps));
  }
  const lineOf = new Map(lines.map((line) => [line.batch.batchId, line]));
  const ledgers = new Map<string, NodeLedger>();
  const problems: string[] = [];

  if (lines.length === 0) {
    problems.push(topUp ? 'Tick a batch to top it up.' : 'Tick a batch to dilute it.');
    return { lines, lineOf, ledgerOf: ledgers, totalCostPlur: topUp ? '0' : null, problems };
  }

  if (topUp && days.kind === 'invalid') problems.push(days.problem);
  // Read as topUpLine reads it: a view with no price at all has none, as one whose price is null.
  if (topUp && !view.postage) problems.push(NO_PRICE_PROBLEM);
  for (const line of lines) {
    if (line.problem) problems.push(`The batch ${shortHex(line.batch.batchId)} of ${line.node.label}: ${line.problem}`);
  }

  // Each node once, in the order its first ticked batch is listed, with the costs of all its ticked batches.
  const byNode = new Map<string, { node: AdminFundingNode; costs: (string | null)[] }>();
  for (const line of lines) {
    const entry = byNode.get(line.node.nodeId) ?? { node: line.node, costs: [] };
    entry.costs.push(line.costPlur);
    byNode.set(line.node.nodeId, entry);
  }
  const priced = topUp && lines.every((line) => line.costPlur !== null);
  for (const { node, costs } of byNode.values()) {
    const xdai = unitsOf(node.xdaiWei);
    const xbzz = unitsOf(node.xbzzPlur);
    // hasTickBox has the wallet read, so only a balance that is not base units comes here.
    if (xdai === null || xbzz === null) {
      problems.push(`The wallet of ${node.label} could not be read.`);
      continue;
    }
    const cost = priced ? costs.reduce((sum, each) => sum + BigInt(each ?? '0'), 0n) : null;
    const ledger = ledgerFor(cost, xbzz, xdai);
    ledgers.set(node.nodeId, ledger);
    if (ledger.fundPlur !== null) {
      problems.push(`${node.label} is short of ${formatShort(ledger.fundPlur, XBZZ_DECIMALS)} xBZZ for its top-ups.`);
    }
    if (ledger.noGas) problems.push(`${node.label} holds no xDAI to pay the gas.`);
  }

  const totalCostPlur = priced ? sumBaseUnits(lines.map((line) => line.costPlur ?? '0')) : null;
  return { lines, lineOf, ledgerOf: ledgers, totalCostPlur, problems };
}
