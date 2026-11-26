import { z } from 'zod';

import { UUID_PATTERN } from './adminApi.js';
import { ARCHIVE_MAX_DEPTH, ARCHIVE_MIN_DEPTH } from './archiveCapacity.js';
import { ARCHIVE_BATCH_LABEL_MAX_LENGTH, STAGE_STAMP_STATES } from './stage.js';

/**
 * The manager's funding API, which the web2 admin calls to keep a brand's stages funded from the brand wallet: the
 * nodes with their wallets, batches and chequebooks, the brand account's balances and nonce, transfers the admin signs
 * and the manager checks and broadcasts, stamp operations, the top-ups and dilutions of the nodes' batches, batch
 * purchases, the new batches a node buys for a rung, for the catalogue or as an archive stamp, and chequebook
 * operations, the deposits into and withdrawals from the nodes' chequebooks, which each node pays for from its own
 * wallet. The admin has no chain connection of its own. `docs/architecture/funding.md` is the design.
 *
 * Every route is under {@link ADMIN_FUNDING_PATH}, takes `Authorization: Bearer` with the manager's API token
 * ({@link MANAGER_API_TOKEN_KEY}), and refuses a session cookie; the manager's operator routes refuse that bearer.
 *
 * Amounts are integer strings in base units: wei for xDAI (18 decimals) and PLUR for xBZZ (16 decimals), so no amount
 * is ever a float. Every object is a `z.object`, so a field a newer manager adds is dropped on the way in rather than
 * refused. That is also the guard on what an answer may carry: no Bee API address, RPC endpoint or key has a field,
 * so none survives a parse.
 */

/** The prefix of every route of the funding API. */
export const ADMIN_FUNDING_PATH = '/api/admin-funding';

/**
 * The setting that holds the bearer token of the manager's API, under one name in the manager's env file, in the
 * admin's and in the deploy settings: the manager takes it on every route of this API, and the admin sends it.
 */
export const MANAGER_API_TOKEN_KEY = 'MANAGER_API_TOKEN';

/** The name the manager read the same token under before {@link MANAGER_API_TOKEN_KEY}, read when that one is unset. */
export const MANAGER_API_TOKEN_FORMER_KEY_IN_MANAGER = 'FUNDING_API_TOKEN';

/** The name the admin read the same token under before {@link MANAGER_API_TOKEN_KEY}, read when that one is unset. */
export const MANAGER_API_TOKEN_FORMER_KEY_IN_ADMIN = 'MANAGER_FUNDING_TOKEN';

/**
 * The manager's API token as an env holds it, and the name it was read under: {@link MANAGER_API_TOKEN_KEY} when that
 * is set to more than spaces, otherwise `formerKey`, the app's own earlier name. Null when neither is set. The value
 * is trimmed and is checked by the app that reads it.
 */
export function managerApiTokenFrom(
  env: Readonly<Record<string, string | undefined>>,
  formerKey: typeof MANAGER_API_TOKEN_FORMER_KEY_IN_MANAGER | typeof MANAGER_API_TOKEN_FORMER_KEY_IN_ADMIN,
): { key: string; value: string } | null {
  for (const key of [MANAGER_API_TOKEN_KEY, formerKey]) {
    const value = env[key]?.trim();
    if (value) return { key, value };
  }
  return null;
}

/** `GET`: every stage's nodes and the catalogue node, with their wallets. */
export const FUNDING_INVENTORY_PATH = `${ADMIN_FUNDING_PATH}/inventory`;

/** `POST`: a signed transfer to a node's wallet, which the manager checks, journals and broadcasts. */
export const FUNDING_TRANSFERS_PATH = `${ADMIN_FUNDING_PATH}/transfers`;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** `GET`: an account's balances, pending nonce, fees and gas limits, by its address. */
export function fundingAccountPath(address: string): string {
  if (!ADDRESS_PATTERN.test(address)) throw new Error('An account is an address, 0x and 40 hex digits.');
  return `${ADMIN_FUNDING_PATH}/accounts/${address.toLowerCase()}`;
}

/** `GET`: the state of one transfer, by the request id the admin gave it. */
export function fundingTransferPath(requestId: string): string {
  if (!UUID_PATTERN.test(requestId)) throw new Error('A transfer request id is a UUID.');
  return `${FUNDING_TRANSFERS_PATH}/${requestId.toLowerCase()}`;
}

/** `POST`: one top-up or dilution of a node's batch, which the manager checks, journals and asks the node for. */
export const FUNDING_STAMP_OPERATIONS_PATH = `${ADMIN_FUNDING_PATH}/stamp-operations`;

/** `GET`: the state of one stamp operation, by the request id the admin gave it. */
export function fundingStampOperationPath(requestId: string): string {
  if (!UUID_PATTERN.test(requestId)) throw new Error('A stamp operation request id is a UUID.');
  return `${FUNDING_STAMP_OPERATIONS_PATH}/${requestId.toLowerCase()}`;
}

/**
 * `POST`: one purchase of a new batch, for a rung, for the catalogue or as an archive stamp, which the manager checks,
 * journals, asks the node for and follows up.
 */
export const FUNDING_BATCH_PURCHASES_PATH = `${ADMIN_FUNDING_PATH}/batch-purchases`;

/** `GET`: where one batch purchase stands, by the request id the admin gave it. */
export function fundingBatchPurchasePath(requestId: string): string {
  if (!UUID_PATTERN.test(requestId)) throw new Error('A batch purchase request id is a UUID.');
  return `${FUNDING_BATCH_PURCHASES_PATH}/${requestId.toLowerCase()}`;
}

/** `POST`: restart now the uploader of one stage that a rung purchase waits to restart. */
export function fundingBatchPurchaseRestartPath(requestId: string): string {
  return `${fundingBatchPurchasePath(requestId)}/restart`;
}

/** `POST`: take up again the follow-up of a purchase that stopped as failed after its batch was bought. */
export function fundingBatchPurchaseCheckPath(requestId: string): string {
  return `${fundingBatchPurchasePath(requestId)}/check`;
}

