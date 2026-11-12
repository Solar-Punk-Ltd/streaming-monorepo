import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  EXPORT_ACTIVE_STATES,
  holdsFinishedRecording,
  type ExportAction,
  type ExportOptionsResponse,
  type ExportPauseReason,
  type ExportQuality,
  type ExportRefusal,
  type ExportState,
  type ExportSummary,
} from '@streaming-monorepo/web2-admin-common';

import type { StreamRenditionRow, StreamRow } from '../../types/index.js';
import { getErrorMessage } from '../../utils/errorUtils.js';
import { describeActor, type OperatorActor } from '../actor.js';
import { recordAudit, type AuditAction, type AuditLog } from '../AuditLog.js';
import { withoutCatalogueNode } from '../catalogueNodeText.js';
import { ExportNotFoundError, ExportRefusedError, StreamNotFoundError } from '../errors/index.js';
import type { CatalogueTarget } from '../FeedGateway.js';
import { Logger } from '../Logger.js';
import type { ExportRow, ExportStore, ExportView } from './ExportRepository.js';
import type { Joiner } from './Joiner.js';
import { broadcastDay, exportFileName, utcDay } from './names.js';
import { parseRecordingPlaylist, PlaylistFormatError, runsOf, type RecordingPlaylist } from './playlist.js';
import type { ReadNode, RecordingFeed, RecordingSource } from './RecordingSource.js';

const logger = Logger.getInstance();

/** What `rendition` holds for a recording with one quality, which has no rung of its own. */
export const SOURCE_RENDITION = 'source';

const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
const DEFAULT_WATCH_INTERVAL_MS = 10_000;
const DEFAULT_STATUS_CHECK_MS = 3_000;
const DEFAULT_PROGRESS_SAVE_MS = 1_000;
/** While ffmpeg joins, the stream is looked at every status check, but never more often than this. */
const JOIN_CHECK_MIN_MS = 20;
/** The share of the disk kept free beside an export, so a full disk never takes the database or the logs down with it. */
const DEFAULT_KEEP_FREE_FRACTION = 0.1;
/** How long the estimate of a single-quality recording may take: one playlist and one segment. */
const ESTIMATE_TIMEOUT_MS = 20_000;
/** ffmpeg is looked for again after this long, so installing it needs no restart. */
const FFMPEG_CHECK_TTL_MS = 60_000;

const UUID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SYSTEM_EXPORT = { kind: 'system', reason: 'export' } as const;

export interface ExportStreams {
  findById(id: string): Promise<StreamRow | null>;
}

export interface ExportRenditions {
  listByStream(streamId: string): Promise<StreamRenditionRow[]>;
}

/** The node recordings are read through: the one the catalogue is read through, by CatalogueBatchService. */
export interface ExportNodes {
  forRead(): Promise<{ target: CatalogueTarget | null } | { skipped: string }>;
}

/** The free and total bytes of the file system a folder is on. */
export interface DiskSpace {
  space(dir: string): Promise<{ free: number; total: number }>;
}

export interface ExportServiceOptions {
  /** `EXPORT_DIR`: where each export keeps its folder. Only folders named by an export's id are ever deleted. */
  dir: string;
  /** `EXPORT_PARALLEL_READS`: how many segments are read at once. */
  parallelReads: number;
  retryDelaysMs?: readonly number[];
  watchIntervalMs?: number;
  statusCheckMs?: number;
  progressSaveMs?: number;
  /** The share of the disk an export keeps free, a tenth unless set. */
  keepFreeFraction?: number;
  disk?: DiskSpace;
  now?: () => Date;
}

/** `complete` when every segment was read; otherwise the export has been paused with the reason, or moved on. */
type ReadOutcome = 'complete' | 'stopped';

interface RunningJob {
  id: string;
  controller: AbortController;
  promise: Promise<void>;
}

const statfsSpace: DiskSpace = {
  async space(dir: string): Promise<{ free: number; total: number }> {
    const stats = await statfs(dir);
    return { free: Number(stats.bavail) * Number(stats.bsize), total: Number(stats.blocks) * Number(stats.bsize) };
  },
};

/** Sizes as the panel shows them: decimal, so 6.6 GB is 6,600,000,000 bytes. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(0, Math.round(bytes / 1e3))} kB`;
}

/**
 * What a user can do to the export in the state it is in. The console shows these and nothing else, and `act`
 * refuses anything else.
 */
export function actionsFor(row: ExportRow, dismissed: boolean): ExportAction[] {
  const save: ExportAction[] = row.segments_read > 0 ? ['save'] : [];
  switch (row.state) {
    case 'reading':
      return ['pause', 'cancel'];
    case 'joining':
      return ['cancel'];
    case 'waiting':
      return [...save, 'cancel'];
    case 'paused':
      if (row.pause_reason === 'live') return [...save, 'wait', 'cancel'];
      if (row.pause_reason === 'disk') return ['resume', 'cancel'];
      return ['resume', ...save, 'cancel'];
    case 'done':
      // Clear stays on offer after a user closed the widget: the kept file is still on the server, and on the panel.
      return dismissed ? ['clear'] : ['dismiss', 'clear'];
  }
}

function stateWords(state: ExportState): string {
  switch (state) {
    case 'reading':
      return 'is running';
    case 'joining':
      return 'is being joined into an MP4';
    case 'paused':
      return 'is paused';
    case 'waiting':
      return 'is waiting for its stream to finish';
    case 'done':
      return 'is done';
  }
}

