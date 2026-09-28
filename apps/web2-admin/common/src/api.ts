/**
 * The web2-admin HTTP contract. Backend implements it, frontend consumes it.
 * Every route is under /api. Errors are `{ error: string, ...fields }` with
 * `error` a snake_case code; yup failures are
 * `{ error: 'validation_error', errors: string[] }`.
 *
 * Field names on the wire are camelCase. Timestamps are ISO 8601 strings.
 */

import type { CatalogState, MediaType } from '@streaming-monorepo/contracts';

export { MEDIA_TYPES, type MediaType } from '@streaming-monorepo/contracts';

/**
 * draft      never published, or unpublished again. It may still hold the
 *            recording of an earlier broadcast, which the next publish lists
 *            as vod
 * publishing publish in progress (transient)
 * published  entry is in the stream list feed with state 'scheduled'
 * live/vod   reported by the uploader: the broadcast is running, or it has
 *            ended and manifestIndex says where its recording is
 */
export type StreamStatus = 'draft' | 'publishing' | 'published' | 'live' | 'vod';

export const STREAM_STATUSES: readonly StreamStatus[] = ['draft', 'publishing', 'published', 'live', 'vod'];

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
  /** May add and remove users and sign anyone out. */
  isAdmin: boolean;
  createdAt: string;
  passwordChangedAt: string | null;
  /** ISO, or null for a user who has never signed in. */
  lastLoginAt: string | null;
}

/** One row of the Access page's user table, as `GET /api/auth/users` answers it. */
export interface UserSummary {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  /** Open sessions this user currently has. */
  sessions: number;
}

export interface UserListResponse {
  users: UserSummary[];
}

