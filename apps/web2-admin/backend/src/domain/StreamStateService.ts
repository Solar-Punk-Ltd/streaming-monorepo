import type { MediaType, Rendition, StreamStateReport, StreamStatus } from '@streaming-monorepo/web2-admin-common';

import type { StreamRow } from '../types/index.js';

import { getErrorMessage } from '../utils/errorUtils.js';

import { describeActor, describeStream, UPLOADER } from './actor.js';
import { recordAudit, type AuditLog } from './AuditLog.js';
import { InvalidStateTransitionError, PublishFailedError, StreamNotFoundError } from './errors/index.js';
import type { FeedIdentity } from './feedIdentity.js';
import { Logger } from './Logger.js';
import type { Mutex } from './Mutex.js';
import type { PublishOutcome, PublishService } from './PublishService.js';
import { allowedFromFor, isOpenToUploader, isStateTransitionAllowed } from './streamState.js';
import { inScope, type UploaderScope } from './uploaderScope.js';

const logger = Logger.getInstance();

/** The slice of StreamRepository a state report needs; a fake stands in. */
export interface StateStreamStore {
  findByTopic(topic: string): Promise<StreamRow | null>;
  findById(id: string): Promise<StreamRow | null>;
  markLive(id: string, allowedFrom: readonly StreamStatus[]): Promise<StreamRow | null>;
  markVod(
    id: string,
    allowedFrom: readonly StreamStatus[],
    manifestIndex: number,
    durationSeconds: number,
  ): Promise<StreamRow | null>;
}

/**
 * What a test stream's reports need beside a listed stream's: the catalogue's identity, which their answers name as
 * every answer does, and the catalogue's mutex, so a test stream's report is stored in the same serialised step as a
 * listed stream's, though it writes nothing there.
 */
export interface TestStreamReports {
  feed: FeedIdentity;
  mutex: Mutex;
}

/**
 * The answer to a report of a test stream, which writes nothing to the catalogue: `written` is false, `feed.index` is
 * the stream's order number after the report, `report_order`, and `feed.entryCount` is 0. The order number grows with
 * every report the admin stores for the stream, so the uploader keeps the newest merge of its ladder by it. It names
 * no catalogue slot.
 */
export function testReportOutcome(
  stream: StreamRow,
  feed: FeedIdentity,
  order: number,
  renditions: Rendition[] = [],
  previousRenditions: Rendition[] = [],
): PublishOutcome {
  return {
    stream,
    entryStatus: null,
    entryRecording: null,
    feed: { owner: feed.owner, topic: feed.topic, topicHex: feed.topicHex, index: order, entryCount: 0 },
    written: false,
    renditions,
    previousRenditions,
  };
}

/** The test stream wiring a report of one needs, or a refusal to go on without it. */
export function testStreamReports(wiring: TestStreamReports | undefined): TestStreamReports {
  if (!wiring) throw new Error('a test stream reported, and this service was built without the test stream wiring');
  return wiring;
}

/**
 * The uploader's half of the contract: resolve the draft an encoder just
 * connected to, and take its state reports.
 *
 * No user scope anywhere here. The internal API is authenticated by a bearer
 * token rather than a session, and the uploader knows a stream by its ingest
 * address, not by who drafted it. Nor is there one on the session side: a
 * stream belongs to the installation, and ownership is which brand a call may
 * act for.
 *
 * There is a stage scope. Every uploader calls on a token of its own and is
 * answered only about the streams on its stage (`UploaderScope`): any other
 * stream, a stream with no stage included, is the same 404 as a stream that
 * does not exist, and nothing is written for it.
 *
 * Every report is the uploader's, so this service names it as the actor
 * itself: the internal route has no session to name anyone else by, and is
 * not asked to.
 */
export class StreamStateService {
  /** The restart-window sweeps started in the tail of a `vod` report and not finished yet. */
  private readonly tails = new Set<Promise<void>>();

  constructor(
    private readonly streams: StateStreamStore,
    private readonly publishService: PublishService,
    private readonly audit: AuditLog,
    /**
     * StreamFinishService's sweep, run in the tail of every `vod` report, so a restart window of 0 finishes the stream
     * the report ended. Never awaited by the report and never failing it.
     */
    private readonly finishEnded?: () => Promise<unknown>,
    /** What a test stream's reports need. Without it a test stream's report is refused as an error. */
    private readonly testStreams?: TestStreamReports,
  ) {}

  /** Resolves once every sweep started in the tail of a `vod` report has run: for the tests. */
  async idle(): Promise<void> {
    await Promise.all([...this.tails]);
  }

