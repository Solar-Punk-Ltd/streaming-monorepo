/**
 * What SRS says about broadcasters publishing over RTMP, as the RTMP part of
 * the ingest reading the manager answers and the deployment page renders
 * (`ingestHealth.ts`).
 *
 * SRS prints a line for each RTMP publisher about every ten seconds, with the
 * bitrate it receives. Images of the stack's SRS fork from 6.0-r2-swarm.3 end
 * that line with the vhost the publisher is on, which is what tells a
 * broadcaster on the ingest vhost from the ABR ladder's rungs: SRS republishes
 * each rung over RTMP, from its own host, onto a vhost of the rungs' own. The
 * manager passes on counts and a bitrate, never the log.
 */

/** SRS reported at least one RTMP publisher on the ingest vhost in the window. */
export const RTMP_INGEST_MEASURED = 'measured' as const;
/** SRS reported no RTMP publisher on the ingest vhost in the window. */
export const RTMP_INGEST_NO_REPORTS = 'no_reports' as const;
/**
 * SRS reported RTMP publishers without naming their vhost, as images before
 * 6.0-r2-swarm.3 do, so a broadcaster cannot be told from the ladder's rungs.
 */
export const RTMP_INGEST_UNATTRIBUTED = 'unattributed' as const;

export interface RtmpIngestMeasured {
  state: typeof RTMP_INGEST_MEASURED;
  /** How many reports of RTMP publishers on the ingest vhost the reading is worked out from. */
  reports: number;
  /** How many RTMP connections printed them. A publisher that reconnected counts twice. */
  connections: number;
  /**
   * The kilobits a second SRS received from the connections still sending,
   * each by the 30-second average in its latest report, added up. Null while
   * none of them has a 30-second average yet, which SRS takes about 40
   * seconds to have for a new connection.
   */
  incomingKbps: number | null;
}

export interface RtmpIngestNoReports {
  state: typeof RTMP_INGEST_NO_REPORTS;
}

export interface RtmpIngestUnattributed {
  state: typeof RTMP_INGEST_UNATTRIBUTED;
}

/** What one read of SRS's log says about RTMP ingest. */
export type RtmpIngestReading = RtmpIngestMeasured | RtmpIngestNoReports | RtmpIngestUnattributed;