/** `POST`: release the batch a catalogue purchase moved the catalogue from, once the admin's move is done. */
export function fundingBatchPurchaseReleasePath(requestId: string): string {
  return `${fundingBatchPurchasePath(requestId)}/release`;
}

/**
 * `POST`: the purchase of an archive stamp as an admin older than {@link FUNDING_BATCH_PURCHASES_PATH} asks for it.
 * The manager answers it as that route answers a purchase of purpose `archive`.
 */
export const FUNDING_STAMP_PURCHASES_PATH = `${ADMIN_FUNDING_PATH}/stamp-purchases`;

/** `GET`: the state of one purchase asked for on {@link FUNDING_STAMP_PURCHASES_PATH}, by its request id. */
export function fundingStampPurchasePath(requestId: string): string {
  if (!UUID_PATTERN.test(requestId)) throw new Error('A stamp purchase request id is a UUID.');
  return `${FUNDING_STAMP_PURCHASES_PATH}/${requestId.toLowerCase()}`;
}

/**
 * `POST`: one deposit into or withdrawal from a node's chequebook, which the manager checks, journals and asks the
 * node for.
 */
export const FUNDING_CHEQUEBOOK_OPERATIONS_PATH = `${ADMIN_FUNDING_PATH}/chequebook-operations`;

/** `GET`: the state of one chequebook operation, by the request id the admin gave it. */
export function fundingChequebookOperationPath(requestId: string): string {
  if (!UUID_PATTERN.test(requestId)) throw new Error('A chequebook operation request id is a UUID.');
  return `${FUNDING_CHEQUEBOOK_OPERATIONS_PATH}/${requestId.toLowerCase()}`;
}

/** What a funded node does for its stage. The catalogue node is answered on its own, as a node of role `uploader`. */
export const FUNDING_NODE_ROLES = ['uploader', 'gateway', 'rung'] as const;
export type FundingNodeRole = (typeof FUNDING_NODE_ROLES)[number];

/**
 * The most blocks a node's view of the chain may be behind the chain's tip and still count as current: 120, ten
 * minutes of Gnosis Chain. Past it, the time a node gives its batches and the price it reads are stale.
 */
export const FUNDING_CHAIN_CURRENT_MAX_LAG_BLOCKS = 120;

/**
 * Whether a node's view of the chain is current: true within {@link FUNDING_CHAIN_CURRENT_MAX_LAG_BLOCKS} of the tip,
 * false past it, and null when the manager could not read it or does not say.
 */
export function fundingNodeChainCurrent(node: { chainLagBlocks?: number | null }): boolean | null {
  if (node.chainLagBlocks === undefined || node.chainLagBlocks === null) return null;
  return node.chainLagBlocks <= FUNDING_CHAIN_CURRENT_MAX_LAG_BLOCKS;
}

/** What a transfer sends: xDAI, the chain's own coin, or xBZZ, the token. */
export const FUNDING_TRANSFER_KINDS = ['xdai', 'xbzz'] as const;
export type FundingTransferKind = (typeof FUNDING_TRANSFER_KINDS)[number];

/**
 * Where a transfer stands in the manager: `submitted` once broadcast, `confirmed` once mined, `failed` when the chain
 * refused it or it reverted, and `unknown` when the manager cannot tell, for example after a broadcast whose answer it
 * never received. An `unknown` transfer is never sent again; its state is read until it settles.
 */
export const FUNDING_TRANSFER_STATES = ['submitted', 'confirmed', 'failed', 'unknown'] as const;
export type FundingTransferState = (typeof FUNDING_TRANSFER_STATES)[number];

/**
 * What a stamp operation does to a batch: `topup` adds balance to each of its chunks, paid in xBZZ from the node's
 * wallet, which buys it life; `dilute` raises its depth, each step doubling what it holds and halving its time left,
 * for the gas alone, paid in xDAI.
 */
export const FUNDING_STAMP_OPERATION_KINDS = ['topup', 'dilute'] as const;
export type FundingStampOperationKind = (typeof FUNDING_STAMP_OPERATION_KINDS)[number];

/**
 * Which way a chequebook operation moves xBZZ: `deposit` from the node's wallet into its chequebook, and `withdraw`
 * from its chequebook back into its wallet, the one place Bee withdraws to. The node pays the gas of either in xDAI.
 */
export const FUNDING_CHEQUEBOOK_DIRECTIONS = ['deposit', 'withdraw'] as const;
export type FundingChequebookDirection = (typeof FUNDING_CHEQUEBOOK_DIRECTIONS)[number];

/**
 * What a batch purchase is for, which decides where the manager puts the batch once it is bought:
 * - `rung`: a rung's node, or a single-node stage's own Bee node, pays for its stage's uploads with it.
 * - `catalogue`: the catalogue node writes the catalogue with it, after the catalogue is moved onto it.
 * - `archive`: the catalogue node copies finished recordings onto it, as an archive stamp.
 *
 * With the node it names, the purpose is the role of the batch: a rung's batch, the catalogue batch or an archive
 * stamp. A purchase's `replacesBatchId` says which batch held that role before.
 */
export const FUNDING_BATCH_PURCHASE_PURPOSES = ['rung', 'catalogue', 'archive'] as const;
export type FundingBatchPurchasePurpose = (typeof FUNDING_BATCH_PURCHASE_PURPOSES)[number];

/** The shallowest batch Bee sells, and the shallowest a purchase of any purpose buys. */
export const FUNDING_PURCHASE_MIN_DEPTH = 17;

/** The deepest batch a purchase for a rung or for the catalogue buys, the deepest the manager's own buy form takes. */
export const FUNDING_PURCHASE_MAX_DEPTH = 40;

/**
 * The shallowest batch the catalogue is written with, the manager's `MIN_CATALOGUE_DEPTH`: an immutable batch refuses
 * a chunk whose bucket is full, and a catalogue slot is written again at the same address.
 */
export const FUNDING_CATALOGUE_PURCHASE_MIN_DEPTH = 18;

/** How long the manager waits for a bought batch to become usable before the follow-up stops as failed: an hour. */
export const FUNDING_PURCHASE_USABLE_WAIT_SECONDS = 3600;

