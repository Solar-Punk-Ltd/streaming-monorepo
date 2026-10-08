import { UUID_PATTERN } from '@streaming-monorepo/contracts';
import {
  DILUTE_MAX_STEPS,
  FUNDING_STAMP_OPERATION_KINDS,
  FUNDING_TRANSFER_KINDS,
  type FundingStampOperationKind,
  type FundingTransferKind,
  PASSWORD_MAX_LENGTH,
  STAMP_MAX_DEPTH,
  type StampOperationItemRequest,
} from '@streaming-monorepo/web2-admin-common';
import { array, type InferType, mixed, number, object, string } from 'yup';

/** The most nodes one pin names, and the most items one send or stamp request carries: far over what a brand runs. */
export const FUNDING_MAX_ITEMS = 200;

/**
 * The most days one top-up buys: no cap a person meets, only the journal column's, a 32-bit integer's, about 5.9
 * million years. The owner set no cap on the days, only a floor of 1.
 */
export const FUNDING_STAMP_MAX_DAYS = 2 ** 31 - 1;

/**
 * The deepest a batch is: the postage contract keeps a depth in a byte. A dilution's is bounded lower, at the
 * manager's ceiling, `STAMP_MAX_DEPTH` of web2-admin-common.
 */
const MAX_DEPTH = 255;

/** A batch id, `0x` and 64 hex digits, in either case. */
const BATCH_ID_RE = /^0x[0-9a-fA-F]{64}$/;

/** The manager's node id, as the contract's `nodeId` takes it. */
const NODE_ID_RE = /^[A-Za-z0-9:._-]{1,200}$/;

/** Base units, more than nothing: decimal digits, no sign, prefix or leading zero, 78 at most. */
const POSITIVE_BASE_UNITS_RE = /^[1-9]\d{0,77}$/;

const MAX_UINT256 = 2n ** 256n - 1n;

/**
 * The operator's password, asked again for a pin or a send. Bounded and not shape-checked, as the password change's
 * current one: a wrong one answers the same way whatever it looked like.
 */
const password = string().required('password is required').max(PASSWORD_MAX_LENGTH);

const nodeId = string()
  .strict()
  .required('nodeId is required')
  .matches(NODE_ID_RE, 'nodeId must be 1 to 200 letters, digits or :._-');

/** `POST /api/funding/pins`: `FundingPinsRequest`. */
export const fundingPinsSchema = object({
  password,
  nodeIds: array(nodeId)
    .required('nodeIds is required')
    .min(1, 'nodeIds must name a node')
    .max(FUNDING_MAX_ITEMS, `nodeIds names ${FUNDING_MAX_ITEMS} nodes at most`),
}).noUnknown(true);

export type FundingPinsBody = InferType<typeof fundingPinsSchema>;

/** Whether base units that passed {@link POSITIVE_BASE_UNITS_RE}, or none, fit in 256 bits. */
function fitsUint256(value: string | undefined): boolean {
  return value === undefined || !POSITIVE_BASE_UNITS_RE.test(value) ? true : BigInt(value) <= MAX_UINT256;
}

/**
 * One item of a send. The amount is a string, never a JSON number, which loses digits past 2^53: a whole number of
 * base units, more than nothing, at most 2^256 - 1.
 */
const fundingItemSchema = object({
  nodeId,
  kind: mixed<FundingTransferKind>()
    .required('kind is required')
    .oneOf([...FUNDING_TRANSFER_KINDS], 'kind must be xdai or xbzz'),
  amount: string()
    .strict()
    .required('amount is required')
    .matches(POSITIVE_BASE_UNITS_RE, 'amount must be a whole number of base units above 0, as decimal digits')
    .test('uint256', 'amount must be at most 2^256 - 1', fitsUint256),
}).noUnknown(true);

/** `POST /api/funding/transfers`: `FundingTransfersRequest`. */
export const fundingTransfersSchema = object({
  password,
  items: array(fundingItemSchema)
    .required('items is required')
    .min(1, 'items must hold a transfer')
    .max(FUNDING_MAX_ITEMS, `items holds ${FUNDING_MAX_ITEMS} transfers at most`),
}).noUnknown(true);

export type FundingTransfersBody = InferType<typeof fundingTransfersSchema>;

/**
 * `GET /api/funding/transfers?bulkId=` and `GET /api/funding/stamp-operations?bulkId=`: a UUID in either case, read
 * in lower case as the journals keep it.
 */
