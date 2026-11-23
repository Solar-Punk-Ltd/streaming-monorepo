import {
  RECORDING_CHECK_ROUNDS,
  type RecordingJudgeInput,
  type RecordingReadings,
} from '@streaming-monorepo/web2-admin-common';

import type { StreamRenditionRow, StreamRow } from '../../types/index.js';
import { parseRecordingPlaylist } from '../export/playlist.js';
import { BeeRecordingSource, type ReadNode, type RecordingFeed } from '../export/RecordingSource.js';
import { restartUntilOf } from '../StreamFinishService.js';

/**
 * How a check of the recordings reads one recording through the catalogue node: its own playlist, the master
 * playlist of a ladder, and each quality's playlist and first segment. `docs/architecture/web2-admin.md`, "Lost
 * recordings".
 */

/** The name a stream with no ladder gives its one quality, itself. */
export const SOURCE_QUALITY = 'source';

/** One recording as a check reads it: its own playlist, and each quality's playlist. */
export interface RecordingParts {
  master: RecordingFeed;
  /** Each quality by name. A stream with no ladder has one, itself, on the master's feed. */
  qualities: { name: string; feed: RecordingFeed }[];
}

/**
 * Where a stream's recording is, or null when it holds none: no finished recording on its row. A ladder's qualities
 * are the rungs that finished; a rung that stopped without a recording is not one.
 */
export function recordingPartsOf(stream: StreamRow, rungs: readonly StreamRenditionRow[]): RecordingParts | null {
  if (stream.manifest_index === null) return null;
  const master = { owner: stream.owner, topic: stream.topic, index: stream.manifest_index };
  if (rungs.length === 0) return { master, qualities: [{ name: SOURCE_QUALITY, feed: master }] };
  const qualities = [...rungs]
    .filter((rung) => rung.manifest_index !== null)
    .sort((a, b) => b.height - a.height)
    .map((rung) => ({
      name: rung.name,
      feed: { owner: stream.owner, topic: rung.topic, index: rung.manifest_index! },
    }));
  return { master, qualities };
}

/** How a check reads through the catalogue node: Bee in production, a fake in the tests. */
export interface RecordingReads {
  /** A playlist from its feed slot, whole; throws when it cannot be read. */
  playlist(node: ReadNode, feed: RecordingFeed): Promise<string>;
  /** The start of a segment; throws when the node gives none of it. */
  segment(node: ReadNode, reference: string): Promise<void>;
  /** How many peers the node is connected to; throws when it does not answer. */
  peers(node: ReadNode): Promise<number>;
}

/** How much of a segment a read takes: enough to show the node holds its first chunks. */
const SEGMENT_READ_BYTES = 64 * 1024;

/** How long a segment's start and the peers may take before the node counts as not answering. */
const SEGMENT_READ_TIMEOUT_MS = 60_000;
const PEERS_TIMEOUT_MS = 5_000;

function apiUrl(node: ReadNode, path: string): string {
  return `${node.beeApiUrl.replace(/\/+$/, '')}${path}`;
}

/**
 * The real thing. A playlist is read as the export reads it (`BeeRecordingSource`); a segment's first 64 KiB from
 * `/bytes/<reference>`; the peers from `/peers`.
 */
export class BeeRecordingReads implements RecordingReads {
  private readonly source = new BeeRecordingSource();

  playlist(node: ReadNode, feed: RecordingFeed): Promise<string> {
    return this.source.readPlaylist(node, feed);
  }

