import type {
  MediaType,
  StreamStateReport,
  StreamStatus,
} from '@streaming-monorepo/web2-admin-common';

import type { StreamRow } from '../types/index.js';

import {
  InvalidStateTransitionError,
  StreamNotFoundError,
} from './errors/index.js';
import { Logger } from './Logger.js';
import type { PublishOutcome, PublishService } from './PublishService.js';
import { allowedFromFor, isStateTransitionAllowed } from './streamState.js';

const logger = Logger.getInstance();

/** The slice of StreamRepository a state report needs; a fake stands in. */
export interface StateStreamStore {
  findByTopic(topic: string): Promise<StreamRow | null>;
  findByIdUnscoped(id: string): Promise<StreamRow | null>;
  markLive(
    id: string,
    allowedFrom: readonly StreamStatus[],
  ): Promise<StreamRow | null>;
  markVod(
    id: string,
    allowedFrom: readonly StreamStatus[],
    manifestIndex: number,
    durationSeconds: number,
  ): Promise<StreamRow | null>;
}

/**
 * The uploader's half of the contract: resolve the draft an encoder just
 * connected to, and take its state reports.
 *
 * No user scope anywhere here. The internal API is authenticated by one shared
 * token rather than a session, and the uploader knows a stream by its ingest
 * address, not by who drafted it. Ownership stays what it is on the session
 * side: which brand a *console* call may act for.
 */
export class StreamStateService {
  constructor(
    private readonly streams: StateStreamStore,
    private readonly publishService: PublishService,
  ) {}

  /**
   * The ingest stream id is `<mediaType>/<topic>`. Both halves must match the
   * row, and the stream must have been announced: a draft has told nobody
   * anything, so an encoder claiming to be one is refused rather than started.
   * `publishing` is refused too — a feed write is in flight, and the publish
   * it belongs to may still fail back to `draft`.
   *
   * Every refusal is the same 404, deliberately: the caller is the uploader,
   * which either starts the session or does not, and a token holder that
   * probes ingest addresses learns nothing from the difference.
   */
  async lookupByIngest(app: MediaType, topic: string): Promise<StreamRow> {
    const notFound = () => new StreamNotFoundError(`${app}/${topic}`);
    const stream = await this.streams.findByTopic(topic);
    if (!stream) throw notFound();
    if (stream.media_type !== app) throw notFound();
    if (stream.status === 'draft' || stream.status === 'publishing') {
      throw notFound();
    }
    return stream;
  }

  /**
   * A state report, in two steps that must stay in this order.
   *
   * The state is persisted first and the catalogue entry rewritten second. A
   * feed write can fail for reasons that have nothing to do with this stream
   * (Bee down, postage exhausted), and the uploader retries; if the write came
   * first, a failure would lose the fact that the stream is live at all. This
   * way the row is already right, the response is a 502, and the retry redoes
   * nothing but the write.
   */
  async report(
    id: string,
    report: StreamStateReport,
  ): Promise<PublishOutcome> {
    const existing = await this.streams.findByIdUnscoped(id);
    if (!existing) throw new StreamNotFoundError(id);
    if (!isStateTransitionAllowed(existing.status, report.state)) {
      throw new InvalidStateTransitionError(id, existing.status, report.state);
    }

    const updated = await this.apply(existing, report);
    if (!updated) {
      // The conditional UPDATE matched nothing: something moved the row
      // between the read and the write. Re-read to say which of the two it is.
      const current = await this.streams.findByIdUnscoped(id);
      if (!current) throw new StreamNotFoundError(id);
      throw new InvalidStateTransitionError(id, current.status, report.state);
    }

    logger.info(
      `[State] ${updated.topic} reported ${report.state}${
        report.state === 'vod'
          ? ` (index ${String(report.index)}, ${String(report.duration)}s)`
          : ''
      }`,
    );
    return this.publishService.republishWithState(updated);
  }

  private async apply(
    existing: StreamRow,
    report: StreamStateReport,
  ): Promise<StreamRow | null> {
    const allowedFrom = allowedFromFor(report.state);
    if (report.state === 'live') {
      // A row coming back from `vod` is un-finished by this one statement —
      // the recording columns and every rung's index and duration — so the
      // republish below writes `live` with a ladder that carries no indexes,
      // and the next final reports flip it again.
      return this.streams.markLive(existing.id, allowedFrom);
    }
    // The schema has already established that a `vod` report carries both.
    return this.streams.markVod(
      existing.id,
      allowedFrom,
      report.index ?? 0,
      report.duration ?? 0,
    );
  }
}
