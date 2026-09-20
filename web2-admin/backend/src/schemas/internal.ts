import {
  MEDIA_TYPES,
  type MediaType,
} from '@streaming-monorepo/web2-admin-common';
import {
  InferType,
  NumberSchema,
  array,
  number,
  object,
  string,
} from 'yup';

import { UUID_RE } from './stream.js';

/**
 * `/streams/by-ingest/:app/:stream` — the ingest stream id split in two. The
 * uploader passes through whatever an encoder put in `streamid=`, so both
 * halves are checked here rather than handed to the database as a topic.
 */
export const ingestLookupParamSchema = object({
  app: string<MediaType>()
    .required()
    .oneOf([...MEDIA_TYPES], `app must be one of ${MEDIA_TYPES.join(', ')}`),
  stream: string().required().matches(UUID_RE, 'stream must be a UUID'),
}).strict();

/**
 * Numbers that belong to a `vod` report and to no other: the feed index of the
 * final manifest and the length of the recording. Required with `vod`, refused
 * with `live` — a `live` report carrying an index is the uploader sending the
 * wrong thing, and silently dropping it would put a stale index on the entry
 * the next time one is written.
 */
function vodOnly(name: string, schema: NumberSchema): NumberSchema {
  return schema
    .min(0, `${name} must not be negative`)
    .when('state', {
      is: 'vod',
      then: (s) => s.required(`${name} is required when state is vod`),
      otherwise: (s) =>
        s.test(
          'vod-only',
          `${name} is only sent with state vod`,
          (value) => value === undefined,
        ),
    });
}

export const streamStateSchema = object({
  state: string<'live' | 'vod'>()
    .required()
    .oneOf(['live', 'vod'], 'state must be one of live, vod'),
  index: vodOnly('index', number().integer('index must be a whole number')),
  duration: vodOnly('duration', number()),
}).noUnknown(true);

export type StreamStateBody = InferType<typeof streamStateSchema>;

const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;
const SWARM_REFERENCE_RE = /^[0-9a-f]{64}$/;

const lifecycleVersion = number()
  .required()
  .oneOf([1], 'lifecycleVersion must be 1');

const positiveSafeInteger = (name: string) =>
  number()
    .required()
    .integer(`${name} must be a whole number`)
    .min(1, `${name} must be positive`)
    .max(SAFE_INTEGER_MAX, `${name} must be a safe integer`);

const uploaderRenditionProfileSchema = object({
  name: string().required().matches(/^[A-Za-z0-9.-]{1,32}$/),
  width: number().required().integer().positive(),
  height: number().required().integer().positive(),
  bandwidth: number().required().integer().min(0),
  avgBandwidth: number().required().integer().min(0),
}).noUnknown(true);

const uploaderMediaProfileSchema = object({
  mediaType: string<MediaType>()
    .required()
    .oneOf([...MEDIA_TYPES]),
  renditions: array()
    .of(uploaderRenditionProfileSchema.required())
    .required()
    .max(16)
    .test(
      'unique-rendition-names',
      'rendition names must be unique within a profile',
      (value) =>
        value === undefined ||
        new Set(value.map(({ name }) => name)).size === value.length,
    ),
})
  .test(
    'audio-has-no-rungs',
    'audio profile must not declare rungs',
    (value) =>
      value?.mediaType !== 'audio' || (value.renditions?.length ?? 0) === 0,
  )
  .noUnknown(true);

export const uploaderCapabilitySchema = object({
  lifecycleVersion,
  capabilities: object({
    durableCheckpointStore: number().required().oneOf([1]),
    legacyRecordingAdoption: number().required().oneOf([1]),
  })
    .required()
    .noUnknown(true),
  profiles: array()
    .of(uploaderMediaProfileSchema.required())
    .required()
    .min(1)
    .max(MEDIA_TYPES.length)
    .test(
      'one-profile-per-media-type',
      'profiles must contain one profile per media type',
      (value) =>
        value === undefined ||
        new Set(value.map(({ mediaType }) => mediaType)).size === value.length,
    ),
}).noUnknown(true);

export const managedClaimSchema = object({
  lifecycleVersion,
  expectedRevision: positiveSafeInteger('expectedRevision'),
  uploaderId: string().required().min(1).max(200),
  requestId: string().required().matches(UUID_RE, 'requestId must be a UUID'),
}).noUnknown(true);

export const managedRunParamSchema = object({
  id: string().required().matches(UUID_RE, 'id must be a UUID'),
  run: positiveSafeInteger('run'),
}).noUnknown(true);

export const managedRunIdentitySchema = object({
  uploaderId: string().required().min(1).max(200),
  claimId: string().required().matches(UUID_RE, 'claimId must be a UUID'),
}).noUnknown(true);

export const uploaderContinuationParamSchema = object({
  uploaderId: string().required().min(1).max(200),
}).noUnknown(true);

export const continuationPreparationParamSchema = object({
  id: string().required().matches(UUID_RE, 'id must be a UUID'),
  operationId: string()
    .required()
    .matches(UUID_RE, 'operationId must be a UUID'),
}).noUnknown(true);

export const continuationPreparationSchema = object({
  lifecycleVersion,
  uploaderId: string().required().min(1).max(200),
  expectedRevision: positiveSafeInteger('expectedRevision'),
  status: string<'ready' | 'failed'>()
    .required()
    .oneOf(['ready', 'failed']),
  checkpointReference: string()
    .matches(UUID_RE, 'checkpointReference must be a UUID')
    .when('status', {
      is: 'ready',
      then: (schema) =>
        schema.required('checkpointReference is required when status is ready'),
      otherwise: (schema) =>
        schema.test(
          'ready-only',
          'checkpointReference is only sent with status ready',
          (value) => value === undefined,
        ),
    }),
  failure: string()
    .min(1)
    .max(500)
    .when('status', {
      is: 'failed',
      then: (schema) => schema.required('failure is required when status is failed'),
      otherwise: (schema) =>
        schema.test(
          'failed-only',
          'failure is only sent with status failed',
          (value) => value === undefined,
        ),
    }),
}).noUnknown(true);

