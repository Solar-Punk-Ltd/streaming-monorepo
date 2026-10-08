import {
  operableBatch,
  stampDiluteQuote,
  stampTopUpQuote,
  sumBaseUnits,
  XBZZ_DECIMALS,
  type AdminFundingNode,
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
import { nodeGroups, type NodeGroup } from './balance';

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

/** Why the days field cannot be read. */
export const DAYS_PROBLEM = 'The days are a whole number, 1 or more.';

/** Why no top-up can be priced: the manager answered no price of postage. */
export const NO_PRICE_PROBLEM =
  'The manager could not read what postage costs, so a top-up cannot be priced. Refresh to read it again.';

type Inventory = Pick<FundingView, 'stages' | 'catalogue'>;

/** One batch as a row lists it: the node that holds it and pays for it, and the batch as that node reported it. */
export interface BatchRow {
  node: AdminFundingNode;
  batch: FundingBatch;
}

/** The catalogue batch, or one stage's batches, with the node group they come from, which the node cards need. */
export interface BatchGroup {
  key: string;
  title: string;
  nodes: NodeGroup;
  rows: BatchRow[];
}

/**
 * The catalogue batch in a group of its own on top, then each stage's batches under its name, in the admin's order.
 * A node with no batch, a gateway among them, has no row.
 */
export function batchGroups(view: Inventory): BatchGroup[] {
  return nodeGroups(view).map((nodes) => ({
    key: nodes.key,
    title: nodes.catalogue ? 'Catalogue batch' : nodes.title,
    nodes,
    rows: nodes.nodes.flatMap((node) => (node.batch ? [{ node, batch: node.batch }] : [])),
  }));
}

/**
 * Every batch once, in the order the page lists them. A batch listed twice, by a node pool two stages share, is ticked
 * in both places and counted and asked for once, for the node that lists it first.
 */
export function allBatchRows(view: Inventory): BatchRow[] {
  const byId = new Map<string, BatchRow>();
  for (const row of batchGroups(view).flatMap((group) => group.rows)) {
    if (!byId.has(row.batch.batchId)) byId.set(row.batch.batchId, row);
  }
  return [...byId.values()];
}

/** Whether the manager names any node's batch: one older than the Stamps tab answers its nodes without them. */
export function reportsBatches(view: Inventory): boolean {
  return nodeGroups(view).some((group) => group.nodes.some((node) => node.batch !== undefined));
}

/**
 * Why a batch has no tick box, said in its row instead, or null when it has one. The rule is the common
 * `operableBatch`, which the backend checks too: a batch read whole, usable and not expired.
 */
export function whyNotOperable(batch: FundingBatch): string | null {
  if (operableBatch(batch)) return null;
  if (batch.readError) return batch.readError;
  if (batch.ttlSeconds === 0) return EXPIRED_TEXT;
  if (batch.usable === false) return NOT_USABLE_TEXT;
  return NOT_READ_IN_FULL_TEXT;
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

/** What one node pays for its ticked top-ups, and what its wallet holds after them. */
export interface NodeLedger {
  /** What its ticked top-ups cost in all, in PLUR. */
  costPlur: string;
  /** Its xBZZ after them, in PLUR, or null when it cannot pay for them. */
  afterPlur: string | null;
  /** What it lacks for them, exactly, in PLUR, or null when it lacks nothing. */
  shortPlur: string | null;
  /**
   * What it lacks rounded up to three decimals of xBZZ, in PLUR, or null: the amount the row says, and the one its Fund
   * link hands the Balance tab, so a node funded with it is not short by a rounding.
   */
  fundPlur: string | null;
}

export interface StampCheck {
  lines: StampLine[];
  /** The line of each ticked batch, by its id. */
  lineOf: ReadonlyMap<string, StampLine>;
  /** What each node pays for its ticked top-ups, by node id. Empty for a dilution, and while a top-up has no price. */
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

/** The ledger of a node whose wallet holds `balance` and whose ticked top-ups cost `cost`. */
function ledgerFor(cost: bigint, balance: bigint): NodeLedger {
  if (cost <= balance) {
    return { costPlur: cost.toString(), afterPlur: (balance - cost).toString(), shortPlur: null, fundPlur: null };
  }
  const short = cost - balance;
  return {
    costPlur: cost.toString(),
    afterPlur: null,
    shortPlur: short.toString(),
    fundPlur: roundUpUnits(short, XBZZ_DECIMALS).toString(),
  };
}

/**
 * The ticked batches the operation asks for, what each costs and leaves, what each node pays and holds after, and
 * every reason the operation cannot be asked for: nothing ticked; for a top-up, days it cannot read or no price; for a
 * dilution, one that would leave its batch under 7 days; a node whose wallet was not read, one short of xBZZ for its
 * top-ups, and one with no xDAI for the gas, which both operations pay. These are the backend's checks, made here
 * first, so the operator learns them before asking. A batch that cannot be ticked is never counted, even when a tick
 * from before a refresh is still on it.
 */
export function checkStamps(view: Inventory & Pick<FundingView, 'postage'>, selection: StampSelection): StampCheck {
  const topUp = selection.operation === 'topup';
  const days = readDays(selection.days);
  const lines: StampLine[] = [];
  for (const { node, batch } of allBatchRows(view)) {
    if (!selection.ticked.has(batch.batchId) || !operableBatch(batch)) continue;
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
  if (topUp && view.postage === null) problems.push(NO_PRICE_PROBLEM);
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
    if (xdai === null || xbzz === null) {
      problems.push(`The wallet of ${node.label} could not be read.`);
      continue;
    }
    if (priced) {
      const cost = costs.reduce((sum, each) => sum + BigInt(each ?? '0'), 0n);
      const ledger = ledgerFor(cost, xbzz);
      ledgers.set(node.nodeId, ledger);
      if (ledger.fundPlur !== null) {
        problems.push(`${node.label} is short of ${formatShort(ledger.fundPlur, XBZZ_DECIMALS)} xBZZ for its top-ups.`);
      }
    }
    if (xdai === 0n) problems.push(`${node.label} holds no xDAI to pay the gas.`);
  }

  const totalCostPlur = priced ? sumBaseUnits(lines.map((line) => line.costPlur ?? '0')) : null;
  return { lines, lineOf, ledgerOf: ledgers, totalCostPlur, problems };
}
