import { z } from 'zod';

export const MEDIA_TYPE_VIDEO = 'video' as const;
export const MEDIA_TYPE_AUDIO = 'audio' as const;

export const MEDIA_TYPES = [MEDIA_TYPE_VIDEO, MEDIA_TYPE_AUDIO] as const;

/** What a stream carries. It is also the ingest application a broadcast is sent to. */
export type MediaType = (typeof MEDIA_TYPES)[number];

export const mediaTypeSchema = z.enum(MEDIA_TYPES);