const immutableReferenceSchema = object({
  topic: string().required().matches(UUID_RE, 'topic must be a UUID'),
  index: number().required().integer().min(0).max(SAFE_INTEGER_MAX),
  reference: string()
    .required()
    .matches(
      SWARM_REFERENCE_RE,
      'reference must be a 64-character Swarm reference',
    ),
  duration: number().required().min(0),
}).noUnknown(true);

const immutableRenditionSchema = immutableReferenceSchema.shape({
  name: string().required().matches(/^[A-Za-z0-9.-]{1,32}$/),
  width: number().integer().positive(),
  height: number().integer().positive(),
  bandwidth: number().integer().min(0),
  avgBandwidth: number().integer().min(0),
});

const completedRecordingSchema = object({
  runNumber: positiveSafeInteger('runNumber'),
  checkpointReference: string()
    .required()
    .matches(UUID_RE, 'checkpointReference must be a UUID'),
  master: immutableReferenceSchema.required(),
  expectedRenditions: array().of(string().required()).required(),
  renditions: array().of(immutableRenditionSchema.required()).required(),
}).noUnknown(true);

const emptyOutcomeSchema = object({
  checkpointReference: string()
    .required()
    .matches(UUID_RE, 'checkpointReference must be a UUID'),
  acceptedMediaCount: number()
    .required()
    .oneOf([0], 'acceptedMediaCount must be 0'),
}).noUnknown(true);

export const managedReportSchema = object({
  lifecycleVersion,
  runNumber: positiveSafeInteger('runNumber'),
  uploaderId: string().required().min(1).max(200),
  claimId: string().required().matches(UUID_RE, 'claimId must be a UUID'),
  eventSequence: positiveSafeInteger('eventSequence'),
  observedAt: string().required().datetime({ precision: 3 }),
  state: string()
    .required()
    .oneOf(['live', 'waiting', 'closed', 'vod']),
  reconnectDeadline: string().datetime({ precision: 3 }).when('state', {
    is: 'waiting',
    then: (schema) =>
      schema.required('reconnectDeadline is required when state is waiting'),
    otherwise: (schema) => schema.strip(),
  }),
  reason: string()
    .oneOf([
      'reconnect_timeout',
      'cancelled',
      'recovery_required',
      'finalization_failed',
      'empty',
    ])
    .when('state', {
      is: 'closed',
      then: (schema) => schema.required('reason is required when state is closed'),
      otherwise: (schema) => schema.strip(),
    }),
  emptyOutcome: emptyOutcomeSchema.when(['state', 'reason'], {
    is: (state: string, reason: string) => state === 'closed' && reason === 'empty',
    then: (schema) =>
      schema.required('emptyOutcome is required for an empty close'),
    otherwise: (schema) => schema.strip(),
  }),
  completedRecording: completedRecordingSchema.when('state', {
    is: 'vod',
    then: (schema) =>
      schema.required('completedRecording is required when state is vod'),
    otherwise: (schema) => schema.strip(),
  }),
}).noUnknown(true);

export type ManagedClaimBody = InferType<typeof managedClaimSchema>;
export type ManagedReportBody = InferType<typeof managedReportSchema>;

/**
 * Rung names go into the uploader's ingest ids as `<base>_<rung>`, so '_' is
 * the one separator a name may not contain; the rest of the charset is what
 * swarm-hls-stream's own ladder allows. 32 characters is far more than the
 * '1080p' / '720p' a ladder actually uses, and short enough to log.
 */
const RENDITION_NAME_RE = /^[A-Za-z0-9.-]{1,32}$/;

/**
 * `POST /streams/:id/renditions` — one rung of an ABR ladder.
 *
 * `index` and `duration` are the rung's final manifest and its length, and
 * they are one fact: a rung that has finished carries both, a rung that is
 * still delivering carries neither. One without the other is refused rather
 * than half-stored, because a ladder counts as finished when every rung has an
 * index, and an index without a duration would finish it with nothing to put
 * on the entry's seek bar.
 */
export const renditionReportSchema = object({
  name: string()
    .required()
    .matches(
      RENDITION_NAME_RE,
      'name must be 1-32 characters of letters, digits, . or -',
    ),
  width: number()
    .required()
    .integer('width must be a whole number')
    .positive('width must be positive'),
  height: number()
    .required()
    .integer('height must be a whole number')
    .positive('height must be positive'),
  topic: string().required().matches(UUID_RE, 'topic must be a UUID'),
  bandwidth: number()
    .required()
    .integer('bandwidth must be a whole number')
    .min(0, 'bandwidth must not be negative'),
  avgBandwidth: number()
    .required()
    .integer('avgBandwidth must be a whole number')
    .min(0, 'avgBandwidth must not be negative'),
  index: number()
    .integer('index must be a whole number')
    .min(0, 'index must not be negative'),
  duration: number().min(0, 'duration must not be negative'),
})
  .test(
    'index-with-duration',
    'index and duration are sent together, or neither is',
    (value) => (value.index === undefined) === (value.duration === undefined),
  )
  .noUnknown(true);

export type RenditionReportBody = InferType<typeof renditionReportSchema>;
