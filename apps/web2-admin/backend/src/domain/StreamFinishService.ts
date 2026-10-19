import type { IngestDetails } from '@streaming-monorepo/web2-admin-common';

import type { StreamRow } from '../types/index.js';
import { getErrorMessage } from '../utils/errorUtils.js';

import { describeActor, describeStream, type Actor } from './actor.js';
import { recordAudit, type AuditLog } from './AuditLog.js';
import { StreamFinishedError, StreamNotFoundError, StreamNotStartedError } from './errors/index.js';
import { Logger } from './Logger.js';
import { newPublishKey } from './StreamService.js';

const logger = Logger.getInstance();

/** STREAM_RESTART_WINDOW_MINUTES when the env file does not set it: half an hour. */
export const STREAM_RESTART_WINDOW_DEFAULT_MINUTES = 30;

/** The longest restart window the setting takes: a week. */
export const STREAM_RESTART_WINDOW_MAX_MINUTES = 7 * 24 * 60;

/** How often the sweep looks for streams whose restart window has run out, after its run at boot. */
export const STREAM_FINISH_SWEEP_MS = 60_000;

/** The actor the sweep's audit rows name: no operator pressed anything, the window ran out. */
export const RESTART_WINDOW_ACTOR: Actor = { kind: 'system', reason: 'restart window' };

/**
 * Until when a stream can go live again on its current key: `ended_at` plus the restart window, only while the stream
 * is recorded (`vod`) and not finished. Null otherwise, and for a `vod` with no `ended_at`, which counts as ended long
 * ago and is finished by the next sweep. A time already past means the same.
 */
export function restartUntilOf(
  row: Pick<StreamRow, 'status' | 'ended_at' | 'finished_at'>,
  windowMinutes: number,
): Date | null {
  if (row.status !== 'vod' || row.finished_at || !row.ended_at) return null;
  return new Date(row.ended_at.getTime() + windowMinutes * 60_000);
}

/** The slice of StreamRepository Finish and the sweep need; a fake stands in. */
export interface FinishStreamStore {
  findById(id: string): Promise<StreamRow | null>;
  finish(id: string, publishKey: string): Promise<StreamRow | null>;
  listRestartWindowRunOut(windowMinutes: number): Promise<string[]>;
  finishAfterWindow(id: string, publishKey: string, windowMinutes: number): Promise<StreamRow | null>;
}

/** The ingest details of a stream as it now stands, with the new key: IngestService's `detailsOf`. */
export interface FinishIngestDetails {
  detailsOf(stream: StreamRow): Promise<IngestDetails>;
}

/** What Finish answers: the stream as it now stands and its ingest details with the new key. */
export interface StreamFinishOutcome {
  stream: StreamRow;
  ingest: IngestDetails;
}

/**
 * A finished stream cannot be restarted by mistake (migration 022). The uploader accepts a stream that is already
 * `vod`, so a broadcaster who dropped can come back; for the restart window after a stream ends
 * (STREAM_RESTART_WINDOW_MINUTES) that goes on as before. Then the admin changes the stream's key itself, so an old
 * encoder profile pressed later is refused at its next connect, and nothing reaches Swarm.
 *
 * Finish does the same at once, by an operator: on a recorded stream it closes the window early, and on a live one the
 * broadcast goes on, since nothing here stops an encoder, and the stream ends for good when the encoder stops or drops.
 * A stream that goes live again on the new key starts a new window at its next end.
 *
 * Every key change is one conditional statement, so a second process, a retry or a race changes nothing twice, and
 * leaves one audit row: `stream.finish` naming the operator, or `stream.finish.window` naming the restart window.
 * Neither key reaches a log line or an audit row.
 */
export class StreamFinishService {
  constructor(
    private readonly streams: FinishStreamStore,
    private readonly ingest: FinishIngestDetails,
    private readonly audit: AuditLog,
    private readonly windowMinutes: number,
    private readonly newKey: () => string = newPublishKey,
  ) {}

  /**
   * Finishes a live or recorded stream: a new key, at once. Refused for no such stream (`StreamNotFoundError`), for
   * one that is neither live nor ended (`StreamNotStartedError`) and for one already finished (`StreamFinishedError`),
   * told apart by reading the row again after a conditional update that matched nothing, as a state report does.
   */
  async finish(actor: Actor, id: string): Promise<StreamFinishOutcome> {
    const finished = await this.streams.finish(id, this.newKey());
    if (!finished) {
      const current = await this.streams.findById(id);
      if (!current) throw new StreamNotFoundError(id);
      if (current.status !== 'live' && current.status !== 'vod') throw new StreamNotStartedError(id);
      throw new StreamFinishedError(id);
    }

    logger.info(`[Finish] ${describeActor(actor)} finished ${describeStream(finished)}: its key changed`);
    await recordAudit(this.audit, {
      actor,
      action: 'stream.finish',
      streamId: finished.id,
      topic: finished.topic,
      statusBefore: finished.status,
      statusAfter: finished.status,
    });
    return { stream: finished, ingest: await this.ingest.detailsOf(finished) };
  }

  /**
   * The sweep: every recorded stream whose restart window has run out gets a new key, one conditional statement per
   * stream, and each one that changed gets one audit row. Answers how many changed. Safe to run at once in several
   * processes or calls: a stream another run changed first matches nothing here.
   */
  async finishEnded(): Promise<number> {
    let finished = 0;
    for (const id of await this.streams.listRestartWindowRunOut(this.windowMinutes)) {
      const row = await this.streams.finishAfterWindow(id, this.newKey(), this.windowMinutes);
      if (!row) continue;
      finished++;
      logger.info(`[Finish] the restart window of ${describeStream(row)} ran out: its key changed`);
      await recordAudit(this.audit, {
        actor: RESTART_WINDOW_ACTOR,
        action: 'stream.finish.window',
        streamId: row.id,
        topic: row.topic,
        statusBefore: row.status,
        statusAfter: row.status,
      });
    }
    return finished;
  }
}

/** The running sweep, which the shutdown stops. */
export interface StreamFinishSweep {
  stop(): void;
}

/**
 * Runs the sweep once now, before the API listens, so the first start after migration 022 finishes every older
 * recording, then every {@link STREAM_FINISH_SWEEP_MS}. A failed run is logged and never stops the start: the next one
 * tries again. The timer is unref'd, as the session sweep's is, so it never keeps the process alive.
 */
export async function startStreamFinishSweep(
  service: Pick<StreamFinishService, 'finishEnded'>,
  intervalMs: number = STREAM_FINISH_SWEEP_MS,
): Promise<StreamFinishSweep> {
  const sweep = async (): Promise<void> => {
    try {
      const finished = await service.finishEnded();
      if (finished > 0) logger.info(`[Finish] the restart window ran out for ${finished} stream(s)`);
    } catch (err) {
      logger.error('[Finish] restart-window sweep failed:', getErrorMessage(err));
    }
  };

  await sweep();
  const timer = setInterval(() => void sweep(), intervalMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