/**
 * Where a purchase stands after it was asked for, the purchase and what follows it as one line:
 * - `buying`: the node was asked, and the purchase is not `confirmed` yet.
 * - `waiting_usable`: the batch is bought, and its node has not seen enough blocks to stamp with it. The manager
 *   reads the node until it has, for up to {@link FUNDING_PURCHASE_USABLE_WAIT_SECONDS}.
 * - `set`: the batch is where its purpose puts it. A rung's is set on its node, and the uploaders that follow are
 *   being restarted, each as `stages` says. The catalogue's is designated as a move, and the batch moved from waits
 *   for its release.
 * - `done`: nothing is left to do. Every stage of a rung purchase is `applied`, `not_following` or `stopped`; the
 *   catalogue's previous batch is released, or there was none; an archive stamp is recorded and usable.
 * - `failed`: nothing was bought, or the batch did not become usable in time, or it could not be set, and `error`
 *   says which. After a purchase that was `confirmed`, {@link fundingBatchPurchaseCheckPath} takes the follow-up up
 *   again, and nothing is bought a second time.
 */
export const FUNDING_PURCHASE_STEPS = ['buying', 'waiting_usable', 'set', 'done', 'failed'] as const;
export type FundingPurchaseStep = (typeof FUNDING_PURCHASE_STEPS)[number];

/**
 * Where the restart of one stage's uploader stands after a rung purchase set its batch:
 * - `pending`: the manager has not looked at this stage yet. It takes the stages one at a time.
 * - `waiting_live`: a broadcast is live on the stage, read twice 15 seconds apart, and the manager looks again every
 *   30 seconds.
 * - `waiting_unknown`: the manager cannot tell whether a broadcast is live, and waits as if one were.
 * - `waiting_settings`: other saved settings wait for an Apply on this stage beside the batch. The manager applies
 *   nothing, and the stage takes the batch with the Apply an operator runs in the manager.
 * - `applying`: the Apply runs, and the uploader is being recreated.
 * - `applied`: the uploader runs and pays with the new batch, whoever applied it.
 * - `failed`: the Apply did not go through, and `message` says why. A check takes it up again, and so does a manager
 *   that restarted, once.
 * - `not_following`: the stage's pool string is another than the pool's own, so the manager changes nothing on it.
 * - `stopped`: the stage does not run. It takes the batch at its next start.
 */
export const FUNDING_PURCHASE_APPLY_STATES = [
  'pending',
  'waiting_live',
  'waiting_unknown',
  'waiting_settings',
  'applying',
  'applied',
  'failed',
  'not_following',
  'stopped',
] as const;
export type FundingPurchaseApplyState = (typeof FUNDING_PURCHASE_APPLY_STATES)[number];

/** Whether a stage's restart can be asked for now: only while it waits for a broadcast, live or untold. */
export function fundingPurchaseRestartable(apply: FundingPurchaseApplyState): boolean {
  return apply === 'waiting_live' || apply === 'waiting_unknown';
}

/** Whether a stage's restart is over: nothing more happens on it for this purchase. */
export function fundingPurchaseApplySettled(apply: FundingPurchaseApplyState): boolean {
  return apply === 'applied' || apply === 'not_following' || apply === 'stopped';
}

/** The codes an error answer carries. */
export const FUNDING_ERROR_CODES = [
  /** The manager has no API token, so the API is off. */
  'funding_off',
  /** No bearer, the wrong one, or a session cookie. */
  'unauthorized',
  /** The node is not in the manager's current inventory, or its wallet is not the address named. */
  'unknown_node',
  /** The signed transaction is not the transfer the request describes, or not one the manager sends. */
  'bad_transaction',
  /** The manager could not reach the chain. */
  'chain_unreachable',
  /** The request id is taken by another transfer. */
  'conflict',
  /**
   * No transfer was journalled under this request id: the manager never received it, so sending it again under the
   * same id is safe.
   */
  'unknown_request',
  /**
   * A check of a stamp operation, of a batch purchase or of one of a purchase's follow-up calls failed, and the
   * sentence says which. Nothing was asked of the node.
   */
  'stamp_refused',
  /** The node's Bee API did not answer the manager. */
  'node_unreachable',
  /**
   * A check of a chequebook operation failed, or the manager could not prepare it, and the sentence says which.
   * Nothing was asked of the node.
   */
  'chequebook_refused',
] as const;
export type FundingErrorCode = (typeof FUNDING_ERROR_CODES)[number];

/**
 * The HTTP status each code is answered with. `funding_off` is a 404, so an API that is off looks like no API at
 * all.
 */
export const FUNDING_ERROR_STATUS: Readonly<Record<FundingErrorCode, number>> = {
  funding_off: 404,
  unauthorized: 401,
  unknown_node: 404,
  bad_transaction: 422,
  chain_unreachable: 502,
  conflict: 409,
  unknown_request: 404,
  stamp_refused: 422,
  node_unreachable: 502,
  chequebook_refused: 422,
};

const someText = z.string().min(1);

/** A UUID in either case, kept in lower case, so one id is one row whichever way the sender printed it. */
const uuid = z
  .string()
  .regex(UUID_PATTERN, 'must be a UUID')
  .transform((id) => id.toLowerCase());

/** A moment with its offset, as `Date.prototype.toISOString` writes one. */
const isoMoment = z.iso.datetime({ offset: true });

/** An address, `0x` and 40 hex digits, kept in lower case. */
const address = z
  .string()
  .regex(ADDRESS_PATTERN, 'must be 0x and 40 hex digits')
  .transform((text) => text.toLowerCase());

/** A transaction hash, `0x` and 64 hex digits, kept in lower case. */
const txHash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be 0x and 64 hex digits')
  .transform((text) => text.toLowerCase());

/** A postage batch id, `0x` and 64 hex digits, kept in lower case. */
const batchId = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be 0x and 64 hex digits')
  .transform((text) => text.toLowerCase());

/** A batch's depth, a whole number up to 255, a byte in the postage contract: the batch holds `2^depth` chunks. */
const depth = z.number().int().min(0).max(255);

/**
 * A whole number of base units as a decimal string, with no sign, fraction, exponent or leading zero, and no more
 * digits than a 256-bit number has.
 */
