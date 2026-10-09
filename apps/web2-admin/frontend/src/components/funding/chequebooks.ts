import {
  CHEQUEBOOK_TARGET_MIN_PLUR,
  chequebookMove,
  movableChequebook,
  sumBaseUnits,
  XBZZ_DECIMALS,
  type AdminFundingNode,
  type ChequebookMove,
  type FundingChequebookOperationsRequest,
  type FundingView,
} from '@streaming-monorepo/web2-admin-common';

import { formatShort, formatUnits, MORE_THAN_ANY_WALLET, readAmount, roundUpUnits } from './amounts';
import { nodeGroups, type NodeGroup } from './balance';

/**
 * The Chequebooks tab's arithmetic and checks: the chequebooks the page lists, which of them can be ticked, and what
 * bringing the ticked ones to the target comes to. Every move is the common `chequebookMove`, which the backend works
 * out again from the balance it reads when the request comes in, `chequebookMoveNow`, never moving more, and every
 * amount is BigInt in PLUR.
 */

/** The least target, as the page says it: 1, in xBZZ, as the owner set it. */
const FLOOR = formatUnits(CHEQUEBOOK_TARGET_MIN_PLUR, XBZZ_DECIMALS);

/** Said beside the target field. */
export const TARGET_FLOOR_TEXT = `At least ${FLOOR} xBZZ`;

/** What the target does, said under the field. */
export const TARGET_CAPTION =
  "Each ticked chequebook is brought to the target: one under it takes a deposit of the difference from its node's wallet, one over it a withdrawal of the difference into its node's wallet.";

/** Why Apply waits while no target is typed. */
export const TARGET_EMPTY_PROBLEM = 'Type a target, the balance to bring each ticked chequebook to.';

/** Why Apply waits while the target is under the floor. */
export const TARGET_UNDER_FLOOR_PROBLEM = `The target is at least ${FLOOR} xBZZ.`;

/**
 * The most digits of PLUR a target has: 30, the most the API takes (its request schema), so that the move worked out
 * from it fits the manager's chequebook journal. Far more xBZZ than there is.
 */
const TARGET_MAX_DIGITS = 30;

/** Why Apply waits while the target is more PLUR than the API takes, 30 digits, or than any balance holds. */
export const TARGET_TOO_LARGE_PROBLEM = 'The target: That is more than any chequebook holds.';

/** Why Apply waits while no chequebook is ticked. */
export const NOTHING_TICKED_PROBLEM = 'Tick a chequebook to bring it to the target.';

/** Why Apply waits while every ticked chequebook is at the target, which asks for nothing. */
export const NOTHING_TO_CHANGE_PROBLEM =
  'Every ticked chequebook is at the target already, so there is nothing to change.';

/** Said in place of the tick box of a gateway's chequebook, which the page shows read-only. */
export const GATEWAY_TEXT = "Read only: the manager moves the chequebook of an uploader or a rung, never a gateway's.";

/** Said in place of the tick box of a chequebook its node could not be read about; its read error is in its column. */
export const CHEQUEBOOK_UNREAD_TEXT = 'Its chequebook could not be read, so it cannot be moved.';

/**
 * Said in place of the tick box of a chequebook whose node's wallet could not be read: the wallet pays a deposit and
 * takes a withdrawal.
 */
export const WALLET_UNREAD_TEXT = 'Its wallet could not be read, so its chequebook cannot be moved.';

/** Said under a stage none of whose nodes has a chequebook. */
export const NO_CHEQUEBOOK_IN_STAGE = 'The manager reports no chequebook for this stage.';

/** Said when the manager names no node's chequebook at all, as one older than the Chequebooks tab answers. */
export const NO_CHEQUEBOOKS_REPORTED =
  "The manager does not report its nodes' chequebooks. A manager older than this page does not read them.";

type Inventory = Pick<FundingView, 'stages'>;

/** One stage's chequebooks: the stage's node group, which the node cards need, and a row for each node with one. */
export interface ChequebookGroup {
  key: string;
  title: string;
  nodes: NodeGroup;
  rows: AdminFundingNode[];
}

/** Whether the manager answered a chequebook for the node, read or not: null is a node that has none. */
function hasChequebook(node: AdminFundingNode): boolean {
  return node.chequebook !== null && node.chequebook !== undefined;
}

