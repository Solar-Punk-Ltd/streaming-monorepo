import {
  MEDIA_TYPES,
  type MediaType,
} from '@streaming-monorepo/web2-admin-common';
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