const baseUnits = z.string().regex(/^(0|[1-9]\d{0,77})$/, 'must be a whole number of base units, as decimal digits');

/** An amount to send: base units, more than none. */
const positiveBaseUnits = baseUnits.refine((amount) => amount !== '0', 'must be more than nothing');

/**
 * The manager's own id of a node, opaque to the admin, for example `<instance_id>:<service>`. Letters, digits and
 * `:._-` only, so it is safe in a path, a log line and a database column.
 */
const nodeId = z.string().regex(/^[A-Za-z0-9:._-]{1,200}$/, 'must be 1 to 200 letters, digits or :._-');

const chainId = z.number().int().positive();

/** A signed transaction as `eth_sendRawTransaction` takes it: `0x` and whole bytes in hex, at most 64 KiB. */
const rawTransaction = z
  .string()
  .regex(/^0x([0-9a-fA-F]{2}){1,65536}$/, 'must be 0x and whole bytes in hex')
  .transform((text) => text.toLowerCase());

/**
 * The batch the manager uses for a node's uploads, as the node reports it in `GET /stamps/{id}`. `usable` is Bee's
 * own word, `immutable` its `immutableFlag`, `ttlSeconds` the seconds left at today's price, where 0 is expired, and
 * `fillRatio` its fullest bucket's share of what one bucket holds, where 1 is full, as the manager's postage page
 * reads it. Every reading is null when the node could not be read about the batch, and `readError` says why in a
 * sentence; it is null otherwise. `ttlSeconds` is null as well when the node could not work it out, and `fillRatio`
 * when the node did not say enough to work it out.
 *
 * `state` is the manager's verdict on the batch, the one its own pages give: `expired` with no time left, `gone` when
 * the node holds it no more, `full`, `pending`, `active`, or `unknown` when the node did not answer. It is optional,
 * so the answer of a manager that does not say still parses.
 */
export const fundingBatchSchema = z.object({
  batchId,
  depth: depth.nullable(),
  immutable: z.boolean().nullable(),
  usable: z.boolean().nullable(),
  ttlSeconds: z.number().int().nonnegative().nullable(),
  fillRatio: z.number().min(0).max(1).nullable(),
  readError: z.string().nullable(),
  state: z.enum(STAGE_STAMP_STATES).optional(),
});
export type FundingBatch = z.infer<typeof fundingBatchSchema>;

/**
 * A node's chequebook, which pays its peers for bandwidth, as the node reports it in `GET /chequebook/address` and
 * `GET /chequebook/balance`: its address; `availablePlur`, what the node can still pay out of it; and `totalPlur`,
 * which also holds the cheques the node wrote that its peers have not cashed yet, so total less available is what the
 * node owes them. Every reading is null when the node could not be read about its chequebook, and `readError` says why
 * in a sentence; it is null otherwise.
 */
export const fundingChequebookSchema = z.object({
  address: address.nullable(),
  availablePlur: baseUnits.nullable(),
  totalPlur: baseUnits.nullable(),
  readError: z.string().nullable(),
});
export type FundingChequebook = z.infer<typeof fundingChequebookSchema>;

/**
 * One archive batch: an immutable batch that finished recordings are copied onto, with the readings of any batch.
 * `nodeId` is the node that holds it, the only one that can stamp with it, top it up through its Bee API and dilute
 * it, and `nodeLabel` that node's name for a person. It is the catalogue node for a batch bought through this API, and
 * another node for a batch left where it was bought once the catalogue node was designated anew, which the inventory
 * lists nowhere else. `label` is the name its buyer gave the batch, null when it has none. `writable` is true only
 * for a batch the catalogue node holds, that the node calls usable and that has not expired; any other is topped up
 * and never written.
 */
export const fundingArchiveBatchSchema = fundingBatchSchema.extend({
  nodeId,
  nodeLabel: someText,
  label: z.string().min(1).max(ARCHIVE_BATCH_LABEL_MAX_LENGTH).nullable(),
  writable: z.boolean(),
});
export type FundingArchiveBatch = z.infer<typeof fundingArchiveBatchSchema>;

/**
 * What the manager recommends for a batch bought in place of a node's own, which the buy dialog opens with: the depth
 * and the kind of the batch the node pays with now, as the node reports them or as the manager last read them, and
 * for a node that never had a batch the depth the manager's own buy form suggests for it, a rung's by its place in the
 * ladder. A catalogue node's is immutable and of {@link FUNDING_CATALOGUE_PURCHASE_MIN_DEPTH} or deeper.
 */
export const fundingReplacementSchema = z.object({
  depth: z.number().int().min(17).max(40),
  immutable: z.boolean(),
});
export type FundingReplacement = z.infer<typeof fundingReplacementSchema>;

/**
 * One node a stage, or the catalogue, runs, with its wallet as the manager read it from the node. The wallet and its
 * balances are null when the node could not be read, and `readError` says why in a sentence; it is null otherwise.
 *
 * `batch` is the batch the manager uses for the node's uploads: a rung's is its rung's batch, a stage's own Bee
 * node's the stage's batch, and the catalogue node's the designated catalogue batch, never the one a pending move
 * left. It is null for a gateway and for a node with no batch set. It is optional, so the answer of a manager that
 * does not read batches still parses.
 *
 * `chequebook` is the node's chequebook, read with its wallet. It is null when the node answered that it has none, as
 * an ultra-light node or one with its chequebook off answers, and optional, so the answer of a manager that does not
 * read chequebooks still parses.
 *
 * `replacement` is what the manager recommends for a batch bought in place of the node's own: see
 * {@link fundingReplacementSchema}. It is null for a node whose batch pays for nothing, a gateway and the own node of
 * a stage that uploads through a pool, and optional, so the answer of a manager that offers no purchases of this kind
 * still parses, and absent is read as no purchase offered.
 *
 * `chainLagBlocks` is how many blocks the node's view of the chain is behind the chain's tip, from the `block` and
 * `chainTip` of its chain state, read with its wallet. It is null when the node's chain state could not be read, and
 * optional, so the answer of a manager that does not read it still parses. {@link fundingNodeChainCurrent} reads it.
 */