/**
 * Each stage's chequebooks under its name, in the admin's order, and no catalogue group: the catalogue node's
 * chequebook is of no use, so it is not listed. A node that has no chequebook, or of which the manager says nothing,
 * has no row.
 */
export function chequebookGroups(view: Inventory): ChequebookGroup[] {
  return nodeGroups({ stages: view.stages, catalogue: null }).map((nodes) => ({
    key: nodes.key,
    title: nodes.title,
    nodes,
    rows: nodes.nodes.filter(hasChequebook),
  }));
}

/**
 * Every node with a chequebook once, in the order the page lists them. A node pool two stages share is listed under
 * both with one nodeId, so it is ticked in both places and counted and asked for once, for the first listing whose
 * chequebook can be moved, or the first of all while none can.
 */
export function allChequebookNodes(view: Inventory): AdminFundingNode[] {
  const byId = new Map<string, AdminFundingNode>();
  for (const node of chequebookGroups(view).flatMap((group) => group.rows)) {
    const kept = byId.get(node.nodeId);
    // A node keeps the place it is first listed in, whichever listing it is kept for.
    if (!kept || (!movableChequebook(kept) && movableChequebook(node))) byId.set(node.nodeId, node);
  }
  return [...byId.values()];
}

/** Whether the manager names any stage node's chequebook: one older than the Chequebooks tab answers without them. */
export function reportsChequebooks(view: Inventory): boolean {
  return view.stages.some((stage) => stage.nodes.some((node) => node.chequebook !== undefined));
}

/**
 * Why a chequebook has no tick box, said in its row instead, or null when it has one. The rule is the common
 * `movableChequebook`, which the backend checks too: a stage's own Bee node's or a rung's, with its wallet and its
 * chequebook read.
 */
export function whyNotMovable(node: AdminFundingNode): string | null {
  if (movableChequebook(node)) return null;
  if (node.role === 'gateway') return GATEWAY_TEXT;
  const chequebook = node.chequebook ?? null;
  if (chequebook === null || chequebook.readError !== null || chequebook.availablePlur === null) {
    return CHEQUEBOOK_UNREAD_TEXT;
  }
  return WALLET_UNREAD_TEXT;
}

export type ReadTarget = { kind: 'empty' } | { kind: 'ok'; plur: string } | { kind: 'invalid'; problem: string };

/**
 * The target as typed, in PLUR: an amount of xBZZ, as the amount fields take one, of at least 1 xBZZ and at most 30
 * digits of PLUR, which the API refuses past.
 */
export function readTarget(typed: string): ReadTarget {
  const read = readAmount(typed, XBZZ_DECIMALS);
  if (read.kind === 'empty') return read;
  if (read.kind === 'invalid') {
    const problem = read.problem === MORE_THAN_ANY_WALLET ? TARGET_TOO_LARGE_PROBLEM : `The target: ${read.problem}`;
    return { kind: 'invalid', problem };
  }
  if (read.value.length > TARGET_MAX_DIGITS) return { kind: 'invalid', problem: TARGET_TOO_LARGE_PROBLEM };
  if (BigInt(read.value) < BigInt(CHEQUEBOOK_TARGET_MIN_PLUR)) {
    return { kind: 'invalid', problem: TARGET_UNDER_FLOOR_PROBLEM };
  }
  return { kind: 'ok', plur: read.value };
}

/** What the operator chose: the target as typed, and the ticked chequebooks, by node id. */
export interface ChequebookSelection {
  target: string;
  ticked: ReadonlySet<string>;
}

/** What the Chequebooks tab starts with: no target typed, and nothing ticked. */
export const FIRST_CHEQUEBOOK_SELECTION: ChequebookSelection = { target: '', ticked: new Set() };

/** One ticked chequebook, once the target can be read: the balance the page shows, and the move to the target. */
export interface ChequebookLine {
  node: AdminFundingNode;
  /** The chequebook's available balance the move is worked out from, PLUR, as the page shows it. */
  availablePlur: string;
  /** What brings it to the target, or null when it is at the target, which asks for nothing. */
  move: ChequebookMove | null;
}

