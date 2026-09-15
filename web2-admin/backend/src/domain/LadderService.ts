import type {
  Rendition,
  RenditionReport,
} from '@streaming-monorepo/web2-admin-common';

import { InvalidStateError, StreamNotFoundError } from './errors/index.js';
import { Logger } from './Logger.js';
import type { PublishOutcome, PublishService } from './PublishService.js';
import {
  foldRendition,
  isLadderFinished,
  ladderDuration,
  toRendition,
} from './renditions.js';
import { StreamRenditionRepository } from './StreamRenditionRepository.js';
import { StreamRepository } from './StreamRepository.js';

const logger = Logger.getInstance();

/** Where the ladder stands after a report; the uploader's cue to report `vod`. */
export interface LadderState {
  finished: boolean;
  flippedToFinished: boolean;
  duration: number | null;
}

export interface RenditionReportOutcome {
  publish: PublishOutcome;
  renditions: Rendition[];
  ladder: LadderState;
}

/**
 * The ABR ladder's half of the uploader contract.
 *
 * Standalone, swarm-hls-stream merges the rungs of a ladder inside the
 * catalogue feed it writes itself. In admin mode it writes no catalogue at
 * all, so each rung reports itself here instead: this service folds the report
 * into what is stored, rewrites the catalogue entry through the same
 * single-writer path everything else uses, and answers with the merged ladder
 * the uploader builds its master playlist from.
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
    private readonly streams: StreamRepository,
    private readonly renditions: StreamRenditionRepository,
    private readonly publishService: PublishService,
  ) {}

  /**
   * A rendition report, in the same two steps a state report takes and for the
   * same reason: the rung is persisted first and the catalogue entry rewritten
   * second. A feed write can fail for reasons that have nothing to do with
   * this stream, and the uploader retries the whole report; the fold is
   * idempotent, so the retry has only the write left to do.
   */
  async report(
    id: string,
    report: RenditionReport,
  ): Promise<RenditionReportOutcome> {
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
    const wasFinished = isLadderFinished(stored);
    const previous = stored.find((rung) => rung.name === report.name) ?? null;
    await this.renditions.upsert(id, foldRendition(previous, report));

    const renditions = (await this.renditions.listByStream(id)).map(
      toRendition,
    );
    const finished = isLadderFinished(renditions);
    const ladder: LadderState = {
      finished,
      flippedToFinished: finished && !wasFinished,
      duration: ladderDuration(renditions),
    };

    logger.info(
      `[Ladder] ${stream.topic} rung ${report.name} reported${
        report.index === undefined
          ? ''
          : ` final (index ${String(report.index)}, ${String(report.duration)}s)`
      }; ${renditions.length} rung(s), ${
        ladder.finished ? 'finished' : 'still running'
      }`,
    );
    const publish = await this.publishService.republishWithState(stream);
    return { publish, renditions, ladder };
  }
}
