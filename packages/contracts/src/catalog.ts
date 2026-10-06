import { z } from 'zod';

import { mediaTypeSchema } from './mediaType.js';

/**
 * The catalog is the list of broadcasts a viewer shows: one JSON array on a feed that the uploader, when it runs
 * without an admin, and the admin both rewrite whole. Each reader checks what it reads, and each keeps its own
 * reading, so there is one schema per reader here rather than one for the catalog.
 *
 * A finished broadcast says where its recording is in one of two ways. Writers on feeds name the feed `index` of the
 * final manifest. Writers on time windows upload the recording playlist once as bytes and name its reference in
 * `recording`, read with `GET /bytes/<recording>`. Readers take both until the last writer on feeds is gone.
 */

/** A rung of an entry's quality ladder as the viewer reads it: every number finite, and fields it does not know kept. */
export const viewerCatalogRungSchema = z.looseObject({
  name: z.string(),
  topic: z.string(),
  width: z.number(),
  height: z.number(),
  bandwidth: z.number(),
  avgBandwidth: z.number(),
  index: z.number().optional(),
  recording: z.string().optional(),
  duration: z.number().optional(),
});

/**
 * One entry as the viewer reads it. A state it does not know passes, and is shown as not live. The duration may be
 * text, and a scheduled start text or a number, as writers before this contract wrote them.
 */
export const viewerCatalogEntrySchema = z.looseObject({
  owner: z.string(),
  topic: z.string(),
  title: z.string(),
  timestamp: z.number(),
  mediatype: mediaTypeSchema,
  state: z.string().optional(),
  duration: z.union([z.string(), z.number()]).optional(),
  index: z.number().optional(),
  recording: z.string().optional(),
  thumbnail: z.string().optional(),
  scheduledStartTime: z.union([z.string(), z.number()]).nullable().optional(),
  renditions: z.array(viewerCatalogRungSchema).optional(),
});

/** The whole catalog as the viewer reads it, refused whole when any one entry is refused. */
export const viewerCatalogSchema = z.array(viewerCatalogEntrySchema);

const anyNumber = z.custom<number>((value) => typeof value === 'number');

/**
 * A rung as the admin reads it back off the catalog before it rewrites an entry: the six fields every rung carries,
 * each only of its kind, and an index or a duration of any number when present.
 */
export const adminFeedRungSchema = z.looseObject({
  name: z.string(),
  topic: z.string(),
  width: anyNumber,
  height: anyNumber,
  bandwidth: anyNumber,
  avgBandwidth: anyNumber,
  index: anyNumber.optional(),
  recording: z.string().optional(),
  duration: anyNumber.optional(),
});