function busyMessage(view: Pick<ExportView, 'stream_title' | 'quality' | 'state' | 'started_by'>): string {
  return `The export of "${view.stream_title}" (${view.quality}) ${stateWords(view.state)}, started by ${view.started_by}. One export runs at a time.`;
}

function statusWords(status: StreamRow['status']): string {
  switch (status) {
    case 'draft':
      return 'a draft with no recording';
    case 'publishing':
      return 'being published';
    case 'published':
      return 'scheduled and has not started';
    case 'live':
      return 'live now';
    case 'vod':
      return 'recorded';
  }
}

function holdsRecording(stream: StreamRow): boolean {
  return holdsFinishedRecording({ status: stream.status, manifestIndex: stream.manifest_index });
}

/**
 * Exporting a recording into an MP4. One export at a time for the whole admin, read through the
 * catalogue node, joined by ffmpeg, and kept on the server until the next export starts.
 * `docs/architecture/web2-admin.md`, "Exporting a recording", is the design.
 *
 * The job reads every segment it can, retrying each a few times, and never fails: anything that stops it pauses the
 * export with a reason, and a user decides. Progress is saved as it goes, and the segments read are kept on disk by
 * reference, so a restart, a pause or a stream that went live again and finished loses nothing already read.
 *
 * State moves are conditional on the state they move from, so a user's action and the job's own move never both
 * apply: whichever lands first wins, and the other finds the export moved on.
 */
export class ExportService {
  private job: RunningJob | null = null;
  private watcher: NodeJS.Timeout | null = null;
  private stopping = false;
  private ticking: Promise<void> | null = null;
  private ffmpegChecked: { at: number; problem: string | null } | null = null;
  private readonly estimates = new Map<string, number | null>();
  private readonly retryDelaysMs: readonly number[];
  private readonly watchIntervalMs: number;
  private readonly statusCheckMs: number;
  private readonly progressSaveMs: number;
  private readonly keepFreeFraction: number;
  private readonly disk: DiskSpace;
  private readonly now: () => Date;

  constructor(
    private readonly store: ExportStore,
    private readonly streams: ExportStreams,
    private readonly renditions: ExportRenditions,
    private readonly nodes: ExportNodes,
    private readonly source: RecordingSource,
    private readonly joiner: Joiner,
    private readonly audit: AuditLog,
    private readonly options: ExportServiceOptions,
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.watchIntervalMs = options.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
    this.statusCheckMs = options.statusCheckMs ?? DEFAULT_STATUS_CHECK_MS;
    this.progressSaveMs = options.progressSaveMs ?? DEFAULT_PROGRESS_SAVE_MS;
    this.keepFreeFraction = options.keepFreeFraction ?? DEFAULT_KEEP_FREE_FRACTION;
    this.disk = options.disk ?? statfsSpace;
    this.now = options.now ?? (() => new Date());
  }

  // --- reads -----------------------------------------------------------------

  /** The export on the server, as the user asking sees it, or null when there is none. */
  async current(userId: string | null): Promise<ExportSummary | null> {
    const view = await this.store.view(userId);
    return view ? summaryOf(view, userId) : null;
  }

  /** What the panel offers for one stream: its qualities with estimates, and why none can start now, if so. */
  async optionsFor(streamId: string, userId: string | null): Promise<ExportOptionsResponse> {
    const stream = await this.streams.findById(streamId);
    if (!stream) throw new StreamNotFoundError(streamId);
    const [renditions, view] = await Promise.all([this.renditions.listByStream(streamId), this.store.view(userId)]);
    const qualities = await this.qualitiesOf(stream, renditions, true);
    return {
      streamId: stream.id,
      title: stream.title,
      date: broadcastDay(stream),
      durationSeconds: stream.duration_seconds,
      qualities: qualities.map((quality) => quality.option),
      refusal: await this.refusalFor(stream, view),
      current: view ? summaryOf(view, userId) : null,
    };
  }

  /** The finished MP4 of the export with this id, to send as an attachment. */
  async file(exportId: string): Promise<{ path: string; fileName: string; sizeBytes: number }> {
    const row = await this.store.get();
    if (!row || row.id !== exportId || row.state !== 'done' || !row.file_name) throw new ExportNotFoundError(exportId);
    const file = this.mp4Path(row.id);
    try {
      const { size } = await stat(file);
      return { path: file, fileName: row.file_name, sizeBytes: size };
    } catch {
      throw new ExportNotFoundError(exportId);
    }
  }

  // --- what a user does --------------------------------------------------------

