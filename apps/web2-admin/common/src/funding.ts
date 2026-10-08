/**
 * The console's Funding page: the brand wallet, the nodes of every stage with their wallets and batches, the pins
 * that confirm each node's address, transfers from the brand wallet to node wallets, and stamp operations, the
 * top-ups and dilutions of the nodes' batches, which each node pays for from its own wallet. The admin learns the
 * nodes from the manager's funding API (`packages/contracts/src/funding.ts`) and relays every transfer and stamp
 * operation through it; it has no chain connection of its own. `docs/architecture/funding.md` is the design.
 *
 * Every route is a session route, so a write also needs the same-site header. Amounts are integer strings in base
 * units, never floats: wei for xDAI ({@link XDAI_DECIMALS}, 18 decimals) and PLUR for xBZZ ({@link XBZZ_DECIMALS},
 * 16 decimals). {@link parseBaseUnits} and {@link formatBaseUnits} convert to and from what a person types and reads.
 */

import {
  type FundingNode,
  type FundingPostage,
  type FundingStampOperationKind,
  type FundingTransferKind,
  UUID_PATTERN,
} from '@streaming-monorepo/contracts';

export {
  FUNDING_NODE_ROLES,
  FUNDING_STAMP_OPERATION_KINDS,
  FUNDING_TRANSFER_KINDS,
  FUNDING_TRANSFER_STATES,
  type FundingBatch,
  type FundingNode,
  type FundingNodeRole,
  type FundingPostage,
  type FundingStampOperationKind,
  type FundingTransferKind,
  type FundingTransferState,
} from '@streaming-monorepo/contracts';

/** `GET`: the Funding page's view. */
export const FUNDING_PATH = '/api/funding';

/** `POST`: confirm the current addresses of some nodes. */
export const FUNDING_PINS_PATH = `${FUNDING_PATH}/pins`;

/** `POST`: send from the brand wallet to node wallets. `GET` with `?bulkId=`: where one such send stands. */
export const FUNDING_TRANSFERS_ADMIN_PATH = `${FUNDING_PATH}/transfers`;

/** `GET`: the items of one send, by the `bulkId` the send answered. */
export function fundingBulkPath(bulkId: string): string {
  if (!UUID_PATTERN.test(bulkId)) throw new Error('A bulk id is a UUID.');
  return `${FUNDING_TRANSFERS_ADMIN_PATH}?bulkId=${bulkId.toLowerCase()}`;
}

/** `POST`: top up or dilute batches. `GET` with `?bulkId=`: where one such bulk stands. */
export const FUNDING_STAMP_OPERATIONS_ADMIN_PATH = `${FUNDING_PATH}/stamp-operations`;

/** `GET`: the items of one stamp bulk, by the `bulkId` its request answered. */
export function fundingStampBulkPath(bulkId: string): string {
  if (!UUID_PATTERN.test(bulkId)) throw new Error('A bulk id is a UUID.');
  return `${FUNDING_STAMP_OPERATIONS_ADMIN_PATH}?bulkId=${bulkId.toLowerCase()}`;
}

/** xDAI's decimals: one xDAI is 10^18 wei. */
export const XDAI_DECIMALS = 18;

/** xBZZ's decimals: one xBZZ is 10^16 PLUR. */
export const XBZZ_DECIMALS = 16;

/** The decimals of each kind of transfer. */
export const FUNDING_KIND_DECIMALS: Readonly<Record<FundingTransferKind, number>> = {
  xdai: XDAI_DECIMALS,
  xbzz: XBZZ_DECIMALS,
};

/**
 * Whether a node's wallet address is the one an operator confirmed: `pinned` when it is, `new` when none was ever
 * confirmed for the node, and `changed` when the node now answers another address than the confirmed one. Only a
 * `pinned` node takes transfers.
 */
export const FUNDING_PIN_STATES = ['pinned', 'new', 'changed'] as const;
export type FundingPinState = (typeof FUNDING_PIN_STATES)[number];

/**
 * Where one item of a send stands in the admin: `queued` once journalled and before the manager took it, then the
 * manager's own states (`FUNDING_TRANSFER_STATES`): `submitted`, `confirmed`, `failed` and `unknown`. `queued`,
 * `submitted`, and `unknown` within the manager's 30 minutes of it being journalled hold up a new send. A `failed`
 * item with no block (the chain's node refused it at the relay) and an `unknown` one are still watched for a late
 * receipt, and may yet turn `confirmed`; a `failed` one with a block reverted, and is final. Each item's `settled` and
 * `watched` say which, as the admin works it out.
 */
export const FUNDING_ITEM_STATES = ['queued', 'submitted', 'confirmed', 'failed', 'unknown'] as const;
export type FundingItemState = (typeof FUNDING_ITEM_STATES)[number];

/**
 * A node as the console shows it: the manager's node, with its batch when the manager read one, and whether its
 * address is the confirmed one.
 */
export interface AdminFundingNode extends FundingNode {
  pin: FundingPinState;
  /** The address an operator confirmed for this node, or null when none was. */
  pinnedAddress: string | null;
}

