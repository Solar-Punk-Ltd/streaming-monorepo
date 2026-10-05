import { z } from 'zod';

import { UUID_PATTERN } from './adminApi.js';

/**
 * The manager's funding API, which the web2 admin calls to keep a brand's stages funded from the brand wallet: the
 * nodes and their wallets, the brand account's balances and nonce, and transfers the admin signs and the manager
 * checks and broadcasts. The admin has no chain connection of its own. `docs/architecture/funding.md` is the design.
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
 * One node a stage, or the catalogue, runs, with its wallet as the manager read it from the node. The wallet and its
 * balances are null when the node could not be read, and `readError` says why in a sentence; it is null otherwise.
 * Later phases add the node's batch and chequebook as optional fields.
 */
export const fundingNodeSchema = z.object({
  nodeId,
  label: someText,
  role: z.enum(FUNDING_NODE_ROLES),
  walletAddress: address.nullable(),
  xdaiWei: baseUnits.nullable(),
  xbzzPlur: baseUnits.nullable(),
  readError: z.string().nullable(),
});
export type FundingNode = z.infer<typeof fundingNodeSchema>;

/** One stage, by the deployment's `instance_id`, and its nodes. */
export const fundingStageSchema = z.object({
  stageId: uuid,
  name: someText,
  nodes: z.array(fundingNodeSchema),
});
export type FundingStage = z.infer<typeof fundingStageSchema>;

/** The chain the manager's nodes run on, and the BZZ token's address on it. */
export const fundingChainSchema = z.object({
  chainId,
  bzzToken: address,
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

/** An error answer of the funding API: one of the codes, with the status {@link FUNDING_ERROR_STATUS} gives it. */
export const fundingErrorAnswerSchema = z.object({
  error: z.enum(FUNDING_ERROR_CODES),
  message: z.string(),
});
export type FundingErrorAnswer = z.infer<typeof fundingErrorAnswerSchema>;
