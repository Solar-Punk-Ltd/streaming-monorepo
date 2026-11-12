import { MEDIA_TYPES, STREAM_LIMITS, type MediaType } from '@streaming-monorepo/web2-admin-common';
import { InferType, array, object, string } from 'yup';

export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

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
        .max(STREAM_LIMITS.TAG_MAX_LENGTH, `each tag must be at most ${STREAM_LIMITS.TAG_MAX_LENGTH} characters`),
    )
    .transform((value: unknown) =>
      Array.isArray(value) ? [...new Set(value.map((v) => (typeof v === 'string' ? v.trim() : v)))] : value,
    )
    .max(STREAM_LIMITS.TAGS_MAX, `at most ${STREAM_LIMITS.TAGS_MAX} tags`)
    .default([]);

const isHttpsAddress = (value: string): boolean => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * The stream's links, each a label and an https address, both trimmed. Only
 * https is taken because a viewer renders the address as a link: `http` would
 * be mixed content on a page served over https, and any other scheme is not a
 * page at all.
 *
 * Absent leaves the stream's links as they are, as an absent stage does, so a
 * client that does not know about links cannot clear them. An empty list
 * clears them.
 */
const linksField = () =>
  array()
    .of(
      object({
        label: string()
          .required('each link needs a label')
          .trim()
          .max(
            STREAM_LIMITS.LINK_LABEL_MAX,
            `each link label must be at most ${STREAM_LIMITS.LINK_LABEL_MAX} characters`,
          ),
        href: string()
          .required('each link needs an address')
          .trim()
          .max(
            STREAM_LIMITS.LINK_HREF_MAX,
            `each link address must be at most ${STREAM_LIMITS.LINK_HREF_MAX} characters`,
          )
          .test(
            'https-address',
            'each link address must start with https://',
            // An empty address is the required rule's to refuse, once.
            (value) => !value || isHttpsAddress(value),
          ),
      }).noUnknown(true),
    )
    .max(STREAM_LIMITS.LINKS_MAX, `at most ${STREAM_LIMITS.LINKS_MAX} links`)
    .optional();

/**
 * Every stream carries a scheduled start: it is the promise the catalogue
 * entry makes to viewers, and a row without one cannot be edited through the
 * console at all. Missing, null and '' are all the same refusal.
 */
const scheduledStartTimeField = () =>
  string()
    .required('scheduledStartTime is required and must be an ISO 8601 date-time')
    .test(
      'iso-date-time',
      'scheduledStartTime is required and must be an ISO 8601 date-time',
      (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)),
    );

/**
 * The stage the stream is broadcast on: a UUID, kept in lower case as the
 * stages table keeps it, or null for none. Absent leaves the stream's stage as
 * it is, so a client that does not know about stages cannot clear one. Whether
 * the stage takes streams, and whether this stream may change stage, is the
 * service's to say.
 */
const stageIdField = () =>
  string()
    .nullable()
    .optional()
    .transform((value: unknown) => (typeof value === 'string' ? value.toLowerCase() : value))
    .matches(UUID_RE, { message: 'stageId must be a UUID', excludeEmptyString: false });

export const streamInputSchema = object({
  title: string()
    .required()
    .trim()
    .min(1)
    .max(STREAM_LIMITS.TITLE_MAX, `title must be at most ${STREAM_LIMITS.TITLE_MAX} characters`),
  description: string()
    .required()
    .trim()
    .min(1)
    .max(STREAM_LIMITS.DESCRIPTION_MAX, `description must be at most ${STREAM_LIMITS.DESCRIPTION_MAX} characters`),
  tags: tagsField(),
  links: linksField(),
  mediaType: string<MediaType>()
    .required()
    .oneOf([...MEDIA_TYPES], `mediaType must be one of ${MEDIA_TYPES.join(', ')}`),
  scheduledStartTime: scheduledStartTimeField(),
  stageId: stageIdField(),
}).noUnknown(true);

export type StreamInputBody = InferType<typeof streamInputSchema>;

export const streamIdParamSchema = object({
  id: string().required().matches(UUID_RE, 'id must be a UUID'),
}).strict();