/** A line whose chequebook moves: not at the target. */
type MovingLine = ChequebookLine & { move: ChequebookMove };

/** What one node's wallet holds after its chequebook's move. */
export interface ChequebookLedger {
  /** Its xBZZ after the move, in PLUR, or null when it cannot pay for its deposit. */
  afterPlur: string | null;
  /** What it lacks for its deposit, exactly, in PLUR, or null when it lacks nothing. */
  shortPlur: string | null;
  /**
   * What it lacks rounded up to three decimals of xBZZ, in PLUR, or null: the amount the row says, and the one Fund
   * all enters on the Balance tab, so a node funded with it is not short by a rounding.
   */
  fundPlur: string | null;
  /** Whether it holds no xDAI to pay the gas, which a deposit and a withdrawal both cost. */
  noGas: boolean;
}

/** How many moves go one way, and what they move in all, in PLUR. */
export interface ChequebookTotal {
  count: number;
  totalPlur: string;
}

export interface ChequebookCheck {
  target: ReadTarget;
  /** How many ticked chequebooks can be moved, each once, whether or not the target can be read. */
  tickedCount: number;
  /** Each ticked chequebook once, with its move, in the order the page lists them; none while there is no target. */
  lines: ChequebookLine[];
  /** The line of each ticked chequebook, by its node's id. */
  lineOf: ReadonlyMap<string, ChequebookLine>;
  /**
   * What each node's wallet holds after its move, by node id, in the order the page lists them: only the nodes whose
   * chequebook moves, the ones Fund all may fund.
   */
  ledgerOf: ReadonlyMap<string, ChequebookLedger>;
  deposits: ChequebookTotal;
  withdrawals: ChequebookTotal;
  /**
   * What Apply asks for: the target, and each ticked chequebook that moves with the available balance the page shows,
   * from which, and the balance it reads when the request comes in, the backend works the move out again,
   * `chequebookMoveNow`, never more than the page shows. Null while nothing would move.
   */
  request: FundingChequebookOperationsRequest | null;
  /** Why Apply cannot ask for it, in the order the page says them; empty when it can. */
  problems: string[];
}

/** A balance as BigInt, or null when it was not read. */
function unitsOf(value: string | null): bigint | null {
  return value !== null && /^\d+$/.test(value) ? BigInt(value) : null;
}

/** The ledger of a node whose wallet holds `xbzz` and `xdai` once its chequebook makes `move`. */
function ledgerFor(move: ChequebookMove, xbzz: bigint, xdai: bigint): ChequebookLedger {
  const amount = BigInt(move.amountPlur);
  const noGas = xdai === 0n;
  if (move.direction === 'withdraw') {
    return { afterPlur: (xbzz + amount).toString(), shortPlur: null, fundPlur: null, noGas };
  }
  if (amount <= xbzz) return { afterPlur: (xbzz - amount).toString(), shortPlur: null, fundPlur: null, noGas };
  const short = amount - xbzz;
  return {
    afterPlur: null,
    shortPlur: short.toString(),
    fundPlur: roundUpUnits(short, XBZZ_DECIMALS).toString(),
    noGas,
  };
}

function totalOf(lines: readonly MovingLine[], direction: ChequebookMove['direction']): ChequebookTotal {
  const amounts = lines.flatMap((line) => (line.move.direction === direction ? [line.move.amountPlur] : []));
  return { count: amounts.length, totalPlur: sumBaseUnits(amounts) };
}

/**
 * The ticked chequebooks' moves to the target, what each node's wallet holds after, and every reason Apply cannot ask
 * for them: no target, one it cannot read, under 1 xBZZ or over 30 digits of PLUR, nothing ticked, nothing to change,
 * a node short of xBZZ for its deposit, and one with no xDAI for the gas, which a deposit and a withdrawal both pay.
 * These are the backend's checks, made here first, so the operator learns them before asking. A chequebook that cannot
 * be ticked is never counted, even when a tick from before a refresh is still on it, and one at the target is never
 * asked for.
 */
