/**
 * Which protocol the harness's publisher sends a broadcast over.
 *
 * SRS takes a broadcast over SRT and over RTMP, and a broadcaster is offered both at the same level, so a suite
 * written against one has to be able to run against the other. `E2E_INGEST_PROTOCOL` chooses for every suite that
 * does not name a protocol itself, and SRT is the default because every suite before RTMP ingest was written for it.
 * A suite that is about one protocol, or about switching between them, names it on its own publisher.
 */

export const INGEST_SRT = 'srt';
export const INGEST_RTMP = 'rtmp';
const INGEST_PROTOCOLS = [INGEST_SRT, INGEST_RTMP] as const;
export type IngestProtocol = (typeof INGEST_PROTOCOLS)[number];

/** What a run that names no protocol publishes over. */
export const DEFAULT_INGEST_PROTOCOL: IngestProtocol = INGEST_SRT;

/** How an operator and a report name a protocol. */
export const PROTOCOL_LABEL: Record<IngestProtocol, string> = { [INGEST_SRT]: 'SRT', [INGEST_RTMP]: 'RTMP' };

export function readIngestProtocol(raw: string): IngestProtocol {
  if ((INGEST_PROTOCOLS as readonly string[]).includes(raw)) {
    return raw as IngestProtocol;
  }
  throw new Error(`Invalid E2E_INGEST_PROTOCOL "${raw}"; expected one of: ${INGEST_PROTOCOLS.join(', ')}`);
}

/**
 * Why `engine` cannot take a broadcast over `protocol` in this stack, or null when it can.
 *
 * OME's compose file publishes an SRT port and no RTMP one, so an RTMP publisher aimed at OME would dial nothing,
 * fail its warmup and read as a broken stack rather than as a question this engine cannot answer.
 */
export function unsupportedIngestReason(engine: string, protocol: IngestProtocol): string | null {
  if (engine === 'ome' && protocol === INGEST_RTMP) {
    return 'OME in this stack takes SRT only: its compose file publishes no RTMP port, so there is nothing to dial';
  }
  return null;
}
