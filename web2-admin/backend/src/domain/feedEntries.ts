import type {
  FeedStreamEntry,
  Rendition,
  StreamStatus,
} from '@streaming-monorepo/web2-admin-common';

import type { StreamRow } from '../types/index.js';

/**
 * The stream list feed is a JSON array that everything on it rewrites whole.
 * These helpers touch exactly the one entry a stream owns and leave every
 * other element of the array — including entries written by another publisher,
 * and elements that are not entries at all — byte-identical.
 */
function sameId(value: unknown, owner: string, topic: string): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { owner?: unknown; topic?: unknown };
  return (
    typeof candidate.owner === 'string' &&
    typeof candidate.topic === 'string' &&
    candidate.owner.toLowerCase() === owner.toLowerCase() &&
    candidate.topic.toLowerCase() === topic.toLowerCase()
  );
}

/** Replaces the stream's entry in place, or appends it when it is not there. */
export function upsertEntry(
  entries: unknown[],
  entry: FeedStreamEntry,
): unknown[] {
  const index = entries.findIndex((e) => sameId(e, entry.owner, entry.topic));
  if (index === -1) return [...entries, entry];

  const next = [...entries];
  next[index] = entry;
  return next;
}

export function removeEntry(
  entries: unknown[],
  owner: string,
  topic: string,
): { entries: unknown[]; removed: boolean } {
  const kept = entries.filter((e) => !sameId(e, owner, topic));
  return { entries: kept, removed: kept.length !== entries.length };
}

/**
 * The entry's `state` is the row's status, narrowed to the three values the
 * viewer knows. Everything this backend does on its own — a draft claimed into
 * `publishing`, a published stream nobody has streamed yet — is an
 * announcement, so it is `scheduled`. `live` and `vod` only ever come from the
 * uploader's report, which has already been written to the row by the time an
 * entry is built from it.
 */
export function feedEntryState(status: StreamStatus): FeedStreamEntry['state'] {
  if (status === 'live') return 'live';
  if (status === 'vod') return 'vod';
  return 'scheduled';
}

/**
 * What a stream looks like on the feed. Field names follow swarm-hls-stream's
 * StreamEntry (hence lowercase `mediatype`); the metadata columns msrs-client
 * had and swarm-hls-stream dropped ride alongside.
 *
 * `index` and `duration` are what a viewer needs to play a recording: the feed
 * index of the final manifest, and how long it runs. They are written only for
 * a `vod` entry and only once the uploader has reported them — an entry that
 * carries neither is a live or scheduled stream, exactly as swarm-hls-stream's
 * reader expects.
 *
 * `renditions` is the stream's ABR ladder, and `group` the topic its master
 * playlist is published under — which in admin mode is the stream's own topic,
 * because the admin declares it and the uploader publishes the master there.
 * Both are written only when the uploader has reported at least one rung, so a
 * single-rendition stream's entry is byte-identical to what it was before the
 * ladder existed.
 */
export function buildFeedEntry(
  stream: StreamRow,
  thumbnailRef: string | null,
  timestamp: number,
  renditions: readonly Rendition[] = [],
): FeedStreamEntry {
  const state = feedEntryState(stream.status);
  const entry: FeedStreamEntry = {
    owner: stream.owner,
    topic: stream.topic,
    title: stream.title,
    description: stream.description,
    tags: stream.tags,
    state,
    mediatype: stream.media_type,
    thumbnail: thumbnailRef ?? '',
    scheduledStartTime: stream.scheduled_start_time
      ? stream.scheduled_start_time.toISOString()
      : null,
    timestamp,
  };
  if (state === 'vod') {
    if (stream.manifest_index !== null) entry.index = stream.manifest_index;
    if (stream.duration_seconds !== null) {
      entry.duration = stream.duration_seconds;
    }
  }
  if (renditions.length > 0) {
    entry.group = stream.topic;
    entry.renditions = [...renditions];
  }
  return entry;
}