  /**
   * The ingest stream id is `<mediaType>/<topic>`. Both halves must match the
   * row, and the stream must be open to its stage's uploader
   * (`isOpenToUploader`): a draft has told nobody anything, so an encoder
   * claiming to be one is refused rather than started, and `publishing` is
   * refused too — a feed write is in flight, and the publish it belongs to
   * may still fail back to `draft`. A test stream is open as a draft, and in
   * every status it has: it is never published. Another stream live on the
   * same stage refuses nothing.
   *
   * Every refusal is the same 404, deliberately: the caller is the uploader,
   * which either starts the session or does not, and a token holder that
   * probes ingest addresses learns nothing from the difference. A stream on
   * another stage than the caller's is one more of them.
   */
  async lookupByIngest(app: MediaType, topic: string, scope: UploaderScope): Promise<StreamRow> {
    const notFound = () => new StreamNotFoundError(`${app}/${topic}`);
    const stream = await this.streams.findByTopic(topic);
    if (!stream) throw notFound();
    if (!inScope(stream, scope)) throw notFound();
    if (stream.media_type !== app) throw notFound();
    if (!isOpenToUploader(stream)) throw notFound();
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
   *
   * The audit entry is written either way, once the write has been tried: the
   * status did move, and the entry says whether the catalogue caught up (the
   * feed index) or not (the error). The write reads the row again when its
   * turn comes, so a later report stored in the meantime is what it
   * publishes, as it should be. The audit entry records that as
   * `entryStatus` and `entryRecording`, the status and the recording the
   * write published, rather than passing the write off as this report's own.
   *
   * A stream outside the caller's scope is refused as not found before
   * anything is written: no status, no feed write, no audit row.
   *
   * A test stream's report is stored in the catalogue's serialised step and
   * writes nothing there: its answer is `testReportOutcome`'s, with the order
   * number the statement that stored it took.
   */
  async report(id: string, report: StreamStateReport, scope: UploaderScope): Promise<PublishOutcome> {
    const existing = await this.streams.findById(id);
    if (!existing || !inScope(existing, scope)) throw new StreamNotFoundError(id);
    if (!isOpenToUploader(existing) || !isStateTransitionAllowed(existing.status, report.state, existing.test)) {
      throw new InvalidStateTransitionError(id, existing.status, report.state);
    }

    const tests = existing.test ? testStreamReports(this.testStreams) : null;
    const updated = tests
      ? await tests.mutex.run(() => this.apply(existing, report))
      : await this.apply(existing, report);
    if (!updated) {
      // The conditional UPDATE matched nothing: something moved the row
      // between the read and the write. Re-read to say which of the two it is.
      const current = await this.streams.findById(id);
      if (!current || !inScope(current, scope)) throw new StreamNotFoundError(id);
      throw new InvalidStateTransitionError(id, current.status, report.state);
    }

    logger.info(
      `[State] ${describeActor(UPLOADER)} reported ${report.state} for ${describeStream(updated)}: ${existing.status} → ${
        updated.status
      }${report.state === 'vod' ? ` (index ${String(report.index)}, ${String(report.duration)}s)` : ''}`,
    );

    const recording = report.state === 'vod' ? { index: report.index ?? 0, duration: report.duration ?? 0 } : {};
    if (tests) {
      if (report.state === 'vod') this.sweepAfterVod();
      const outcome = testReportOutcome(updated, tests.feed, updated.report_order);
      await recordAudit(this.audit, {
        actor: UPLOADER,
        action: report.state === 'live' ? 'stream.state.live' : 'stream.state.vod',
        streamId: updated.id,
        topic: updated.topic,
        statusBefore: existing.status,
        statusAfter: updated.status,
        details: { ...recording, feedIndex: outcome.feed.index, written: false, test: true },
      });
      return outcome;
    }
    const entry = {
      actor: UPLOADER,
      action: report.state === 'live' ? 'stream.state.live' : 'stream.state.vod',
      streamId: updated.id,
      topic: updated.topic,
      statusBefore: existing.status,
      statusAfter: updated.status,
    } as const;

    let outcome: PublishOutcome;
    try {
      outcome = await this.publishService.republishWithState(UPLOADER, updated);
    } catch (error) {
      const message = error instanceof PublishFailedError ? error.reason : getErrorMessage(error);
      await recordAudit(this.audit, { ...entry, details: { ...recording, feedIndex: null, publishError: message } });
      throw error;
    } finally {
      // The status is written whether the catalogue write went or not, so the window may already have run out.
      if (report.state === 'vod') this.sweepAfterVod();
    }
    await recordAudit(this.audit, {
      ...entry,
      details: {
        ...recording,
        feedIndex: outcome.feed.index,
        entryStatus: outcome.entryStatus,
        entryRecording: outcome.entryRecording,
      },
    });
    return outcome;
  }

  /**
   * Starts the restart-window sweep behind a `vod` report, in the background: the uploader's answer neither waits on it
   * nor fails with it, and a sweep that fails is logged and left to the next run.
   */
  private sweepAfterVod(): void {
    if (!this.finishEnded) return;
    const tail = this.finishEnded().then(
      () => undefined,
      (error: unknown) => {
        logger.error('[State] restart-window sweep after a vod report failed:', getErrorMessage(error));
      },
    );
    this.tails.add(tail);
    void tail.finally(() => this.tails.delete(tail));
  }

  private async apply(existing: StreamRow, report: StreamStateReport): Promise<StreamRow | null> {
    const allowedFrom = allowedFromFor(report.state, existing.test);
    if (report.state === 'live') {
      // A row coming back from `vod` is un-finished by this one statement —
      // the recording columns and every rung's index and duration — so the
      // republish below writes `live` with a ladder that carries no indexes,
      // and the next final reports flip it again.
      return this.streams.markLive(existing.id, allowedFrom);
    }
    // The schema has already established that a `vod` report carries both.
    return this.streams.markVod(existing.id, allowedFrom, report.index ?? 0, report.duration ?? 0);
  }
}
