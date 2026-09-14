/**
 * The web2-admin HTTP contract. Backend implements it, frontend consumes it.
 * Every route is under /api. Errors are `{ error: string, ...fields }` with
 * `error` a snake_case code; yup failures are
 * `{ error: 'validation_error', errors: string[] }`.
 *
 * Field names on the wire are camelCase. Timestamps are ISO 8601 strings.
 */

export type MediaType = 'video' | 'audio';

/**
 * draft      never published, or unpublished again
 * publishing publish in progress (transient)
 * published  entry is in the stream list feed with state 'scheduled'
 * live/vod   reserved for checkpoint 3, when the uploader reports state back
 */
export type StreamStatus = 'draft' | 'publishing' | 'published' | 'live' | 'vod';

export const MEDIA_TYPES: readonly MediaType[] = ['video', 'audio'];
export const STREAM_STATUSES: readonly StreamStatus[] = [
  'draft',
  'publishing',
  'published',
  'live',
  'vod',
];

/** Limits copied from msrs-client so the two consoles feel the same. */
export const STREAM_LIMITS = {
  TITLE_MAX: 100,
  DESCRIPTION_MAX: 500,
  TAGS_MAX: 10,
  TAG_MAX_LENGTH: 20,
  THUMBNAIL_MAX_BYTES: 5 * 1024 * 1024,
} as const;

export interface User {
  id: string;
  username: string;
  createdAt: string;
  passwordChangedAt: string | null;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

/** GET /api/auth/me */
export interface MeResponse {
  user: User;
}

export interface Stream {
  id: string;
  /** Stream id inside the stream list feed; a UUID minted by the backend. */
  topic: string;
  /** Feed owner address (hex, no 0x) derived from the backend's feed key. */
  owner: string;
  title: string;
  description: string;
  tags: string[];
  mediaType: MediaType;
  scheduledStartTime: string | null;
  /** True when a thumbnail image is stored for this stream. */
  hasThumbnail: boolean;
  /** Swarm reference (hex) of the uploaded thumbnail, once published. */
  thumbnailRef: string | null;
  status: StreamStatus;
  publishedAt: string | null;
  /** Feed index of the last publication that included this stream. */
  publishedFeedIndex: number | null;
  publishError: string | null;
  /** Feed index of the final manifest, reported by the uploader when the stream ends. */
  manifestIndex?: number | null;
  /** Seconds, reported by the uploader when the stream ends. */
  durationSeconds?: number | null;
  /** When the uploader reported the stream live, and when it reported it ended. */
  liveSince?: string | null;
  endedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StreamInput {
  title: string;
  description: string;
  tags?: string[];
  mediaType: MediaType;
  scheduledStartTime: string | null;
}

/** GET /api/streams */
export interface StreamListResponse {
  streams: Stream[];
}

/**
 * What lands in the stream list feed for one stream. Field names follow
 * swarm-hls-stream's StreamEntry (note lowercase `mediatype`) and add the
 * metadata msrs-client had and swarm-hls-stream dropped.
 */
export interface FeedStreamEntry {
  owner: string;
  topic: string;
  title: string;
  description: string;
  tags: string[];
  state: 'scheduled' | 'live' | 'vod';
  mediatype: MediaType;
  /** Swarm reference hex of the thumbnail, or '' when there is none. */
  thumbnail: string;
  scheduledStartTime: string | null;
  /** ms since epoch, when this entry was last written. */
  timestamp: number;
  index?: number;
  duration?: number;
}

/** GET /api/streams/:id/feed and POST /api/streams/:id/publish */
export interface PublishResult {
  stream: Stream;
  feed: {
    owner: string;
    topic: string;
    /** Hex topic as it appears in bee URLs. */
    topicHex: string;
    index: number;
    entryCount: number;
  };
}

/** GET /api/config — public, unauthenticated. */
export interface PublicConfig {
  feed: {
    owner: string;
    topic: string;
    topicHex: string;
  };
  /** Base URL of the branded viewer, if configured, for "open in player" links. */
  viewerBaseUrl: string | null;
}

export interface ApiError {
  error: string;
  message?: string;
  errors?: string[];
}

/* ── Internal API: what the stream uploader calls ─────────────────────────
 * Routes under /api/internal, authenticated with `Authorization: Bearer
 * <INTERNAL_API_TOKEN>`, never with a session cookie. The uploader resolves a
 * draft when an encoder connects and reports state changes; the admin API
 * stays the only writer of the stream list feed.
 */

/** GET /api/internal/streams/by-ingest/:app/:stream (ingest stream id = `<app>/<stream>`) */
export interface IngestLookupResponse {
  id: string;
  topic: string;
  owner: string;
  mediaType: MediaType;
  title: string;
  status: StreamStatus;
  /** The per-stream key the encoder must present as `key=`. */
  publishKey: string;
}

/** POST /api/internal/streams/:id/state */
export interface StreamStateReport {
  state: 'live' | 'vod';
  /** Required with 'vod': feed index of the final manifest under the stream's topic. */
  index?: number;
  /** Seconds; with 'vod'. */
  duration?: number;
}

/** Response of POST /api/internal/streams/:id/state: the stream plus the feed write it caused. */
export type StreamStateResponse = PublishResult;