export const fundingNodeSchema = z.object({
  nodeId,
  label: someText,
  role: z.enum(FUNDING_NODE_ROLES),
  walletAddress: address.nullable(),
  xdaiWei: baseUnits.nullable(),
  xbzzPlur: baseUnits.nullable(),
  readError: z.string().nullable(),
  batch: fundingBatchSchema.nullable().optional(),
  chequebook: fundingChequebookSchema.nullable().optional(),
  replacement: fundingReplacementSchema.nullable().optional(),
  chainLagBlocks: z.number().int().nonnegative().nullable().optional(),
});
export type FundingNode = z.infer<typeof fundingNodeSchema>;

/** One stage, by the deployment's `instance_id`, and its nodes. */
export const fundingStageSchema = z.object({
  stageId: uuid,
  name: someText,
  nodes: z.array(fundingNodeSchema),
});
export type FundingStage = z.infer<typeof fundingStageSchema>;

/**
 * What postage costs now: the price of keeping one chunk for one block, in PLUR, as a node reads it from the chain
 * (`currentPrice` in its `/chainstate`); the chain's block time in seconds, 5 on Gnosis Chain; and the postage
 * contract's floor in blocks, the least life a batch may be left with, 17280, a day of blocks.
 */
export const fundingPostageSchema = z.object({
  pricePerChunkPerBlockPlur: positiveBaseUnits,
  blockSeconds: z.number().int().positive(),
  minimumValidityBlocks: z.number().int().positive(),
});
export type FundingPostage = z.infer<typeof fundingPostageSchema>;

/**
 * The chain the manager's nodes run on, the BZZ token's address on it, and what postage costs now, which is null when
 * no node answered. `postage` is optional, so the answer of a manager that does not read it still parses.
 */
export const fundingChainSchema = z.object({
  chainId,
  bzzToken: address,
  postage: fundingPostageSchema.nullable().optional(),
});
export type FundingChain = z.infer<typeof fundingChainSchema>;

/**
 * `GET /api/admin-funding/inventory`: every stage's nodes and the brand's catalogue node, null when none is
 * designated, as the manager read them at `observedAt`. Never a Bee API address, an RPC endpoint or a key.
 *
 * `archiveBatches` is every archive batch the manager keeps, in the order they were designated, each naming the node
 * that holds it. They are listed while no catalogue node is designated too, since each still needs its top-ups. It is
 * optional, so the answer of a manager that keeps none still parses, and absent is read as none.
 */
export const fundingInventorySchema = z.object({
  observedAt: isoMoment,
  chain: fundingChainSchema,
  stages: z.array(fundingStageSchema),
  catalogue: fundingNodeSchema.nullable(),
  archiveBatches: z.array(fundingArchiveBatchSchema).optional(),
});
export type FundingInventory = z.infer<typeof fundingInventorySchema>;

/**
 * `GET /api/admin-funding/accounts/:address`: what the admin needs to sign transfers from this account. The nonce is
 * the pending one. The fees are in wei per gas, and `gasNative` and `gasBzzTransfer` are the suggested gas limits of
 * an xDAI transfer and of an xBZZ `transfer` call, all decimal strings.
 */
export const fundingAccountAnswerSchema = z.object({
  address,
  chainId,
  xdaiWei: baseUnits,
  xbzzPlur: baseUnits,
  nonce: z.number().int().nonnegative(),
  maxFeePerGasWei: baseUnits,
  maxPriorityFeePerGasWei: baseUnits,
  gasNative: baseUnits,
  gasBzzTransfer: baseUnits,
});
export type FundingAccountAnswer = z.infer<typeof fundingAccountAnswerSchema>;

/**
 * `POST /api/admin-funding/transfers`: one signed transfer to a node's wallet. The manager decodes `rawTransaction`
 * and checks it is exactly this transfer on its chain before it journals and broadcasts it: for `xdai` a plain
 * transfer of `amount` wei to `to`; for `xbzz` a call of the BZZ token's `transfer(to, amount)` with no value. `to`
 * must be the wallet of `nodeId` in the manager's current inventory. The same `requestId` sent again answers the
 * transfer's state and never sends it twice.
 */
export const fundingTransferRequestSchema = z.object({
  requestId: uuid,
  nodeId,
  kind: z.enum(FUNDING_TRANSFER_KINDS),
  to: address,
  amount: positiveBaseUnits,
  rawTransaction,
});
export type FundingTransferRequest = z.infer<typeof fundingTransferRequestSchema>;

/** What `POST /api/admin-funding/transfers` answers, with 202: the transfer's state, and its hash once there is one. */
export const fundingTransferAnswerSchema = z.object({
  requestId: uuid,
  state: z.enum(FUNDING_TRANSFER_STATES),
  txHash: txHash.nullable(),
});
export type FundingTransferAnswer = z.infer<typeof fundingTransferAnswerSchema>;

/**
 * `GET /api/admin-funding/transfers/:requestId`: where the transfer stands. The hash, the block it was mined in and
 * the error are each null until there is one.
 */
export const fundingTransferStatusSchema = z.object({
  requestId: uuid,
  state: z.enum(FUNDING_TRANSFER_STATES),
  txHash: txHash.nullable(),
  blockNumber: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
});
export type FundingTransferStatus = z.infer<typeof fundingTransferStatusSchema>;

/** What every stamp operation names: its request id, the node, the node's batch and the depth the admin saw. */
const stampOperationFields = {
  requestId: uuid,
  nodeId,
  batchId,
  expectedDepth: depth,
};

/**
 * `POST /api/admin-funding/stamp-operations`: one top-up or dilution of a batch, which the node that holds it carries
 * out and pays for from its own wallet. `nodeId` and `batchId` must be a node and its batch in the manager's current
 * inventory, or an archive batch of the inventory with the `nodeId` it names as its holder, and `expectedDepth` the
 * depth the admin saw, so a batch whose depth moved since is refused. A `topup`
 * adds `amountPerChunkPlur` to each of the batch's chunks, which costs that amount times `2^depth` in xBZZ. A `dilute`
 * raises the batch to `newDepth`, one or two steps deeper than `expectedDepth`. The same `requestId` sent again
 * answers the operation's state and never runs it twice.
 */