/** One stage and its nodes. */
export interface AdminFundingStage {
  stageId: string;
  name: string;
  nodes: AdminFundingNode[];
}

/** The brand wallet: its address, and its balances in base units, null when the manager could not be asked. */
export interface BrandWalletView {
  address: string;
  /** Wei, as a decimal string. */
  xdaiWei: string | null;
  /** PLUR, as a decimal string. */
  xbzzPlur: string | null;
}

/**
 * `GET /api/funding`. `configured` is false while the admin has no manager funding URL and token, and then the page
 * says it is not set up. `wallet` is null while there is no brand wallet. `managerError` says in a sentence why the
 * manager could not be read, and then `stages` is empty, `catalogue` null, `postage` null and `observedAt` null.
 */
export interface FundingView {
  configured: boolean;
  wallet: BrandWalletView | null;
  /** The chain the admin signs for, fixed in the admin. */
  chainId: number;
  stages: AdminFundingStage[];
  catalogue: AdminFundingNode | null;
  /**
   * What postage costs now, as the manager read it from a node's chain state: the price per chunk per block in PLUR,
   * the chain's block time and the postage contract's floor in blocks. Null when no node answered.
   */
  postage: FundingPostage | null;
  /** When the manager read the nodes, ISO 8601, or null when it was not read. */
  observedAt: string | null;
  managerError: string | null;
  /**
   * The latest send that still has an item which holds up a new one (`settled` false), or null. The page resumes its
   * progress from it after a reload or in another tab.
   */
  openBulkId: string | null;
  /**
   * The latest stamp bulk that still has an item which holds up a new one, or null, as `openBulkId` is for sends.
   * A stamp bulk and a send do not hold each other up.
   */
  openStampBulkId: string | null;
}

/** `POST /api/funding/pins`: confirm the current addresses of these nodes, behind the operator's password. */
export interface FundingPinsRequest {
  password: string;
  nodeIds: string[];
}

/** What `POST /api/funding/pins` answers: the nodes whose address is now confirmed. */
export interface FundingPinsAnswer {
  pinned: string[];
}

/** One transfer of a send: what to send to which node, in base units. */
export interface FundingTransferItemRequest {
  nodeId: string;
  kind: FundingTransferKind;
  /** Wei for `xdai`, PLUR for `xbzz`, as a decimal string, more than nothing. */
  amount: string;
}

/**
 * `POST /api/funding/transfers`: send these from the brand wallet, behind the operator's password. Refused when the
 * password is wrong, a node is not pinned or its address changed, or the sum of either kind is over the wallet's
 * balance of it.
 */
export interface FundingTransfersRequest {
  password: string;
  items: FundingTransferItemRequest[];
}

/** One item of a send, as the admin journalled it and as it stands now. */
export interface FundingTransferItem {
  requestId: string;
  nodeId: string;
  kind: FundingTransferKind;
  /** Wei for `xdai`, PLUR for `xbzz`, as a decimal string. */
  amount: string;
  state: FundingItemState;
  /** The transaction hash once the admin signed it, or null. */
  txHash: string | null;
  /**
   * The block it was mined in, or null until it is. Tells a `failed` item the chain reverted (a block, final) from one
   * the chain's node refused at the relay (no block, still watched for a late receipt).
   */
  blockNumber: number | null;
  /** Why it failed, in a sentence, or null. */
  error: string | null;
  /**
   * Whether it no longer holds up a new send. False while it is `queued` or `submitted`, and while it is `unknown`
   * and the manager answered its relay at most 30 minutes ago: the manager answers `unknown` too when the answer of
   * its broadcast was lost, and the transaction may then sit in the chain's pool at its nonce. True once it is `confirmed` or `failed`,
   * and once it is `unknown` for longer than the manager's 30 minutes, after which the chain no longer holds it, so the
   * next send reuses its nonce. Worked out by the admin when it answers.
   */
  settled: boolean;
  /**
   * Whether the admin still asks the manager about it although it has an outcome: true while it is `unknown`, of any
   * age, and while it is `failed` with no block because the chain's node refused it at the relay; a late receipt may
   * still turn either `confirmed`. False for `queued` and `submitted`, which are still under way, and for an item
   * settled for good: `confirmed`, `failed` in a block, or `failed` before the chain saw it.
   */
  watched: boolean;
}

/** What `POST /api/funding/transfers` answers, with 202: the send's id and its items. */
export interface FundingTransfersAnswer {
  bulkId: string;
  items: FundingTransferItem[];
}

/** What `GET /api/funding/transfers?bulkId=` answers: each item of the send, refreshed from the manager. */
export interface FundingBulkAnswer {
  items: FundingTransferItem[];
}

/** How many steps a dilution takes: each doubles what the batch holds and halves its time left. */
export type FundingDiluteSteps = 1 | 2;

