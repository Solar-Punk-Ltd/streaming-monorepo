/**
 * How a broadcast is coming into a deployment's SRS over the last minute, in
 * the one shape the manager answers and the deployment page renders.
 *
 * Every part of it comes from one read of SRS's own log, so the states that
 * say why nothing was read belong to the reading as a whole: SRS not running,
 * a log that could not be read, or an engine that is not SRS. A reading that
 * was read carries what the log said about each ingest protocol.
 */
import type { RtmpIngestReading } from './rtmpIngestHealth.js';
import type { SrtIngestReading } from './srtIngestHealth.js';

/** The manager read the window of SRS's log, and the reading carries what it found. */
export const INGEST_READ = 'read' as const;
/** No SRS container is running for the deployment, so there is no log to read. */
export const INGEST_NOT_RUNNING = 'not_running' as const;
/** The engine's log could not be read. Says nothing about the broadcast. */
export const INGEST_UNREADABLE = 'unreadable' as const;
/** The deployment's media server is not SRS, so there is no such log. */
export const INGEST_NOT_SRS = 'not_srs' as const;

export type IngestNotReadState = typeof INGEST_NOT_RUNNING | typeof INGEST_UNREADABLE | typeof INGEST_NOT_SRS;

export interface IngestHealthRead {
  state: typeof INGEST_READ;
  /** How far back the manager read the log. */
  windowSeconds: number;
  srt: SrtIngestReading;
  rtmp: RtmpIngestReading;
}

export interface IngestHealthNotRead {
  state: IngestNotReadState;
  windowSeconds: number;
}

/** One manager read of one deployment's ingest. */
export type IngestHealthReading = IngestHealthRead | IngestHealthNotRead;
