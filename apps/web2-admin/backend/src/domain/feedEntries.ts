import { isDeepStrictEqual } from 'node:util';

import type { FeedStreamEntry, Rendition, StreamStatus } from '@streaming-monorepo/web2-admin-common';

import type { StreamRow } from '../types/index.js';

import { asFeedOwner } from './feedIdentity.js';

import { isRendition } from './renditions.js';

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
export function upsertEntry(entries: unknown[], entry: FeedStreamEntry): unknown[] {
  const index = entries.findIndex((e) => sameId(e, entry.owner, entry.topic));
  if (index === -1) return [...entries, entry];

  const next = [...entries];
  next[index] = entry;
  return next;
}

/**
 * Whether the list already carries `entry` exactly as it would be written, apart from its `timestamp`, which only
 * says when the entry was last written. `upsertEntry` would then hand back the same list with a newer timestamp,
 * and a write of it would spend a slot on nothing. Compared as `planReconcile` compares a rebuilt entry, field by
 * field: an element without a timestamp, or with a field the rebuild has not, is not carried.
 */
export function carriesEntry(entries: unknown[], entry: FeedStreamEntry): boolean {
  const current = entries.find((e) => sameId(e, entry.owner, entry.topic));
  if (typeof current !== 'object' || current === null || !('timestamp' in current)) return false;
  return isDeepStrictEqual(current, { ...entry, timestamp: current.timestamp });
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
 * The list without any entry of ours for `entry`'s topic under another owner
 * than `entry`'s: what a failed publish may have left under the owner the row
 * had before its stage's key was rotated. An element under an owner that is
 * none of `ourOwners`, and anything that is not an entry, stays as it is.
 */
export function withoutTopicUnderOtherOwners(
  entries: unknown[],
  entry: Pick<FeedStreamEntry, 'owner' | 'topic'>,
  ourOwners: readonly string[],
): unknown[] {
  const ours = new Set(ourOwners.map(asFeedOwner));
  const keep = asFeedOwner(entry.owner);
  const topic = entry.topic.toLowerCase();
  return entries.filter((element) => {
    const owner = entryOwner(element);
    return !(entryTopic(element) === topic && owner !== null && owner !== keep && ours.has(owner));
  });
}

/**
 * The ladder the stream's entry carries on the list right now — what
 * `upsertEntry` is about to replace. Empty when the stream has no entry there
 * or its entry carries no `renditions`.
 *
 * Read rung by rung rather than cast: an element that names our `(owner,
 * topic)` is still only JSON somebody wrote. A ladder with a rung this backend
 * cannot read counts as no ladder at all. Of the two ways to be wrong about
 * what was there, that one costs a repeated `vod` report, which the state
 * route takes; the other costs a `vod` that is never sent.
 */
export function ladderOnFeed(entries: unknown[], owner: string, topic: string): Rendition[] {
  const entry = entries.find((e) => sameId(e, owner, topic));
  if (typeof entry !== 'object' || entry === null) return [];
  const renditions = (entry as { renditions?: unknown }).renditions;
  if (!Array.isArray(renditions)) return [];
  return renditions.every(isRendition) ? [...renditions] : [];
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
 * index of the final manifest, and how long it runs. An uploader on time
 * windows names the recording playlist by reference instead, and the entry
 * carries that as `recording` in place of `index`. They are written only for
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
    scheduledStartTime: stream.scheduled_start_time ? stream.scheduled_start_time.toISOString() : null,
    timestamp,
  };
  if (state === 'vod') {
    if (stream.manifest_index !== null) entry.index = stream.manifest_index;
    if (stream.recording_ref !== null) entry.recording = stream.recording_ref;
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

/** What a reconcile would do to the list, before anything is written. */
export interface ReconcilePlan {
  /** The repaired list. Identical to the base when `changed` is false. */
  entries: unknown[];
  /** Topics of our entries with no published row behind them. */
  removed: string[];
  /** Topics of published rows that were not on the list. */
  added: string[];
  /** Topics whose entry no longer matched its row. */
  updated: string[];
  changed: boolean;
}

/** The `topic` of an element of the list, when it has one at all. */
function entryTopic(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const topic = (value as { topic?: unknown }).topic;
  return typeof topic === 'string' ? topic.toLowerCase() : null;
}

function entryOwner(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const owner = (value as { owner?: unknown }).owner;
  return typeof owner === 'string' ? asFeedOwner(owner) : null;
}

/**
 * Diffs the catalogue against the database: what the list would have to say if
 * it were rebuilt from the rows right now.
 *
 * This is the repair path for what a stale feed read left behind — an entry
 * whose row was unpublished and then deleted, so nothing holds a `(owner,
 * topic)` that could ever take it off again, and a row that is `published`
 * while its entry was silently overwritten away.
 *
 * Three rules, in the order they are applied to each element:
 *
 *  - An element that is not ours — another publisher's entry, or something
 *    that is not an entry at all — is copied through byte for byte. The feed
 *    is a shared array; nothing here is allowed to prune it.
 *  - An entry of ours whose topic has no row in `rows` is dropped. `rows` is
 *    every row that *should* be on the catalogue (published, live or vod), so
 *    "no row" covers both a deleted stream and one that went back to draft.
 *  - An entry of ours whose row exists is rebuilt from that row. If the
 *    rebuild matches what is already there, the existing element is kept
 *    untouched — including its `timestamp`, so a clean catalogue is a no-op
 *    and costs no stamp.
 *
 * "Ours" is an entry whose owner is one of `ourOwners`: the brand key's, which
 * every entry older than stages carries, and each stage's, since a stream on a
 * stage is signed as that stage. Compared whatever the case and the `0x`.
 *
 * Rows with no entry are appended. A row whose owner is none of ours is
 * skipped: its entry would name an owner this admin does not publish under.
 *
 * `ladders` is each row's stored ABR rungs, by stream id, and it has to be
 * given for the rebuild to mean anything on a ladder stream: an entry rebuilt
 * from the row alone carries no `renditions`, so without it every ladder reads
 * as drifted and the "drift" written is the ladder coming off the catalogue.
 */
export function planReconcile(
  base: unknown[],
  rows: StreamRow[],
  ourOwners: readonly string[],
  now: number = Date.now(),
  ladders: ReadonlyMap<string, readonly Rendition[]> = new Map(),
): ReconcilePlan {
  const ours = new Set(ourOwners.map(asFeedOwner));
  const byTopic = new Map(rows.map((row) => [row.topic.toLowerCase(), row]));
  const seen = new Set<string>();

  const removed: string[] = [];
  const updated: string[] = [];
  const added: string[] = [];
  const entries: unknown[] = [];

  for (const element of base) {
    const topic = entryTopic(element);
    // Any element carrying a topic answers for that row, whoever wrote it, so
    // a row whose entry sits under a rotated key is not appended a second time.
    if (topic) seen.add(topic);

    const owner = entryOwner(element);
    if (owner === null || !ours.has(owner) || topic === null) {
      entries.push(element);
      continue;
    }

    const row = byTopic.get(topic);
    if (!row) {
      removed.push(topic);
      continue;
    }

    const timestamp = (element as FeedStreamEntry).timestamp;
    const rebuilt = buildFeedEntry(
      row,
      row.thumbnail_ref,
      typeof timestamp === 'number' ? timestamp : now,
      ladders.get(row.id) ?? [],
    );
    if (isDeepStrictEqual(element, rebuilt)) {
      entries.push(element);
      continue;
    }
    updated.push(topic);
    entries.push({ ...rebuilt, timestamp: now });
  }

  for (const row of rows) {
    if (seen.has(row.topic.toLowerCase())) continue;
    if (!ours.has(asFeedOwner(row.owner))) continue;
    added.push(row.topic);
    entries.push(buildFeedEntry(row, row.thumbnail_ref, now, ladders.get(row.id) ?? []));
  }

  return {
    entries,
    removed,
    added,
    updated,
    changed: removed.length + added.length + updated.length > 0,
  };
}
