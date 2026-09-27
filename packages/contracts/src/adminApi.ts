import { z } from 'zod';

import { MEDIA_TYPES } from './mediaType.js';

/** How the admin names a stream and a feed topic: 8-4-4-4-12 hex digits, either case, any version. */
export const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * A number as the admin has always read one from a request body, before it checks it. Text loses its spaces and is
 * read as JavaScript reads a number, so `" 3 "` is 3 and `""` is no number. Anything else but a number or null goes
 * through `parseFloat`, so `[3]` is 3 and `true` is no number. Infinity is a number here and passes.
 */
function readAsNumber(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') {
    const digits = value.replace(/\s/g, '');
    return digits === '' ? Number.NaN : +digits;
  }
  if (typeof value === 'number' && !Number.isNaN(value)) return value;
  return Number.parseFloat(value as string);
}

/** Text as the admin has always read it from a request body: anything with a text form of its own is taken as it. */
function readAsText(value: unknown): unknown {
  if (value === undefined || value === null || typeof value === 'string' || Array.isArray(value)) return value;
  const text = (value as { toString?: () => string }).toString?.();
  return text === undefined || text === '[object Object]' ? value : text;
}

/** What a request is told about a field it left out, or sent in a shape that is not `what`. */
const fieldError =
  (name: string, what: string) =>
  (issue: { input?: unknown }): string =>
    issue.input === undefined ? `${name} is a required field` : `${name} must be ${what}`;

const bodyNumber = (name: string) =>
  z.preprocess(
    readAsNumber,
    z.custom<number>((value) => typeof value === 'number' && !Number.isNaN(value), {
      error: fieldError(name, 'a number'),
    }),
  );

const wholeNumber = (name: string) => bodyNumber(name).refine(Number.isInteger, `${name} must be a whole number`);

const notNegative =
  (name: string) =>
  <T extends z.ZodType<number>>(schema: T) =>
    schema.refine((value) => value >= 0, `${name} must not be negative`);

const bodyText = (name: string) => z.preprocess(readAsText, z.string({ error: fieldError(name, 'text') }));

/**
 * `GET /api/internal/streams/by-ingest/:app/:stream`: the ingest stream id split in two, both checked as sent. A route
 * has no other parameters, and any other key is left as it is.
 */
export const ingestLookupParamsSchema = z.looseObject({
  app: z.enum(MEDIA_TYPES, `app must be one of ${MEDIA_TYPES.join(', ')}`),
  stream: z.string().regex(UUID_PATTERN, 'stream must be a UUID'),
});

export const STREAM_STATE_REPORTS = ['live', 'vod'] as const;

/**
 * `POST /api/internal/streams/:id/state`: the broadcast is running, or it has ended and its recording is at `index`
 * with `duration` seconds. The index and the duration belong to a recording and to nothing else, so both are required
 * with `vod` and refused with `live`.
 */
export const streamStateReportSchema = z
  .object({
    state: z.enum(STREAM_STATE_REPORTS, 'state must be one of live, vod'),
    index: notNegative('index')(wholeNumber('index')).optional(),
    duration: notNegative('duration')(bodyNumber('duration')).optional(),
  })
  .superRefine((report, context) => {
    for (const name of ['index', 'duration'] as const) {
      if (report.state === 'vod' && report[name] === undefined) {
        context.addIssue({ code: 'custom', path: [name], message: `${name} is required when state is vod` });
      }
      if (report.state !== 'vod' && report[name] !== undefined) {
        context.addIssue({ code: 'custom', path: [name], message: `${name} is only sent with state vod` });
      }
    }
  });

export type StreamStateReport = z.infer<typeof streamStateReportSchema>;

/**
 * A rung's name goes into the uploader's ingest ids as `<base>_<rung>`, so `_` is the one separator it may not hold.
 * 32 characters is far more than the `1080p` a ladder uses, and short enough to log.
 */
export const RENDITION_NAME_PATTERN = /^[A-Za-z0-9.-]{1,32}$/;

/**
 * `POST /api/internal/streams/:id/renditions`: one rung of a quality ladder. `index` and `duration` are the rung's
 * final manifest and its length, one fact: a finished rung carries both, a rung still delivering carries neither.
 */
export const renditionReportSchema = z
  .object({
    name: bodyText('name').pipe(
      z.string().regex(RENDITION_NAME_PATTERN, 'name must be 1-32 characters of letters, digits, . or -'),
    ),
    width: wholeNumber('width').refine((value) => value > 0, 'width must be positive'),
    height: wholeNumber('height').refine((value) => value > 0, 'height must be positive'),
    topic: bodyText('topic').pipe(z.string().regex(UUID_PATTERN, 'topic must be a UUID')),
    bandwidth: notNegative('bandwidth')(wholeNumber('bandwidth')),
    avgBandwidth: notNegative('avgBandwidth')(wholeNumber('avgBandwidth')),
    index: notNegative('index')(wholeNumber('index')).optional(),
    duration: notNegative('duration')(bodyNumber('duration')).optional(),
  })
  .refine(
    (rung) => (rung.index === undefined) === (rung.duration === undefined),
    'index and duration are sent together, or neither is',
  );

export type RenditionReport = z.infer<typeof renditionReportSchema>;