  /**
   * Starts exporting one quality of a stream's recording. Refused, with the sentence the console shows, while another
   * export holds the slot, for a stream with no finished recording or a quality that has not finished, without a node
   * to read through or ffmpeg, or with too little free disk. The kept export, if any, is deleted first.
   */
  async start(actor: OperatorActor, streamId: string, rendition: string): Promise<ExportSummary> {
    const stream = await this.streams.findById(streamId);
    if (!stream) throw new StreamNotFoundError(streamId);
    const [renditions, view] = await Promise.all([
      this.renditions.listByStream(streamId),
      this.store.view(actor.userId),
    ]);
    const refusal = await this.refusalFor(stream, view);
    if (refusal) throw new ExportRefusedError(refusal.problem, refusal.message);

    const qualities = await this.qualitiesOf(stream, renditions, false);
    const chosen = qualities.find((quality) => quality.option.rendition === rendition);
    if (!chosen) {
      const names = qualities.map((quality) => quality.option.label).join(', ');
      throw new ExportRefusedError('quality_unavailable', `This recording has no ${rendition}; it has ${names}.`);
    }
    if (!chosen.feed) {
      throw new ExportRefusedError(
        'quality_unavailable',
        chosen.option.unavailable ?? `The ${chosen.option.label} recording has not finished.`,
      );
    }

    const estimate =
      chosen.option.estimatedBytes ?? (rendition === SOURCE_RENDITION ? await this.estimateSource(chosen.feed) : null);
    let room: { free: number; keep: number };
    try {
      await mkdir(this.options.dir, { recursive: true });
      room = await this.room();
    } catch (error) {
      throw new ExportRefusedError('disk', `The folder exports are kept in cannot be used: ${getErrorMessage(error)}`);
    }
    // The kept export is deleted before this one starts, so its space is free for it.
    const free = room.free + (view?.state === 'done' ? (view.size_bytes ?? 0) : 0);
    if (estimate !== null && free - room.keep < estimate * 2) {
      throw new ExportRefusedError(
        'disk',
        `The server has ${formatBytes(free)} free and keeps ${formatBytes(room.keep)} of it free, ${this.keepFreeShare()} of its disk. This export needs about ${formatBytes(estimate * 2)} while it runs: the segments and the MP4.`,
      );
    }

    const created = await this.store.create({
      id: randomUUID(),
      streamId: stream.id,
      rendition: chosen.option.rendition,
      quality: chosen.option.rendition,
      feedOwner: chosen.feed.owner,
      feedTopic: chosen.feed.topic,
      manifestIndex: chosen.feed.index,
      estimatedBytes: estimate,
      durationSeconds: chosen.option.durationSeconds,
      startedByUserId: actor.userId,
      startedBy: describeActor(actor),
    });
    if (!created) {
      const now = await this.store.view(actor.userId);
      throw new ExportRefusedError(
        'busy',
        now ? busyMessage(now) : 'Another export started first. One export runs at a time.',
      );
    }
    // The replaced export's folder, and any an export left behind when its stream was deleted under it.
    await this.sweep(created.row.id);

    logger.info(
      `[Export] ${describeActor(actor)} started exporting "${stream.title}" at ${chosen.option.label}${
        estimate !== null ? `, about ${formatBytes(estimate)}` : ''
      }${created.replaced.length > 0 ? ', replacing the kept export' : ''}`,
    );
    await recordAudit(this.audit, {
      actor,
      action: 'export.start',
      streamId: stream.id,
      topic: stream.topic,
      details: {
        exportId: created.row.id,
        rendition: chosen.option.rendition,
        manifestIndex: chosen.feed.index,
        estimatedBytes: estimate,
        replaced: created.replaced,
      },
    });
    this.launch(created.row.id, 'read');
    return (await this.current(actor.userId))!;
  }

  /** Pause, resume, wait, save what was read, cancel, or close the widget. Answers the export as it now stands. */
  async act(actor: OperatorActor, exportId: string, action: ExportAction): Promise<ExportSummary | null> {
    const view = await this.store.view(actor.userId);
    if (!view || view.id !== exportId) throw new ExportNotFoundError(exportId);
    const notNow = () =>
      new ExportRefusedError(
        'not_now',
        `The export ${stateWords(view.state)}, so it cannot ${actionWords(action)} now.`,
      );
    if (!actionsFor(view, view.dismissed).includes(action)) throw notNow();

    const audit = (auditAction: AuditAction, details: Record<string, unknown> = {}) =>
      recordAudit(this.audit, {
        actor,
        action: auditAction,
        streamId: view.stream_id,
        details: { exportId, rendition: view.rendition, ...details },
      });

    switch (action) {
      case 'pause': {
        const paused = await this.store.transition(exportId, ['reading'], {
          state: 'paused',
          pauseReason: 'user',
          pauseMessage: `Paused by ${describeActor(actor)}.`,
        });
        if (!paused) throw notNow();
        if (this.job?.id === exportId) this.job.controller.abort();
        logger.info(`[Export] ${describeActor(actor)} paused the export of "${view.stream_title}"`);
        await audit('export.pause', { segmentsRead: paused.segments_read });
        break;
      }
      case 'resume': {
        const resumed = await this.store.transition(exportId, ['paused'], { state: 'reading', saveChosen: false });
        if (!resumed) throw notNow();
        logger.info(`[Export] ${describeActor(actor)} resumed the export of "${view.stream_title}"`);
        await audit('export.resume', { after: view.pause_reason });
        this.launch(exportId, 'read');
        break;
      }
      case 'wait': {
        const waiting = await this.store.transition(exportId, ['paused'], { state: 'waiting' });
        if (!waiting) throw notNow();
        logger.info(
          `[Export] ${describeActor(actor)} set the export of "${view.stream_title}" to wait until the stream finishes`,
        );
        await audit('export.wait');
        // The stream may have finished already.
        await this.tick();
        break;
      }
      case 'save': {
        // The user's own answer to a stream that went live again: this join finishes whatever the stream does.
        const joining = await this.store.transition(exportId, ['paused', 'waiting'], {
          state: 'joining',
          saveChosen: true,
        });
        if (!joining) throw notNow();
        logger.info(`[Export] ${describeActor(actor)} saved what was read of "${view.stream_title}"`);
        await audit('export.save', { segmentsRead: joining.segments_read, segmentsTotal: joining.segments_total });
        this.launch(exportId, 'join');
        break;
      }
      case 'cancel': {
        if (!(await this.store.remove(exportId))) throw new ExportNotFoundError(exportId);
        await this.stopJob(exportId);
        await this.removeFolder(exportId);
        logger.info(`[Export] ${describeActor(actor)} cancelled the export of "${view.stream_title}"`);
        await audit('export.cancel', { state: view.state, segmentsRead: view.segments_read });
        return null;
      }
      case 'dismiss': {
        if (!(await this.store.dismiss(exportId, actor.userId))) throw notNow();
        break;
      }
      case 'clear': {
        // The kept file goes for everyone, so the same quality can be exported again from the panel.
        if (!(await this.store.remove(exportId))) throw new ExportNotFoundError(exportId);
        await this.removeFolder(exportId);
        logger.info(`[Export] ${describeActor(actor)} cleared the kept file of "${view.stream_title}"`);
        await audit('export.clear', { fileName: view.file_name, sizeBytes: view.size_bytes });
        return null;
      }
    }
    return this.current(actor.userId);
  }

