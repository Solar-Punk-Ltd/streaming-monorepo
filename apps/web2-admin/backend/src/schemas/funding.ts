import { UUID_PATTERN } from '@streaming-monorepo/contracts';
import {
  FUNDING_TRANSFER_KINDS,
  type FundingTransferKind,
  PASSWORD_MAX_LENGTH,
} from '@streaming-monorepo/web2-admin-common';
import { array, type InferType, mixed, object, string } from 'yup';

/** The most nodes one pin names, and the most items one send carries: far over what a brand runs. */
export const FUNDING_MAX_ITEMS = 200;

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
    .test('uint256', 'amount must be at most 2^256 - 1', (value) =>
      value === undefined || !POSITIVE_BASE_UNITS_RE.test(value) ? true : BigInt(value) <= MAX_UINT256,
    ),
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

/** `GET /api/funding/transfers?bulkId=`: a UUID in either case, read in lower case as the journal keeps it. */
export const fundingBulkQuerySchema = object({
  bulkId: string().strict().required('bulkId is required').matches(UUID_PATTERN, 'bulkId must be a UUID'),
});