export const fundingStampOperationRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    ...stampOperationFields,
    kind: z.literal('topup'),
    amountPerChunkPlur: positiveBaseUnits,
  }),
  z
    .object({
      ...stampOperationFields,
      kind: z.literal('dilute'),
      newDepth: depth,
    })
    .refine(
      (request) => request.newDepth === request.expectedDepth + 1 || request.newDepth === request.expectedDepth + 2,
      {
        message: 'must be one or two steps deeper than expectedDepth',
        path: ['newDepth'],
      },
    ),
]);
export type FundingStampOperationRequest = z.infer<typeof fundingStampOperationRequestSchema>;
export type FundingStampTopUpRequest = Extract<FundingStampOperationRequest, { kind: 'topup' }>;
export type FundingStampDiluteRequest = Extract<FundingStampOperationRequest, { kind: 'dilute' }>;

/**
 * What `POST /api/admin-funding/stamp-operations` answers, with 202: the operation's state, in the transfers' four
 * states, and its transaction hash once there is one.
 */
export const fundingStampOperationAnswerSchema = z.object({
  requestId: uuid,
  kind: z.enum(FUNDING_STAMP_OPERATION_KINDS),
  state: z.enum(FUNDING_TRANSFER_STATES),
  txHash: txHash.nullable(),
});
export type FundingStampOperationAnswer = z.infer<typeof fundingStampOperationAnswerSchema>;

/**
 * `GET /api/admin-funding/stamp-operations/:requestId`: where the operation stands. The hash and the error are each
 * null until there is one.
 */
export const fundingStampOperationStatusSchema = z.object({
  requestId: uuid,
  kind: z.enum(FUNDING_STAMP_OPERATION_KINDS),
  state: z.enum(FUNDING_TRANSFER_STATES),
  txHash: txHash.nullable(),
  error: z.string().nullable(),
});
export type FundingStampOperationStatus = z.infer<typeof fundingStampOperationStatusSchema>;

/**
 * `POST /api/admin-funding/batch-purchases`: one purchase of a new batch of `depth`, which the node `nodeId` buys and
 * pays for from its own wallet: `amountPerChunkPlur` for each of the batch's `2^depth` stamps in xBZZ, and the gas in
 * xDAI. One route buys for every purpose, and only these fields differ:
 *
 * | `purpose`   | `nodeId`                                         | `depth`                       | `immutable`   |
 * | ----------- | ------------------------------------------------ | ----------------------------- | ------------- |
 * | `rung`      | a rung's node, or a single-node stage's Bee node | 17 to 40                      | either        |
 * | `catalogue` | the catalogue node                               | 18 to 40                      | true          |
 * | `archive`   | the catalogue node                               | a depth of the capacity table | true          |
 *
 * `replacesBatchId` is the batch that holds the role now: the batch set on the rung or on the stage, or the designated
 * catalogue batch, and null when the node has none set. It is null for an archive stamp, which replaces none. `label`
 * is the name the batch carries in the manager and the admin, null for none; on its node the batch carries a label of
 * the manager's own, made from the purpose and the request id.
 *
 * The manager refuses with `stamp_refused`, and asks nothing of the node, when the node is not one the purpose names
 * in its current inventory; when `replacesBatchId` is another batch than the one set there now; when, for a rung or
 * the catalogue, that batch is neither expired nor gone, since a batch that still works is topped up or diluted; when
 * the amount buys less life than the postage contract's floor; and when the wallet holds less than the cost. A rung's
 * or the catalogue's purchase is refused the same way while the node's latest purchase for that purpose bought a batch
 * and stopped as `failed` before it was put to use, for as long as the node still holds that batch with time left:
 * a check puts it to use, and a new purchase would pay for a second one. A node that could not be read about that
 * batch keeps the refusal. A node on which another purchase is `buying` or `waiting_usable`, or another operation of
 * this API is under way, answers 409 `conflict`.
 *
 * The manager journals the request before it asks the node. The same `requestId` sent again answers the purchase's
 * state and never buys twice. What the manager does once the batch is bought is in
 * {@link fundingBatchPurchaseStatusSchema}.
 */
export const fundingBatchPurchaseRequestSchema = z
  .object({
    requestId: uuid,
    purpose: z.enum(FUNDING_BATCH_PURCHASE_PURPOSES),
    nodeId,
    depth: z.number().int(),
    amountPerChunkPlur: positiveBaseUnits,
    immutable: z.boolean(),
    label: z.string().trim().min(1).max(ARCHIVE_BATCH_LABEL_MAX_LENGTH).nullable(),
    replacesBatchId: batchId.nullable(),
  })
  .superRefine((request, context) => {
    const [least, most] =
      request.purpose === 'archive'
        ? [ARCHIVE_MIN_DEPTH, ARCHIVE_MAX_DEPTH]
        : request.purpose === 'catalogue'
          ? [FUNDING_CATALOGUE_PURCHASE_MIN_DEPTH, FUNDING_PURCHASE_MAX_DEPTH]
          : [FUNDING_PURCHASE_MIN_DEPTH, FUNDING_PURCHASE_MAX_DEPTH];
    if (request.depth < least || request.depth > most) {
      context.addIssue({
        code: 'custom',
        path: ['depth'],
        message: `must be ${least} to ${most} for ${request.purpose}`,
      });
    }
    if (request.purpose !== 'rung' && !request.immutable) {
      context.addIssue({ code: 'custom', path: ['immutable'], message: `must be true for ${request.purpose}` });
    }
    if (request.purpose === 'archive' && request.replacesBatchId !== null) {
      context.addIssue({ code: 'custom', path: ['replacesBatchId'], message: 'must be null for archive' });
    }
  });
export type FundingBatchPurchaseRequest = z.infer<typeof fundingBatchPurchaseRequestSchema>;

/**
 * What `POST /api/admin-funding/batch-purchases` answers, with 202: the purchase's state, in the transfers' four
 * states, and the batch and its transaction hash once the node has answered with them. Bee answers a purchase only
 * once its transaction is mined, so a purchase is `unknown` until then and the manager never answers `submitted`.
 */