export interface AddUserRequest {
  username: string;
  password: string;
  /** Defaults to false. The first user ever added is an admin regardless. */
  admin?: boolean;
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
  /** Null only on a row created before a schedule was required. */
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
  /**
   * True while the console holds an edit this stream's catalogue entry does
   * not carry: its title, description, tags, media type, scheduled start or
   * thumbnail changed after the last write that rebuilt the entry from the
   * stream. A publish or republish clears it, and so do the uploader's state
   * and rendition reports, because each of those rebuilds the entry too. A
   * reconcile clears it as well, except on a stream whose new image is still
   * waiting to be uploaded, because a reconcile uploads nothing. The
   * uploader's reports never set it. Always false for a stream that is not on
   * the catalogue.
   */
  hasUnpublishedEdits: boolean;
  /**
   * The merged ABR ladder, when the uploader has reported rungs for this
   * stream. Absent for a single-rendition stream, and absent from the console's
   * stream routes for now: `POST /api/internal/streams/:id/renditions` is the
   * only answer that carries the ladder, and a later checkpoint surfaces it on
   * the console's own responses.
   */
  renditions?: Rendition[];
  /**
   * The stage the stream is broadcast on (`GET /api/stages` names it), or
   * null until one is picked. A draft needs one to be published. It changes
   * only while the stream is a draft, and a stream that holds a recording
   * keeps the one it has.
   */
  stageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StreamInput {
  title: string;
  description: string;
  tags?: string[];
  mediaType: MediaType;
  /** Required: a stream is a promise to viewers about when it starts. */
  scheduledStartTime: string;
  /**
   * The stage to broadcast on: one that is not retired and is supported, or
   * null for none. Absent leaves the stream's stage as it is. A change is
   * refused with 409 `stage_locked` once the stream is not a draft, or while
   * it holds a recording and a stage, and a stage that cannot take streams
   * with 409 `stage_unavailable`.
   */
  stageId?: string | null;
}

/** GET /api/streams */
export interface StreamListResponse {
  streams: Stream[];
}

/**
 * One rung of an ABR ladder: a rendition the uploader publishes as its own
 * manifest feed, signed by the same owner as the master. Field names and
 * semantics are swarm-hls-stream's `Rendition`, verbatim, because the same
 * objects ride on the catalogue entry the viewer reads.
 */
export interface Rendition {
  /** Rung name, e.g. '720p'. Letters, digits, '.' and '-' only (no '_'). */
  name: string;
  width: number;
  height: number;
  /** The rung's own manifest feed raw topic; a UUID, signed by the same owner. */
  topic: string;
  /** Peak observed segment bitrate, bits/s. HLS BANDWIDTH. */
  bandwidth: number;
  /** Mean bitrate, bits/s. HLS AVERAGE-BANDWIDTH. */
  avgBandwidth: number;
  /** Set once the rung finalized: feed index of its VOD manifest in `topic`. */
  index?: number;
  /** Set with `index`: recording length in seconds. */
  duration?: number;
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
  state: CatalogState;
  mediatype: MediaType;
  /** Swarm reference hex of the thumbnail, or '' when there is none. */
  thumbnail: string;
  /** Null only on a row created before a schedule was required. */
  scheduledStartTime: string | null;
  /** ms since epoch, when this entry was last written. */
  timestamp: number;
  index?: number;
  duration?: number;
  /**
   * Both present only for a stream whose uploader publishes an ABR ladder, and
   * both absent otherwise. `group` equals the stream's `topic`: in admin mode
   * the declared topic *is* the master playlist's feed, and the rungs listed in
   * `renditions` (ascending by height) each have a feed of their own under the
   * same owner. Field names mirror swarm-hls-stream's `StreamEntry` and
   * `Rendition`, so its viewer reads this entry unchanged.
   */
  group?: string;
  renditions?: Rendition[];
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

/**
 * POST /api/feed/reconcile — rewrites the stream list feed from the database.
 *
 * The repair path for a catalogue entry no request can reach: one whose stream
 * was unpublished and then deleted, so nothing holds the `(owner, topic)` that
 * would remove it. Entries written by anyone else are left untouched.
 *
 * `index` is the feed index of the repair write, or null when the catalogue
 * already matched the database and nothing was written. The three arrays are
 * stream topics.
 */
export interface FeedReconcileResult {
  index: number | null;
  /** Entries dropped: on the feed, no published stream behind them. */
  removed: string[];
  /** Entries added: published streams that were missing from the feed. */
  added: string[];
  /** Entries rewritten because they no longer matched their stream. */
  updated: string[];
  /** How many elements the feed holds now. */
  entryCount: number;
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

/**
 * POST /api/internal/streams/:id/state
 *
 * `live` may follow `vod`: a broadcast goes live again on the same feeds, and
 * that report clears the recording the stream last listed, rungs included.
 */
export interface StreamStateReport {
  state: 'live' | 'vod';
  /** Required with 'vod': feed index of the final manifest under the stream's topic. */
  index?: number;
  /** Seconds; with 'vod'. */
  duration?: number;
}

/** Response of POST /api/internal/streams/:id/state: the stream plus the feed write it caused. */
export type StreamStateResponse = PublishResult;

/**
 * POST /api/internal/streams/:id/renditions — one rung of an ABR ladder,
 * reported by the uploader as that rung starts delivering and again when it
 * finalizes (then carrying `index` and `duration`, both or neither).
 *
 * The admin merges the report into what it already stores for `(stream, name)`,
 * writes the merged ladder onto the catalogue entry, and answers with the
 * ladder as it now stands. It never moves the stream's status from a rendition
 * report: `live` and `vod` still come from POST /state.
 */
export type RenditionReport = Rendition;

/** Response of POST /api/internal/streams/:id/renditions. */
export interface RenditionReportResponse {
  stream: Stream;
  /** The merged ladder after this report, ascending by height. */
  renditions: Rendition[];
  ladder: {
    /** At least one rung, and every rung has an index. */
    finished: boolean;
    /** Finished now and not before this report — the uploader's cue to report `vod`. */
    flippedToFinished: boolean;
    /** Longest rung when finished, else null. Seconds. */
    duration: number | null;
  };
  /** The catalogue write this report caused. */
  feed: PublishResult['feed'];
}