/** Top up one batch for `days` more days at today's price, paid from its node's wallet in xBZZ. */
export interface StampTopUpItemRequest {
  kind: 'topup';
  nodeId: string;
  /** `0x` and 64 hex digits, lower case. */
  batchId: string;
  /** The depth the page showed, so a batch whose depth moved since is refused. */
  expectedDepth: number;
  /** A whole number of days, 1 or more, with no cap. */
  days: number;
}

/** Dilute one batch by one step or two, the gas paid from its node's wallet in xDAI. */
export interface StampDiluteItemRequest {
  kind: 'dilute';
  nodeId: string;
  /** `0x` and 64 hex digits, lower case. */
  batchId: string;
  /** The depth the page showed, so a batch whose depth moved since is refused. */
  expectedDepth: number;
  steps: FundingDiluteSteps;
}

/** One item of a stamp bulk: a top-up or a dilution of one batch. */
export type StampOperationItemRequest = StampTopUpItemRequest | StampDiluteItemRequest;

/**
 * `POST /api/funding/stamp-operations`: top up or dilute these batches, behind a confirm dialog and no password. One
 * kind per request, and a batch at most once.
 */
export interface FundingStampOperationsRequest {
  items: StampOperationItemRequest[];
}

/** One item of a stamp bulk, as the admin journalled it and as it stands now. */
export interface FundingStampItem {
  requestId: string;
  kind: FundingStampOperationKind;
  nodeId: string;
  /** The node's label when the item was journalled. */
  nodeLabel: string;
  /** `0x` and 64 hex digits, lower case. */
  batchId: string;
  /** The days a top-up buys, or null for a dilution. */
  days: number | null;
  /** The steps a dilution takes, or null for a top-up. */
  steps: FundingDiluteSteps | null;
  /** What a top-up takes from the node's wallet, PLUR as a decimal string, or null for a dilution, which costs gas. */
  costPlur: string | null;
  state: FundingItemState;
  /** The transaction hash once the manager reported one, or null. */
  txHash: string | null;
  /** Why it failed, in a sentence, or null. */
  error: string | null;
  /** Whether it no longer holds up a new stamp bulk, as a transfer's `settled` is for a new send. */
  settled: boolean;
  /** Whether the admin still asks the manager about it although it has an outcome, as a transfer's `watched`. */
  watched: boolean;
}

/** What `POST /api/funding/stamp-operations` answers, with 202: the bulk's id and its items. */
export interface FundingStampOperationsAnswer {
  bulkId: string;
  items: FundingStampItem[];
}

/** What `GET /api/funding/stamp-operations?bulkId=` answers: each item of the bulk, refreshed from the manager. */
export interface FundingStampBulkAnswer {
  items: FundingStampItem[];
}

const AMOUNT_PATTERN = /^(\d+)?(?:\.(\d*))?$/;

/**
 * Base units as the contract's `baseUnits` takes them: decimal digits only, no leading zero but in `0` itself, and at
 * most 78 digits, the most a 256-bit number has.
 */
const BASE_UNITS_PATTERN = /^(0|[1-9]\d{0,77})$/;

/** The most digits base units have, a 256-bit number's. */
const MAX_BASE_UNITS_DIGITS = 78;

/**
 * `amount` as a BigInt, once it is base units by {@link BASE_UNITS_PATTERN}. `BigInt()` alone would read an empty
 * string as 0, trim spaces, and take a sign or a `0x`, `0o` or `0b` prefix, so a balance check could add a negative
 * amount.
 */
function baseUnitsValue(amount: string): bigint {
  if (!BASE_UNITS_PATTERN.test(amount)) {
    throw new Error('An amount in base units is decimal digits, with no sign, prefix or leading zero, 78 at most.');
  }
  return BigInt(amount);
}

/**
 * A typed amount, such as `0.25`, in base units of a token with `decimals` decimals, as a decimal string, or null when
 * the text is not an amount: no sign, exponent, thousands separator or hex, no more decimals than the token has, and
 * no more than 78 digits of base units, which the contract refuses. Spaces around the text are trimmed, since a person
 * typed it. Exact, with no float in between.
 */
export function parseBaseUnits(text: string, decimals: number): string | null {
  const match = AMOUNT_PATTERN.exec(text.trim());
  if (!match) return null;
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  if (whole === '' && fraction === '') return null;
  if (fraction.length > decimals) return null;
  const units = (
    BigInt(whole || '0') * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, '0') || '0')
  ).toString();
  return units.length > MAX_BASE_UNITS_DIGITS ? null : units;
}

/**
 * Base units as an amount a person reads, such as `0.25`, with the trailing zeros of the fraction dropped. Throws when
 * `amount` is not base units.
 */
export function formatBaseUnits(amount: string, decimals: number): string {
  const units = baseUnitsValue(amount);
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  const fraction = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** The sum of some amounts in base units, exactly, as a decimal string. Throws when one of them is not base units. */
export function sumBaseUnits(amounts: readonly string[]): string {
  return amounts.reduce((sum, amount) => sum + baseUnitsValue(amount), 0n).toString();
}
