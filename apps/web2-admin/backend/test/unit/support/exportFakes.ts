import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ExportState } from '@streaming-monorepo/web2-admin-common';

import type {
  ExportChange,
  ExportProgress,
  ExportRow,
  ExportStore,
  ExportView,
  NewExport,
} from '../../../src/domain/export/ExportRepository.js';
import type { Joiner, JoinRun } from '../../../src/domain/export/Joiner.js';
import type { ReadNode, RecordingFeed, RecordingSource } from '../../../src/domain/export/RecordingSource.js';
import type { StreamRenditionRow, StreamRow } from '../../../src/types/index.js';

/** Fakes for exporting a recording: the export's store, Swarm and ffmpeg, in memory. */

/** A segment reference: 64 hex digits. */
export function ref(n: number): string {
  return n.toString(16).padStart(64, '0');
}

/** A recording playlist naming `refs`, two seconds each, with a seam before the indexes in `seams`. */
export function playlistOf(refs: string[], seams: number[] = []): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-PLAYLIST-TYPE:VOD'];
  refs.forEach((reference, index) => {
    if (seams.includes(index)) lines.push('#EXT-X-DISCONTINUITY');
    lines.push('#EXTINF:2.000000,', reference);
  });
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

export class FakeStreams {
  readonly rows = new Map<string, StreamRow>();
  async findById(id: string): Promise<StreamRow | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }
}

export class FakeRenditions {
  readonly rows = new Map<string, StreamRenditionRow[]>();
  async listByStream(streamId: string): Promise<StreamRenditionRow[]> {
    return (this.rows.get(streamId) ?? []).map((row) => ({ ...row }));
  }
}

/** The SQL of ExportRepository, in memory: one row, moves conditional on the state they move from. */
export class InMemoryExportStore implements ExportStore {
  row: ExportRow | null = null;
  readonly dismissals = new Set<string>();
  constructor(private readonly streams: FakeStreams) {}

  async get(): Promise<ExportRow | null> {
    return this.row ? { ...this.row } : null;
  }

  async view(userId: string | null): Promise<ExportView | null> {
    if (!this.row) return null;
    const stream = this.streams.rows.get(this.row.stream_id);
    if (!stream) return null;
    return {
      ...this.row,
      stream_title: stream.title,
      dismissed: userId !== null && this.dismissals.has(`${this.row.id}:${userId}`),
    };
  }

  async create(input: NewExport): Promise<{ row: ExportRow; replaced: string[] } | null> {
    if (this.row && this.row.state !== 'done') return null;
    const replaced = this.row ? [this.row.id] : [];
    const now = new Date();
    this.row = {
      id: input.id,
      stream_id: input.streamId,
      rendition: input.rendition,
      quality: input.quality,
      feed_owner: input.feedOwner,
      feed_topic: input.feedTopic,
      manifest_index: input.manifestIndex,
      state: 'reading',
      pause_reason: null,
      pause_message: null,
      paused_at: null,
      segments_total: null,
      segments_read: 0,
      segments_missing: 0,
      bytes_read: 0,
      estimated_bytes: input.estimatedBytes,
      duration_seconds: input.durationSeconds,
      file_name: null,
      size_bytes: null,
      partial: false,
      save_chosen: false,
      started_by_user_id: input.startedByUserId,
      started_by: input.startedBy,
      started_at: now,
      updated_at: now,
      finished_at: null,
    };
    return { row: { ...this.row }, replaced };
  }

  async transition(id: string, from: readonly ExportState[], change: ExportChange): Promise<ExportRow | null> {
    const row = this.row;
    if (!row || row.id !== id || !from.includes(row.state)) return null;
    row.state = change.state;
    if (change.state === 'paused') {
      row.pause_reason = change.pauseReason ?? 'problem';
      row.pause_message = change.pauseMessage ?? null;
      row.paused_at = new Date();
    } else {
      row.pause_reason = null;
      row.pause_message = null;
      row.paused_at = null;
    }
    if (change.manifestIndex !== undefined) row.manifest_index = change.manifestIndex;
    if (change.segmentsTotal !== undefined) row.segments_total = change.segmentsTotal;
    if (change.segmentsRead !== undefined) row.segments_read = change.segmentsRead;
    if (change.segmentsMissing !== undefined) row.segments_missing = change.segmentsMissing;
    if (change.bytesRead !== undefined) row.bytes_read = change.bytesRead;
    if (change.durationSeconds !== undefined) row.duration_seconds = change.durationSeconds;
    if (change.quality !== undefined) row.quality = change.quality;
    if (change.fileName !== undefined) row.file_name = change.fileName;
    if (change.sizeBytes !== undefined) row.size_bytes = change.sizeBytes;
    if (change.partial !== undefined) row.partial = change.partial;
    if (change.saveChosen !== undefined) row.save_chosen = change.saveChosen;
    if (change.state === 'done') row.finished_at = new Date();
    row.updated_at = new Date();
    return { ...row };
  }

