/**
 * Row → wire. The only place snake_case columns and `Date`s become the
 * camelCase, ISO-8601 shapes web2-admin-common declares.
 */
import type {
  IngestLookupResponse,
  PublishResult,
  RenditionReportResponse,
  Stream,
  User,
} from '@streaming-monorepo/web2-admin-common';

import type { RenditionReportOutcome } from '../domain/LadderService.js';
import type { PublishOutcome } from '../domain/PublishService.js';
import type { StreamRow, UserRow } from '../types/index.js';

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    isAdmin: row.is_admin,
    createdAt: row.created_at.toISOString(),
    passwordChangedAt: iso(row.password_changed_at),
    lastLoginAt: iso(row.last_login_at),
  };
}

export function toStream(row: StreamRow): Stream {
  return {
    id: row.id,
    topic: row.topic,
    owner: row.owner,
    title: row.title,
    description: row.description,
    tags: row.tags,
    mediaType: row.media_type,
    scheduledStartTime: iso(row.scheduled_start_time),
    hasThumbnail: row.has_thumbnail,
    thumbnailRef: row.thumbnail_ref,
    status: row.status,
    publishedAt: iso(row.published_at),
    publishedFeedIndex: row.published_feed_index,
    publishError: row.publish_error,
    manifestIndex: row.manifest_index,
    durationSeconds: row.duration_seconds,
    liveSince: iso(row.live_since),
    endedAt: iso(row.ended_at),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toPublishResult(outcome: PublishOutcome): PublishResult {
  return { stream: toStream(outcome.stream), feed: outcome.feed };
}

/**
 * The answer to a rendition report: the stream exactly as the state route
 * returns it, the merged ladder, where that ladder now stands, and the
 * catalogue write the report caused. The ladder rides beside the stream rather
 * than inside it — `Stream.renditions` is the console's field, filled in by a
 * later checkpoint, and the uploader reads this one.
 */
export function toRenditionReportResponse(
  outcome: RenditionReportOutcome,
): RenditionReportResponse {
  return {
    stream: toStream(outcome.publish.stream),
    renditions: outcome.renditions,
    ladder: outcome.ladder,
    feed: outcome.publish.feed,
  };
}

/**
 * What the uploader is told about a draft when an encoder connects. A subset
 * of the stream on purpose: enough to name the session and to check the `key=`
 * the encoder presented, and nothing else — this answer leaves the trusted
 * network the internal token protects.
 */
export function toIngestLookup(
  row: StreamRow,
  negotiatedLifecycle = false,
): IngestLookupResponse {
  const legacy = {
    id: row.id,
    topic: row.topic,
    owner: row.owner,
    mediaType: row.media_type,
    title: row.title,
    status: row.status,
    publishKey: row.publish_key,
  };
  if (!negotiatedLifecycle) return legacy;
  if (row.lifecycle_version !== 1) {
    return { ...legacy, lifecycleVersion: 1, mode: 'legacy' };
  }
  if (
    row.current_run_number === null ||
    row.lifecycle_state === null ||
    row.lifecycle_permission === null ||
    row.lifecycle_uploader_id === null
  ) {
    throw new Error(`Managed stream ${row.id} has no current run envelope`);
  }
  return {
    ...legacy,
    lifecycleVersion: 1,
    mode: 'managed',
    lifecycle: {
      revision: row.lifecycle_revision,
      runNumber: row.current_run_number,
      state: row.lifecycle_state,
      permission: row.lifecycle_permission,
      uploaderId: row.lifecycle_uploader_id,
    },
  };
}
