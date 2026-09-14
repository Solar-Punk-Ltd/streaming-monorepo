import {
  MEDIA_TYPES,
  STREAM_LIMITS,
  type MediaType,
} from '@streaming-monorepo/web2-admin-common';
import { InferType, array, object, string } from 'yup';

export const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Tags are trimmed and deduplicated before the element rules run, so the
 * stored value is exactly what was accepted: `.max` counts distinct tags, and
 * a whitespace-only tag fails the per-element `min(1)` instead of being stored
 * as an empty chip.
 */
const tagsField = () =>
  array()
    .of(
      string()
        .required()
        .trim()
        .min(1)
        .max(
          STREAM_LIMITS.TAG_MAX_LENGTH,
          `each tag must be at most ${STREAM_LIMITS.TAG_MAX_LENGTH} characters`,
        ),
    )
    .transform((value: unknown) =>
      Array.isArray(value)
        ? [...new Set(value.map((v) => (typeof v === 'string' ? v.trim() : v)))]
        : value,
    )
    .max(STREAM_LIMITS.TAGS_MAX, `at most ${STREAM_LIMITS.TAGS_MAX} tags`)
    .default([]);

const scheduledStartTimeField = () =>
  string()
    .nullable()
    .default(null)
    .test(
      'iso-date-time',
      'scheduledStartTime must be an ISO 8601 date-time or null',
      (value) => value == null || !Number.isNaN(Date.parse(value)),
    );

export const streamInputSchema = object({
  title: string()
    .required()
    .trim()
    .min(1)
    .max(
      STREAM_LIMITS.TITLE_MAX,
      `title must be at most ${STREAM_LIMITS.TITLE_MAX} characters`,
    ),
  description: string()
    .required()
    .trim()
    .min(1)
    .max(
      STREAM_LIMITS.DESCRIPTION_MAX,
      `description must be at most ${STREAM_LIMITS.DESCRIPTION_MAX} characters`,
    ),
  tags: tagsField(),
  mediaType: string<MediaType>()
    .required()
    .oneOf([...MEDIA_TYPES], `mediaType must be one of ${MEDIA_TYPES.join(', ')}`),
  scheduledStartTime: scheduledStartTimeField(),
}).noUnknown(true);

export type StreamInputBody = InferType<typeof streamInputSchema>;

export const streamIdParamSchema = object({
  id: string().required().matches(UUID_RE, 'id must be a UUID'),
}).strict();