  async progress(id: string, state: ExportState, progress: ExportProgress): Promise<boolean> {
    const row = this.row;
    if (!row || row.id !== id || row.state !== state) return false;
    row.segments_total = progress.segmentsTotal;
    row.segments_read = progress.segmentsRead;
    row.segments_missing = progress.segmentsMissing;
    row.bytes_read = progress.bytesRead;
    row.duration_seconds = progress.durationSeconds ?? row.duration_seconds;
    return true;
  }

  async remove(id: string): Promise<boolean> {
    if (!this.row || this.row.id !== id) return false;
    this.row = null;
    return true;
  }

  async dismiss(id: string, userId: string): Promise<boolean> {
    if (!this.row || this.row.id !== id || this.row.state !== 'done') return false;
    this.dismissals.add(`${id}:${userId}`);
    return true;
  }
}

/** Swarm in memory: playlists by feed topic and index, segments by reference. */
export class FakeSource implements RecordingSource {
  readonly playlists = new Map<string, string>();
  readonly segments = new Map<string, Buffer>();
  readonly failing = new Set<string>();
  readonly reads = new Map<string, number>();
  /** Holds every segment read until opened. */
  gate: Promise<void> | null = null;
  /** Called after each segment read, with how many were read so far. */
  afterRead: ((count: number) => void) | null = null;
  private count = 0;

  playlist(topic: string, index: number, text: string): void {
    this.playlists.set(`${topic}:${index}`, text);
  }

  segment(reference: string, bytes = `segment ${reference.slice(-4)};`): void {
    this.segments.set(reference, Buffer.from(bytes));
  }

  async readPlaylist(_node: ReadNode, feed: RecordingFeed): Promise<string> {
    const text = this.playlists.get(`${feed.topic}:${feed.index}`);
    if (text === undefined) throw new Error(`no playlist at ${feed.topic}:${feed.index}`);
    return text;
  }

  async readSegment(_node: ReadNode, reference: string, destination: string, signal?: AbortSignal): Promise<number> {
    if (this.gate) await this.gate;
    if (signal?.aborted) throw new Error('stopped');
    const bytes = this.segments.get(reference);
    if (!bytes || this.failing.has(reference)) throw new Error('the node answered 404');
    this.reads.set(reference, (this.reads.get(reference) ?? 0) + 1);
    await writeFile(destination, bytes);
    this.count += 1;
    this.afterRead?.(this.count);
    return bytes.length;
  }
}

/** ffmpeg in memory: the MP4 is the segments one after the other, and every run is recorded. */
export class FakeJoiner implements Joiner {
  problem: string | null = null;
  height: number | null = 720;
  readonly joins: JoinRun[][] = [];
  /** Runs inside each join before the file is written: a test's way to change the world while ffmpeg runs. */
  during: ((signal?: AbortSignal) => Promise<void>) | null = null;
  /** Joins stopped by their signal before they wrote anything. */
  stopped = 0;

  async check(): Promise<string | null> {
    return this.problem;
  }

  async join(runs: JoinRun[], output: string, workDir: string, signal?: AbortSignal): Promise<void> {
    this.joins.push(runs);
    if (this.during) await this.during(signal);
    if (signal?.aborted) {
      this.stopped += 1;
      throw new Error('the join was stopped');
    }
    const parts: Buffer[] = [];
    for (const run of runs) for (const file of run.files) parts.push(await readFile(path.join(workDir, file)));
    await writeFile(output, Buffer.concat(parts));
  }

  async probeHeight(): Promise<number | null> {
    return this.height;
  }
}