  /** Records that a user saved the finished file. */
  async recordSaved(actor: OperatorActor, exportId: string): Promise<void> {
    const row = await this.store.get();
    if (!row || row.id !== exportId) return;
    await recordAudit(this.audit, {
      actor,
      action: 'export.file',
      streamId: row.stream_id,
      details: { exportId, fileName: row.file_name, sizeBytes: row.size_bytes },
    });
  }

  // --- the process's own lifecycle ---------------------------------------------

  /**
   * At boot: deletes export folders no row names, carries on with an export left reading or joining by a process
   * that stopped, and starts the watch that resumes a waiting export once its stream is a recording again. A folder
   * that cannot be used is logged, and every start is refused with the reason, rather than the admin not starting.
   */
  async boot(): Promise<void> {
    try {
      await mkdir(this.options.dir, { recursive: true });
      const row = await this.store.get();
      await this.sweep(row?.id ?? null);
      const problem = await this.ffmpegProblem();
      logger.info(`[Export] exports are kept in ${this.options.dir}${problem ? `; ${problem}` : ', ffmpeg found'}`);
      if (row && (row.state === 'reading' || row.state === 'joining')) {
        logger.info(`[Export] carrying on with the export the last process left ${row.state}`);
        this.launch(row.id, row.state === 'reading' ? 'read' : 'join');
      }
    } catch (error) {
      logger.error(`[Export] the export folder ${this.options.dir} cannot be used: ${getErrorMessage(error)}`);
    }
    this.watcher = setInterval(() => void this.tick(), this.watchIntervalMs);
    this.watcher.unref();
  }

  /** Stops the job after the reads in flight, leaving the export in its state, so the next start carries on with it. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
    const job = this.job;
    if (job) {
      job.controller.abort();
      await job.promise.catch(() => undefined);
    }
    await this.ticking;
  }

  /** Resolves once no job is running. For the tests. */
  async settled(): Promise<void> {
    while (this.job) await this.job.promise.catch(() => undefined);
  }

