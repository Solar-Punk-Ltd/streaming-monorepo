import { ARCHIVE_ACTIONS } from '@streaming-monorepo/web2-admin-common';
import { array, boolean, mixed, number, object, string } from 'yup';

import { UUID_RE } from './stream.js';

/** The shapes of `apps/web2-admin/common/src/archive.ts`, checked at the edge. Unknown keys are stripped. */

const BATCH_ID_RE = /^(0x)?[0-9a-fA-F]{64}$/;
const RENDITION_RE = /^[A-Za-z0-9.-]{1,32}$/;

export const archiveIdParamSchema = object({
  id: string().required().matches(UUID_RE, 'id must be a UUID'),
}).strict();

/**
 * `POST /api/archive/stamp-purchases` and `POST /api/archive/:id/confirm-purchase`: an `ArchiveBuyChoice`, the
 * depth, the days, a label and the cost the dialog showed.
 */
export const archiveBuySchema = object({
  depth: number().required().integer('depth must be a whole number'),
  days: number().required().integer('days must be a whole number').min(2, 'days must be 2 or more'),
  label: string().nullable().defined().max(64, 'label is 64 characters at most'),
  costPlur: string()
    .required()
    .matches(/^[1-9]\d{0,77}$/, 'costPlur must be a whole number of PLUR'),
}).strict();

/** `POST /api/streams/:id/archive`: an `ArchiveStartRequest`. */
export const archiveStartSchema = object({
  renditions: array()
    .of(string().required().matches(RENDITION_RE, 'each rendition must be a rung name or source'))
    .required()
    .min(1, 'choose at least one quality')
    .max(16, 'at most 16 qualities'),
  target: mixed<{ batchId: string } | { buyNew: true }>()
    .required()
    .test('target', 'target must be { batchId } or { buyNew: true }', (value) => {
      if (typeof value !== 'object' || value === null) return false;
      if (Object.keys(value).length !== 1) return false;
      if ('batchId' in value) return typeof value.batchId === 'string' && BATCH_ID_RE.test(value.batchId);
      return 'buyNew' in value && value.buyNew === true;
    }),
}).strict();

/** `POST /api/archive/:id/actions`: an `ArchiveActionRequest`. */
export const archiveActionSchema = object({
  action: string()
    .required()
    .oneOf([...ARCHIVE_ACTIONS], `action must be one of ${ARCHIVE_ACTIONS.join(', ')}`),
  batchId: string().when('action', {
    is: 'use_stamp',
    then: (schema) =>
      schema.required('use_stamp takes the batchId').matches(BATCH_ID_RE, 'batchId must be 64 hex digits'),
    otherwise: (schema) => schema.optional(),
  }),
}).strict();

/** `PUT /api/streams/:id/archive/listing`: an `ArchiveListingRequest`. */
export const archiveListingSchema = object({
  archivedOnly: boolean().required(),
}).strict();
