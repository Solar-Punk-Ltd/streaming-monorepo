import { z } from 'zod';

import { mediaTypeSchema } from './mediaType.js';

/**
 * The `error` code the admin answers an internal lookup of a stream nobody declared with, on a 404. A caller tells the
 * admin's own 404 from any other server's by it.
 */
export const ADMIN_ERROR_STREAM_NOT_FOUND = 'stream_not_found';

/** The `error` code the admin answers a request without a token it takes with, on a 401. */
export const ADMIN_ERROR_UNAUTHENTICATED = 'unauthenticated';

const someText = z.string().min(1);

/**
 * `GET /api/internal/streams/by-ingest/:app/:stream`, answered 200: the stream the admin declared for that ingest id,
 * as the uploader reads it. Six fields are text with something in it and the media type is one the contract names.
 * Every field is kept as sent, those it does not check included.
 */
export const ingestLookupAnswerSchema = z.looseObject({
  id: someText,
  topic: someText,
  owner: someText,
  mediaType: mediaTypeSchema,
  title: someText,
  status: someText,
  publishKey: someText,
});

export type IngestLookupAnswer = z.infer<typeof ingestLookupAnswerSchema>;

/** A number of any kind, NaN and the infinities included, where a reader asks only that it is one. */
const anyNumber = z.custom<number>((value) => typeof value === 'number');

/** A Swarm reference as an uploader names content it uploaded: 64 lowercase hex digits, unencrypted. */
const REFERENCE_PATTERN = /^[0-9a-f]{64}$/;

/**
 * One rung of the ladder a rung report is answered with, as the uploader reads it. The name and the topic are text
 * with something in it, and the sizes and bandwidths are finite numbers. A finished rung says where its recording is
 * the way a rung report does: a numeric `index` with its duration, or a `recording` reference with its duration, never
 * both. Every field is kept as sent.
 */
export const renditionAnswerRungSchema = z
  .looseObject({
    name: someText,
    width: z.number(),
    height: z.number(),
    topic: someText,
    bandwidth: z.number(),
    avgBandwidth: z.number(),
    index: anyNumber.optional(),
    recording: z.string().regex(REFERENCE_PATTERN).optional(),
    duration: anyNumber.optional(),
  })
  .refine((rung) =>
    rung.recording === undefined
      ? (rung.index === undefined) === (rung.duration === undefined)
      : rung.index === undefined && rung.duration !== undefined,
  );

export type RenditionAnswerRung = z.infer<typeof renditionAnswerRungSchema>;

/**
 * `POST /api/internal/streams/:id/renditions`, answered 200: the ladder the admin holds after merging one rung, as
 * the uploader reads it. The rungs and the ladder state must be there. The stream's status and the catalog write's
 * index are read when the body carries them as they should be and are null otherwise, never a refusal.
 */
export const renditionReportAnswerSchema = z
  .looseObject({
    renditions: z.array(renditionAnswerRungSchema),
    ladder: z.looseObject({
      finished: z.boolean(),
      flippedToFinished: z.boolean(),
      duration: z.custom<number | null>((value) => value === null || typeof value === 'number'),
    }),
    stream: z
      .looseObject({ status: z.string() })
      .transform((stream): string | null => stream.status)
      .catch(null),
    feed: z
      .looseObject({ index: z.number() })
      .transform((feed): number | null => feed.index)
      .catch(null),
  })
  .transform((answer) => ({
    renditions: answer.renditions,
    streamStatus: answer.stream,
    feedIndex: answer.feed,
    ladder: {
      finished: answer.ladder.finished,
      flippedToFinished: answer.ladder.flippedToFinished,
      duration: answer.ladder.duration,
    },
  }));

export type RenditionReportAnswer = z.infer<typeof renditionReportAnswerSchema>;

const publicConfigFeedOwnerSchema = z.looseObject({ feed: z.looseObject({ owner: someText }) });

/** `GET /api/config`: the address the admin signs its catalog feed with, or null when the body names none as text. */
export function feedOwnerOf(body: unknown): string | null {
  const read = publicConfigFeedOwnerSchema.safeParse(body);
  return read.success ? read.data.feed.owner : null;
}

/**
 * Whether two feed owners are one address. A key's address is printed as forty hex digits, and the admin's rows and
 * public config may carry a `0x` prefix, in either case, so both are compared without the prefix and without case.
 */
export function sameFeedOwner(left: string, right: string): boolean {
  return normaliseFeedOwner(left) === normaliseFeedOwner(right);
}

function normaliseFeedOwner(owner: string): string {
  return owner.trim().toLowerCase().replace(/^0x/, '');
}