  /**
   * One look at the export: a waiting export whose stream is a recording again carries on, and an export left reading
   * or joining with no job in this process gets one. Runs on a timer, and after a user chooses Wait.
   */
  async tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      try {
        const row = await this.store.get();
        if (!row || this.stopping) return;
        if (row.state === 'waiting') {
          const stream = await this.streams.findById(row.stream_id);
          if (!stream || !holdsRecording(stream)) return;
          const feed = await this.feedOf(stream, row.rendition);
          if (!feed) return;
          const resumed = await this.store.transition(row.id, ['waiting'], {
            state: 'reading',
            manifestIndex: feed.index,
          });
          if (!resumed) return;
          logger.info(`[Export] "${stream.title}" is a recording again; the export carries on with it`);
          this.launch(row.id, 'read');
          return;
        }
        if ((row.state === 'reading' || row.state === 'joining') && !this.job) {
          this.launch(row.id, row.state === 'reading' ? 'read' : 'join');
        }
      } catch (error) {
        logger.warn(`[Export] could not look at the export: ${getErrorMessage(error)}`);
      } finally {
        this.ticking = null;
      }
    })();
    return this.ticking;
  }

  // --- the job -------------------------------------------------------------------

  /** Starts the job for the export, after the one before it has stopped, so two jobs never touch one folder. */
  private launch(id: string, mode: 'read' | 'join'): void {
    if (this.stopping) return;
    const before = this.job?.promise ?? Promise.resolve();
    const controller = new AbortController();
    const promise: Promise<void> = before
      .catch(() => undefined)
      .then(() => (controller.signal.aborted ? undefined : this.run(id, mode, controller.signal)))
      .finally(() => {
        if (this.job?.promise === promise) this.job = null;
      });
    this.job = { id, controller, promise };
  }

  private async stopJob(id: string): Promise<void> {
    const job = this.job;
    if (!job || job.id !== id) return;
    job.controller.abort();
    await job.promise.catch(() => undefined);
  }

  private async run(id: string, mode: 'read' | 'join', signal: AbortSignal): Promise<void> {
    try {
      if (mode === 'read') {
        if ((await this.readPass(id, signal)) !== 'complete' || signal.aborted) return;
        if (!(await this.store.transition(id, ['reading'], { state: 'joining', saveChosen: false }))) return;
      }
      await this.joinPass(id, signal);
    } catch (error) {
      // Stopped from outside: whoever stopped it has already moved the export, or left it for the next start.
      if (signal.aborted) return;
      const message = withoutCatalogueNode(getErrorMessage(error));
      logger.error(`[Export] the export stopped on a problem: ${message}`);
      await this.pause(id, ['reading', 'joining'], 'problem', `The export stopped: ${message}`);
    }
  }

  /**
   * Reads every segment of the recording not on disk yet. Answers `complete` when all were read; otherwise it has
   * paused the export with the reason, or found it moved on.
   */
  private async readPass(id: string, signal: AbortSignal): Promise<ReadOutcome> {
    const row = await this.store.get();
    if (!row || row.id !== id || row.state !== 'reading') return 'stopped';
    const stream = await this.streams.findById(row.stream_id);
    if (!stream) return 'stopped';
    if (stream.status === 'live') {
      await this.pause(id, ['reading'], 'live', liveMessage());
      return 'stopped';
    }
    // The recording as the stream points at it now: one that went live again and finished has a new playlist, which
    // carries the earlier sessions too, so the segments already read are kept.
    const feed = await this.feedOf(stream, row.rendition);
    if (!feed) {
      await this.pause(
        id,
        ['reading'],
        'problem',
        `The ${row.rendition} recording of "${stream.title}" is not finished.`,
      );
      return 'stopped';
    }
    if (feed.index !== row.manifest_index) {
      if (!(await this.store.transition(id, ['reading'], { state: 'reading', manifestIndex: feed.index }))) {
        return 'stopped';
      }
    }
    const node = await this.readNode();
    if ('problem' in node) {
      await this.pause(id, ['reading'], 'problem', node.problem);
      return 'stopped';
    }

    await mkdir(this.segmentsDir(id), { recursive: true });
    const loaded = await this.playlistFor(id, node.node, feed, signal).then(
      (playlist) => ({ playlist }),
      (error: unknown) => ({ error }),
    );
    if ('error' in loaded) {
      if (signal.aborted) return 'stopped';
      const reason =
        loaded.error instanceof PlaylistFormatError
          ? loaded.error.message
          : withoutCatalogueNode(getErrorMessage(loaded.error), node.target);
      await this.pause(id, ['reading'], 'problem', `The recording playlist could not be read: ${reason}`);
      return 'stopped';
    }
    const { playlist } = loaded;

    const present = await this.presentSegments(id);
    const total = playlist.segments.length;
    const pass = {
      halted: null as 'live' | 'disk' | 'gone' | null,
      missing: 0,
      lastError: null as string | null,
      next: 0,
      lastSave: Date.now(),
      lastCheck: Date.now(),
      looking: false,
    };
    const save = async () => {
      const { read, bytes } = countPresent(playlist, present);
      return this.store.progress(id, 'reading', {
        segmentsTotal: total,
        segmentsRead: read,
        segmentsMissing: pass.missing,
        bytesRead: bytes,
        durationSeconds: playlist.durationSeconds,
      });
    };
    if (!(await save())) return 'stopped';

    const todo = [...new Set(playlist.segments.map((segment) => segment.reference))].filter(
      (reference) => !present.has(reference),
    );
    const inner = new AbortController();
    const onAbort = () => inner.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const halt = (why: 'live' | 'disk' | 'gone') => {
      if (pass.halted) return;
      pass.halted = why;
      inner.abort();
    };
    // Between segments: progress saved, and the stream and the disk looked at, each now and then.
    const lookAround = async () => {
      if (pass.looking) return;
      pass.looking = true;
      try {
        if (Date.now() - pass.lastSave >= this.progressSaveMs) {
          pass.lastSave = Date.now();
          if (!(await save())) halt('gone');
        }
        if (Date.now() - pass.lastCheck >= this.statusCheckMs) {
          pass.lastCheck = Date.now();
          const now = await this.streams.findById(stream.id);
          if (!now) halt('gone');
          else if (now.status === 'live') halt('live');
          else {
            const room = await this.room();
            if (room.free < room.keep) halt('disk');
          }
        }
      } finally {
        pass.looking = false;
      }
    };
    const worker = async () => {
      while (!inner.signal.aborted) {
        const reference = todo[pass.next++];
        if (reference === undefined) return;
        const read = await this.readWithRetries(id, node.node, reference, inner.signal);
        if (inner.signal.aborted) return;
        if (typeof read === 'number') {
          present.set(reference, read);
        } else {
          pass.missing += 1;
          pass.lastError = read.error;
        }
        await lookAround();
      }
    };
    try {
      const workers = Math.max(1, Math.min(this.options.parallelReads, todo.length));
      await Promise.all(Array.from({ length: workers }, worker));
    } finally {
      signal.removeEventListener('abort', onAbort);
    }

    if (signal.aborted || pass.halted === 'gone') return 'stopped';
    await save();
    if (pass.halted === 'live') {
      await this.pause(id, ['reading'], 'live', liveMessage());
      return 'stopped';
    }
    if (pass.halted === 'disk') {
      const room = await this.room();
      await this.pause(
        id,
        ['reading'],
        'disk',
        `The server has ${formatBytes(room.free)} free, and keeps ${formatBytes(room.keep)} free, ${this.keepFreeShare()} of its disk, so reading stopped. Free some disk, then resume.`,
      );
      return 'stopped';
    }
    const unread = total - countPresent(playlist, present).read;
    if (unread > 0) {
      const last = pass.lastError ? ` The last error: ${withoutCatalogueNode(pass.lastError, node.target)}.` : '';
      await this.pause(
        id,
        ['reading'],
        'unreadable',
        `${unread} of ${total} segments could not be read from Swarm.${last}`,
      );
      return 'stopped';
    }
    return 'complete';
  }

  /**
   * Joins every segment read into the MP4, keeps it, and deletes the segments. A missing stretch becomes a cut. A join
   * the job started itself pauses as `live` when the stream goes live again, as reading does: before ffmpeg starts,
   * while it runs, and before the file is kept. One a user chose with Save what was read finishes regardless.
   */
  private async joinPass(id: string, signal: AbortSignal): Promise<void> {
    const row = await this.store.get();
    if (!row || row.id !== id || row.state !== 'joining') return;
    const stream = await this.streams.findById(row.stream_id);
    if (!stream) return;
    const wentLive = async () => !row.save_chosen && (await this.streams.findById(stream.id))?.status === 'live';
    if (!row.save_chosen && stream.status === 'live') {
      await this.pause(id, ['joining'], 'live', liveMessage());
      return;
    }
    const playlist = await this.cachedPlaylist(id, row.manifest_index);
    const present = await this.presentSegments(id);
    const runs = playlist ? runsOf(playlist.segments, new Set(present.keys())) : [];
    if (!playlist || runs.length === 0) {
      await this.pause(id, ['joining'], 'problem', 'Nothing has been read yet, so there is nothing to save.');
      return;
    }
    const { read, bytes } = countPresent(playlist, present);
    const room = await this.room();
    const needed = bytes * (runs.length > 1 ? 2 : 1);
    if (room.free - room.keep < needed) {
      await this.pause(
        id,
        ['joining'],
        'disk',
        `The server has ${formatBytes(room.free)} free and keeps ${formatBytes(room.keep)} of it free, ${this.keepFreeShare()} of its disk. Joining needs about ${formatBytes(needed)}. Free some disk, then resume.`,
      );
      return;
    }

    const partial = read < playlist.segments.length;
    const temporary = path.join(this.folder(id), 'export.tmp.mp4');
    // While ffmpeg runs, the stream is looked at now and then, and the join stopped if it went live.
    const join = { halted: null as 'live' | null, looking: false };
    const inner = new AbortController();
    const onAbort = () => inner.abort();
    if (signal.aborted) inner.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const watch = setInterval(() => {
      if (join.looking || join.halted) return;
      join.looking = true;
      wentLive()
        .then((live) => {
          if (live && !join.halted) {
            join.halted = 'live';
            inner.abort();
          }
        })
        .catch(() => undefined)
        .finally(() => {
          join.looking = false;
        });
    }, Math.max(this.statusCheckMs, JOIN_CHECK_MIN_MS));
    try {
      await this.joiner.join(
        runs.map((run) => ({
          files: run.map((segment) => path.join('segments', `${segment.reference}.ts`)),
          durations: run.map((segment) => segment.durationSeconds),
        })),
        temporary,
        this.folder(id),
        inner.signal,
      );
    } catch (error) {
      await rm(temporary, { force: true });
      if (signal.aborted) return;
      if (join.halted === 'live') {
        await this.pause(id, ['joining'], 'live', liveMessage());
        return;
      }
      await this.pause(
        id,
        ['joining'],
        'problem',
        `Joining the segments into an MP4 failed: ${getErrorMessage(error)}. Try again, or cancel.`,
      );
      return;
    } finally {
      clearInterval(watch);
      signal.removeEventListener('abort', onAbort);
    }
    // The stream may have gone live since the last look, and the file must not be kept as if it had not.
    if (await wentLive()) {
      await rm(temporary, { force: true });
      await this.pause(id, ['joining'], 'live', liveMessage());
      return;
    }

    let quality = row.rendition;
    if (row.rendition === SOURCE_RENDITION) {
      const height = await this.joiner.probeHeight(temporary).catch(() => null);
      quality = height ? `${height}p` : 'audio';
    }
    const fileName = exportFileName({
      title: stream.title,
      day: broadcastDay(stream) ?? utcDay(this.now()),
      quality,
      partial,
    });
    await rename(temporary, this.mp4Path(id));
    const { size } = await stat(this.mp4Path(id));
    const done = await this.store.transition(id, ['joining'], {
      state: 'done',
      quality,
      fileName,
      sizeBytes: size,
      partial,
      segmentsRead: read,
      segmentsMissing: playlist.segments.length - read,
      bytesRead: bytes,
    });
    if (!done) {
      await rm(this.mp4Path(id), { force: true });
      return;
    }
    await this.clearWork(id);
    logger.info(
      `[Export] "${stream.title}" at ${quality} is ready: ${fileName}, ${formatBytes(size)}${
        partial ? ', from part of the recording' : ''
      }`,
    );
    await recordAudit(this.audit, {
      actor: SYSTEM_EXPORT,
      action: 'export.done',
      streamId: stream.id,
      topic: stream.topic,
      details: {
        exportId: id,
        rendition: row.rendition,
        fileName,
        sizeBytes: size,
        partial,
        segmentsRead: read,
        segmentsTotal: playlist.segments.length,
      },
    });
  }

  /** Pauses the export on a problem and audits it; an export already moved on is left as it is. */
  private async pause(
    id: string,
    from: readonly ExportState[],
    reason: Exclude<ExportPauseReason, 'user'>,
    message: string,
  ): Promise<void> {
    const paused = await this.store.transition(id, from, {
      state: 'paused',
      pauseReason: reason,
      pauseMessage: message,
    });
    if (!paused) return;
    logger.warn(`[Export] the export paused (${reason}): ${message}`);
    await recordAudit(this.audit, {
      actor: SYSTEM_EXPORT,
      action: 'export.paused',
      streamId: paused.stream_id,
      details: { exportId: id, rendition: paused.rendition, reason, message, segmentsRead: paused.segments_read },
    });
  }

  private async readWithRetries(
    id: string,
    node: ReadNode,
    reference: string,
    signal: AbortSignal,
  ): Promise<number | { error: string }> {
    let error = 'not read';
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      if (attempt > 0 && !(await sleep(this.retryDelaysMs[attempt - 1]!, signal))) return { error };
      try {
        return await this.source.readSegment(node, reference, this.segmentPath(id, reference), signal);
      } catch (caught) {
        if (signal.aborted) return { error };
        error = getErrorMessage(caught);
      }
    }
    return { error };
  }

  // --- what the export reads -----------------------------------------------------

  private async qualitiesOf(
    stream: StreamRow,
    renditions: StreamRenditionRow[],
    estimateSource: boolean,
  ): Promise<Array<{ option: ExportQuality; feed: RecordingFeed | null }>> {
    if (renditions.length > 0) {
      return [...renditions]
        .sort((a, b) => b.height - a.height)
        .map((rung) => {
          const bitrate = rung.avg_bandwidth > 0 ? rung.avg_bandwidth : rung.bandwidth;
          return {
            option: {
              rendition: rung.name,
              label: rung.name,
              width: rung.width,
              height: rung.height,
              durationSeconds: rung.duration_seconds,
              estimatedBytes:
                rung.duration_seconds !== null && bitrate > 0
                  ? Math.round((bitrate * rung.duration_seconds) / 8)
                  : null,
              unavailable: rung.manifest_index === null ? 'This quality has not finished recording.' : null,
            },
            feed:
              rung.manifest_index === null
                ? null
                : { owner: stream.owner, topic: rung.topic, index: rung.manifest_index },
          };
        });
    }
    const feed =
      stream.manifest_index === null
        ? null
        : { owner: stream.owner, topic: stream.topic, index: stream.manifest_index };
    return [
      {
        option: {
          rendition: SOURCE_RENDITION,
          label: 'Source',
          width: null,
          height: null,
          durationSeconds: stream.duration_seconds,
          estimatedBytes: feed && estimateSource ? await this.estimateSource(feed) : null,
          unavailable: feed ? null : 'The recording has not finished.',
        },
        feed,
      },
    ];
  }

  /**
   * The size of a single-quality recording, which has no bitrate in the admin: its first segment's size, spread over
   * the playlist's length. One small read, remembered per recording. Null when it cannot be read.
   */
  private async estimateSource(feed: RecordingFeed): Promise<number | null> {
    const key = `${feed.owner}:${feed.topic}:${feed.index}`;
    if (this.estimates.has(key)) return this.estimates.get(key) ?? null;
    let estimate: number | null = null;
    const node = await this.readNode();
    if (!('problem' in node)) {
      const scratch = await mkdtemp(path.join(os.tmpdir(), 'web2-admin-estimate-'));
      try {
        const signal = AbortSignal.timeout(ESTIMATE_TIMEOUT_MS);
        const playlist = parseRecordingPlaylist(await this.source.readPlaylist(node.node, feed, signal));
        const first = playlist.segments[0]!;
        const size = await this.source.readSegment(node.node, first.reference, path.join(scratch, 'first.ts'), signal);
        estimate =
          first.durationSeconds > 0
            ? Math.round((size / first.durationSeconds) * playlist.durationSeconds)
            : size * playlist.segments.length;
      } catch (error) {
        logger.warn(
          `[Export] could not estimate the recording's size: ${withoutCatalogueNode(getErrorMessage(error), node.target)}`,
        );
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }
    this.estimates.set(key, estimate);
    return estimate;
  }

  /** The feed of the quality as the stream points at it now, or null when that quality holds no finished recording. */
  private async feedOf(stream: StreamRow, rendition: string): Promise<RecordingFeed | null> {
    if (rendition === SOURCE_RENDITION) {
      return stream.manifest_index === null
        ? null
        : { owner: stream.owner, topic: stream.topic, index: stream.manifest_index };
    }
    const rung = (await this.renditions.listByStream(stream.id)).find((candidate) => candidate.name === rendition);
    return rung && rung.manifest_index !== null
      ? { owner: stream.owner, topic: rung.topic, index: rung.manifest_index }
      : null;
  }

  private async refusalFor(stream: StreamRow, view: ExportView | null): Promise<ExportRefusal | null> {
    if (!holdsRecording(stream)) {
      return {
        problem: 'not_recording',
        message: `Only a finished recording can be exported, and this stream is ${statusWords(stream.status)}.`,
      };
    }
    if (view && EXPORT_ACTIVE_STATES.includes(view.state)) return { problem: 'busy', message: busyMessage(view) };
    const ffmpeg = await this.ffmpegProblem();
    if (ffmpeg) return { problem: 'no_ffmpeg', message: ffmpeg };
    const node = await this.readNode();
    if ('problem' in node) return { problem: 'no_node', message: node.problem };
    return null;
  }

  private async ffmpegProblem(): Promise<string | null> {
    const now = Date.now();
    if (this.ffmpegChecked && now - this.ffmpegChecked.at < FFMPEG_CHECK_TTL_MS) return this.ffmpegChecked.problem;
    const problem = await this.joiner.check();
    this.ffmpegChecked = { at: now, problem };
    return problem;
  }

  private async readNode(): Promise<{ node: ReadNode; target: CatalogueTarget } | { problem: string }> {
    const read = await this.nodes.forRead();
    if ('skipped' in read) return { problem: `There is no node to read the recording through: ${read.skipped}` };
    if (!read.target) {
      return {
        problem: 'There is no node to read the recording through: the manager has not designated a catalogue node yet.',
      };
    }
    return { node: { beeApiUrl: read.target.beeApiUrl }, target: read.target };
  }

  /** The playlist of the recording at `feed.index`, read once and kept in the export's folder. */
  private async playlistFor(
    id: string,
    node: ReadNode,
    feed: RecordingFeed,
    signal: AbortSignal,
  ): Promise<RecordingPlaylist> {
    const kept = await this.cachedPlaylist(id, feed.index);
    if (kept) return kept;
    const read = { text: null as string | null, error: null as unknown };
    for (let attempt = 0; attempt <= this.retryDelaysMs.length && read.text === null; attempt++) {
      if (attempt > 0 && !(await sleep(this.retryDelaysMs[attempt - 1]!, signal))) break;
      try {
        read.text = await this.source.readPlaylist(node, feed, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        read.error = error;
      }
    }
    if (read.text === null) throw read.error ?? new Error('the playlist was not read');
    const playlist = parseRecordingPlaylist(read.text);
    await writeFile(this.playlistPath(id, feed.index), read.text);
    return playlist;
  }

  private async cachedPlaylist(id: string, index: number): Promise<RecordingPlaylist | null> {
    try {
      return parseRecordingPlaylist(await readFile(this.playlistPath(id, index), 'utf8'));
    } catch {
      return null;
    }
  }

  /** The segments on disk, by reference, with their sizes. */
  private async presentSegments(id: string): Promise<Map<string, number>> {
    const present = new Map<string, number>();
    const names = await readdir(this.segmentsDir(id)).catch(() => [] as string[]);
    await Promise.all(
      names
        .filter((name) => name.endsWith('.ts'))
        .map(async (name) => {
          const { size } = await stat(path.join(this.segmentsDir(id), name));
          if (size > 0) present.set(name.slice(0, -'.ts'.length), size);
        }),
    );
    return present;
  }

  /** The free bytes where exports are kept, and how many of them stay free: a share of the whole disk. */
  private async room(): Promise<{ free: number; keep: number }> {
    const { free, total } = await this.disk.space(this.options.dir);
    return { free, keep: Math.round(total * this.keepFreeFraction) };
  }

  private keepFreeShare(): string {
    return `${Math.round(this.keepFreeFraction * 100)}%`;
  }

  // --- files ---------------------------------------------------------------------

  private folder(id: string): string {
    return path.join(this.options.dir, id);
  }

  private segmentsDir(id: string): string {
    return path.join(this.folder(id), 'segments');
  }

  private segmentPath(id: string, reference: string): string {
    return path.join(this.segmentsDir(id), `${reference}.ts`);
  }

  private playlistPath(id: string, index: number): string {
    return path.join(this.folder(id), `playlist-${index}.m3u8`);
  }

  private mp4Path(id: string): string {
    return path.join(this.folder(id), 'export.mp4');
  }

  /** Everything but the MP4: the segments and the playlists. */
  private async clearWork(id: string): Promise<void> {
    const names = await readdir(this.folder(id)).catch(() => [] as string[]);
    await Promise.all(
      names
        .filter((name) => name !== 'export.mp4')
        .map((name) => rm(path.join(this.folder(id), name), { recursive: true, force: true })),
    );
  }

  private async removeFolder(id: string): Promise<void> {
    if (!UUID_NAME.test(id)) return;
    await rm(this.folder(id), { recursive: true, force: true });
  }

  /** Deletes the folders of exports that are gone. Only names an export could have are touched. */
  private async sweep(keep: string | null): Promise<void> {
    const names = await readdir(this.options.dir).catch(() => [] as string[]);
    await Promise.all(
      names.filter((name) => UUID_NAME.test(name) && name !== keep).map((name) => this.removeFolder(name)),
    );
  }
}

function summaryOf(view: ExportView, userId: string | null): ExportSummary {
  return {
    id: view.id,
    streamId: view.stream_id,
    streamTitle: view.stream_title,
    rendition: view.rendition,
    quality: view.quality,
    state: view.state,
    pauseReason: view.pause_reason,
    pauseMessage: view.pause_message,
    pausedAt: view.paused_at?.toISOString() ?? null,
    segmentsTotal: view.segments_total,
    segmentsRead: view.segments_read,
    segmentsMissing: view.segments_missing,
    bytesRead: view.bytes_read,
    estimatedBytes: view.estimated_bytes,
    durationSeconds: view.duration_seconds,
    fileName: view.file_name,
    sizeBytes: view.size_bytes,
    partial: view.partial,
    startedBy: view.started_by,
    startedByYou: userId !== null && view.started_by_user_id === userId,
    startedAt: view.started_at.toISOString(),
    finishedAt: view.finished_at?.toISOString() ?? null,
    dismissed: view.dismissed,
    actions: actionsFor(view, view.dismissed),
  };
}

function countPresent(
  playlist: RecordingPlaylist,
  present: ReadonlyMap<string, number>,
): { read: number; bytes: number } {
  let read = 0;
  let bytes = 0;
  const counted = new Set<string>();
  for (const segment of playlist.segments) {
    const size = present.get(segment.reference);
    if (size === undefined) continue;
    read += 1;
    if (!counted.has(segment.reference)) {
      counted.add(segment.reference);
      bytes += size;
    }
  }
  return { read, bytes };
}

function liveMessage(): string {
  return 'The stream went live again, so its recording is changing. Save what was read, wait until it finishes, or cancel.';
}

function actionWords(action: ExportAction): string {
  switch (action) {
    case 'pause':
      return 'be paused';
    case 'resume':
      return 'be resumed';
    case 'wait':
      return 'wait for the stream';
    case 'save':
      return 'be saved';
    case 'cancel':
      return 'be cancelled';
    case 'dismiss':
      return 'be closed';
    case 'clear':
      return 'be cleared';
  }
}

/** Waits, unless the signal stops it first: answers whether the wait ran out rather than being stopped. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