export const fundingBatchPurchaseAnswerSchema = z.object({
  requestId: uuid,
  purpose: z.enum(FUNDING_BATCH_PURCHASE_PURPOSES),
  state: z.enum(FUNDING_TRANSFER_STATES),
  batchId: batchId.nullable(),
  txHash: txHash.nullable(),
});
export type FundingBatchPurchaseAnswer = z.infer<typeof fundingBatchPurchaseAnswerSchema>;

/** One stage whose uploader follows the rung a purchase bought for, and where its restart stands. */
export const fundingPurchaseStageSchema = z.object({
  stageId: uuid,
  name: someText,
  apply: z.enum(FUNDING_PURCHASE_APPLY_STATES),
  /** A sentence about the state where there is one to say: why an Apply failed, which settings wait. */
  message: z.string().nullable(),
});
export type FundingPurchaseStage = z.infer<typeof fundingPurchaseStageSchema>;

/**
 * What a catalogue purchase left behind: the batch the catalogue is moving from, null when the node had none
 * designated, and whether the manager has released it.
 */
export const fundingPurchaseCatalogueSchema = z.object({
  previousBatchId: batchId.nullable(),
  released: z.boolean(),
});
export type FundingPurchaseCatalogue = z.infer<typeof fundingPurchaseCatalogueSchema>;

/**
 * `GET /api/admin-funding/batch-purchases/:requestId`, and what the three follow-up calls answer: where the purchase
 * stands. The batch, the hash and the error are each null until there is one. `usable` is Bee's own word about the
 * bought batch, null while there is no batch yet and when the node could not be read about it.
 *
 * The manager follows a purchase up by itself, in the background, and keeps each step in its journal, so a manager
 * that restarts goes on from the step it had reached:
 *
 * - **Any purpose.** A purchase whose answer the manager lost stays `unknown` until the node lists a batch of the
 *   purchase's depth and kind under the purchase's own label, which makes it `confirmed`, or lists none thirty
 *   minutes after the request, which makes it `failed`. A bought batch is read every few seconds until its node calls
 *   it usable.
 * - **`rung`.** The usable batch is set on the rung's node, or on the single-node stage, as the manager's own buy
 *   form sets one, which writes the pool string of every uploader that follows the rung. The manager then takes
 *   those stages one at a time and runs the stage's settings Apply, the one its own console runs, when the batch is
 *   the only setting the running uploader is behind on and no broadcast is live. `stages` names each stage and its
 *   state. Nothing but a purchase makes the manager apply a stage.
 * - **`catalogue`.** The usable batch is designated as the catalogue batch, as a move from the batch designated
 *   before, with every check the manager's own designation makes, and the catalogue stamp record is pushed. The
 *   admin moves the catalogue and then asks for the release of the previous batch.
 * - **`archive`.** The batch is recorded as an archive batch once it is `confirmed`, and the catalogue stamp record is
 *   pushed.
 *
 * `stages` is empty for every purpose but `rung`, and before the batch is set. `catalogue` is null for every purpose
 * but `catalogue`, and before the batch is designated.
 *
 * `batchState` is the state of the bought batch on its node, as the manager read it for this answer, in the words the
 * inventory gives a batch: `pending` until it is usable, `active`, `expired` once it has no time left, `gone` once
 * the node holds it no more. It is absent while there is no batch, and when the node could not be read about it. A
 * purchase that stopped as `failed` with its batch bought holds its node against a second purchase only until this
 * reads `expired` or `gone`.
 */
export const fundingBatchPurchaseStatusSchema = z.object({
  requestId: uuid,
  purpose: z.enum(FUNDING_BATCH_PURCHASE_PURPOSES),
  nodeId,
  state: z.enum(FUNDING_TRANSFER_STATES),
  batchId: batchId.nullable(),
  txHash: txHash.nullable(),
  usable: z.boolean().nullable(),
  step: z.enum(FUNDING_PURCHASE_STEPS),
  error: z.string().nullable(),
  stages: z.array(fundingPurchaseStageSchema),
  catalogue: fundingPurchaseCatalogueSchema.nullable(),
  batchState: z.enum(STAGE_STAMP_STATES).optional(),
});
export type FundingBatchPurchaseStatus = z.infer<typeof fundingBatchPurchaseStatusSchema>;

/**
 * `POST /api/admin-funding/batch-purchases/:requestId/restart`: run the Apply of one stage now, although a broadcast
 * is live on it or the manager cannot tell. It is taken only while that stage's `apply` is `waiting_live` or
 * `waiting_unknown` ({@link fundingPurchaseRestartable}), so the batch is the only setting the Apply carries; any
 * other state is refused with `stamp_refused`. A live broadcast pauses while its uploader is recreated, and its
 * recording is kept. The answer is the purchase's status.
 *
 * `POST .../check` takes no body: it takes up again the follow-up of a purchase whose step is `failed` after the batch
 * was bought, and a stage whose apply is `failed`, and answers the status. `POST .../release` takes no body: for a
 * `catalogue` purchase whose step is `set`, it releases the batch the catalogue moved from, as the manager's own
 * Release does, and answers the status with `released` true and the step `done`. The admin calls it once its move
 * has switched the catalogue to the new batch; the manager cannot see that move, and takes the call as the word that
 * it is done.
 */
export const fundingBatchPurchaseRestartRequestSchema = z.object({
  stageId: uuid,
});
export type FundingBatchPurchaseRestartRequest = z.infer<typeof fundingBatchPurchaseRestartRequestSchema>;

/** The depth of an archive stamp: one the capacity table of `archiveCapacity.ts` names. */
const archiveDepth = z.number().int().min(ARCHIVE_MIN_DEPTH).max(ARCHIVE_MAX_DEPTH);