export const fundingBulkQuerySchema = object({
  bulkId: string().strict().required('bulkId is required').matches(UUID_PATTERN, 'bulkId must be a UUID'),
});

/**
 * One item of a stamp request: a top-up in whole days, 1 or more, at the price of postage the page quoted it at, or a
 * dilution of 1 or 2 steps, of one batch of one node, at the depth the page showed. Every count is a JSON number, never
 * a string; the price is base units as a decimal string, as every amount is, since a JSON number loses digits past
 * 2^53. A field of the other kind is refused rather than ignored.
 */
const stampItemSchema = object({
  kind: mixed<FundingStampOperationKind>()
    .required('kind is required')
    .oneOf([...FUNDING_STAMP_OPERATION_KINDS], 'kind must be topup or dilute'),
  nodeId,
  batchId: string()
    .strict()
    .required('batchId is required')
    .matches(BATCH_ID_RE, 'batchId must be 0x and 64 hex digits'),
  expectedDepth: number()
    .strict()
    .required('expectedDepth is required')
    .integer('expectedDepth must be a whole number')
    .min(0, 'expectedDepth must be 0 or more')
    .max(MAX_DEPTH, `expectedDepth must be at most ${MAX_DEPTH}`)
    .when('kind', {
      is: 'dilute',
      then: (schema) =>
        schema.max(
          STAMP_MAX_DEPTH,
          `a dilution's expectedDepth must be at most ${STAMP_MAX_DEPTH}, the deepest the manager dilutes a batch to`,
        ),
    }),
  days: number()
    .strict()
    .integer('days must be a whole number')
    .min(1, 'days must be 1 or more')
    .max(FUNDING_STAMP_MAX_DAYS, `days must be at most ${FUNDING_STAMP_MAX_DAYS}`)
    .when('kind', {
      is: 'topup',
      then: (schema) => schema.required('days is required for a top-up'),
      otherwise: (schema) => schema.test('topup-only', 'days is for a top-up only', (value) => value === undefined),
    }),
  pricePerChunkPerBlockPlur: string()
    .strict()
    .matches(
      POSITIVE_BASE_UNITS_RE,
      'pricePerChunkPerBlockPlur must be a whole number of base units above 0, as decimal digits',
    )
    .test('uint256', 'pricePerChunkPerBlockPlur must be at most 2^256 - 1', fitsUint256)
    .when('kind', {
      is: 'topup',
      then: (schema) => schema.required('pricePerChunkPerBlockPlur is required for a top-up'),
      otherwise: (schema) =>
        schema.test('topup-only', 'pricePerChunkPerBlockPlur is for a top-up only', (value) => value === undefined),
    }),
  steps: number()
    .strict()
    .integer('steps must be 1 or 2')
    .min(1, 'steps must be 1 or 2')
    .max(DILUTE_MAX_STEPS, 'steps must be 1 or 2')
    .when('kind', {
      is: 'dilute',
      then: (schema) => schema.required('steps is required for a dilution'),
      otherwise: (schema) => schema.test('dilute-only', 'steps is for a dilution only', (value) => value === undefined),
    }),
}).noUnknown(true);

/**
 * `POST /api/funding/stamp-operations`: `FundingStampOperationsRequest`. One kind per request and a batch at most once
 * are the service's checks, which answer the same 400.
 */
export const fundingStampOperationsSchema = object({
  items: array(stampItemSchema)
    .required('items is required')
    .min(1, 'items must hold an operation')
    .max(FUNDING_MAX_ITEMS, `items holds ${FUNDING_MAX_ITEMS} operations at most`),
}).noUnknown(true);

export type FundingStampOperationsBody = InferType<typeof fundingStampOperationsSchema>;

/** The items of a stamp request the schema took, as the contract's union of a top-up and a dilution. */
export function stampOperationItemsOf(body: FundingStampOperationsBody): StampOperationItemRequest[] {
  return body.items.map((item) => {
    const { nodeId: id, batchId, expectedDepth } = item;
    if (item.kind === 'topup') {
      return {
        kind: 'topup',
        nodeId: id,
        batchId,
        expectedDepth,
        days: Number(item.days),
        pricePerChunkPerBlockPlur: String(item.pricePerChunkPerBlockPlur),
      };
    }
    return { kind: 'dilute', nodeId: id, batchId, expectedDepth, steps: item.steps === 2 ? 2 : 1 };
  });
}
