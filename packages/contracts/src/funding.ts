import { z } from 'zod';

import { UUID_PATTERN } from './adminApi.js';

/**
 * The manager's funding API, which the web2 admin calls to keep a brand's stages funded from the brand wallet: the
 * nodes with their wallets, batches and chequebooks, the brand account's balances and nonce, transfers the admin signs
 * and the manager checks and broadcasts, stamp operations, the top-ups and dilutions of the nodes' batches, and
 * chequebook operations, the deposits into and withdrawals from the nodes' chequebooks, which each node pays for from
 * its own wallet. The admin has no chain connection of its own. `docs/architecture/funding.md` is the design.
 *
 * Every route is under {@link ADMIN_FUNDING_PATH}, takes `Authorization: Bearer` with the manager's
 * `FUNDING_API_TOKEN`, and refuses a session cookie; the manager's operator routes refuse that bearer.
 *
 * Amounts are integer strings in base units: wei for xDAI (18 decimals) and PLUR for xBZZ (16 decimals), so no amount
 * is ever a float. Every object is a `z.object`, so a field a newer manager adds is dropped on the way in rather than
 * refused. That is also the guard on what an answer may carry: no Bee API address, RPC endpoint or key has a field,
 * so none survives a parse.
 */

/** The prefix of every route of the funding API. */
export const ADMIN_FUNDING_PATH = '/api/admin-funding';

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

/** The codes an error answer carries. */
export const FUNDING_ERROR_CODES = [
  /** The manager has no `FUNDING_API_TOKEN`, so the API is off. */
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
  /** A check of a stamp operation failed, and the sentence says which. Nothing was asked of the node. */
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
 */
export const fundingBatchSchema = z.object({
  batchId,
  depth: depth.nullable(),
  immutable: z.boolean().nullable(),
  usable: z.boolean().nullable(),
  ttlSeconds: z.number().int().nonnegative().nullable(),
  fillRatio: z.number().min(0).max(1).nullable(),
  readError: z.string().nullable(),
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
 */
export const fundingInventorySchema = z.object({
  observedAt: isoMoment,
  chain: fundingChainSchema,
  stages: z.array(fundingStageSchema),
  catalogue: fundingNodeSchema.nullable(),
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
 * inventory, and `expectedDepth` the depth the admin saw, so a batch whose depth moved since is refused. A `topup`
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
 * An amount a chequebook operation moves: base units, more than none, and at most 30 digits, as the manager's
 * chequebook journal takes one, which is more xBZZ than there is.
 */
const chequebookAmount = positiveBaseUnits.refine((amount) => amount.length <= 30, 'must be at most 30 digits');

/**
 * `POST /api/admin-funding/chequebook-operations`: one deposit into, or withdrawal from, a node's chequebook, which the
 * node carries out and pays the gas of. `nodeId` must be a stage's own Bee node or a rung in the manager's current
 * inventory: never a gateway, whose chequebook the manager does not move, nor the catalogue node, which no stage lists.
 * A `deposit` moves `amountPlur` from the node's wallet into its chequebook, a `withdraw` from its chequebook back into
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
