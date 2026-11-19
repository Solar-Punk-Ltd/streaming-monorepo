/**
 * In-memory stand-ins for what checking the recordings reads and writes: `recording_checks` and its streams with the
 * same conditional updates the SQL makes, a node whose playlists, segments and peers a test sets, and the catalogue
 * write of a removal. The integration suite `recordingChecks.test.ts` holds the SQL to the same answers.
 */
import type { RecordingReadings, StreamStatus } from '@streaming-monorepo/web2-admin-common';

import type { Actor } from '../../../src/domain/actor.js';
import type { ReadNode, RecordingFeed } from '../../../src/domain/export/RecordingSource.js';
import type {
  RecordingCheckRow,
  RecordingCheckStore,
  RecordingCheckStreamRow,
  RecordingRemoval,
  StreamVerdict,
} from '../../../src/domain/recordings/RecordingCheckRepository.js';
import type { LostRecordingsCatalogueWrite } from '../../../src/domain/recordings/RecordingCheckService.js';
import type { RecordingReads } from '../../../src/domain/recordings/recordingReads.js';

/** `recording_checks` and `recording_check_streams`, and the verdict each finished check left on a stream's row. */
export class InMemoryRecordingCheckStore implements RecordingCheckStore {
  readonly checks: (RecordingCheckRow & { rows: RecordingCheckStreamRow[] })[] = [];
  /** `streams.recording_verdict`, by stream id. */
  readonly marks = new Map<string, 'lost' | 'partly_lost'>();
  /** The streams the store treats as live when a check finishes, as the SQL reads `streams.status`. */
  liveStreams = new Set<string>();

  async latest(): Promise<RecordingCheckRow | null> {
    const last = this.checks.at(-1);
    return last ? this.copy(last) : null;
  }

  async create(check: {
    id: string;
    startedBy: string;
    startedByUserId: string | null;
    unjudged: number;
    streams: readonly { streamId: string; title: string; status: StreamStatus }[];
  }): Promise<RecordingCheckRow | null> {
    if (this.checks.some((one) => one.state === 'running')) return null;
    const row = {
      id: check.id,
      state: 'running' as const,
      stopMessage: null,
      round: 1,
      nextRoundAt: null,
      unjudged: check.unjudged,
      startedBy: check.startedBy,
      startedAt: new Date(),
      finishedAt: null,
      rows: check.streams.map((stream) => ({
        ...stream,
        readings: { master: [], qualities: [] },
        verdict: null,
        hasExportFile: false,
        removal: null,
        keptReason: null,
        removedAt: null,
      })),
    };
    this.checks.push(row);
    return this.copy(row);
  }

  async streams(checkId: string): Promise<RecordingCheckStreamRow[]> {
    const check = this.find(checkId);
    return check ? structuredClone([...check.rows].sort((a, b) => a.title.localeCompare(b.title))) : [];
  }

  async recordReadings(checkId: string, streamId: string, readings: RecordingReadings): Promise<void> {
    const row = this.find(checkId)?.rows.find((one) => one.streamId === streamId);
    if (row) row.readings = structuredClone(readings);
  }

  async recordRound(checkId: string, round: number, nextRoundAt: Date | null): Promise<RecordingCheckRow | null> {
    const check = this.find(checkId);
    if (!check || check.state !== 'running') return null;
    Object.assign(check, { round, nextRoundAt });
    return this.copy(check);
  }

  async finish(
    checkId: string,
    verdicts: readonly StreamVerdict[],
    unjudged: number,
  ): Promise<RecordingCheckRow | null> {
    const check = this.find(checkId);
    if (!check || check.state !== 'running') return null;
    Object.assign(check, { state: 'done', unjudged, nextRoundAt: null, finishedAt: new Date() });
    for (const given of verdicts) {
      const row = check.rows.find((one) => one.streamId === given.streamId);
      if (row) Object.assign(row, { verdict: given.verdict, hasExportFile: given.hasExportFile });
      if (given.verdict === null || this.liveStreams.has(given.streamId)) continue;
      if (given.verdict === 'readable') this.marks.delete(given.streamId);
      else this.marks.set(given.streamId, given.verdict);
    }
    return this.copy(check);
  }

  async stop(checkId: string, message: string): Promise<RecordingCheckRow | null> {
    const check = this.find(checkId);
    if (!check || check.state !== 'running') return null;
    Object.assign(check, { state: 'stopped', stopMessage: message, nextRoundAt: null, finishedAt: new Date() });
    return this.copy(check);
  }

