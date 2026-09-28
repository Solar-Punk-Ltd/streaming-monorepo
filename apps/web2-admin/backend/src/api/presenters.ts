/**
 * Row → wire. The only place snake_case columns and `Date`s become the
 * camelCase, ISO-8601 shapes web2-admin-common declares.
 */
import type {
  CatalogueStampSummary,
  IngestLookupResponse,
  PublishResult,
  RenditionReportResponse,
  StageSummary,
  Stream,
  User,
} from '@streaming-monorepo/web2-admin-common';

import type { RenditionReportOutcome } from '../domain/LadderService.js';
import type { PublishOutcome } from '../domain/PublishService.js';
import { hasUnpublishedEdits } from '../domain/unpublishedEdits.js';
import type { CatalogueStampRow, StageRow, StreamRow, UserRow } from '../types/index.js';

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
    hasUnpublishedEdits: hasUnpublishedEdits(row),
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
export function toRenditionReportResponse(outcome: RenditionReportOutcome): RenditionReportResponse {
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
export function toIngestLookup(row: StreamRow): IngestLookupResponse {
  return {
    id: row.id,
    topic: row.topic,
    owner: row.owner,
    mediaType: row.media_type,
    title: row.title,
    status: row.status,
    publishKey: row.publish_key,
  };
}

/**
 * A stage as the console lists it. Built field by field from the row, which carries neither the passphrase nor the
 * token hash, so a field a newer record adds reaches the console only once it is named here.
 */
export function toStageSummary(row: StageRow): StageSummary {
  const { record } = row;
  return {
    stageId: row.stage_id,
    name: row.name,
    kind: row.kind,
    engine: row.engine,
    supported: row.engine === 'srs',
    stackVersion: record.stackVersion,
    status: record.status,
    owner: row.owner,
    ingest: {
      host: record.ingest.host,
      srtPort: record.ingest.srtPort,
      rtmpPort: record.ingest.rtmpPort,
      rtmpPublic: record.ingest.rtmpPublic,
      hasSrtPassphrase: row.has_srt_passphrase,
    },
    rungs: record.rungs.map((rung) => ({
      name: rung.name,
      stamp: rung.stamp
        ? {
            batchId: rung.stamp.batchId,
            state: rung.stamp.state,
            ttlSeconds: rung.stamp.ttlSeconds,
            fillRatio: rung.stamp.fillRatio,
            immutable: rung.stamp.immutable,
          }
        : null,
      chequebook: rung.chequebook
        ? { health: rung.chequebook.health, availableBzz: rung.chequebook.availableBzz }
        : null,
    })),
    uploader: record.uploader ? { state: record.uploader.state, reasons: [...record.uploader.reasons] } : null,
    readiness: { tone: record.readiness.tone, reasons: [...record.readiness.reasons] },
    observedAt: row.observed_at.toISOString(),
    receivedAt: row.received_at.toISOString(),
    retiredAt: iso(row.retired_at),
  };
}

/** The catalogue stamp as the console shows it: everything but the Bee API address the admin dials. */
export function toCatalogueStampSummary(row: CatalogueStampRow): CatalogueStampSummary {
  const { record } = row;
  return {
    nodeName: record.nodeName,
    batchId: row.batch_id,
    immutable: record.immutable,
    depth: record.depth,
    state: record.state,
    ttlSeconds: record.ttlSeconds,
    fillRatio: record.fillRatio,
    designatedAt: record.designatedAt,
    observedAt: row.observed_at.toISOString(),
    receivedAt: row.received_at.toISOString(),
  };
}
