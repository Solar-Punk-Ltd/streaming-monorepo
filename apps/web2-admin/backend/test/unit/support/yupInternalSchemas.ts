import { MEDIA_TYPES, type MediaType } from '@streaming-monorepo/web2-admin-common';
import { InferType, NumberSchema, number, object, string } from 'yup';

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
  return schema.min(0, `${name} must not be negative`).when('state', {
    is: 'vod',
    then: (s) => s.required(`${name} is required when state is vod`),
    otherwise: (s) => s.test('vod-only', `${name} is only sent with state vod`, (value) => value === undefined),
  });
}

export const streamStateSchema = object({
  state: string<'live' | 'vod'>().required().oneOf(['live', 'vod'], 'state must be one of live, vod'),
  index: vodOnly('index', number().integer('index must be a whole number')),
  duration: vodOnly('duration', number()),
}).noUnknown(true);

export type StreamStateBody = InferType<typeof streamStateSchema>;

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
  name: string().required().matches(RENDITION_NAME_RE, 'name must be 1-32 characters of letters, digits, . or -'),
  width: number().required().integer('width must be a whole number').positive('width must be positive'),
  height: number().required().integer('height must be a whole number').positive('height must be positive'),
  topic: string().required().matches(UUID_RE, 'topic must be a UUID'),
  bandwidth: number().required().integer('bandwidth must be a whole number').min(0, 'bandwidth must not be negative'),
  avgBandwidth: number()
    .required()
    .integer('avgBandwidth must be a whole number')
    .min(0, 'avgBandwidth must not be negative'),
  index: number().integer('index must be a whole number').min(0, 'index must not be negative'),
  duration: number().min(0, 'duration must not be negative'),
})
  .test(
    'index-with-duration',
    'index and duration are sent together, or neither is',
    (value) => (value.index === undefined) === (value.duration === undefined),
  )
  .noUnknown(true);

export type RenditionReportBody = InferType<typeof renditionReportSchema>;