/**
 * `POST /api/admin-funding/stamp-purchases`: the purchase of an archive stamp as an admin older than
 * {@link fundingBatchPurchaseRequestSchema} sends it, which the manager takes as a batch purchase of purpose
 * `archive`, immutable and replacing none. One purchase of an archive stamp, a new immutable batch of `depth` on the
 * catalogue node, which that node buys and pays for from its own wallet: `amountPerChunkPlur` for each of the batch's
 * `2^depth` stamps in xBZZ, and the gas in xDAI. `nodeId` must be the catalogue node of the manager's current
 * inventory; any other node is refused with `stamp_refused`, as is an amount that buys less life than the postage
 * contract's floor and a wallet that holds less than the cost. A node on which another operation of this API is still
 * under way answers 409 `conflict`, as it does for a chequebook operation. Nothing is asked of the node when a check
 * refuses.
 *
 * `label` is the name the batch carries in the manager and the admin, null for none. On its node the batch carries a
 * label of the manager's own, made from the request id. The manager journals the request before it asks the node,
 * records the batch as an archive batch once the node answers with its id, and pushes the catalogue stamp record. The
 * same `requestId` sent again answers the purchase's state and never buys twice.
 */
export const fundingStampPurchaseRequestSchema = z.object({
  requestId: uuid,
  nodeId,
  depth: archiveDepth,
  amountPerChunkPlur: positiveBaseUnits,
  label: z.string().trim().min(1).max(ARCHIVE_BATCH_LABEL_MAX_LENGTH).nullable(),
});
export type FundingStampPurchaseRequest = z.infer<typeof fundingStampPurchaseRequestSchema>;

/**
 * What `POST /api/admin-funding/stamp-purchases` answers, with 202: the purchase's state, in the transfers' four
 * states, and the batch and its transaction hash once the node has answered with them. Bee answers a purchase only
 * once its transaction is mined, so a purchase is `unknown` until then and the manager never answers `submitted`.
 */
export const fundingStampPurchaseAnswerSchema = z.object({
  requestId: uuid,
  state: z.enum(FUNDING_TRANSFER_STATES),
  batchId: batchId.nullable(),
  txHash: txHash.nullable(),
});
export type FundingStampPurchaseAnswer = z.infer<typeof fundingStampPurchaseAnswerSchema>;

/**
 * `GET /api/admin-funding/stamp-purchases/:requestId`: where the purchase stands. The batch, the hash and the error
 * are each null until there is one.
 *
 * `usable` is Bee's own word about the bought batch, read from the node on every call of this route: false from the
 * purchase until the node has seen enough blocks after it, which takes some minutes, and true from then on, when the
 * batch can stamp. It is null while there is no batch yet and when the node could not be read about it. The manager
 * waits for nothing in the background: whoever needs the batch usable calls this route until it says so.
 *
 * A purchase whose answer the manager lost stays `unknown` until this route settles it: `confirmed` once the node
 * lists an immutable batch of the purchase's depth under the purchase's own label, and `failed` when it lists none
 * thirty minutes after the request. A node that answered 429 made the purchase `failed`, as it does a stamp operation.
 */
export const fundingStampPurchaseStatusSchema = z.object({
  requestId: uuid,
  state: z.enum(FUNDING_TRANSFER_STATES),
  batchId: batchId.nullable(),
  txHash: txHash.nullable(),
  usable: z.boolean().nullable(),
  error: z.string().nullable(),
});
export type FundingStampPurchaseStatus = z.infer<typeof fundingStampPurchaseStatusSchema>;

/**
 * An amount a chequebook operation moves: base units, more than none, and at most 30 digits, as the manager's
 * chequebook journal takes one, which is more xBZZ than there is.
 */
const chequebookAmount = positiveBaseUnits.refine((amount) => amount.length <= 30, 'must be at most 30 digits');

/**
 * `POST /api/admin-funding/chequebook-operations`: one deposit into, or withdrawal from, a node's chequebook, which the
 * node carries out and pays the gas of. `nodeId` must be a stage's own Bee node, a rung or the catalogue node in the
 * manager's current inventory: never a gateway, whose chequebook the manager does not move. The catalogue node pays
 * its peers from its chequebook for every recording it copies onto an archive batch. A `deposit` moves `amountPlur` from the node's wallet into its chequebook, a `withdraw` from its chequebook back into
 * its wallet. The same `requestId` sent again answers the operation's state and never runs it twice.
 */
export const fundingChequebookOperationRequestSchema = z.object({
  requestId: uuid,
  nodeId,
  direction: z.enum(FUNDING_CHEQUEBOOK_DIRECTIONS),
  amountPlur: chequebookAmount,
});
export type FundingChequebookOperationRequest = z.infer<typeof fundingChequebookOperationRequestSchema>;

/**
 * What `POST /api/admin-funding/chequebook-operations` answers, with 202: the operation's state, in the transfers'
 * four states, and its transaction hash once there is one.
 */
export const fundingChequebookOperationAnswerSchema = z.object({
  requestId: uuid,
  direction: z.enum(FUNDING_CHEQUEBOOK_DIRECTIONS),
  state: z.enum(FUNDING_TRANSFER_STATES),
  txHash: txHash.nullable(),
});
export type FundingChequebookOperationAnswer = z.infer<typeof fundingChequebookOperationAnswerSchema>;

/**
 * `GET /api/admin-funding/chequebook-operations/:requestId`: where the operation stands. The hash and the error are
 * each null until there is one.
 *
 * `mined` is true while the move's transaction is in a block that is not final yet: the manager confirms a chequebook
 * move only once its block is final on the chain, about 3 minutes after it is mined on Gnosis Chain, so the operation
 * stays `submitted` until then. It is true when the manager's journal row is `submitted` and its last look at the
 * receipt found it pending for finality (`awaiting_finality`), and false otherwise. It is optional, so the answer of a
 * manager that does not say still parses, and absent is read as false.
 */
export const fundingChequebookOperationStatusSchema = z.object({
  requestId: uuid,
  direction: z.enum(FUNDING_CHEQUEBOOK_DIRECTIONS),
  state: z.enum(FUNDING_TRANSFER_STATES),
  txHash: txHash.nullable(),
  error: z.string().nullable(),
  mined: z.boolean().optional(),
});
export type FundingChequebookOperationStatus = z.infer<typeof fundingChequebookOperationStatusSchema>;

/** An error answer of the funding API: one of the codes, with the status {@link FUNDING_ERROR_STATUS} gives it. */
export const fundingErrorAnswerSchema = z.object({
  error: z.enum(FUNDING_ERROR_CODES),
  message: z.string(),
});
export type FundingErrorAnswer = z.infer<typeof fundingErrorAnswerSchema>;
