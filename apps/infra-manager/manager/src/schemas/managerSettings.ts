import { ADMIN_LINK_TOKEN_HOLDERS, type AdminLinkTokenChoice } from '@streaming-infra-manager/common';
import { boolean, InferType, mixed, number, object, string } from 'yup';

/** Far past any real address or token, while keeping a save a small request. */
const MAX_TEXT_LENGTH = 8192;

/**
 * yup's own message for a value of the wrong type repeats the value, and the
 * token is a secret, so every rule here words its own message and names no
 * value.
 */
const URL_MESSAGE = 'url is text, the admin address, or empty for no default';
const TOKEN_MESSAGE = 'token is text to replace the stored one, or null to clear it';
const LENGTH_MESSAGE = `url and token hold at most ${MAX_TEXT_LENGTH} characters each`;

const withinLength = (value: unknown): boolean => typeof value !== 'string' || value.length <= MAX_TEXT_LENGTH;

/**
 * What `PUT /manager-settings/admin-link` takes. Only the shape: whether the
 * stack takes the address and the token is the service's to answer. Unknown
 * keys are refused rather than dropped, because a misspelt token key dropped
 * would read as a request to keep the stored token.
 */
export const saveManagerAdminLinkSchema = object({
  expectedRevision: number()
    .typeError('expectedRevision is the revision the page read, a whole number')
    .required('expectedRevision is the revision the page read, a whole number')
    .integer('expectedRevision is the revision the page read, a whole number')
    .min(0, 'expectedRevision is the revision the page read, a whole number'),
  url: mixed<string>()
    .defined(URL_MESSAGE)
    .test('text', URL_MESSAGE, (value) => typeof value === 'string')
    .test('length', LENGTH_MESSAGE, withinLength),
  token: mixed<string>()
    .nullable()
    .test('text-or-null', TOKEN_MESSAGE, (value) => value === undefined || value === null || typeof value === 'string')
    .test('length', LENGTH_MESSAGE, withinLength),
}).noUnknown(true);

export type SaveManagerAdminLinkBody = InferType<typeof saveManagerAdminLinkSchema>;

const TEST_URL_MESSAGE = 'url is text, the admin address to test';
const TOKEN_CHOICE_MESSAGE =
  'token is either the stored one, { "source": "stored" }, or one typed, { "source": "typed", "value": "..." }';
const FEED_OWNER_MESSAGE = 'feedOwner is a stream address, 40 hex characters with or without 0x';
const FEED_OWNER_RE = /^(0x)?[0-9a-fA-F]{40}$/;
const TOKEN_FOR_MESSAGE =
  'tokenFor is "registrar" for the web2 admin\'s registrar token, or "uploader" for an uploader\'s';

/** Exactly one of the two token choices, with no other key, whose typed value is text. */
function isTokenChoice(value: unknown): value is AdminLinkTokenChoice {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const choice = value as Record<string, unknown>;
  const keys = Object.keys(choice).sort().join(',');
  if (choice.source === 'stored') return keys === 'source';
  return choice.source === 'typed' && keys === 'source,value' && typeof choice.value === 'string';
}

/**
 * What `POST /manager-settings/admin-link/test` takes: an address typed on a
 * page, the token to present, whose token it is, and the stream address to
 * compare the admin's owner with, where the page has one. Only the shape here,
 * with messages that name no value.
 */
export const testAdminLinkSchema = object({
  url: mixed<string>()
    .defined(TEST_URL_MESSAGE)
    .test('text', TEST_URL_MESSAGE, (value) => typeof value === 'string')
    .test('length', LENGTH_MESSAGE, withinLength),
  token: mixed<AdminLinkTokenChoice>()
    .defined(TOKEN_CHOICE_MESSAGE)
    .test('choice', TOKEN_CHOICE_MESSAGE, isTokenChoice)
    .test(
      'length',
      LENGTH_MESSAGE,
      (value) => !isTokenChoice(value) || value.source === 'stored' || withinLength(value.value),
    ),
  tokenFor: string()
    .typeError(TOKEN_FOR_MESSAGE)
    .strict()
    .notRequired()
    .oneOf(ADMIN_LINK_TOKEN_HOLDERS, TOKEN_FOR_MESSAGE),
  feedOwner: string().typeError(FEED_OWNER_MESSAGE).nullable().notRequired().matches(FEED_OWNER_RE, FEED_OWNER_MESSAGE),
}).noUnknown(true);

export type TestAdminLinkBody = InferType<typeof testAdminLinkSchema>;

const CATALOGUE_REVISION_MESSAGE = 'expectedRevision is the revision the page read, a whole number';
const CATALOGUE_PROFILE_MESSAGE = 'profileName is the name of the deployment whose Bee node holds the batch';
const CATALOGUE_BATCH_MESSAGE = 'batchId is a batch id, 64 hex digits with or without 0x';
const CATALOGUE_MOVE_MESSAGE = 'move is true to move the catalogue to this batch, false or left out otherwise';

const catalogueRevision = number()
  .typeError(CATALOGUE_REVISION_MESSAGE)
  .required(CATALOGUE_REVISION_MESSAGE)
  .integer(CATALOGUE_REVISION_MESSAGE)
  .min(0, CATALOGUE_REVISION_MESSAGE);

/**
 * What `PUT /manager-settings/catalogue-node` takes: the deployment and the batch its node holds, at the revision the
 * page read, and `move: true` when the page confirmed moving the catalogue to that batch. Only the shape here: whether
 * that node and that batch can hold the catalogue is the service's to answer.
 */
export const saveCatalogueNodeSchema = object({
  expectedRevision: catalogueRevision,
  profileName: string()
    .typeError(CATALOGUE_PROFILE_MESSAGE)
    .required(CATALOGUE_PROFILE_MESSAGE)
    .max(128, CATALOGUE_PROFILE_MESSAGE),
  batchId: string()
    .typeError(CATALOGUE_BATCH_MESSAGE)
    .required(CATALOGUE_BATCH_MESSAGE)
    .matches(/^(0x)?[0-9a-fA-F]{64}$/, CATALOGUE_BATCH_MESSAGE),
  // strict: yup would otherwise read the text "true" as the boolean, and a move is confirmed by the page alone.
  move: boolean().strict().typeError(CATALOGUE_MOVE_MESSAGE).notRequired(),
}).noUnknown(true);

export type SaveCatalogueNodeBody = InferType<typeof saveCatalogueNodeSchema>;

/** What `DELETE /manager-settings/catalogue-node` takes: the revision the page read. */
export const clearCatalogueNodeSchema = object({ expectedRevision: catalogueRevision }).noUnknown(true);

export type ClearCatalogueNodeBody = InferType<typeof clearCatalogueNodeSchema>;

/** What `POST /manager-settings/catalogue-node/release` takes: the revision the page read. */
export const releaseCatalogueNodeSchema = object({ expectedRevision: catalogueRevision }).noUnknown(true);

export type ReleaseCatalogueNodeBody = InferType<typeof releaseCatalogueNodeSchema>;