export function checkChequebooks(view: Inventory, selection: ChequebookSelection): ChequebookCheck {
  const target = readTarget(selection.target);
  const ticked = allChequebookNodes(view).filter(
    (node) => selection.ticked.has(node.nodeId) && movableChequebook(node),
  );
  const problems: string[] = [];
  if (target.kind === 'empty') problems.push(TARGET_EMPTY_PROBLEM);
  if (target.kind === 'invalid') problems.push(target.problem);
  if (ticked.length === 0) problems.push(NOTHING_TICKED_PROBLEM);

  const lines: ChequebookLine[] = [];
  if (target.kind === 'ok') {
    for (const node of ticked) {
      const availablePlur = node.chequebook?.availablePlur ?? null;
      if (availablePlur === null) continue;
      lines.push({ node, availablePlur, move: chequebookMove(target.plur, availablePlur) });
    }
  }
  const moving = lines.filter((line): line is MovingLine => line.move !== null);
  if (target.kind === 'ok' && lines.length > 0 && moving.length === 0) problems.push(NOTHING_TO_CHANGE_PROBLEM);

  const ledgers = new Map<string, ChequebookLedger>();
  for (const { node, move } of moving) {
    const xbzz = unitsOf(node.xbzzPlur);
    const xdai = unitsOf(node.xdaiWei);
    // movableChequebook has the wallet read, so only a balance that is not base units comes here.
    if (xbzz === null || xdai === null) {
      problems.push(`The wallet of ${node.label} could not be read.`);
      continue;
    }
    const ledger = ledgerFor(move, xbzz, xdai);
    ledgers.set(node.nodeId, ledger);
    if (ledger.fundPlur !== null) {
      problems.push(`${node.label} is short of ${formatShort(ledger.fundPlur, XBZZ_DECIMALS)} xBZZ for its deposit.`);
    }
    if (ledger.noGas) problems.push(`${node.label} holds no xDAI to pay the gas.`);
  }

  const request =
    target.kind === 'ok' && moving.length > 0
      ? {
          targetPlur: target.plur,
          items: moving.map((line) => ({ nodeId: line.node.nodeId, availablePlur: line.availablePlur })),
        }
      : null;

  return {
    target,
    tickedCount: ticked.length,
    lines,
    lineOf: new Map(lines.map((line) => [line.node.nodeId, line])),
    ledgerOf: ledgers,
    deposits: totalOf(moving, 'deposit'),
    withdrawals: totalOf(moving, 'withdraw'),
    request,
    problems,
  };
}

/** The available balance a line leaves its chequebook with, in PLUR: the target, worked out from the move. */
export function availableAfter(line: ChequebookLine): string {
  const available = BigInt(line.availablePlur);
  if (line.move === null) return line.availablePlur;
  const amount = BigInt(line.move.amountPlur);
  return (line.move.direction === 'deposit' ? available + amount : available - amount).toString();
}

/**
 * The minus sign, U+2212, before what a withdrawal moves, as wide as the plus before a deposit. Made from its code,
 * since in the source the character reads as a hyphen.
 */
export const MINUS = String.fromCharCode(0x2212);

/**
 * The space that does not break, U+00A0, between an amount and its token, so a long amount wraps before it and never
 * from its token. Made from its code, since in the source the character reads as a plain space.
 */
export const NO_BREAK = String.fromCharCode(0xa0);

/**
 * A move as the page says it, every digit of its amount: `deposit +0.5 xBZZ`, the same after `withdraw` with a
 * {@link MINUS}, or `no change`. The amount keeps its token on its line, so a long one wraps after the direction.
 */
export function moveText(move: ChequebookMove | null): string {
  if (move === null) return 'no change';
  const amount = `${formatUnits(move.amountPlur, XBZZ_DECIMALS)}${NO_BREAK}xBZZ`;
  return move.direction === 'deposit' ? `deposit +${amount}` : `withdraw ${MINUS}${amount}`;
}

/** `1 chequebook`, `3 chequebooks`. */
export function chequebookCount(count: number): string {
  return `${count} chequebook${count === 1 ? '' : 's'}`;
}

/** `1 deposit`, `2 deposits`. */
export function depositCount(count: number): string {
  return `${count} deposit${count === 1 ? '' : 's'}`;
}

/** `1 withdrawal`, `2 withdrawals`. */
export function withdrawalCount(count: number): string {
  return `${count} withdrawal${count === 1 ? '' : 's'}`;
}