  async stopRunning(message: string): Promise<RecordingCheckRow[]> {
    const stopped: RecordingCheckRow[] = [];
    for (const check of this.checks.filter((one) => one.state === 'running')) {
      stopped.push((await this.stop(check.id, message))!);
    }
    return stopped;
  }

  async recordRemoval(
    checkId: string,
    streamId: string,
    removal: RecordingRemoval,
    keptReason: string | null,
  ): Promise<void> {
    const row = this.find(checkId)?.rows.find((one) => one.streamId === streamId);
    if (!row || row.removal !== null) return;
    Object.assign(row, { removal, keptReason: removal === 'kept' ? keptReason : null, removedAt: new Date() });
  }

  async clearVerdict(streamId: string): Promise<void> {
    this.marks.delete(streamId);
  }

  async unlisted(): Promise<{ streamId: string; removedAt: Date }[]> {
    const latest = new Map<string, Date>();
    for (const row of this.checks.flatMap((check) => check.rows)) {
      if (row.removal !== 'unlisted' || !row.removedAt) continue;
      const known = latest.get(row.streamId);
      if (!known || known < row.removedAt) latest.set(row.streamId, row.removedAt);
    }
    return [...latest].map(([streamId, removedAt]) => ({ streamId, removedAt }));
  }

  /** A finished check that ended at `endedAt`, with these verdicts, for the removal's tests. */
  finished(
    id: string,
    rows: { streamId: string; title: string; verdict: 'lost' | 'partly_lost' | 'readable' }[],
    endedAt: Date,
  ): void {
    this.checks.push({
      id,
      state: 'done',
      stopMessage: null,
      round: 3,
      nextRoundAt: null,
      unjudged: 0,
      startedBy: 'test-operator',
      startedAt: new Date(endedAt.getTime() - 20 * 60_000),
      finishedAt: endedAt,
      rows: rows.map((row) => ({
        ...row,
        status: 'vod' as const,
        readings: { master: [false, false, false], qualities: [] },
        hasExportFile: false,
        removal: null,
        keptReason: null,
        removedAt: null,
      })),
    });
  }

  private find(id: string) {
    return this.checks.find((check) => check.id === id);
  }

  private copy(check: RecordingCheckRow & { rows: RecordingCheckStreamRow[] }): RecordingCheckRow {
    const { rows: _rows, ...row } = check;
    return structuredClone(row);
  }
}

/** A feed slot as the reads key it. */
export function feedKey(feed: RecordingFeed): string {
  return `${feed.owner}:${feed.topic}:${feed.index}`;
}

/** The catalogue node as a test sets it: the playlists it gives by slot, the segments it holds, and its peers. */
export class FakeRecordingReads implements RecordingReads {
  readonly playlists = new Map<string, string>();
  readonly segments = new Set<string>();
  peerCount = 8;
  /** Set to make `peers` throw, as a node that does not answer. */
  peersFail = false;
  /** Every slot and segment read, in order. */
  readonly read: string[] = [];

  async playlist(_node: ReadNode, feed: RecordingFeed): Promise<string> {
    const key = feedKey(feed);
    this.read.push(`playlist ${key}`);
    const text = this.playlists.get(key);
    if (text === undefined) throw new Error('Not Found');
    return text;
  }

  async segment(_node: ReadNode, reference: string): Promise<void> {
    this.read.push(`segment ${reference}`);
    if (!this.segments.has(reference)) throw new Error('Not Found');
  }

  async peers(): Promise<number> {
    if (this.peersFail) throw new Error('connect ECONNREFUSED');
    return this.peerCount;
  }

  /** How many times the slot `feed` was read. */
  readsOf(feed: RecordingFeed): number {
    return this.read.filter((line) => line === `playlist ${feedKey(feed)}`).length;
  }
}

/** The removal's catalogue write, as PublishService makes it: one call, with the streams it took off. */
export class FakeLostRecordingsWrite implements LostRecordingsCatalogueWrite {
  readonly calls: { actor: Actor; streamIds: string[] }[] = [];
  /** What a call answers: the index written, and the streams it would not take. */
  answer: { index: number | null; kept: { streamId: string; reason: string }[] } = { index: 41, kept: [] };
  /** Called with each stream taken off, as `finishUnpublish` leaves its row a draft. */
  onTaken: ((streamId: string) => void) | null = null;

  async takeOffCatalogue(
    actor: Actor,
    streamIds: readonly string[],
  ): Promise<{ index: number | null; kept: { streamId: string; reason: string }[] }> {
    this.calls.push({ actor, streamIds: [...streamIds] });
    const kept = new Set(this.answer.kept.map((one) => one.streamId));
    for (const id of streamIds) if (!kept.has(id)) this.onTaken?.(id);
    return structuredClone(this.answer);
  }
}
