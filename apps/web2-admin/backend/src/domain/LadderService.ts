import type { Rendition, RenditionReport } from '@streaming-monorepo/web2-admin-common';

import type { StreamRenditionRow, StreamRow } from '../types/index.js';

import { InvalidStateError, StreamNotFoundError } from './errors/index.js';
import { Logger } from './Logger.js';
import type { PublishOutcome, PublishService } from './PublishService.js';
import { mergeRendition, isLadderFinished, ladderDuration, toRendition } from './renditions.js';

const logger = Logger.getInstance();

/** The slice of StreamRepository a report needs; a fake stands in for tests. */
export interface LadderStreamStore {
  findByIdUnscoped(id: string): Promise<StreamRow | null>;
}

/** The slice of StreamRenditionRepository the merge needs; a fake stands in. */
export interface LadderRenditionStore {
  listByStream(streamId: string): Promise<StreamRenditionRow[]>;
  upsert(streamId: string, rendition: Rendition): Promise<StreamRenditionRow>;
}

/** Where the ladder stands after a report; the uploader's cue to report `vod`. */
export interface LadderState {
  finished: boolean;
  flippedToFinished: boolean;
  duration: number | null;
}

export interface RenditionReportOutcome {
  publish: PublishOutcome;
  /** The ladder as the write put it on the catalogue: `publish.renditions`. */
  renditions: Rendition[];
  ladder: LadderState;
}

/**
 * The ABR ladder's half of the uploader contract.
 *
 * Standalone, swarm-hls-stream merges the rungs of a ladder inside the
 * catalogue feed it writes itself. In admin mode it writes no catalogue at
 * all, so each rung reports itself here instead: this service merges the report
 * into what is stored, rewrites the catalogue entry through the same
 * single-writer path everything else uses, and answers with the merged ladder
 * the uploader builds its master playlist from.
 *
 * Everything the uploader reads back — the merged ladder, `finished`,
 * `flippedToFinished`, `duration` — is taken from that write: the ladder it
 * put on the entry, and the ladder the entry it replaced was carrying. Both
 * are read under the publish mutex, so two reports that overlap answer in the
 * order their entries landed on the catalogue, and only the one whose write
 * finished the ladder there says so.
 *
 * It never moves the stream's status. `live` and `vod` still come from
 * POST /state, and a rendition report that flipped the ladder to finished is
 * what tells the uploader to send the `vod` one.
 *
 * No user scope, like StreamStateService: the caller is the uploader, holding
 * the shared internal token and the stream id this API handed it.
 */
export class LadderService {
  constructor(
    private readonly streams: LadderStreamStore,
    private readonly renditions: LadderRenditionStore,
    private readonly publishService: PublishService,
  ) {}

  /**
   * A rendition report, in the same two steps a state report takes and for the
   * same reason: the rung is persisted first and the catalogue entry rewritten
   * second. A feed write can fail for reasons that have nothing to do with
   * this stream, and the uploader retries the whole report; the merge is
   * idempotent, so the retry has only the write left to do.
   *
   * The answer comes from the write, not from reads of the stored ladder
   * around the merge. Two reports can merge in one order and reach the mutex in
   * the other, and a ladder read out here can describe an entry other than
   * the one this report wrote; the uploader would then build its master from
   * an older ladder than the entry carries. `flippedToFinished` is judged
   * against the entry the write replaced, which is also why a report whose
   * write failed flips on its retry: the row already held the finished ladder,
   * but the catalogue did not yet say so.
   */
  async report(id: string, report: RenditionReport): Promise<RenditionReportOutcome> {
    const stream = await this.streams.findByIdUnscoped(id);
    if (!stream) throw new StreamNotFoundError(id);
    // Nothing has been announced (`draft`), or a feed write is already in
    // flight for this stream (`publishing`) and would be raced. `published`,
    // `live` and `vod` all take a rung: a ladder can start reporting before
    // the first `live` report gets through, and a rung can finalize after it.
    if (stream.status === 'draft' || stream.status === 'publishing') {
      throw new InvalidStateError(id, stream.status);
    }

    const stored = (await this.renditions.listByStream(id)).map(toRendition);
    const previous = stored.find((rung) => rung.name === report.name) ?? null;
    await this.renditions.upsert(id, mergeRendition(previous, report));

    const publish = await this.publishService.republishWithState(stream);
    const { renditions } = publish;
    const finished = isLadderFinished(renditions);
    const ladder: LadderState = {
      finished,
      flippedToFinished: finished && !isLadderFinished(publish.previousRenditions),
      duration: ladderDuration(renditions),
    };

    logger.info(
      `[Ladder] ${publish.stream.topic} rung ${report.name} reported${
        report.index === undefined ? '' : ` final (index ${String(report.index)}, ${String(report.duration)}s)`
      }; ${renditions.length} rung(s) on the catalogue, ${
        finished ? 'finished' : 'still running'
      }${ladder.flippedToFinished ? ' as of this report' : ''}`,
    );
    return { publish, renditions, ladder };
  }
}