  async segment(node: ReadNode, reference: string): Promise<void> {
    const response = await fetch(apiUrl(node, `/bytes/${reference}`), {
      signal: AbortSignal.timeout(SEGMENT_READ_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`the node answered ${response.status} for segment ${reference.slice(0, 12)}…`);
    }
    const reader = response.body.getReader();
    let received = 0;
    try {
      while (received < SEGMENT_READ_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (received === 0) throw new Error(`the node answered an empty segment ${reference.slice(0, 12)}…`);
  }

  async peers(node: ReadNode): Promise<number> {
    const response = await fetch(apiUrl(node, '/peers'), { signal: AbortSignal.timeout(PEERS_TIMEOUT_MS) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`the node answered ${response.status} for its peers`);
    }
    const body = (await response.json()) as { peers?: unknown };
    return Array.isArray(body.peers) ? body.peers.length : 0;
  }
}

/** Readings with nothing read yet. */
export function noReadings(parts: RecordingParts | null): RecordingReadings {
  return { master: [], qualities: (parts?.qualities ?? []).map((quality) => ({ name: quality.name, rounds: [] })) };
}

/** Whether a part still needs reading: nothing read of it yet, or its last reading failed. */
function unread(rounds: readonly boolean[]): boolean {
  return rounds.length === 0 || rounds[rounds.length - 1] === false;
}

/** Whether a recording has a part a further round would read: one whose last reading failed, or never read. */
export function stillUnread(readings: RecordingReadings): boolean {
  return unread(readings.master) || readings.qualities.some((quality) => unread(quality.rounds));
}

/**
 * One round of a recording: every part not yet read is read once, and its result added to its rounds; a part that
 * read before is skipped, so its list ends in true. A quality is its playlist, then the first segment that playlist
 * names. A playlist the master and a quality share, as a stream with no ladder's, is read once a round.
 */
export async function readRecordingRound(
  reads: RecordingReads,
  node: ReadNode,
  parts: RecordingParts,
  before: RecordingReadings,
): Promise<RecordingReadings> {
  const playlists = new Map<string, Promise<string>>();
  const playlistOf = (feed: RecordingFeed): Promise<string> => {
    const key = `${feed.owner}:${feed.topic}:${feed.index}`;
    let read = playlists.get(key);
    if (!read) {
      read = reads.playlist(node, feed);
      playlists.set(key, read);
    }
    return read;
  };
  const attempt = async (read: () => Promise<unknown>): Promise<boolean> => {
    try {
      await read();
      return true;
    } catch {
      return false;
    }
  };

  const master = unread(before.master)
    ? [...before.master, await attempt(() => playlistOf(parts.master))]
    : [...before.master];
  const qualities: { name: string; rounds: boolean[] }[] = [];
  for (const quality of parts.qualities) {
    const rounds = before.qualities.find((known) => known.name === quality.name)?.rounds ?? [];
    if (!unread(rounds)) {
      qualities.push({ name: quality.name, rounds: [...rounds] });
      continue;
    }
    const read = await attempt(async () => {
      const playlist = parseRecordingPlaylist(await playlistOf(quality.feed));
      const first = playlist.segments[0];
      if (!first) throw new Error('the playlist names no segment');
      await reads.segment(node, first.reference);
    });
    qualities.push({ name: quality.name, rounds: [...rounds, read] });
  }
  return { master, qualities };
}

/**
 * Whether one read, the removal's read once more, finds the recording lost: its master playlist failed, or every
 * quality did. One that reads in part is not lost by it.
 */
export function lostInOneRead(readings: RecordingReadings): boolean {
  const last = (rounds: readonly boolean[]) => rounds[rounds.length - 1];
  if (last(readings.master) === false) return true;
  return readings.qualities.length > 0 && readings.qualities.every((quality) => last(quality.rounds) === false);
}

/** The qualities that failed in every round, by name. */
export function failedQualitiesOf(readings: RecordingReadings): string[] {
  return readings.qualities
    .filter((quality) => quality.rounds.length >= RECORDING_CHECK_ROUNDS && quality.rounds.every((read) => !read))
    .map((quality) => quality.name);
}

/**
 * Whether a removal kept the stream as a draft off the catalogue for its export file, at `unlistedAt`, and it has not
 * changed since: still a draft, still marked lost, and its row not updated after that removal. Going live, a publish
 * and an edit each change it, and a check judges it again.
 */
export function stillUnlisted(stream: StreamRow, unlistedAt: Date | undefined): boolean {
  return (
    unlistedAt !== undefined &&
    stream.status === 'draft' &&
    stream.recording_verdict === 'lost' &&
    stream.updated_at.getTime() <= unlistedAt.getTime()
  );
}

/**
 * What the one rule, `recordingSkipReason`, reads of a stream: its status, its restart window as the stream list
 * shows it, whether an export or an archive of it is under way, whether it is a test stream, which a check never
 * judges and a removal never touches, and whether a removal kept it as a draft for its export file and it has not
 * changed since (`unlistedAt`, by stream id).
 */
export function recordingJudgeInputOf(
  stream: StreamRow,
  openJobs: ReadonlySet<string>,
  restartWindowMinutes: number,
  unlistedAt: ReadonlyMap<string, Date>,
): RecordingJudgeInput {
  return {
    status: stream.status,
    restartUntil: restartUntilOf(stream, restartWindowMinutes)?.toISOString() ?? null,
    hasOpenJob: openJobs.has(stream.id),
    test: stream.test,
    unlisted: stillUnlisted(stream, unlistedAt.get(stream.id)),
  };
}
