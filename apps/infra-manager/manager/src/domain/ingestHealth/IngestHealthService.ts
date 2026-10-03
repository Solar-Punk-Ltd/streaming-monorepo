import {
  defaultServicesFor,
  engineOfServices,
  INGEST_NOT_RUNNING,
  INGEST_NOT_SRS,
  INGEST_READ,
  INGEST_UNREADABLE,
  type IngestHealthNotRead,
  type IngestHealthReading,
  type IngestNotReadState,
  SRS_SERVICE,
} from '@streaming-infra-manager/common';

import { ContainerNotRunningError, ProfileNotFoundError } from '../errors/index.js';
import { Logger } from '../Logger.js';
import type { LogWindow } from '../logWindow.js';
import type { TargetDocker } from '../ports/TargetDocker.js';
import type { ProfileRepository } from '../ProfileRepository.js';
import type { MarkedLines } from '../ports/remoteLogLines.js';
import { rtmpIngestReadingFrom } from './rtmpIngestReading.js';
import { parseRtmpPublishReports, RTMP_PUBLISH_HOST_PATTERN } from './rtmpPublishReport.js';
import { srtIngestReadingFrom } from './srtIngestReading.js';
import { parseTransportStatsLines, TRANSPORT_STATS_HOST_PATTERN } from './transportStatsLine.js';

const logger = Logger.getInstance();

/**
 * The last minute of SRS's log, and of that at most the last 20,000 lines.
 *
 * A minute holds about six reports per publisher at SRS's ten second print
 * interval. The line cap is for a link that is failing, when libsrt writes a
 * line per dropped packet into the same log: the broadcast of 2026-09-22
 * dropped about forty a second, some 2,400 lines a minute, so the cap holds
 * several minutes of that before it cuts into the window.
 */
export const INGEST_LOG_WINDOW: LogWindow = { sinceSeconds: 60, tailLines: 20_000 };

/**
 * SRS's report lines for SRT and RTMP publishers, each held to its whole shape
 * on a remote host. The marker is the tag SRS gives a publisher's report in
 * both, `SRT_CPB` and `CPB`, with the space after it.
 */
export const INGEST_LOG_LINES: MarkedLines = {
  marker: 'CPB ',
  hostPattern: `${TRANSPORT_STATS_HOST_PATTERN}|${RTMP_PUBLISH_HOST_PATTERN}`,
};

/** The part of `TargetDocker` this reads through. */
export type MarkedLogLines = Pick<TargetDocker, 'logLinesContaining'>;

/**
 * What SRS's own statistics say about a deployment's ingest over the last
 * minute.
 *
 * Observational only. Nothing reads this to gate a deploy, a start or a health
 * check, and it never throws for a reading, since the page asks on a cadence
 * and an engine that is still coming up is an answer rather than an error. An
 * unknown deployment still throws, because that is about the request.
 */
export class IngestHealthService {
  constructor(
    private readonly profiles: ProfileRepository,
    private readonly logs: MarkedLogLines,
  ) {}

  async read(name: string): Promise<IngestHealthReading> {
    const profile = await this.profiles.findByName(name);
    if (!profile) throw new ProfileNotFoundError(name);
    if (engineOfServices(defaultServicesFor(profile)) !== SRS_SERVICE) {
      return notRead(INGEST_NOT_SRS);
    }

    let lines: string[];
    try {
      lines = await this.logs.logLinesContaining(
        profile.name,
        SRS_SERVICE,
        INGEST_LOG_LINES,
        INGEST_LOG_WINDOW,
        profile.host,
      );
    } catch (err) {
      if (err instanceof ContainerNotRunningError) return notRead(INGEST_NOT_RUNNING);
      // The kind of failure and none of its text, which a stream error could
      // have filled with anything, a line of this log included.
      logger.debug(`[IngestHealth] ${profile.name}: the SRS log could not be read (${failureKind(err)})`);
      return notRead(INGEST_UNREADABLE);
    }

    return {
      state: INGEST_READ,
      windowSeconds: INGEST_LOG_WINDOW.sinceSeconds,
      srt: srtIngestReadingFrom(parseTransportStatsLines(lines)),
      rtmp: rtmpIngestReadingFrom(parseRtmpPublishReports(lines)),
    };
  }
}

function notRead(state: IngestNotReadState): IngestHealthNotRead {
  return { state, windowSeconds: INGEST_LOG_WINDOW.sinceSeconds };
}

/** A system error's code, such as `ENOENT`, or the error's class name. */
function failureKind(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)) return code;
  return err instanceof Error ? err.constructor.name : 'unknown failure';
}
